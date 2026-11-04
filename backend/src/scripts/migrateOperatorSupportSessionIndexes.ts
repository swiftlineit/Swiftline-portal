import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import {
  assertExpectedDatabaseName,
  assertTenantMigrationExecutionAllowed,
  isMainModule,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";

function parseArguments(args: string[]) {
  let apply = false;
  let applySeen = false;
  let expectedDatabase = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") {
      if (applySeen) throw new Error("Pass --apply at most once.");
      applySeen = true;
      apply = true;
      continue;
    }
    if (args[index] === "--database") {
      const value = args[index + 1] ?? "";
      if (expectedDatabase || !value.trim() || value.startsWith("--")) {
        throw new Error("Pass exactly one --database <expected-database-name>.");
      }
      expectedDatabase = value.trim();
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run audit:operator-support-indexes -- --database <expected-database-name> [--apply]");
  }
  if (!expectedDatabase) {
    throw new Error("Usage: npm run audit:operator-support-indexes -- --database <expected-database-name> [--apply]");
  }
  return { apply, expectedDatabase };
}

async function main(
  args = process.argv.slice(2),
  authorization?: ProductionTenantMigrationAuthorization,
  mongoUri = tenantMigrationEnv.applicationMongoUri
) {
  const { apply, expectedDatabase } = parseArguments(args);
  assertTenantMigrationExecutionAllowed({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    step: "operator-support-indexes",
    expectedDatabase,
    mongoUri,
    authorization
  });
  await mongoose.connect(mongoUri, { family: 4, autoIndex: false, autoCreate: false });
  try {
    assertExpectedDatabaseName(expectedDatabase, mongoose.connection.db?.databaseName);
    const existing = await OperatorSupportSession.collection.indexes().catch(() => []);
    const expectedNames = new Set(["_id_", "uniq_operator_support_token_hash", "operator_support_session_expiry"]);
    const unexpected = existing.filter((index) => index.name && !expectedNames.has(index.name));
    if (unexpected.length) throw new Error("Unexpected indexes exist on operator support sessions; review them before proceeding.");
    const missing = ["uniq_operator_support_token_hash", "operator_support_session_expiry"]
      .filter((name) => !existing.some((index) => index.name === name));
    if (!apply) {
      console.log(`Operator support session index audit for ${expectedDatabase}: ${missing.length} missing index(es).`);
      return;
    }
    await OperatorSupportSession.createIndexes();
    console.log("Operator support session indexes created.");
  } finally {
    await mongoose.disconnect();
  }
}

export function runAuthorizedProductionMigration(
  authorization: ProductionTenantMigrationAuthorization,
  apply: boolean
) {
  const args = ["--database", "swiftline", ...(apply ? ["--apply"] : [])];
  const mongoUri = tenantMigrationEnv.migrationMongoUri;
  if (!mongoUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required for production migrations.");
  return main(args, authorization, mongoUri);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Operator support session index migration failed.");
    process.exitCode = 1;
  });
}
