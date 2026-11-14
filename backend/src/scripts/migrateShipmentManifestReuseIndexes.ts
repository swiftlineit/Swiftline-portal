import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mongoose from "mongoose";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import {
  assertExpectedDatabaseName,
  assertProductionTenantAuditTarget,
  assertTenantMigrationExecutionAllowed,
  createProductionTenantMigrationAuthorization,
  isEnvironmentFlagEnabled,
  isMainModule,
  parseMongoSrvCredentialUser,
  parseMongoSrvTarget
} from "./migrationSafety.js";

const clientIndexName = "tenant_client_manifest_shipment_draft_unique";
const clientIndexKeys = { tenantId: 1, shipmentDraftIds: 1 } as const;
const clientIndexFilter = { actorRole: "client" } as const;
const legacyUniqueIndexes = [
  { name: "tenant_manifest_shipment_draft_actor_type_unique", key: { tenantId: 1, shipmentDraftIds: 1, actorRole: 1, manifestType: 1 } },
  { name: "shipmentDraftIds_1_actorRole_1", key: { shipmentDraftIds: 1, actorRole: 1 } },
  { name: "shipmentDraftIds_1", key: { shipmentDraftIds: 1 } }
] as const;
const productionFlags = ["--cluster-host", "--change-id", "--backup-ref", "--run-id", "--artifact-sha", "--confirm", "--log-file"] as const;
const usage = "Usage: npm run audit:shipment-manifest-reuse-indexes -- --database <name> [--cluster-host <host>] or npm run migrate:shipment-manifest-reuse-indexes -- --database <name> [production approval flags]";

