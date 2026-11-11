import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import {
  assertExpectedDatabaseName, assertProductionTenantAuditTarget, assertTenantMigrationExecutionAllowed,
  createProductionTenantMigrationAuthorization, isEnvironmentFlagEnabled, isMainModule,
  parseMongoSrvCredentialUser, parseMongoSrvTarget
} from "./migrationSafety.js";
import { FeatureAnnouncement, FeatureAnnouncementView } from "../models/featureAnnouncement.model.js";

const usage = "Usage: npm run audit:feature-announcement-indexes -- --database <name> [--apply] [--cluster-host <host> --change-id <id> --backup-ref <ref> --run-id <id> --artifact-sha <sha> --confirm <phrase> --log-file <absolute-path>]";
const productionFlags = ["--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"] as const;
const models = [FeatureAnnouncement, FeatureAnnouncementView];

function parseArguments(args: string[]) {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--apply") { if (apply) throw new Error(usage); apply = true; continue; }
    if (!["--database", ...productionFlags].includes(flag)) throw new Error(usage);
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(usage);
    values.set(flag, value);
  }
  const database = values.get("--database");
  if (!database) throw new Error(usage);
  return { apply, database, values };
}

function verifyRelease(sha: string) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (!/^[a-f\d]{7,40}$/i.test(sha) || !head.toLowerCase().startsWith(sha.toLowerCase()) || status.trim()) {
    throw new Error("Production apply requires the matching release commit in a clean Git checkout.");
  }
  return root;
}

