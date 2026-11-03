import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { OperatorInvitation } from "../models/operatorInvitation.model.js";
import { OperatorClientInvitation } from "../models/operatorClientInvitation.model.js";
import { OperatorShipmentTrackingCounter } from "../models/operatorShipmentTrackingCounter.model.js";
import { OperatorContactQuery } from "../models/operatorContactQuery.model.js";
import { assertExpectedDatabaseName, assertNonProductionEnvironment } from "./migrationSafety.js";

function parseArguments(args: string[]) {
  let apply = false;
  let expectedDatabase = "";
  let applySeen = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") {
      if (applySeen) throw new Error("Pass --apply at most once.");
      applySeen = true;
      apply = true;
      continue;
    }
    if (args[index] === "--database") {
      const databaseArgument = args[index + 1] ?? "";
      if (expectedDatabase || !databaseArgument.trim() || databaseArgument.startsWith("--")) {
        throw new Error("Pass exactly one --database <expected-database-name>.");
      }
      expectedDatabase = databaseArgument;
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run audit:tenant-registry-indexes -- --database <expected-database-name> [--apply]");
  }
  if (!expectedDatabase.trim()) {
    throw new Error("Usage: npm run audit:tenant-registry-indexes -- --database <expected-database-name> [--apply]");
  }
  return { apply, expectedDatabase: expectedDatabase.trim() };
}

async function main() {
  assertNonProductionEnvironment(env.NODE_ENV, "Tenant registry index migration");
  const { apply, expectedDatabase } = parseArguments(process.argv.slice(2));
  await mongoose.connect(env.MONGODB_URI, { family: 4, autoIndex: false, autoCreate: false });
  try {
    assertExpectedDatabaseName(expectedDatabase, mongoose.connection.db?.databaseName);
    const models = [
      Tenant,
      TenantSlug,
      TenantMembership,
      OperatorInvitation,
      OperatorClientInvitation,
      OperatorShipmentTrackingCounter,
      OperatorContactQuery,
    ];
    const missing: string[] = [];
    for (const model of models) {
      const existing = await model.collection.indexes().catch(() => []);
      const existingNames = new Set(existing.map((index) => index.name).filter(Boolean));
      const expectedNames = (model.schema.indexes() as Array<[unknown, { name?: string }]>)
        .map(([, options]) => options.name)
        .filter((name): name is string => Boolean(name));
      for (const name of expectedNames) {
        if (!existingNames.has(name)) missing.push(`${model.collection.collectionName}.${name}`);
      }
    }
    if (!apply) {
      console.log(`Tenant registry index audit for ${expectedDatabase}: ${missing.length} missing index(es).`);
      for (const index of missing) console.log(`  ${index}`);
      return;
    }
    for (const model of models) await model.createIndexes();
    console.log("Tenant registry, operator tracking counter and client query indexes created.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Tenant registry index migration failed.");
  process.exitCode = 1;
});
