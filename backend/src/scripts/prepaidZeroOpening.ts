import { createHash } from "node:crypto";
import { ObjectId, type ClientSession, type Db, type Document } from "mongodb";
import type { AuditAction } from "../models/auditLog.model.js";
import { SYSTEM_ACTOR_ID } from "../utils/systemActor.js";

// Stable across release versions and CLI run IDs. Never change this key to rerun
// the reset: a completed cutover must not erase subsequently deposited money.
const cutoverKey = "swiftline-prepaid-zero-opening-v1";
const action: AuditAction = "PREPAID_ZERO_OPENING_APPLIED";
const systemActor = new ObjectId(SYSTEM_ACTOR_ID.toHexString());
const creditFields = ["requestedCreditLimitMinor", "approvedCreditLimitMinor", "reservedCreditMinor",
  "unbilledCreditMinor", "invoicedOutstandingMinor", "customerAdvanceBalanceMinor", "reservedAdvanceMinor"];
const walletFields = ["cashBalanceMinor", "reservedBalanceMinor", "fundingCycleSequence", "fundingCycleBaselineMinor"];

function auditId(tenantId: ObjectId, suffix = "completed") {
  return new ObjectId(createHash("sha256").update(`${tenantId}:${cutoverKey}:${suffix}`).digest("hex").slice(0, 24));
}

export type ZeroOpeningReport = {
  alreadyApplied: boolean;
  walletsToReset: number;
  creditAccountsToClose: number;
  walletBalanceToRemoveMinor: number;
  legacyAdvanceToRemoveMinor: number;
  walletAdjustmentsToWrite: number;
  blockers: string[];
};