async function auditIndexes() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database connection.");
  const findings: string[] = [];
  let missingCount = 0;
  for (const model of models) {
    const exists = await db.listCollections({ name: model.collection.collectionName }, { nameOnly: true }).hasNext();
    const existing = exists ? await model.collection.listIndexes().toArray() : [];
    const expected: Array<[Record<string, unknown>, { name?: string; unique?: boolean }]> = model.schema.indexes();
    const missing = expected.filter(([, options]) => !existing.some((index) => index.name === options.name));
    missingCount += missing.length;
    for (const [keys, options] of expected) {
      const match = existing.find((index) => index.name === options.name);
      if (match && (JSON.stringify(match.key) !== JSON.stringify(keys) || Boolean(match.unique) !== Boolean(options.unique))) {
        findings.push(`${model.collection.name}: index ${options.name} has different keys or uniqueness`);
      }
      const sameKeys = existing.find((index) => JSON.stringify(index.key) === JSON.stringify(keys));
      if (sameKeys && sameKeys.name !== options.name) findings.push(`${model.collection.name}: expected index keys already use another name`);
    }
    if (exists && await model.collection.countDocuments({ tenantId: { $exists: false } })) {
      findings.push(`${model.collection.name}: records without tenant ownership exist`);
    }
    console.log(`${model.collection.name}: ${exists ? "exists" : "new collection"}; missing: ${missing.map(([, options]) => options.name).join(", ") || "none"}`);
  }
  const receipts = FeatureAnnouncementView.collection;
  const receiptExists = await db.listCollections({ name: receipts.collectionName }, { nameOnly: true }).hasNext();
  if (receiptExists) {
    const duplicates = await receipts.aggregate([
      { $group: { _id: { tenantId: "$tenantId", userId: "$userId", announcementId: "$announcementId" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 }
    ], { maxTimeMS: 30_000 }).toArray();
    if (duplicates.length) findings.push("Duplicate per-user announcement receipts exist.");
  }
  return { findings, missingCount };
}

export async function migrateFeatureAnnouncementIndexes(args = process.argv.slice(2)) {
  const { apply, database, values } = parseArguments(args);
  const production = tenantMigrationEnv.nodeEnvironment === "production";
  let auditUri = tenantMigrationEnv.applicationMongoUri;
  let migrationUri = auditUri;
  let log: fs.FileHandle | undefined;
  let authorization: ReturnType<typeof createProductionTenantMigrationAuthorization> | undefined;
  try {
    if (production) {
      if ([process.env.CI, process.env.GITHUB_ACTIONS].some(isEnvironmentFlagEnabled)) throw new Error("Production index migrations cannot run from CI/CD.");
      const host = values.get("--cluster-host");
      auditUri = tenantMigrationEnv.auditMongoUri ?? "";
      if (!host || !auditUri) throw new Error("Production audit requires --cluster-host and TENANT_AUDIT_MONGODB_URI.");
      assertProductionTenantAuditTarget({ nodeEnvironment: tenantMigrationEnv.nodeEnvironment, expectedDatabase: database, expectedClusterHost: host, mongoUri: auditUri, allowedClusterHost: tenantMigrationEnv.allowedClusterHost, applyRequested: false });
      if (apply) {
        const missing = productionFlags.filter((flag) => !values.get(flag));
        if (missing.length) throw new Error(`Production apply requires ${missing.join(", ")}.`);
        migrationUri = tenantMigrationEnv.migrationMongoUri ?? "";
        if (!migrationUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required.");
        if (parseMongoSrvCredentialUser(auditUri) === parseMongoSrvCredentialUser(migrationUri)) throw new Error("Audit and migration must use separate MongoDB users.");
        const target = parseMongoSrvTarget(migrationUri);
        if (target.database !== database || target.clusterHost !== host.toLowerCase()) throw new Error("Migration URI does not match the approved audit target.");
        authorization = createProductionTenantMigrationAuthorization({
          nodeEnvironment: tenantMigrationEnv.nodeEnvironment, ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
          expectedDatabase: database, expectedClusterHost: host, mongoUri: migrationUri,
          allowedClusterHost: tenantMigrationEnv.allowedClusterHost, apply: true,
          confirmation: values.get("--confirm")!, changeId: values.get("--change-id")!,
          backupReference: values.get("--backup-ref")!, runId: values.get("--run-id")!
        });
        const root = verifyRelease(values.get("--artifact-sha")!);
        const logPath = path.resolve(values.get("--log-file")!);
        if (!path.isAbsolute(values.get("--log-file")!) || !path.relative(root, logPath).startsWith("..")) throw new Error("Use an absolute log path outside the release checkout.");
        log = await fs.open(logPath, "wx", 0o600);
      }
    } else if (!auditUri) throw new Error("MONGODB_URI is required.");
    await mongoose.connect(auditUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
    assertExpectedDatabaseName(database, mongoose.connection.db?.databaseName);
    const audit = await auditIndexes();
    if (audit.findings.length) throw new Error(`Index audit blocked apply: ${audit.findings.join("; ")}`);
    if (!apply) { console.log("Read-only audit complete. No indexes changed."); return; }
    assertTenantMigrationExecutionAllowed({ nodeEnvironment: tenantMigrationEnv.nodeEnvironment, step: "feature-announcement-indexes", expectedDatabase: database, mongoUri: migrationUri, authorization });
    if (production) {
      await mongoose.disconnect();
      await mongoose.connect(migrationUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
      assertExpectedDatabaseName(database, mongoose.connection.db?.databaseName);
      const preflight = await auditIndexes();
      if (preflight.findings.length) throw new Error(`Preflight blocked apply: ${preflight.findings.join("; ")}`);
    }
    if (log) { await log.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "preflight-passed", changeId: values.get("--change-id"), runId: values.get("--run-id") })}\n`); await log.sync(); }
    for (const model of models) await model.createIndexes();
    const final = await auditIndexes();
    if (final.findings.length || final.missingCount) throw new Error(`Index verification failed: ${final.findings.join("; ") || `${final.missingCount} index(es) missing`}`);
    if (log) { await log.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "indexes-created", changeId: values.get("--change-id"), runId: values.get("--run-id") })}\n`); await log.sync(); }
    console.log("Feature announcement indexes are ready.");
  } finally {
    await mongoose.disconnect();
    await log?.close();
  }
}

if (isMainModule(import.meta.url)) migrateFeatureAnnouncementIndexes().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Feature announcement index migration failed.");
  process.exitCode = 1;
});
