import { MongoClient } from "mongodb";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { applyPrepaidRelease, inspectPrepaidRelease } from "./prepaidReleaseMigration.js";
import {
  assertExpectedDatabaseName, assertProductionTenantAuditTarget,
  assertTenantMigrationExecutionAllowed, createProductionTenantMigrationAuthorization,
  isMainModule, parseMongoSrvCredentialUser, parseMongoSrvTarget
} from "./migrationSafety.js";

export async function runPrepaidRelease(args = process.argv.slice(2)) {
  const values = new Map<string, string>();
  let apply = false;
  let writersPaused = false;
  let zeroOpeningBalances = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--apply" && !apply) { apply = true; continue; }
    if (flag === "--writers-paused" && !writersPaused) { writersPaused = true; continue; }
    if (flag === "--zero-opening-balances" && !zeroOpeningBalances) { zeroOpeningBalances = true; continue; }
    if (!["--database", "--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"].includes(flag)) {
      throw new Error(`Unknown release migration option: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`Pass ${flag} exactly once with a value.`);
    values.set(flag, value.trim());
  }
  const database = values.get("--database");
  if (!database) throw new Error("Pass --database <expected-database-name>.");
  const production = tenantMigrationEnv.nodeEnvironment === "production";
  const auditUri = production ? tenantMigrationEnv.auditMongoUri : tenantMigrationEnv.applicationMongoUri;
  if (!auditUri) throw new Error(production ? "TENANT_AUDIT_MONGODB_URI is required." : "MONGODB_URI is required.");
  const host = values.get("--cluster-host") ?? "";
  let authorization;
  let writeUri = auditUri;
  let auditLog: fs.FileHandle | undefined;
  let client: MongoClient | undefined;
  if (apply && !writersPaused) throw new Error("Pause all booking, payment, webhook and scheduled writers, then pass --writers-paused.");
  if (production) {
    const auditedTarget = assertProductionTenantAuditTarget({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment, expectedDatabase: database,
      expectedClusterHost: host, mongoUri: auditUri,
      allowedClusterHost: tenantMigrationEnv.allowedClusterHost, applyRequested: false
    });
    if (apply) {
      writeUri = tenantMigrationEnv.migrationMongoUri ?? "";
      if (!writeUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required.");
      if (parseMongoSrvCredentialUser(auditUri) === parseMongoSrvCredentialUser(writeUri)) throw new Error("Use separate audit and migration database users.");
      const writeTarget = parseMongoSrvTarget(writeUri);
      if (writeTarget.database !== auditedTarget.database || writeTarget.clusterHost !== auditedTarget.clusterHost) throw new Error("Write and audit targets differ.");
      authorization = createProductionTenantMigrationAuthorization({
        nodeEnvironment: tenantMigrationEnv.nodeEnvironment, ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
        expectedDatabase: database, expectedClusterHost: host, mongoUri: writeUri,
        allowedClusterHost: tenantMigrationEnv.allowedClusterHost, apply,
        confirmation: values.get("--confirm") ?? "", changeId: values.get("--change-id") ?? "",
        backupReference: values.get("--backup-ref") ?? "", runId: values.get("--run-id") ?? ""
      });
      const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const expected = values.get("--artifact-sha") ?? "";
      if (!/^[a-f\d]{7,40}$/i.test(expected) || !sha.startsWith(expected.toLowerCase())) throw new Error("Release SHA does not match --artifact-sha.");
      if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Release checkout must be clean.");
      const log = values.get("--log-file") ?? "";
      const relative = path.relative(repository, path.resolve(log));
      if (!path.isAbsolute(log) || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error("Use an absolute audit log path outside the repository.");
      auditLog = await fs.open(log, "wx", 0o600);
      await auditLog.appendFile(`${JSON.stringify({ event: "prepaid-release-started", sha, database, host, zeroOpeningBalances, at: new Date().toISOString(), changeId: values.get("--change-id"), backup: values.get("--backup-ref"), runId: values.get("--run-id") })}\n`);
      await auditLog.sync();
    }
  }
  try {
    client = new MongoClient(auditUri, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 2 });
    await client.connect();
    assertExpectedDatabaseName(database, client.db(database).databaseName);
    const before = await inspectPrepaidRelease(client.db(database), { zeroOpeningBalances });
    console.log(JSON.stringify({ mode: "READ_ONLY_PREFLIGHT", database, ...before }, null, 2));
    if (before.blockers.length) throw new Error("Prepaid release is blocked. Resolve the listed findings before applying.");
    if (!apply) return before;
    assertTenantMigrationExecutionAllowed({ nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      step: "prepaid-release-indexes", expectedDatabase: database, mongoUri: writeUri, authorization });
    await client.close();
    client = new MongoClient(writeUri, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 2 });
    await client.connect();
    // applyPrepaidRelease runs the complete preflight again using the writer.
    const after = await applyPrepaidRelease(client.db(database), { zeroOpeningBalances });
    console.log(JSON.stringify({ mode: "APPLIED_AND_VERIFIED", database, ...after }, null, 2));
    if (auditLog) {
      await auditLog.appendFile(`${JSON.stringify({ event: "prepaid-release-completed", at: new Date().toISOString(), records: after.records, zeroOpeningBefore: before.zeroOpening, zeroOpeningAfter: after.zeroOpening, ownershipAssigned: before.ownership, indexesCreated: before.missingIndexes.map((plan) => `${plan.collection}.${plan.options.name}`) })}\n`);
      await auditLog.sync();
    }
    return after;
  } catch (error) {
    if (auditLog) {
      await auditLog.appendFile(`${JSON.stringify({ event: "prepaid-release-failed", at: new Date().toISOString(), errorType: error instanceof Error ? error.name : "UnknownError" })}\n`);
      await auditLog.sync();
    }
    throw error;
  } finally {
    await client?.close();
    await auditLog?.close();
  }
}

if (isMainModule(import.meta.url)) {
  runPrepaidRelease().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Prepaid release audit failed.");
    process.exitCode = 1;
  });
}
