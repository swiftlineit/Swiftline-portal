import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
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
import {
  cashReceiptActiveIndexPlans,
  duplicateActiveShipmentCashReceiptsPipeline,
  findCashReceiptActiveIndexNameCollisions,
  findConflictingCashReceiptActiveIndexes,
  findMissingCashReceiptActiveIndexes
} from "./cashReceiptActiveIndexMigration.js";
import type { ExistingIndexShape } from "./tenantMigrationIndexHelpers.js";

const migrationStep = "cash-receipt-active-indexes" as const;
const productionFlags = ["--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"] as const;
const usage = "Usage: npm run audit:cash-receipt-active-indexes -- --database <name> [--apply]";

type Options = {
  apply: boolean;
  database: string;
  values: Map<string, string>;
};

function parseArguments(args: string[]): Options {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--apply") {
      if (apply) throw new Error(usage);
      apply = true;
      continue;
    }
    if (!["--database", ...productionFlags].includes(flag)) throw new Error(usage);
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(usage);
    values.set(flag, value.trim());
    index += 1;
  }
  const database = values.get("--database");
  if (!database) throw new Error(usage);
  return { apply, database, values };
}

function insideDirectory(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function verifyRelease(expectedSha: string) {
  const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const changes = execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" });
  if (!/^[a-f\d]{7,40}$/i.test(expectedSha) || !head.toLowerCase().startsWith(expectedSha.toLowerCase()) || changes.trim()) {
    throw new Error("Production apply requires the matching release commit in a clean Git checkout.");
  }
  return repository;
}

async function inspect() {
  const database = mongoose.connection.db;
  if (!database) throw new Error("No MongoDB database is connected.");
  const exists = await database.listCollections({ name: "cashreceipts" }, { nameOnly: true }).hasNext();
  if (!exists) {
    return { collectionExists: false, records: 0, duplicateShipments: 0, indexes: [] as ExistingIndexShape[], missing: cashReceiptActiveIndexPlans, conflicts: [], nameCollisions: [] };
  }
  const collection = database.collection("cashreceipts");
  const [records, duplicates, indexes] = await Promise.all([
    collection.countDocuments({}, { maxTimeMS: 30_000 }),
    collection.aggregate(duplicateActiveShipmentCashReceiptsPipeline(), { maxTimeMS: 30_000 }).toArray(),
    collection.listIndexes().toArray() as Promise<ExistingIndexShape[]>
  ]);
  return {
    collectionExists: true,
    records,
    duplicateShipments: duplicates.length,
    indexes,
    missing: findMissingCashReceiptActiveIndexes(indexes),
    conflicts: findConflictingCashReceiptActiveIndexes(indexes),
    nameCollisions: findCashReceiptActiveIndexNameCollisions(indexes)
  };
}

function report(result: Awaited<ReturnType<typeof inspect>>, database: string) {
  console.log(`Cash receipt active-index audit for ${database}:`);
  console.log(`  collection exists: ${result.collectionExists}; receipt rows: ${result.records}`);
  console.log(`  duplicate active shipment receipts: ${result.duplicateShipments}`);
  console.log(`  missing indexes: ${result.missing.map(({ options }) => options.name).join(", ") || "none"}`);
  console.log(`  conflicting indexes: ${result.conflicts.map(({ index }) => index.name ?? "unnamed").join(", ") || "none"}`);
}

function assertSafeToApply(result: Awaited<ReturnType<typeof inspect>>) {
  if (result.duplicateShipments > 0 || result.nameCollisions.length > 0) {
    throw new Error("Preflight found duplicate active shipment receipts or an unexpected index name collision. No index was changed.");
  }
  const unknownConflicts = result.conflicts.filter(({ plan, index }) => index.name !== plan.options.name);
  if (unknownConflicts.length > 0) {
    throw new Error("Preflight found a conflicting index under an unrecognized name. No index was changed.");
  }
}

async function applyIndexes() {
  const before = await inspect();
  assertSafeToApply(before);
  if (!before.collectionExists) return { before, after: before, dropped: [] as string[] };

  const collection = mongoose.connection.db!.collection("cashreceipts");
  const dropped = [...new Set(before.conflicts.map(({ index }) => index.name).filter((name): name is string => Boolean(name)))];
  for (const name of dropped) await collection.dropIndex(name);

  const currentIndexes = await collection.listIndexes().toArray() as ExistingIndexShape[];
  const missing = findMissingCashReceiptActiveIndexes(currentIndexes);
  for (const plan of missing) {
    await collection.createIndex(plan.key, {
      name: plan.options.name,
      unique: plan.options.unique === true,
      ...(plan.options.partialFilterExpression ? { partialFilterExpression: plan.options.partialFilterExpression } : {})
    });
  }
  const after = await inspect();
  if (after.missing.length || after.conflicts.length || after.nameCollisions.length || after.duplicateShipments > 0) {
    throw new Error("Post-migration verification failed. Rerun the read-only audit before retrying.");
  }
  return { before, after, dropped };
}

async function openAuditLog(filePath: string, repository: string) {
  if (!path.isAbsolute(filePath)) throw new Error("--log-file must be an absolute path outside the repository.");
  const absolutePath = path.resolve(filePath);
  if (insideDirectory(repository, absolutePath)) throw new Error("Production migration logs must be outside the release checkout.");
  return fs.open(absolutePath, "wx", 0o600);
}

export async function migrateCashReceiptActiveIndexes(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const production = tenantMigrationEnv.nodeEnvironment === "production";
  let auditUri = tenantMigrationEnv.applicationMongoUri;
  let migrationUri = auditUri;
  let authorization: ProductionTenantMigrationAuthorization | undefined;
  let auditLog: fs.FileHandle | undefined;
  let release: { repository: string; sha: string } | undefined;
  try {
    if (production) {
      if ([process.env.CI, process.env.GITHUB_ACTIONS].some(isEnvironmentFlagEnabled)) throw new Error("Production index migrations cannot run from CI/CD.");
      const host = options.values.get("--cluster-host");
      auditUri = tenantMigrationEnv.auditMongoUri ?? "";
      if (!host || !auditUri) throw new Error("Production audit requires --cluster-host and TENANT_AUDIT_MONGODB_URI.");
      const auditTarget = assertProductionTenantAuditTarget({
        nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
        expectedDatabase: options.database,
        expectedClusterHost: host,
        mongoUri: auditUri,
        allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
        applyRequested: false
      });
      if (options.apply) {
        const missing = productionFlags.filter((flag) => !options.values.get(flag));
        if (missing.length) throw new Error(`Production apply requires ${missing.join(", ")}.`);
        migrationUri = tenantMigrationEnv.migrationMongoUri ?? "";
        if (!migrationUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required.");
        if (parseMongoSrvCredentialUser(auditUri) === parseMongoSrvCredentialUser(migrationUri)) throw new Error("Audit and migration must use separate MongoDB users.");
        const migrationTarget = parseMongoSrvTarget(migrationUri);
        if (migrationTarget.database !== auditTarget.database || migrationTarget.clusterHost !== auditTarget.clusterHost) throw new Error("Migration credentials do not match the audited database and cluster.");
        authorization = createProductionTenantMigrationAuthorization({
          nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
          ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
          expectedDatabase: options.database,
          expectedClusterHost: host,
          mongoUri: migrationUri,
          allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
          apply: true,
          confirmation: options.values.get("--confirm")!,
          changeId: options.values.get("--change-id")!,
          backupReference: options.values.get("--backup-ref")!,
          runId: options.values.get("--run-id")!
        });
        release = { repository: verifyRelease(options.values.get("--artifact-sha")!), sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
        auditLog = await openAuditLog(options.values.get("--log-file")!, release.repository);
      }
    } else if (!auditUri) {
      throw new Error("MONGODB_URI is required.");
    }

    if (!auditUri) throw new Error("A MongoDB URI is required.");
    await mongoose.connect(auditUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
    assertExpectedDatabaseName(options.database, mongoose.connection.db?.databaseName);
    const preflight = await inspect();
    report(preflight, options.database);
    assertSafeToApply(preflight);
    if (!options.apply) {
      console.log("Read-only audit complete. No records or indexes were changed.");
      return;
    }
    assertTenantMigrationExecutionAllowed({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      step: migrationStep,
      expectedDatabase: options.database,
      mongoUri: migrationUri,
      authorization
    });
    if (production) {
      await mongoose.disconnect();
      await mongoose.connect(migrationUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
      assertExpectedDatabaseName(options.database, mongoose.connection.db?.databaseName);
      const migrationPreflight = await inspect();
      report(migrationPreflight, options.database);
      assertSafeToApply(migrationPreflight);
    }
    if (auditLog) {
      await auditLog.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "cash-receipt-index-preflight-passed", database: options.database, changeId: options.values.get("--change-id"), runId: options.values.get("--run-id"), artifactSha: release?.sha, indexesToReplace: preflight.conflicts.map(({ index }) => index.name), indexesToCreate: preflight.missing.map(({ options: index }) => index.name) })}\n`);
      await auditLog.sync();
    }
    const result = await applyIndexes();
    report(result.after, options.database);
    if (auditLog) {
      await auditLog.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "cash-receipt-indexes-applied", database: options.database, changeId: options.values.get("--change-id"), runId: options.values.get("--run-id"), artifactSha: release?.sha, recordsPreserved: result.after.records, indexesReplaced: result.dropped })}\n`);
      await auditLog.sync();
    }
    console.log("Cash receipt active-shipment indexes are ready. Receipt rows were preserved.");
  } finally {
    await mongoose.disconnect().catch(() => undefined);
    await auditLog?.close();
  }
}

if (isMainModule(import.meta.url)) migrateCashReceiptActiveIndexes().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Cash receipt index migration failed.");
  process.exitCode = 1;
});
