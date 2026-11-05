import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { runProductionTenantAudit } from "./auditTenantDataInventory.js";
import { runAuthorizedProductionMigration as runAccountCredit } from "./migrateAccountCreditTenantOwnership.js";
import { runAuthorizedProductionMigration as runBusinessAccountIndexes } from "./migrateBusinessAccountTenantIndexes.js";
import { runAuthorizedProductionMigration as runOperational } from "./migrateOperationalTenantOwnership.js";
import { runAuthorizedProductionMigration as runSupportIndexes } from "./migrateOperatorSupportSessionIndexes.js";
import { runAuthorizedProductionMigration as runRegistryIndexes } from "./migrateTenantRegistryIndexes.js";
import { runAuthorizedProductionMigration as runShipmentOwnership } from "./migrateShipmentTenantOwnership.js";
import { runAuthorizedProductionMigration as runRootOwnership } from "./migrateSwiftlineRootOwnership.js";
import {
  assertProductionTenantAuditTarget,
  createProductionTenantMigrationAuthorization,
  isEnvironmentFlagEnabled,
  isMainModule,
  parseMongoSrvCredentialUser,
  parseMongoSrvTarget,
  productionTenantMigrationSteps,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";

type CoordinatedProductionTenantMigrationStep = typeof productionTenantMigrationSteps[number];

type Arguments = {
  apply: boolean;
  expectedDatabase: string;
  expectedClusterHost: string;
  changeId: string;
  backupReference: string;
  runId: string;
  artifactSha: string;
  confirmation: string;
  logFile: string;
};

function parseArguments(args: string[]): Arguments {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--apply") {
      if (apply) throw new Error("Pass --apply only once.");
      apply = true;
      continue;
    }
    if (![
      "--database",
      "--cluster-host",
      "--change-id",
      "--backup-ref",
      "--run-id",
      "--artifact-sha",
      "--confirm",
      "--log-file"
    ].includes(argument)) {
      throw new Error(`Unknown production migration option: ${argument}`);
    }
    const value = args[index + 1] ?? "";
    if (!value.trim() || value.startsWith("--") || values.has(argument)) {
      throw new Error(`Pass ${argument} exactly once with a value.`);
    }
    values.set(argument, value.trim());
    index += 1;
  }
  const required = ["--database", "--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"];
  const missing = required.filter((key) => !values.has(key));
  if (missing.length) throw new Error(`Missing required options: ${missing.join(", ")}.`);
  return {
    apply,
    expectedDatabase: values.get("--database")!,
    expectedClusterHost: values.get("--cluster-host")!,
    changeId: values.get("--change-id")!,
    backupReference: values.get("--backup-ref")!,
    runId: values.get("--run-id")!,
    artifactSha: values.get("--artifact-sha")!,
    confirmation: values.get("--confirm")!,
    logFile: values.get("--log-file")!
  };
}

