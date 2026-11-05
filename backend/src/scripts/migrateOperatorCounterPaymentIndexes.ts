import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { OperatorCounterPayment } from "../models/operatorCounterPayment.model.js";
import {
  duplicateOperatorCounterPaymentSourcesPipeline,
  findConflictingOperatorCounterPaymentIndexes,
  findMissingOperatorCounterPaymentIndexes,
  invalidOperatorCounterPaymentFieldsPipeline,
  operatorCounterPaymentIndexPlans
} from "./operatorCounterPaymentIndexMigration.js";
import {
  assertExpectedDatabaseName,
  assertProductionTenantAuditTarget,
  assertTenantMigrationExecutionAllowed,
  createProductionTenantMigrationAuthorization,
  isEnvironmentFlagEnabled,
  isMainModule,
  parseMongoSrvCredentialUser,
  parseMongoSrvTarget,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";
import type { ExistingIndexShape } from "./tenantMigrationIndexHelpers.js";

type Arguments = {
  apply: boolean;
  expectedDatabase: string;
  expectedClusterHost?: string;
  changeId?: string;
  backupReference?: string;
  runId?: string;
  artifactSha?: string;
  confirmation?: string;
  logFile?: string;
};

type Preflight = {
  collectionExists: boolean;
  records: number;
  invalidKeys: number;
  duplicateSources: number;
  missingIndexes: string[];
  conflictingIndexes: string[];
};

const usage = "Usage: npm run audit:operator-counter-payment-indexes -- --database <database> [--apply]";
const productionOptions = ["--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"];

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
    if (!["--database", ...productionOptions].includes(argument)) {
      throw new Error(usage);
    }
    const value = args[index + 1] ?? "";
    if (!value.trim() || value.startsWith("--") || values.has(argument)) {
      throw new Error(`Pass ${argument} exactly once with a value.`);
    }
    values.set(argument, value.trim());
    index += 1;
  }
  const expectedDatabase = values.get("--database");
  if (!expectedDatabase) throw new Error(usage);
  return {
    apply,
    expectedDatabase,
    expectedClusterHost: values.get("--cluster-host"),
    changeId: values.get("--change-id"),
    backupReference: values.get("--backup-ref"),
    runId: values.get("--run-id"),
    artifactSha: values.get("--artifact-sha"),
    confirmation: values.get("--confirm"),
    logFile: values.get("--log-file")
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
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    changes = execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw new Error("Run the production index migration from a Git checkout so its release commit can be verified.");
  }
  if (!/^[a-f\d]{7,40}$/i.test(expectedArtifactSha) || !head.startsWith(expectedArtifactSha.toLowerCase())) {
    throw new Error("--artifact-sha does not match the checked-out Git commit.");
  }
  if (changes.trim()) throw new Error("Production index migration requires a clean Git working tree.");
  return { repositoryPath, artifactSha: head };
}

async function inspect(): Promise<Preflight> {
  const collection = OperatorCounterPayment.collection;
  const database = mongoose.connection.db;
  if (!database) throw new Error("No MongoDB database is connected.");
  const collectionExists = await database.listCollections(
    { name: collection.collectionName },
    { nameOnly: true }
  ).hasNext();
  if (!collectionExists) {
    return {
      collectionExists,
      records: 0,
      invalidKeys: 0,
      duplicateSources: 0,
      missingIndexes: operatorCounterPaymentIndexPlans.map((plan) => plan.options.name ?? Object.keys(plan.key).join("_")),
      conflictingIndexes: []
    };
  }

  const [records, invalidRows, duplicateRows, existingIndexes] = await Promise.all([
    collection.countDocuments({}),
    collection.aggregate(invalidOperatorCounterPaymentFieldsPipeline(), { maxTimeMS: 30_000 }).toArray(),
    collection.aggregate(duplicateOperatorCounterPaymentSourcesPipeline(), { maxTimeMS: 30_000 }).toArray(),
    collection.listIndexes().toArray() as Promise<ExistingIndexShape[]>
  ]);
  const missing = findMissingOperatorCounterPaymentIndexes(existingIndexes);
  const conflicting = findConflictingOperatorCounterPaymentIndexes(existingIndexes);
  return {
    collectionExists,
    records,
    invalidKeys: Number(invalidRows[0]?.count ?? 0),
    duplicateSources: Number(duplicateRows[0]?.count ?? 0),
    missingIndexes: missing.map((plan) => plan.options.name ?? Object.keys(plan.key).join("_")),
    conflictingIndexes: conflicting.map((plan) => plan.options.name ?? Object.keys(plan.key).join("_"))
  };
}

