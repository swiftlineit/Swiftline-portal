import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import { BalanceReservation } from "../models/balanceReservation.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentChargeVerification } from "../models/shipmentChargeVerification.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentImportBatch } from "../models/shipmentImportBatch.model.js";
import { ShipmentImportEntry } from "../models/shipmentImportEntry.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceRevisedDocument } from "../models/shipmentInvoiceRevisedDocument.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { ShipmentProfitability } from "../models/shipmentProfitability.model.js";
import { ShipmentQuote } from "../models/shipmentQuote.model.js";
import { ShipmentSupportingDocument } from "../models/shipmentSupportingDocument.model.js";
import { Tenant } from "../models/tenant.model.js";
import {
  assertExpectedDatabaseName,
  assertTenantMigrationExecutionAllowed,
  isMainModule,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";

const tenantOwnedShipmentModels = [
  ShipmentDraft,
  DpdShipment,
  LabelDocument,
  ShipmentInvoice,
  ShipmentEvent,
  ShipmentCharge,
  BalanceReservation,
  ShipmentManifest,
  ShipmentImportBatch,
  ShipmentImportEntry,
  ShipmentAmendment,
  ShipmentCancellation,
  ShipmentCreditNote,
  CancellationFeeInvoice,
  ShipmentSupportingDocument,
  ShipmentInvoiceRevisedDocument,
  ShipmentChargeVerification,
  ShipmentProfitability,
  ShipmentOperationsParcelScan,
  ShipmentQuote
];

export const shipmentTenantOwnershipModelNames = tenantOwnedShipmentModels.map((model) => model.modelName);

type CollectionPlan = {
  modelName: string;
  collection: mongoose.Collection;
  total: number;
  missing: number;
  conflicts: number;
  tenantIndexExists: boolean;
};

type Arguments = { apply: boolean; expectedDatabase: string };

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
  if (!expectedDatabase) throw new Error("Pass --database <expected-database-name>.");
  return { apply, expectedDatabase };
}

function missingTenantFilter() {
  return { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

function otherTenantFilter(tenantId: mongoose.Types.ObjectId) {
  return {
    $and: [
      { tenantId: { $exists: true, $ne: null } },
      { tenantId: { $ne: tenantId } }
    ]
  };
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
    throw new Error("Shipment ownership backfill is restricted to the pre-activation cutover; an operator has left DRAFT.");
  }

  const plans: CollectionPlan[] = [];
  for (const model of tenantOwnedShipmentModels) {
    const collection = model.collection;
    const [total, missing, conflicts, indexes] = await Promise.all([
      collection.countDocuments({}),
      collection.countDocuments(missingTenantFilter()),
      collection.countDocuments(otherTenantFilter(rootTenantId)),
      collection.listIndexes().toArray().catch((error: unknown) => {
        const mongoError = error as { code?: number; codeName?: string };
        if (mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound") return [];
        throw error;
      })
    ]);
    const tenantIndexExists = indexes.some((index: { name?: string; key?: Record<string, unknown> }) =>
      index.name === "tenant_id" && index.key?.tenantId === 1
    );
    plans.push({ modelName: model.modelName, collection, total, missing, conflicts, tenantIndexExists });
  }

  return { databaseName, rootTenantId, plans };
}

async function run(
  args = process.argv.slice(2),
  authorization?: ProductionTenantMigrationAuthorization,
  mongoUri = tenantMigrationEnv.applicationMongoUri
) {
  const { apply, expectedDatabase } = parseArguments(args);
  assertTenantMigrationExecutionAllowed({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    step: "shipment-tenant-ownership",
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
    for (const plan of before.plans) {
      console.log(`${plan.modelName}: ${plan.total} document(s); missing tenant: ${plan.missing}; conflicts: ${plan.conflicts}; tenant index: ${plan.tenantIndexExists ? "present" : "missing"}`);
      total += plan.total;
      missing += plan.missing;
      conflicts += plan.conflicts;
    }
    console.log(`Totals: ${total} document(s); missing tenant: ${missing}; conflicts: ${conflicts}`);

    if (conflicts > 0) throw new Error("Conflicting tenant owners were found; no records were changed.");
    if (!apply) {
      console.log("Dry run only. Pass --apply to assign pre-operator shipment records to the Swiftline tenant and create tenant indexes.");
      return;
    }

    // This migration is idempotent and intentionally runs one collection at a
    // time. If interrupted, rerun the preflight and resume without a long
    // multi-collection transaction over operational history.
    for (const plan of before.plans) {
      if (plan.missing > 0) {
        await plan.collection.updateMany(missingTenantFilter(), { $set: { tenantId: before.rootTenantId } });
      }
    }

    for (const plan of before.plans) {
      await plan.collection.createIndex({ tenantId: 1 }, { name: "tenant_id" });
    }

    const after = await inspect(expectedDatabase);
    const remainingMissing = after.plans.reduce((sum, plan) => sum + plan.missing, 0);
    const remainingConflicts = after.plans.reduce((sum, plan) => sum + plan.conflicts, 0);
    const missingIndexes = after.plans.filter((plan) => !plan.tenantIndexExists).length;
    if (remainingMissing > 0 || remainingConflicts > 0 || missingIndexes > 0) {
      throw new Error("Post-migration verification failed; rerun the dry run and inspect the named collections.");
    }
    console.log(`Applied and verified tenant ownership for ${total} shipment workflow record(s).`);
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
    console.error(error instanceof Error ? error.message : "Shipment tenant ownership migration failed.");
    process.exitCode = 1;
  });
}
