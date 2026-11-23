import type { Db, Document, ObjectId } from "mongodb";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import { PrepaidTransaction } from "../models/prepaidTransaction.model.js";
import { PaymentTopUp } from "../models/paymentTopUp.model.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { CashReceiptRead } from "../models/cashReceiptRead.model.js";
import { CashAllocationEvent } from "../models/cashAllocationEvent.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { WebhookEvent } from "../models/webhookEvent.model.js";
import { indexKeyEquals, indexSatisfiesPlan, type ExistingIndexShape, type PlannedIndexShape } from "./tenantMigrationIndexHelpers.js";

// These models are registered for schema inspection only. The caller uses a
// native MongoClient; importing this module never connects Mongoose.
const models = [PrepaidAccount, PrepaidTransaction, PaymentTopUp, CashReceipt,
  CashReceiptRead, CashAllocationEvent, ShipmentDirectPayment, ShipmentFunding,
  ShipmentAmendment, ShipmentCancellation, PublicShipmentPayment, WebhookEvent];
const ownershipCollections = ["prepaidaccounts", "prepaidtransactions", "paymenttopups"];
const replaceableCashIndexes = new Set(["tenant_active_cash_receipt", "tenant_one_active_shipment_cash_receipt"]);
const queryOptions = { maxTimeMS: 20_000 };
type SchemaIndex = [Record<string, number>, { name?: string; unique?: boolean; partialFilterExpression?: Document }];

export const prepaidReleaseIndexPlans = models.flatMap((model) => (model.schema.indexes() as SchemaIndex[]).map(([key, options]) => ({
  collection: model.collection.collectionName,
  key: key as Record<string, number>,
  options: {
    name: options.name ?? Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_"),
    ...(options.unique ? { unique: true } : {}),
    ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression as Record<string, unknown> } : {})
  }
})));

export type PrepaidReleaseReport = {
  rootTenantId: ObjectId;
  records: Record<string, number>;
  ownership: Array<{ collection: string; count: number }>;
  missingIndexes: Array<typeof prepaidReleaseIndexPlans[number]>;
  replaceIndexes: Array<{ collection: string; name: string }>;
  walletsMissingCycleMetadata: number;
  blockers: string[];
};