function printPreflight(result: Preflight, expectedDatabase: string) {
  console.log(`Operator counter-payment index audit for ${expectedDatabase}:`);
  console.log(`  collection exists: ${result.collectionExists}; records: ${result.records}`);
  console.log(`  malformed index keys: ${result.invalidKeys}; duplicate tenant sources: ${result.duplicateSources}`);
  console.log(`  missing indexes: ${result.missingIndexes.length ? result.missingIndexes.join(", ") : "none"}`);
  console.log(`  conflicting indexes: ${result.conflictingIndexes.length ? result.conflictingIndexes.join(", ") : "none"}`);
}

function assertSafeToApply(result: Preflight) {
  if (result.invalidKeys || result.duplicateSources || result.conflictingIndexes.length) {
    throw new Error("Preflight found malformed or duplicate operator payment keys, or conflicting indexes. No index was changed.");
  }
}

function writeAuditRecord(logFile: fs.FileHandle, record: Record<string, unknown>) {
  return logFile.appendFile(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8")
    .then(() => logFile.sync());
}

async function executeIndexCreation() {
  const current = await inspect();
  assertSafeToApply(current);
  const missingPlans = findMissingOperatorCounterPaymentIndexes(
    await OperatorCounterPayment.collection.listIndexes().toArray().catch(() => []) as ExistingIndexShape[]
  );
  for (const plan of missingPlans) {
    await OperatorCounterPayment.collection.createIndex(plan.key, {
      name: plan.options.name,
      unique: plan.options.unique === true,
      ...(plan.options.partialFilterExpression ? { partialFilterExpression: plan.options.partialFilterExpression } : {})
    });
  }
  const final = await inspect();
  if (final.missingIndexes.length || final.conflictingIndexes.length) {
    throw new Error("Index verification did not match the expected operator counter-payment indexes.");
  }
  return { before: current, after: final };
}

export async function migrateOperatorCounterPaymentIndexes(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const production = tenantMigrationEnv.nodeEnvironment === "production";
  let mongoUri = tenantMigrationEnv.applicationMongoUri;
  let authorization: ProductionTenantMigrationAuthorization | undefined;
  let release: { repositoryPath: string; artifactSha: string } | undefined;
  let auditLog: fs.FileHandle | undefined;

  if (production) {
    if ([process.env.CI, process.env.GITHUB_ACTIONS].some(isEnvironmentFlagEnabled)) {
      throw new Error("Production index migrations cannot run from CI/CD.");
    }
    if (!options.expectedClusterHost) throw new Error("Production index audit requires --cluster-host.");
    if (!tenantMigrationEnv.auditMongoUri) {
      throw new Error("TENANT_AUDIT_MONGODB_URI is required and must use a read-only database user.");
    }
    const auditTarget = assertProductionTenantAuditTarget({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      expectedDatabase: options.expectedDatabase,
      expectedClusterHost: options.expectedClusterHost,
      mongoUri: tenantMigrationEnv.auditMongoUri,
      allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
      applyRequested: false
    });
    const auditCredential = parseMongoSrvCredentialUser(tenantMigrationEnv.auditMongoUri);
    if (options.apply) {
      if (!tenantMigrationEnv.migrationMongoUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required for --apply.");
      if (auditCredential === parseMongoSrvCredentialUser(tenantMigrationEnv.migrationMongoUri)) {
        throw new Error("Read-only audit and migration URIs must use separate MongoDB users.");
      }
      const migrationTarget = parseMongoSrvTarget(tenantMigrationEnv.migrationMongoUri);
      if (migrationTarget.database !== auditTarget.database || migrationTarget.clusterHost !== auditTarget.clusterHost) {
        throw new Error("Read-only audit and migration credentials must target the same approved production cluster and database.");
      }
      const missing = productionOptions.filter((option) => {
        const value = option === "--cluster-host" ? options.expectedClusterHost
          : option === "--change-id" ? options.changeId
          : option === "--backup-ref" ? options.backupReference
          : option === "--run-id" ? options.runId
          : option === "--artifact-sha" ? options.artifactSha
          : option === "--confirm" ? options.confirmation
          : options.logFile;
        return !value;
      });
      if (missing.length) throw new Error(`Production --apply requires: ${missing.join(", ")}.`);
      if (!options.changeId || !options.backupReference || !options.runId || !options.artifactSha || !options.logFile) {
        throw new Error("Production --apply requires change, backup, run, artifact, and external log details.");
      }
      authorization = createProductionTenantMigrationAuthorization({
        nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
        ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
        expectedDatabase: options.expectedDatabase,
        expectedClusterHost: options.expectedClusterHost,
        mongoUri: tenantMigrationEnv.migrationMongoUri,
        allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
        apply: true,
        confirmation: options.confirmation ?? "",
        changeId: options.changeId,
        backupReference: options.backupReference,
        runId: options.runId
      });
      release = verifyReleaseCheckout(options.artifactSha);
      auditLog = await createAuditLog(options.logFile, release.repositoryPath);
    }
    mongoUri = tenantMigrationEnv.auditMongoUri;
  } else if (!mongoUri) {
    throw new Error("MONGODB_URI is required for a non-production index audit.");
  }

  if (!mongoUri) throw new Error("A MongoDB URI is required for this index audit.");
  let target: { expectedClusterHost: string } | null = null;
  if (production) {
    target = { expectedClusterHost: options.expectedClusterHost! };
  }

  try {
    await mongoose.connect(mongoUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
    assertExpectedDatabaseName(options.expectedDatabase, mongoose.connection.db?.databaseName);
    const preflight = await inspect();
    printPreflight(preflight, options.expectedDatabase);
    if (!options.apply) {
      if (preflight.invalidKeys || preflight.duplicateSources || preflight.conflictingIndexes.length) {
        throw new Error("Read-only audit found blockers. No indexes were changed.");
      }
      console.log("Read-only audit completed. No records were modified.");
      return;
    }
    assertTenantMigrationExecutionAllowed({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      step: "operator-counter-payment-indexes",
      expectedDatabase: options.expectedDatabase,
      mongoUri: production ? tenantMigrationEnv.migrationMongoUri! : mongoUri,
      authorization
    });
    if (production) {
      await mongoose.disconnect();
      const migrationUri = tenantMigrationEnv.migrationMongoUri!;
      await mongoose.connect(migrationUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
      assertExpectedDatabaseName(options.expectedDatabase, mongoose.connection.db?.databaseName);
    }
    const beforeApply = await inspect();
    assertSafeToApply(beforeApply);
    if (auditLog) {
      await writeAuditRecord(auditLog, {
        event: "operator-counter-payment-index-preflight-passed",
        changeId: options.changeId,
        backupReference: options.backupReference,
        runId: options.runId,
        database: options.expectedDatabase,
        clusterHost: target?.expectedClusterHost,
        artifactSha: release?.artifactSha,
        records: beforeApply.records,
        indexesToCreate: beforeApply.missingIndexes
      });
    }
    const after = await executeIndexCreation();
    printPreflight(after.after, options.expectedDatabase);
    if (auditLog) {
      await writeAuditRecord(auditLog, {
        event: "operator-counter-payment-indexes-created",
        changeId: options.changeId,
        backupReference: options.backupReference,
        runId: options.runId,
        database: options.expectedDatabase,
        clusterHost: target?.expectedClusterHost,
        artifactSha: release?.artifactSha,
        recordsPreserved: after.after.records,
        indexesCreated: after.before.missingIndexes.length
      });
    }
    console.log("Operator counter-payment indexes are present. No records were modified.");
  } catch (error) {
    if (auditLog) {
      await writeAuditRecord(auditLog, {
        event: "operator-counter-payment-index-migration-failed",
        changeId: options.changeId,
        runId: options.runId,
        database: options.expectedDatabase,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    }
    throw error;
  } finally {
    await mongoose.disconnect().catch(() => undefined);
    await auditLog?.close();
  }
}

async function main() {
  try {
    await migrateOperatorCounterPaymentIndexes();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operator counter-payment index migration failed.");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) void main();
