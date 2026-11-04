import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { AddressBookEntry } from "../models/addressBookEntry.model.js";
import { BusinessAccountInvitation } from "../models/businessAccountInvitation.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditAgreement } from "../models/creditAgreement.model.js";
import { CreditAgreementCounter } from "../models/creditAgreementCounter.model.js";
import { CreditBillingAdjustment } from "../models/creditBillingAdjustment.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { CreditBillingStatementCounter } from "../models/creditBillingStatementCounter.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { CreditLimitHistory } from "../models/creditLimitHistory.model.js";
import { CreditLimitIncreaseRequest } from "../models/creditLimitIncreaseRequest.model.js";
import { CreditPayment } from "../models/creditPayment.model.js";
import { PaymentTermsAcceptance, PaymentTermsDocument } from "../models/paymentTerms.model.js";
import { Tenant } from "../models/tenant.model.js";
import {
  assertExpectedDatabaseName,
  assertTenantMigrationExecutionAllowed,
  isMainModule,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";

type IndexPlan = {
  key: Record<string, number>;
  options: mongoose.IndexOptions;
};

type ModelPlan = {
  model: mongoose.Model<any>;
  legacyUniqueKeys: Array<Record<string, number>>;
};

type CollectionPlan = {
  model: mongoose.Model<any>;
  collection: mongoose.Collection;
  total: number;
  missing: number;
  conflicts: number;
  duplicateGroups: number;
  tenantIndexExists: boolean;
  scopedUniqueIndexesPresent: number;
  scopedUniqueIndexesExpected: number;
  legacyUniqueIndexes: string[];
  indexPlans: IndexPlan[];
};

type Arguments = { apply: boolean; expectedDatabase: string };

const modelPlans: ModelPlan[] = [
  { model: BusinessAccountMember, legacyUniqueKeys: [{ user: 1 }] },
  { model: BusinessAccountInvitation, legacyUniqueKeys: [] },
  { model: AddressBookEntry, legacyUniqueKeys: [] },
  { model: BusinessCreditAccount, legacyUniqueKeys: [{ businessAccountId: 1 }] },
  { model: CreditLedgerEntry, legacyUniqueKeys: [{ idempotencyKey: 1 }] },
  {
    model: CreditPayment,
    legacyUniqueKeys: [
      { internalReference: 1 },
      { idempotencyKey: 1 },
      { businessAccountId: 1, method: 1, externalReference: 1 }
    ]
  },
  {
    model: CreditBillingStatement,
    legacyUniqueKeys: [
      { statementNumber: 1 },
      { businessAccountId: 1, billingCycle: 1, periodStart: 1, periodEnd: 1 }
    ]
  },
  { model: CreditBillingAdjustment, legacyUniqueKeys: [{ sourceType: 1, sourceId: 1 }] },
  {
    model: CreditAgreement,
    legacyUniqueKeys: [
      { agreementNumber: 1 },
      { businessAccountId: 1, version: 1 },
      { businessAccountId: 1 }
    ]
  },
  { model: CreditAgreementCounter, legacyUniqueKeys: [{ businessAccountId: 1 }] },
  { model: CreditBillingStatementCounter, legacyUniqueKeys: [{ financialYear: 1 }] },
  { model: CreditLimitHistory, legacyUniqueKeys: [] },
  { model: CreditLimitIncreaseRequest, legacyUniqueKeys: [{ businessAccountId: 1 }] },
  { model: PaymentTermsDocument, legacyUniqueKeys: [{ version: 1 }] },
  {
    model: PaymentTermsAcceptance,
    legacyUniqueKeys: [{ businessAccountId: 1, userId: 1, termsVersion: 1, paymentReference: 1 }]
  }
];

export const accountCreditTenantOwnershipModelNames = modelPlans.map((plan) => plan.model.modelName);

function parseArguments(args: string[]): Arguments {
  let apply = false;
  let expectedDatabase = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") {
      apply = true;
      continue;
    }
    if (args[index] === "--database") {
      expectedDatabase = args[index + 1] ?? "";
      index += 1;
    }
  }
  if (!expectedDatabase.trim()) throw new Error("Pass --database <expected-database-name>.");
  return { apply, expectedDatabase: expectedDatabase.trim() };
}