function duplicatePipeline(plan: PlannedIndexShape, rootTenantId: ObjectId): Document[] {
  const key = Object.fromEntries(Object.keys(plan.key).map((field) => [
    field, field === "tenantId" ? { $ifNull: ["$tenantId", rootTenantId] } : `$${field}`
  ]));
  return [
    { $match: plan.options.partialFilterExpression ?? {} },
    { $group: { _id: key, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
    { $project: { _id: 0, count: 1 } }
  ];
}

export async function inspectPrepaidRelease(db: Db): Promise<PrepaidReleaseReport> {
  const roots = await db.collection("tenants").find({ kind: "SWIFTLINE", status: "ACTIVE" }, queryOptions).limit(2).toArray();
  if (roots.length !== 1) throw new Error("Expected exactly one active Swiftline tenant.");
  const rootTenantId = roots[0]!._id;
  const report: PrepaidReleaseReport = { rootTenantId, records: {}, ownership: [], missingIndexes: [], replaceIndexes: [], walletsMissingCycleMetadata: 0, blockers: [] };
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name));

  for (const collection of new Set(prepaidReleaseIndexPlans.map((plan) => plan.collection))) {
    const target = db.collection(collection);
    report.records[collection] = await target.countDocuments({}, queryOptions);
    const indexes = collections.has(collection) ? await target.listIndexes().toArray() as ExistingIndexShape[] : [];
    const unowned = await target.countDocuments({ tenantId: null }, queryOptions);
    const tenantOwned = models.find((model) => model.collection.collectionName === collection)?.schema.path("tenantId");
    if (tenantOwned && unowned) {
      if (!ownershipCollections.includes(collection)) {
        report.blockers.push(`${collection}: unowned records require separate review.`);
      } else {
        const badParents = await target.aggregate([
          { $match: { tenantId: null } },
          { $lookup: { from: "businessaccounts", localField: "businessAccountId", foreignField: "_id", as: "business" } },
          { $match: { "business.0.tenantId": { $ne: rootTenantId } } },
          { $count: "count" }
        ], queryOptions).toArray();
        if (badParents.length) report.blockers.push(`${collection}: unowned records have missing or non-Swiftline business accounts.`);
        report.ownership.push({ collection, count: unowned });
      }
    }
    for (const plan of prepaidReleaseIndexPlans.filter((item) => item.collection === collection)) {
      // Retain a stronger historical unique index when the schema only asks
      // for the same non-unique lookup index (notably businessAccountId_1).
      if (indexes.some((index) => indexSatisfiesPlan(index, plan)
        || (!plan.options.unique && index.unique === true
          && indexSatisfiesPlan(index, { ...plan, options: { ...plan.options, unique: true } })))) continue;
      report.missingIndexes.push(plan);
      const conflicts = indexes.filter((index) => index.name === plan.options.name
        || Boolean(index.key && indexKeyEquals(index.key, plan.key)));
      for (const conflict of conflicts) {
        const oldTopupOrder = collection === "paymenttopups" && conflict.name === "razorpayOrderId_1"
          && conflict.unique === true && !conflict.partialFilterExpression;
        const oldCashIndex = collection === "cashreceipts" && conflict.name && replaceableCashIndexes.has(conflict.name);
        if ((oldTopupOrder || oldCashIndex) && conflict.name
          && conflict.key && indexKeyEquals(conflict.key, plan.key)) {
          report.replaceIndexes.push({ collection, name: conflict.name });
        } else report.blockers.push(`${collection}.${conflict.name}: incompatible existing index requires review.`);
      }
      if (plan.options.unique && (await target.aggregate(duplicatePipeline(plan, rootTenantId), queryOptions).toArray()).length) {
        report.blockers.push(`${collection}.${plan.options.name}: duplicate keys prevent index creation.`);
      }
    }
  }
  report.walletsMissingCycleMetadata = await db.collection("prepaidaccounts").countDocuments({
    $or: [{ tenantId: rootTenantId }, { tenantId: null }],
    $and: [{ $or: [{ fundingCycleSequence: null }, { fundingCycleBaselineMinor: null }] }]
  }, queryOptions);
  // These historical requests have no prepaid reservation and cannot safely be
  // guessed into the new payment workflow by a deployment script.
  for (const [collection, statuses] of [
    ["shipmentamendments", ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"]],
    ["shipmentcancellations", ["REQUESTED"]],
    ["balancereservations", ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"]]
  ] as const) {
    const count = await db.collection(collection).countDocuments({ tenantId: rootTenantId, status: { $in: statuses } }, queryOptions);
    if (count) report.blockers.push(`${collection}: ${count} active Swiftline request(s)/reservation(s) must be resolved before cutover.`);
  }
  return report;
}

/** Apply only while every application and scheduled writer is paused. No balance transfers or deletes. */
export async function applyPrepaidRelease(db: Db) {
  const before = await inspectPrepaidRelease(db);
  if (before.blockers.length) throw new Error(`Release migration blocked: ${before.blockers.join(" ")}`);
  // One transaction assigns the proven legacy ownership without touching money,
  // provider statuses, payment IDs, receipts, or other tenants' existing records.
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const rootBusinesses = await db.collection("businessaccounts").find(
        { tenantId: before.rootTenantId }, { session, projection: { _id: 1 } }
      ).toArray();
      const businessAccountIds = rootBusinesses.map((business) => business._id);
      for (const plan of before.ownership) {
        const result = await db.collection(plan.collection).updateMany(
          { tenantId: null, businessAccountId: { $in: businessAccountIds } },
          { $set: { tenantId: before.rootTenantId } }, { session }
        );
        if (result.modifiedCount !== plan.count) throw new Error("Ownership changed after preflight; keep writers paused.");
      }
      await db.collection("prepaidaccounts").updateMany({ tenantId: before.rootTenantId }, [{ $set: {
        fundingCycleSequence: { $ifNull: ["$fundingCycleSequence", 0] },
        fundingCycleBaselineMinor: { $ifNull: ["$fundingCycleBaselineMinor", 0] },
        fundingCycleStartedAt: { $ifNull: ["$fundingCycleStartedAt", null] },
        lowBalanceAlertedCycle: { $ifNull: ["$lowBalanceAlertedCycle", null] }
      } }], { session });
    });
  } finally { await session.endSession(); }

  for (const plan of before.replaceIndexes) await db.collection(plan.collection).dropIndex(plan.name);
  for (const plan of before.missingIndexes) {
    await db.collection(plan.collection).createIndex(plan.key, plan.options);
  }
  const after = await inspectPrepaidRelease(db);
  if (after.blockers.length || after.missingIndexes.length || after.replaceIndexes.length || after.ownership.length || after.walletsMissingCycleMetadata) {
    throw new Error("Release postflight failed; keep the portal in maintenance mode and inspect the audit.");
  }
  for (const [collection, count] of Object.entries(before.records)) {
    if (after.records[collection] !== count) throw new Error(`${collection}: record counts changed during migration.`);
  }
  return after;
}
