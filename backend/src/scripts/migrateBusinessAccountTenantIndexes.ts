import mongoose from "mongoose";
import { env } from "../config/env.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Tenant } from "../models/tenant.model.js";
import { assertExpectedDatabaseName, assertNonProductionEnvironment } from "./migrationSafety.js";
import {
  businessAccountLegacyUniqueKeys,
  duplicateTenantIdentityPipeline,
  sameIndexKey,
  tenantScopedUniqueIndexes
} from "./tenantIdentityIndexMigration.js";

type Arguments = { apply: boolean; expectedDatabase: string };
type ExistingIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

type Preflight = {
  total: number;
  missingTenantOwner: number;
  unresolvedTenantOwner: number;
  duplicateGroups: number;
  legacyIndexes: ExistingIndex[];
};

function parseArguments(args: string[]): Arguments {
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
    throw new Error("Usage: npm run migrate:business-account-tenant-indexes -- --database <expected-database-name> [--apply]");
  }
  if (!expectedDatabase) {
    throw new Error("Usage: npm run migrate:business-account-tenant-indexes -- --database <expected-database-name> [--apply]");
  }
  return { apply, expectedDatabase };
}

async function preflight(): Promise<Preflight> {
  const collection = BusinessAccount.collection;
  const plans = tenantScopedUniqueIndexes(BusinessAccount);
  const [total, missingTenantOwner, unresolvedOwners, indexes, duplicateCounts] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ $expr: { $ne: [{ $type: "$tenantId" }, "objectId"] } }),
    collection.aggregate([
      {
        $lookup: {
          from: Tenant.collection.name,
          localField: "tenantId",
          foreignField: "_id",
          as: "_tenantOwner"
        }
      },
      { $match: { _tenantOwner: { $size: 0 } } },
      { $count: "unresolved" }
    ]).toArray(),
    collection.indexes() as Promise<ExistingIndex[]>,
    Promise.all(plans.map(async (plan) => {
      const groups = await collection.aggregate(duplicateTenantIdentityPipeline(plan)).toArray();
      return Number(groups[0]?.duplicateGroups ?? 0);
    }))
  ]);

  const legacyIndexes = indexes.filter((index) => index.unique === true &&
    businessAccountLegacyUniqueKeys.some((key) => sameIndexKey(index.key, key))
  );

  return {
    total,
    missingTenantOwner,
    unresolvedTenantOwner: Number(unresolvedOwners[0]?.unresolved ?? 0),
    duplicateGroups: duplicateCounts.reduce((sum, count) => sum + count, 0),
    legacyIndexes
  };
}

function assertSafeToApply(result: Preflight) {
  if (result.missingTenantOwner > 0 || result.unresolvedTenantOwner > 0 || result.duplicateGroups > 0) {
    throw new Error("Preflight found missing or invalid tenant owners, or duplicate tenant-local business identities. Reconcile the records before applying indexes.");
  }
}

async function main() {
  assertNonProductionEnvironment(env.NODE_ENV, "Business account tenant index migration");
  const { apply, expectedDatabase } = parseArguments(process.argv.slice(2));
  await mongoose.connect(env.MONGODB_URI, { family: 4, autoIndex: false, autoCreate: false });
  try {
    assertExpectedDatabaseName(expectedDatabase, mongoose.connection.db?.databaseName);
    const result = await preflight();
    const plans = tenantScopedUniqueIndexes(BusinessAccount);
    console.log(
      `BusinessAccount: ${result.total} records; missing tenant owner=${result.missingTenantOwner}; ` +
      `unresolved tenant owner=${result.unresolvedTenantOwner}; duplicate tenant keys=${result.duplicateGroups}.`
    );
    console.log(`Tenant-scoped unique indexes to verify/create=${plans.length}; global unique indexes to remove=${result.legacyIndexes.length}.`);

    if (!apply) {
      if (result.missingTenantOwner || result.unresolvedTenantOwner || result.duplicateGroups) {
        throw new Error("Dry run is not clean; no indexes were changed.");
      }
      console.log("Dry run passed. Review the counts, then rerun with --apply to create scoped indexes and remove superseded global unique indexes.");
      return;
    }

    assertSafeToApply(result);
    for (const plan of plans) {
      await BusinessAccount.collection.createIndex(plan.key, {
        name: plan.options.name,
        unique: true,
        ...(plan.options.partialFilterExpression
          ? { partialFilterExpression: plan.options.partialFilterExpression }
          : {})
      });
    }

    const createdIndexes = await BusinessAccount.collection.indexes() as ExistingIndex[];
    const missingScopedIndexes = plans.filter((plan) => !createdIndexes.some((index) =>
      index.unique === true && sameIndexKey(index.key, plan.key)
    ));
    if (missingScopedIndexes.length) {
      throw new Error("One or more tenant-scoped indexes could not be verified; legacy indexes were left in place.");
    }

    for (const index of result.legacyIndexes) {
      if (index.name && index.name !== "_id_") {
        await BusinessAccount.collection.dropIndex(index.name);
      }
    }

    const finalIndexes = await BusinessAccount.collection.indexes() as ExistingIndex[];
    const remainingLegacyIndexes = finalIndexes.filter((index) => index.unique === true &&
      businessAccountLegacyUniqueKeys.some((key) => sameIndexKey(index.key, key))
    );
    if (remainingLegacyIndexes.length) {
      throw new Error("Superseded global unique indexes remain; inspect the database before enabling operator accounts.");
    }
    console.log("Tenant-scoped business-account identity indexes are active; superseded global unique indexes were removed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Business account tenant index migration failed.");
  process.exitCode = 1;
});