function missingTenantFilter() {
  return { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

function conflictingTenantFilter(tenantId: mongoose.Types.ObjectId) {
  return {
    $and: [
      { tenantId: { $exists: true, $ne: null } },
      { tenantId: { $ne: tenantId } }
    ]
  };
}

function indexKeyEquals(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([field, value], index) =>
    field === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]
  );
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function plannedScopedUniqueIndexes(model: mongoose.Model<any>): IndexPlan[] {
  const schemaIndexes = model.schema.indexes() as Array<[
    Record<string, number>,
    mongoose.IndexOptions
  ]>;
  return schemaIndexes
    .filter(([key, options]) => options.unique === true && key.tenantId === 1)
    .map(([key, options]) => ({
      key: key as Record<string, number>,
      options: options as mongoose.IndexOptions
    }));
}

function indexMatchesPlan(
  existing: { key?: Record<string, unknown>; name?: string; unique?: boolean; partialFilterExpression?: Record<string, unknown> },
  plan: IndexPlan
) {
  return Boolean(existing.key) && indexKeyEquals(existing.key!, plan.key) &&
    existing.unique === true &&
    stableValue(existing.partialFilterExpression ?? {}) === stableValue(plan.options.partialFilterExpression ?? {});
}

async function duplicateGroupCount(
  collection: mongoose.Collection,
  index: IndexPlan,
  rootTenantId: mongoose.Types.ObjectId
) {
  const indexedFields = Object.keys(index.key);
  const groupKey = Object.fromEntries(indexedFields.map((field) => [
    field,
    field === "tenantId" ? { $ifNull: ["$tenantId", rootTenantId] } : `$${field}`
  ]));
  const ownershipMatch = {
    $or: [
      { tenantId: { $exists: false } },
      { tenantId: null },
      { tenantId: rootTenantId }
    ]
  };
  const match = index.options.partialFilterExpression
    ? { $and: [ownershipMatch, index.options.partialFilterExpression] }
    : ownershipMatch;
  const duplicates = await collection.aggregate([
    { $match: match },
    { $group: { _id: groupKey, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 100 }
  ]).toArray();
  return duplicates.length;
}

async function readIndexes(collection: mongoose.Collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    const mongoError = error as { code?: number; codeName?: string };
    if (mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

async function inspect(expectedDatabase: string) {
  const databaseName = mongoose.connection.db?.databaseName;
  assertExpectedDatabaseName(expectedDatabase, databaseName);

  const roots = await Tenant.collection.find({ kind: "SWIFTLINE", status: "ACTIVE" }).limit(2).toArray();
  if (roots.length !== 1) throw new Error("Expected exactly one active Swiftline tenant.");
  const rootTenantId = roots[0]?._id as mongoose.Types.ObjectId;
  const initializedOperators = await Tenant.collection.countDocuments({
    kind: "OPERATOR",
    status: { $ne: "DRAFT" }
  });
  if (initializedOperators > 0) {
    throw new Error("Account and credit ownership backfill is restricted to the pre-activation cutover.");
  }

  const plans: CollectionPlan[] = [];
  for (const { model, legacyUniqueKeys } of modelPlans) {
    const collection = model.collection;
    const indexPlans = plannedScopedUniqueIndexes(model);
    const [total, missing, conflicts, indexes, duplicateGroupsByIndex] = await Promise.all([
      collection.countDocuments({}),
      collection.countDocuments(missingTenantFilter()),
      collection.countDocuments(conflictingTenantFilter(rootTenantId)),
      readIndexes(collection),
      Promise.all(indexPlans.map((index) => duplicateGroupCount(collection, index, rootTenantId)))
    ]);
    const tenantIndexExists = indexes.some((index) =>
      indexKeyEquals(index.key ?? {}, { tenantId: 1 }) && index.unique !== true
    );
    const scopedUniqueIndexesPresent = indexPlans.filter((plan) =>
      indexes.some((index) => index.name === plan.options.name && indexMatchesPlan(index, plan))
    ).length;
    const legacyUniqueIndexes = indexes
      .filter((index) => index.unique === true && legacyUniqueKeys.some((key) => indexKeyEquals(index.key ?? {}, key)))
      .map((index) => index.name)
      .filter((name): name is string => Boolean(name));
    plans.push({
      model,
      collection,
      total,
      missing,
      conflicts,
      duplicateGroups: duplicateGroupsByIndex.reduce((sum, count) => sum + count, 0),
      tenantIndexExists,
      scopedUniqueIndexesPresent,
      scopedUniqueIndexesExpected: indexPlans.length,
      legacyUniqueIndexes,
      indexPlans
    });
  }
  return { databaseName, rootTenantId, plans };
}

async function ensureTenantIndex(plan: CollectionPlan) {
  const indexes = await readIndexes(plan.collection);
  const namedTenantIndex = indexes.find((index) =>
    index.name === "tenant_id" && !indexKeyEquals(index.key ?? {}, { tenantId: 1 })
  );
  if (namedTenantIndex) throw new Error(`${plan.model.modelName} has a conflicting tenant_id index.`);
  const uniqueSingleTenantIndex = indexes.find((index) =>
    indexKeyEquals(index.key ?? {}, { tenantId: 1 }) && index.unique === true
  );
  if (uniqueSingleTenantIndex) throw new Error(`${plan.model.modelName} has a conflicting unique tenant index.`);
  if (!plan.tenantIndexExists) await plan.collection.createIndex({ tenantId: 1 }, { name: "tenant_id" });
}

async function replaceLegacyUniqueIndexes(plan: CollectionPlan) {
  const indexes = await readIndexes(plan.collection);
  for (const legacyName of plan.legacyUniqueIndexes) {
    if (indexes.some((index) => index.name === legacyName)) {
      await plan.collection.dropIndex(legacyName);
    }
  }
}

async function run(
  args = process.argv.slice(2),
  authorization?: ProductionTenantMigrationAuthorization,
  mongoUri = tenantMigrationEnv.applicationMongoUri
) {
  const { apply, expectedDatabase } = parseArguments(args);
  assertTenantMigrationExecutionAllowed({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    step: "account-credit-tenant-ownership",
    expectedDatabase,
    mongoUri,
    authorization
  });
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(mongoUri, {
    family: 4,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000
  });

  try {
    const before = await inspect(expectedDatabase);
    console.log(`Database: ${before.databaseName}`);
    let total = 0;
    let missing = 0;
    let conflicts = 0;
    let duplicateGroups = 0;
    for (const plan of before.plans) {
      console.log(
        `${plan.model.modelName}: ${plan.total} document(s); missing tenant: ${plan.missing}; ` +
        `conflicts: ${plan.conflicts}; duplicate tenant keys: ${plan.duplicateGroups}; ` +
        `tenant index: ${plan.tenantIndexExists ? "present" : "missing"}; ` +
        `scoped unique indexes: ${plan.scopedUniqueIndexesPresent}/${plan.scopedUniqueIndexesExpected}; ` +
        `legacy unique indexes to replace: ${plan.legacyUniqueIndexes.length}`
      );
      total += plan.total;
      missing += plan.missing;
      conflicts += plan.conflicts;
      duplicateGroups += plan.duplicateGroups;
    }
    console.log(`Totals: ${total} document(s); missing tenant: ${missing}; conflicts: ${conflicts}; duplicate tenant keys: ${duplicateGroups}`);

    if (conflicts > 0 || duplicateGroups > 0) {
      throw new Error("Ownership or uniqueness conflicts were found; no records or indexes were changed.");
    }
    if (!apply) {
      console.log("Dry run only. Pass --apply to assign pre-operator records to Swiftline and replace legacy unique indexes.");
      return;
    }

    for (const plan of before.plans) {
      if (plan.missing > 0) {
        await plan.collection.updateMany(missingTenantFilter(), { $set: { tenantId: before.rootTenantId } });
      }
    }
    for (const plan of before.plans) {
      await ensureTenantIndex(plan);
      for (const index of plan.indexPlans) {
        await plan.collection.createIndex(
          index.key,
          index.options as Parameters<mongoose.Collection["createIndex"]>[1]
        );
      }
    }
    for (const plan of before.plans) {
      await replaceLegacyUniqueIndexes(plan);
    }

    const after = await inspect(expectedDatabase);
    const remainingMissing = after.plans.reduce((sum, plan) => sum + plan.missing, 0);
    const remainingConflicts = after.plans.reduce((sum, plan) => sum + plan.conflicts, 0);
    const remainingDuplicates = after.plans.reduce((sum, plan) => sum + plan.duplicateGroups, 0);
    const missingTenantIndexes = after.plans.filter((plan) => !plan.tenantIndexExists).length;
    const missingScopedUniqueIndexes = after.plans.reduce(
      (sum, plan) => sum + plan.scopedUniqueIndexesExpected - plan.scopedUniqueIndexesPresent,
      0
    );
    const remainingLegacyUniqueIndexes = after.plans.reduce((sum, plan) => sum + plan.legacyUniqueIndexes.length, 0);
    if (
      remainingMissing || remainingConflicts || remainingDuplicates || missingTenantIndexes ||
      missingScopedUniqueIndexes || remainingLegacyUniqueIndexes
    ) {
      throw new Error("Post-migration verification failed; rerun the dry run and inspect the named collections.");
    }
    console.log(`Applied and verified tenant ownership for ${total} client-account and credit record(s).`);
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
  return run(args, authorization, mongoUri);
}

if (isMainModule(import.meta.url)) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Account and credit tenant ownership migration failed.");
    process.exitCode = 1;
  });
}