function isInsideDirectory(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function createAuditLog(filePath: string, repositoryPath: string) {
  if (!path.isAbsolute(filePath)) throw new Error("--log-file must be an absolute path outside the repository.");
  const absolutePath = path.resolve(filePath);
  if (isInsideDirectory(repositoryPath, absolutePath)) {
    throw new Error("Production migration logs must be stored outside the application repository.");
  }
  return fs.open(absolutePath, "wx", 0o600);
}

function verifyReleaseCheckout(expectedArtifactSha: string) {
  let repositoryPath: string;
  let head: string;
  let changes: string;
  try {
    repositoryPath = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    changes = execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw new Error("Run the production migration from a Git checkout so its release commit can be verified.");
  }
  if (!head || !head.startsWith(expectedArtifactSha.toLowerCase())) {
    throw new Error("--artifact-sha does not match the checked-out Git commit.");
  }
  if (changes.trim()) throw new Error("Production tenant migration requires a clean Git working tree.");
  return { repositoryPath, artifactSha: head };
}

function writeAuditRecord(
  logFile: fs.FileHandle,
  record: Record<string, unknown>
) {
  return logFile.appendFile(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8")
    .then(() => logFile.sync());
}

const stepRunners: Record<CoordinatedProductionTenantMigrationStep, (authorization: ProductionTenantMigrationAuthorization, apply: boolean) => Promise<void>> = {
  "swiftline-root-ownership": runRootOwnership,
  "account-credit-tenant-ownership": runAccountCredit,
  "operational-tenant-ownership": runOperational,
  "shipment-tenant-ownership": runShipmentOwnership,
  "business-account-tenant-indexes": runBusinessAccountIndexes,
  "tenant-registry-indexes": runRegistryIndexes,
  "operator-support-indexes": runSupportIndexes
};

async function audit(
  logFile: fs.FileHandle,
  target: { expectedClusterHost: string; auditMongoUri: string },
  phase: "preflight" | "postflight"
) {
  const result = await runProductionTenantAudit({
    expectedClusterHost: target.expectedClusterHost,
    mongoUri: target.auditMongoUri
  });
  await writeAuditRecord(logFile, {
    event: "read-only-audit-completed",
    phase,
    findings: result.hasFindings,
    blockers: result.blockingFindings.length
  });
  return result;
}

export async function runProductionSwiftlineTenantMigration(args = process.argv.slice(2)) {
  if (tenantMigrationEnv.nodeEnvironment !== "production") throw new Error("This runner requires NODE_ENV=production.");
  if ([process.env.CI, process.env.GITHUB_ACTIONS].some(isEnvironmentFlagEnabled)) {
    throw new Error("Production tenant migrations cannot run from CI/CD.");
  }
  const options = parseArguments(args);
  if (!options.apply) throw new Error("This runner requires explicit --apply approval.");
  if (!tenantMigrationEnv.migrationMongoUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required.");
  if (!tenantMigrationEnv.auditMongoUri) throw new Error("TENANT_AUDIT_MONGODB_URI is required and must use a read-only database user.");
  if (!/^[a-f\d]{7,40}$/i.test(options.artifactSha)) throw new Error("--artifact-sha must be a 7 to 40 character Git SHA.");
  const auditCredentialUser = parseMongoSrvCredentialUser(tenantMigrationEnv.auditMongoUri);
  const migrationCredentialUser = parseMongoSrvCredentialUser(tenantMigrationEnv.migrationMongoUri);
  if (auditCredentialUser === migrationCredentialUser) {
    throw new Error("Read-only audit and migration URIs must use separate MongoDB users.");
  }

  const migrationTarget = parseMongoSrvTarget(tenantMigrationEnv.migrationMongoUri);
  const auditTarget = assertProductionTenantAuditTarget({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    expectedDatabase: options.expectedDatabase,
    expectedClusterHost: options.expectedClusterHost,
    mongoUri: tenantMigrationEnv.auditMongoUri,
    allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
    applyRequested: false
  });
  if (migrationTarget.database !== auditTarget.database || migrationTarget.clusterHost !== auditTarget.clusterHost) {
    throw new Error("Read-only audit and migration credentials must target the same approved production cluster and database.");
  }

  const authorization = createProductionTenantMigrationAuthorization({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
    expectedDatabase: options.expectedDatabase,
    expectedClusterHost: options.expectedClusterHost,
    mongoUri: tenantMigrationEnv.migrationMongoUri,
    allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
    apply: options.apply,
    confirmation: options.confirmation,
    changeId: options.changeId,
    backupReference: options.backupReference,
    runId: options.runId
  });

  const release = verifyReleaseCheckout(options.artifactSha);
  const logFile = await createAuditLog(options.logFile, release.repositoryPath);
  const logContext = {
    runId: options.runId,
    changeId: options.changeId,
    backupReference: options.backupReference,
    database: options.expectedDatabase,
    clusterHost: options.expectedClusterHost,
    artifactSha: release.artifactSha
  };

  try {
    await writeAuditRecord(logFile, { event: "migration-run-started", ...logContext, steps: productionTenantMigrationSteps });
    console.log("Running the read-only structural preflight against the approved production target.");
    const preflight = await audit(logFile, {
      expectedClusterHost: options.expectedClusterHost,
      auditMongoUri: tenantMigrationEnv.auditMongoUri!
    }, "preflight");
    if (preflight.blockingFindings.length) {
      await writeAuditRecord(logFile, { event: "migration-blocked", ...logContext, blockerCount: preflight.blockingFindings.length });
      throw new Error(`Read-only preflight found ${preflight.blockingFindings.length} structural blocker(s). Review the audit output; no migration step was run.`);
    }

    for (const step of productionTenantMigrationSteps) {
      console.log(`Preflighting ${step}.`);
      await writeAuditRecord(logFile, { event: "step-preflight-started", ...logContext, step });
      await stepRunners[step](authorization, false);
      await writeAuditRecord(logFile, { event: "step-preflight-passed", ...logContext, step });

      console.log(`Applying ${step}.`);
      await writeAuditRecord(logFile, { event: "step-apply-started", ...logContext, step });
      await stepRunners[step](authorization, true);
      await writeAuditRecord(logFile, { event: "step-apply-completed", ...logContext, step });
    }

    console.log("Running the post-migration read-only audit.");
    const postflight = await audit(logFile, {
      expectedClusterHost: options.expectedClusterHost,
      auditMongoUri: tenantMigrationEnv.auditMongoUri!
    }, "postflight");
    if (postflight.hasFindings) {
      await writeAuditRecord(logFile, { event: "migration-postflight-findings", ...logContext });
      throw new Error("Post-migration audit found remaining ownership, reference, duplicate-key, or index findings. Keep the release blocked and review the audit output.");
    }
    await writeAuditRecord(logFile, { event: "migration-run-completed", ...logContext });
    console.log("Migration sequence and post-migration audit completed cleanly.");
  } catch (error) {
    const errorCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    await writeAuditRecord(logFile, {
      event: "migration-run-failed",
      ...logContext,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode
    });
    throw error;
  } finally {
    await logFile.close();
  }
}

async function main() {
  try {
    await runProductionSwiftlineTenantMigration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production Swiftline tenant migration failed.");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) void main();