function sumMinor(records: Document[], field: string): number {
  const total = records.reduce((sum, record) => sum + (record[field] ?? 0), 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Unsafe ${field} total; review before resetting.`);
  return total;
}

/** Native reads only, also repeated inside the reset transaction. */
export async function inspectZeroOpening(db: Db, tenantId: ObjectId, session?: ClientSession): Promise<ZeroOpeningReport> {
  const options = { ...(session ? { session } : {}), maxTimeMS: 20_000 };
  const report: ZeroOpeningReport = { alreadyApplied: false, walletsToReset: 0, creditAccountsToClose: 0,
    walletBalanceToRemoveMinor: 0, legacyAdvanceToRemoveMinor: 0, walletAdjustmentsToWrite: 0, blockers: [] };
  const completed = await db.collection("auditlogs").findOne({ _id: auditId(tenantId) }, options);
  if (completed) {
    if (!completed.tenantId?.equals(tenantId) || completed.action !== action || completed.metadata?.cutoverKey !== cutoverKey) {
      throw new Error("Zero-opening audit marker conflicts with an existing record.");
    }
    report.alreadyApplied = true;
    return report;
  }
  if (await db.collection("prepaidtransactions").countDocuments({
    $or: [{ tenantId }, { tenantId: null }], idempotencyKey: { $regex: `^${cutoverKey}:` }
  }, options)) {
    report.blockers.push("Zero-opening adjustment exists without its completion marker; review before proceeding.");
  }
  for (const [collection, fields] of [["prepaidaccounts", walletFields], ["businesscreditaccounts", creditFields]] as const) {
    // Unowned wallets are verified by the release ownership preflight before
    // assignment. Unowned credit accounts need separate ownership review.
    const scope = collection === "prepaidaccounts" ? { $or: [{ tenantId }, { tenantId: null }] } : { tenantId };
    const records = await db.collection(collection).find(scope, options).toArray();
    const badParents = await db.collection(collection).aggregate([
      { $match: scope },
      { $lookup: { from: "businessaccounts", localField: "businessAccountId", foreignField: "_id", as: "business" } },
      { $match: { "business.0.tenantId": { $ne: tenantId } } }, { $limit: 1 }
    ], options).toArray();
    if (badParents.length) report.blockers.push(`${collection}: zero-opening ownership does not match Swiftline.`);
    if (records.some((record) => record.currency != null && record.currency !== "INR")) {
      report.blockers.push(`${collection}: unsupported currency requires review before zero-opening.`);
    }
    if (records.some((record) => [...fields, "version"].some((field) =>
      !Number.isSafeInteger(record[field] ?? 0) || (record[field] ?? 0) < 0 || (field === "version" && record[field] === Number.MAX_SAFE_INTEGER)))) {
      report.blockers.push(`${collection}: invalid balance or version requires review.`);
      continue;
    }
    if (records.some((record) => collection === "prepaidaccounts" ? (record.reservedBalanceMinor ?? 0) !== 0
      : (record.reservedCreditMinor ?? 0) !== 0 || (record.reservedAdvanceMinor ?? 0) !== 0)) {
      report.blockers.push(`${collection}: release held funds through their workflow before zero-opening.`);
    }
    if (collection === "prepaidaccounts") {
      report.walletsToReset = records.length;
      report.walletBalanceToRemoveMinor = sumMinor(records, "cashBalanceMinor");
      report.walletAdjustmentsToWrite = records.filter((record) => record.cashBalanceMinor > 0).length;
    } else {
      report.creditAccountsToClose = records.length;
      report.legacyAdvanceToRemoveMinor = sumMinor(records, "customerAdvanceBalanceMinor");
    }
  }
  if (await db.collection("businesscreditaccounts").countDocuments({ tenantId: null }, options)) {
    report.blockers.push("businesscreditaccounts: unowned legacy accounts require review before zero-opening.");
  }
  for (const [collection, statuses] of [
    ["shipmentfundings", ["SECURED", "CONSUMING", "REVIEW_REQUIRED"]],
    ["shipmentdirectpayments", ["ORDER_CREATING", "PROCESSING", "CAPTURED", "REVIEW_REQUIRED", "REFUND_PENDING"]]
  ] as const) {
    if (await db.collection(collection).countDocuments({ tenantId, status: { $in: statuses } }, options)) {
      report.blockers.push(`${collection}: reconcile in-flight prepaid payments before zero-opening.`);
    }
  }
  return report;
}

/** Called only in the release transaction, after verified ownership assignment. */
export async function applyZeroOpening(db: Db, tenantId: ObjectId, session: ClientSession): Promise<number> {
  const plan = await inspectZeroOpening(db, tenantId, session);
  if (plan.blockers.length) throw new Error(`Zero-opening blocked: ${plan.blockers.join(" ")}`);
  if (plan.alreadyApplied) return 0;
  const at = new Date();
  for (const [collection, fields] of [["prepaidaccounts", walletFields], ["businesscreditaccounts", creditFields]] as const) {
    const records = await db.collection(collection).find({ tenantId }, { session }).toArray();
    for (const record of records) {
      const before = Object.fromEntries([...fields, "status", "version"].map((field) => [field, record[field] ?? null]));
      const changes: Document = Object.fromEntries(fields.map((field) => [field, 0]));
      if (collection === "prepaidaccounts") {
        Object.assign(changes, { fundingCycleStartedAt: null, lowBalanceAlertedCycle: null });
        before.fundingCycleStartedAt = record.fundingCycleStartedAt ?? null;
        before.lowBalanceAlertedCycle = record.lowBalanceAlertedCycle ?? null;
      } else changes.status = "CLOSED";
      Object.assign(changes, { version: (record.version ?? 0) + 1, updatedAt: at });
      await db.collection("auditlogs").insertOne({
        _id: auditId(tenantId, `${collection}:${record._id}`), tenantId,
        action, entityType: "BUSINESS_ACCOUNT", entityId: record.businessAccountId,
        performedBy: systemActor, performedAt: at,
        metadata: { cutoverKey, collection, recordId: record._id, before, after: changes }
      }, { session });
      await db.collection(collection).updateOne({ _id: record._id, tenantId }, { $set: changes }, { session });
      if (collection === "prepaidaccounts" && record.cashBalanceMinor > 0) {
        await db.collection("prepaidtransactions").insertOne({
          tenantId, businessAccountId: record.businessAccountId, branchId: null,
          transactionType: "ADMIN_DEBIT", direction: "DEBIT", amountMinor: record.cashBalanceMinor,
          currency: record.currency ?? "INR", referenceType: "ADMIN_ADJUSTMENT", referenceId: record._id,
          idempotencyKey: `${cutoverKey}:${record._id}`, paymentSource: "CLIENT_PREPAID",
          cashBalanceBeforeMinor: record.cashBalanceMinor, cashBalanceAfterMinor: 0,
          reservedBalanceBeforeMinor: 0, reservedBalanceAfterMinor: 0,
          description: "Management-approved reset to zero opening balance at prepaid launch.",
          createdBy: systemActor, createdAt: at
        }, { session });
      }
    }
  }
  // Marker, snapshots, ledger adjustments and balances commit atomically.
  await db.collection("auditlogs").insertOne({
    _id: auditId(tenantId), tenantId, action, entityType: "TENANT", entityId: tenantId,
    performedBy: systemActor, performedAt: at, metadata: { cutoverKey, ...plan }
  }, { session });
  return plan.walletAdjustmentsToWrite;
}