function parseArguments(args: string[]) {
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

function sameKeys(actual: Record<string, unknown>, expected: Record<string, number>) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function classifyShipmentManifestIndexes(indexes: Array<{
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}>) {
  const findings: string[] = [];
  const legacy: string[] = [];
  let clientIndexReady = false;

  for (const index of indexes) {
    if (index.name === clientIndexName) {
      clientIndexReady = sameKeys(index.key, clientIndexKeys)
        && index.unique === true
        && JSON.stringify(index.partialFilterExpression) === JSON.stringify(clientIndexFilter);
      if (!clientIndexReady) findings.push(`${clientIndexName} has unexpected options.`);
      continue;
    }
    const knownLegacy = legacyUniqueIndexes.find((item) => item.name === index.name);
    if (knownLegacy) {
      if (!sameKeys(index.key, knownLegacy.key)) {
        findings.push(`${index.name} has unexpected options; inspect it before removal.`);
      } else if (index.unique === true) {
        legacy.push(index.name!);
      }
    } else if (index.unique && Object.hasOwn(index.key, "shipmentDraftIds")) {
      findings.push(`${index.name} is an unrecognized unique shipment membership index.`);
    }
  }
  return { findings, legacy, clientIndexReady };
}

async function auditIndexes() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database connection.");
  const exists = await db.listCollections({ name: ShipmentManifest.collection.collectionName }, { nameOnly: true }).hasNext();
  const indexes = exists ? await ShipmentManifest.collection.listIndexes().toArray() : [];
  const result = classifyShipmentManifestIndexes(indexes);

  if (exists) {
    const duplicates = await ShipmentManifest.collection.aggregate([
      { $match: { actorRole: "client" } },
      { $unwind: "$shipmentDraftIds" },
      { $group: { _id: { tenantId: "$tenantId", shipmentDraftId: "$shipmentDraftIds" }, manifestIds: { $addToSet: "$_id" } } },
      { $project: { count: { $size: "$manifestIds" } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 }
    ], { maxTimeMS: 30_000 }).toArray();
    if (duplicates.length) result.findings.push("A shipment belongs to multiple client manifests; resolve this before creating the client-only unique index.");
  }

  return result;
}

export async function migrateShipmentManifestReuseIndexes(args = process.argv.slice(2)) {
  const { apply, database, values } = parseArguments(args);
  const production = tenantMigrationEnv.nodeEnvironment === "production";
  let auditUri = tenantMigrationEnv.applicationMongoUri;
  let migrationUri = auditUri;
  let log: fs.FileHandle | undefined;
  let authorization: ReturnType<typeof createProductionTenantMigrationAuthorization> | undefined;

  try {
    if (production) {
      if ([process.env.CI, process.env.GITHUB_ACTIONS].some(isEnvironmentFlagEnabled)) {
        throw new Error("Production index migrations cannot run from CI/CD.");
      }
      const host = values.get("--cluster-host");
      auditUri = tenantMigrationEnv.auditMongoUri ?? "";
      if (!host || !auditUri) throw new Error("Production audit requires --cluster-host and TENANT_AUDIT_MONGODB_URI.");
      assertProductionTenantAuditTarget({
        nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
        expectedDatabase: database,
        expectedClusterHost: host,
        mongoUri: auditUri,
        allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
        applyRequested: false
      });
      if (apply) {
        const missing = productionFlags.filter((flag) => !values.get(flag));
        if (missing.length) throw new Error(`Production apply requires ${missing.join(", ")}.`);
        migrationUri = tenantMigrationEnv.migrationMongoUri ?? "";
        if (!migrationUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required.");
        if (parseMongoSrvCredentialUser(auditUri) === parseMongoSrvCredentialUser(migrationUri)) {
          throw new Error("Audit and migration must use separate MongoDB users.");
        }
        const target = parseMongoSrvTarget(migrationUri);
        if (target.database !== database || target.clusterHost !== host.toLowerCase()) {
          throw new Error("Migration URI does not match the audited target.");
        }
        authorization = createProductionTenantMigrationAuthorization({
          nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
          ci: process.env.CI ?? process.env.GITHUB_ACTIONS,
          expectedDatabase: database,
          expectedClusterHost: host,
          mongoUri: migrationUri,
          allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
          apply: true,
          confirmation: values.get("--confirm")!,
          changeId: values.get("--change-id")!,
          backupReference: values.get("--backup-ref")!,
          runId: values.get("--run-id")!
        });
        const root = verifyRelease(values.get("--artifact-sha")!);
        const logPath = path.resolve(values.get("--log-file")!);
        if (!path.isAbsolute(values.get("--log-file")!) || !path.relative(root, logPath).startsWith("..")) {
          throw new Error("Use an absolute log path outside the release checkout.");
        }
        log = await fs.open(logPath, "wx", 0o600);
      }
    } else if (!auditUri) {
      throw new Error("MONGODB_URI is required.");
    }

    await mongoose.connect(auditUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
    assertExpectedDatabaseName(database, mongoose.connection.db?.databaseName);
    let audit = await auditIndexes();
    console.log(JSON.stringify({ database, clientIndexReady: audit.clientIndexReady, legacyUniqueIndexes: audit.legacy, findings: audit.findings }));
    if (audit.findings.length) throw new Error(`Shipment manifest index audit blocked apply: ${audit.findings.join("; ")}`);
    if (!apply) {
      console.log("Read-only audit complete. No indexes changed.");
      return;
    }

    assertTenantMigrationExecutionAllowed({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      step: "shipment-manifest-reuse-indexes",
      expectedDatabase: database,
      mongoUri: migrationUri,
      authorization
    });
    if (production) {
      await mongoose.disconnect();
      await mongoose.connect(migrationUri, { family: 4, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
      assertExpectedDatabaseName(database, mongoose.connection.db?.databaseName);
      audit = await auditIndexes();
      if (audit.findings.length) throw new Error(`Production preflight blocked apply: ${audit.findings.join("; ")}`);
    }
    if (log) { await log.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "preflight-passed", legacy: audit.legacy })}\n`); await log.sync(); }

    // Keep the client invariant in place before lifting the old staff limit.
    await ShipmentManifest.collection.createIndex(clientIndexKeys, {
      name: clientIndexName,
      unique: true,
      partialFilterExpression: clientIndexFilter
    });
    const afterCreate = await auditIndexes();
    if (!afterCreate.clientIndexReady || afterCreate.findings.length) {
      throw new Error("Client-only unique index verification failed; legacy indexes were retained.");
    }
    for (const name of afterCreate.legacy) await ShipmentManifest.collection.dropIndex(name);
    const final = await auditIndexes();
    if (final.findings.length || final.legacy.length || !final.clientIndexReady) {
      throw new Error("Shipment manifest index migration verification failed.");
    }
    if (log) { await log.appendFile(`${JSON.stringify({ at: new Date().toISOString(), event: "indexes-migrated", dropped: afterCreate.legacy })}\n`); await log.sync(); }
    console.log("Staff manifest reuse indexes are ready; client manifest uniqueness remains enforced.");
  } finally {
    await mongoose.disconnect();
    await log?.close();
  }
}

if (isMainModule(import.meta.url)) migrateShipmentManifestReuseIndexes().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Shipment manifest reuse index migration failed.");
  process.exitCode = 1;
});
