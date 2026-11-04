import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { AuditLog } from "../models/auditLog.model.js";
import { CancellationDocumentCounter } from "../models/cancellationDocumentCounter.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { IdempotencyKey } from "../models/idempotencyKey.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceCounter } from "../models/shipmentInvoiceCounter.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentManifestCounter } from "../models/shipmentManifestCounter.model.js";
import { Tenant } from "../models/tenant.model.js";
import {
  assertExpectedDatabaseName,
  assertTenantMigrationExecutionAllowed,
  isMainModule,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";
import { indexKeyEquals, indexSatisfiesPlan } from "./tenantMigrationIndexHelpers.js";

type IndexPlan = {
  key: Record<string, number>;
  options: mongoose.IndexOptions;
};

type ModelPlan = {
  model: mongoose.Model<any>;
  legacyIndexes: Array<{ key: Record<string, number>; unique: boolean }>;
  additionalIndexes?: IndexPlan[];
};

type CollectionPlan = {
  model: mongoose.Model<any>;
  collection: mongoose.Collection;
  total: number;
  missing: number;
  conflicts: number;
  duplicateGroups: number;
  tenantIndexExists: boolean;
  tenantQueryIndexesPresent: number;
  tenantQueryIndexesExpected: number;
  scopedUniqueIndexesPresent: number;
  scopedUniqueIndexesExpected: number;
  additionalIndexesPresent: number;
  additionalIndexesExpected: number;
  legacyIndexesToReplace: string[];
  indexPlans: IndexPlan[];
  additionalIndexPlans: IndexPlan[];
};

type Arguments = { apply: boolean; expectedDatabase: string };

const modelPlans: ModelPlan[] = [
  {
    model: CountryRateCard,
    legacyIndexes: [
      { key: { band: 1, countryCode: 1, service: 1, fromKg: 1, toKg: 1 }, unique: false },
      { key: { businessAccountId: 1, countryCode: 1, service: 1, fromKg: 1, toKg: 1 }, unique: false }
    ]
  },
  {
    model: CountryRouteCharge,
    legacyIndexes: [{ key: { businessAccountId: 1, band: 1, countryCode: 1, service: 1 }, unique: true }]
  },
  { model: ShipmentInvoiceCounter, legacyIndexes: [{ key: { financialYear: 1 }, unique: true }] },
  { model: CancellationDocumentCounter, legacyIndexes: [{ key: { financialYear: 1, documentType: 1 }, unique: true }] },
  { model: ShipmentManifestCounter, legacyIndexes: [] },
  {
    model: ShipmentInvoice,
    legacyIndexes: [
      { key: { invoiceNumber: 1 }, unique: true },
      { key: { shipmentDraftId: 1 }, unique: true },
      { key: { dpdShipmentId: 1 }, unique: true }
    ]
  },
  {
    model: ShipmentCreditNote,
    legacyIndexes: [{ key: { creditNoteNumber: 1 }, unique: true }, { key: { cancellationId: 1 }, unique: true }]
  },
  {
    model: CancellationFeeInvoice,
    legacyIndexes: [{ key: { invoiceNumber: 1 }, unique: true }, { key: { cancellationId: 1 }, unique: true }]
  },
  {
    model: ShipmentManifest,
    legacyIndexes: [
      { key: { manifestNumber: 1 }, unique: true },
      { key: { shipmentDraftIds: 1, actorRole: 1, manifestType: 1 }, unique: true }
    ]
  },
  {
    model: PortalNotification,
    legacyIndexes: [
      { key: { idempotencyKey: 1 }, unique: true },
      { key: { recipientUserId: 1, readAt: 1, createdAt: -1 }, unique: false }
    ]
  },
  {
    model: EmailOutbox,
    legacyIndexes: [
      { key: { idempotencyKey: 1 }, unique: true },
      { key: { status: 1, nextAttemptAt: 1, priority: -1 }, unique: false },
      { key: { businessAccountId: 1, createdAt: -1 }, unique: false },
      { key: { toEmail: 1, createdAt: -1 }, unique: false }
    ],
    additionalIndexes: [
      { key: { sesMessageId: 1 }, options: { name: "email_outbox_ses_message_id" } }
    ]
  },
  { model: AuditLog, legacyIndexes: [] },
  { model: IdempotencyKey, legacyIndexes: [{ key: { scope: 1, userId: 1, key: 1 }, unique: true }] }
];

export const operationalTenantOwnershipModelNames = modelPlans.map((plan) => plan.model.modelName);

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

function plannedScopedUniqueIndexes(model: mongoose.Model<any>): IndexPlan[] {
  return (model.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>)
    .filter(([key, options]) => options.unique === true && key.tenantId === 1)
    .map(([key, options]) => ({ key, options }));
}

function plannedTenantQueryIndexes(model: mongoose.Model<any>): IndexPlan[] {
  return (model.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>)
    .filter(([key]) => key.tenantId === 1 && Object.keys(key).length > 1)
    .map(([key, options]) => ({ key, options }));
}

async function duplicateGroupCount(
  plan: ModelPlan,
  index: IndexPlan,
  rootTenantId: mongoose.Types.ObjectId
) {
  const arrayFields = Object.keys(index.key).filter((field) => plan.model.schema.path(field)?.instance === "Array");
  if (arrayFields.length > 1) {
    throw new Error(`${plan.model.modelName} has a compound unique index with multiple array paths; review it manually.`);
  }
  const groupKey = Object.fromEntries(Object.keys(index.key).map((field) => [
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
  const pipeline: mongoose.PipelineStage[] = [
    { $match: match },
    ...arrayFields.map((field) => ({ $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true } }) as mongoose.PipelineStage),
    { $group: { _id: groupKey, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 100 }
  ];
  return (await plan.model.collection.aggregate(pipeline, { maxTimeMS: 60_000 }).toArray()).length;
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
    throw new Error("This pre-activation ownership migration is blocked after an operator is activated.");
  }

  const plans: CollectionPlan[] = [];
  for (const entry of modelPlans) {
    const { model } = entry;
    const collection = model.collection;
    const indexPlans = plannedTenantQueryIndexes(model);
    const uniqueIndexPlans = plannedScopedUniqueIndexes(model);
    const additionalIndexPlans = entry.additionalIndexes ?? [];
    const [total, missing, conflicts, indexes, duplicateGroupsByIndex] = await Promise.all([
      collection.countDocuments({}),
      collection.countDocuments(missingTenantFilter()),
      collection.countDocuments(conflictingTenantFilter(rootTenantId)),
      readIndexes(collection),
      Promise.all(uniqueIndexPlans.map((index) => duplicateGroupCount(entry, index, rootTenantId)))
    ]);
    const tenantIndexExists = indexes.some((index) =>
      indexKeyEquals(index.key ?? {}, { tenantId: 1 }) && index.unique !== true
    );
    const tenantQueryIndexesPresent = indexPlans.filter((plan) =>
      indexes.some((index) => index.name === plan.options.name && indexSatisfiesPlan(index, plan))
    ).length;
    const scopedUniqueIndexesPresent = uniqueIndexPlans.filter((plan) =>
      indexes.some((index) => index.name === plan.options.name && indexSatisfiesPlan(index, plan))
    ).length;
    const additionalIndexesPresent = additionalIndexPlans.filter((plan) =>
      indexes.some((index) => indexSatisfiesPlan(index, plan))
    ).length;
    const legacyIndexesToReplace = indexes
      .filter((index) => entry.legacyIndexes.some((legacy) =>
        Boolean(index.unique) === legacy.unique && indexKeyEquals(index.key ?? {}, legacy.key)
      ))
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
      tenantQueryIndexesPresent,
      tenantQueryIndexesExpected: indexPlans.length,
      scopedUniqueIndexesPresent,
      scopedUniqueIndexesExpected: uniqueIndexPlans.length,
      additionalIndexesPresent,
      additionalIndexesExpected: additionalIndexPlans.length,
      legacyIndexesToReplace,
      indexPlans,
      additionalIndexPlans
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
  if (!indexes.some((index) => indexKeyEquals(index.key ?? {}, { tenantId: 1 }) && index.unique !== true)) {
    await plan.collection.createIndex({ tenantId: 1 }, { name: "tenant_id" });
  }
}

async function replaceLegacyIndexes(plan: CollectionPlan) {
  const indexes = await readIndexes(plan.collection);
  for (const legacyName of plan.legacyIndexesToReplace) {
    if (indexes.some((index) => index.name === legacyName)) await plan.collection.dropIndex(legacyName);
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
    step: "operational-tenant-ownership",
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
    console.log(`Swiftline tenant: ${before.rootTenantId}`);
    let total = 0;
    let missing = 0;
    let conflicts = 0;
    let duplicateGroups = 0;
    for (const plan of before.plans) {
      console.log(
        `${plan.model.modelName}: ${plan.total} document(s); missing tenant: ${plan.missing}; ` +
        `conflicts: ${plan.conflicts}; duplicate tenant keys: ${plan.duplicateGroups}; ` +
        `tenant index: ${plan.tenantIndexExists ? "present" : "missing"}; ` +
        `tenant query indexes: ${plan.tenantQueryIndexesPresent}/${plan.tenantQueryIndexesExpected}; ` +
        `scoped unique indexes: ${plan.scopedUniqueIndexesPresent}/${plan.scopedUniqueIndexesExpected}; ` +
        `additional indexes: ${plan.additionalIndexesPresent}/${plan.additionalIndexesExpected}; ` +
        `legacy indexes to replace: ${plan.legacyIndexesToReplace.length}`
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
      console.log("Dry run only. Pass --apply to assign pre-activation records to Swiftline and replace legacy unique indexes.");
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
      for (const index of plan.additionalIndexPlans) {
        const existingIndexes = await readIndexes(plan.collection);
        if (existingIndexes.some((existing) => indexSatisfiesPlan(existing, index))) continue;
        await plan.collection.createIndex(
          index.key,
          index.options as Parameters<mongoose.Collection["createIndex"]>[1]
        );
      }
    }
    for (const plan of before.plans) await replaceLegacyIndexes(plan);

    const after = await inspect(expectedDatabase);
    const remainingMissing = after.plans.reduce((sum, plan) => sum + plan.missing, 0);
    const remainingConflicts = after.plans.reduce((sum, plan) => sum + plan.conflicts, 0);
    const remainingDuplicates = after.plans.reduce((sum, plan) => sum + plan.duplicateGroups, 0);
    const missingTenantIndexes = after.plans.filter((plan) => !plan.tenantIndexExists).length;
    const missingScopedUniqueIndexes = after.plans.reduce(
      (sum, plan) => sum + plan.scopedUniqueIndexesExpected - plan.scopedUniqueIndexesPresent,
      0
    );
    const missingTenantQueryIndexes = after.plans.reduce(
      (sum, plan) => sum + plan.tenantQueryIndexesExpected - plan.tenantQueryIndexesPresent,
      0
    );
    const missingAdditionalIndexes = after.plans.reduce(
      (sum, plan) => sum + plan.additionalIndexesExpected - plan.additionalIndexesPresent,
      0
    );
    const remainingLegacyIndexes = after.plans.reduce((sum, plan) => sum + plan.legacyIndexesToReplace.length, 0);
    if (
      remainingMissing || remainingConflicts || remainingDuplicates || missingTenantIndexes ||
      missingScopedUniqueIndexes || missingTenantQueryIndexes || missingAdditionalIndexes || remainingLegacyIndexes
    ) {
      throw new Error("Post-migration verification failed; rerun the dry run and inspect the named collections.");
    }
    console.log(`Applied and verified tenant ownership for ${total} operational support record(s).`);
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
    console.error(error instanceof Error ? error.message : "Operational tenant ownership migration failed.");
    process.exitCode = 1;
  });
}
