import mongoose from "mongoose";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import { CashReceipt } from "../../models/cashReceipt.model.js";
import { CashAllocationEvent } from "../../models/cashAllocationEvent.model.js";
import { attachLedgerShipments, type LedgerDocument } from "./ledgerReferences.service.js";
import { getDataAccessTenantId } from "../tenantScope.service.js";

export type AccountLedgerRow = {
  _id: string; createdAt: Date; transactionType: string; direction: "CREDIT" | "DEBIT" | "NONE";
  amountMinor: number; currency: string; paymentSource: string; status: string; reference: string;
  description: string; shipmentDraftId?: unknown; shipmentNumber?: string | null;
  cashReceiptId?: unknown; documents?: LedgerDocument[];
  cashBalanceAfterMinor?: number; reservedBalanceAfterMinor?: number;
};

/**
 * Read-only payments activity for one business account.
 *
 * Only verified online payments and receipted cash are part of this ledger.
 * Historical wallet rows stay in their original collection for audit, and
 * public/counter shipments never carry a business-account id, so neither leaks
 * into an account's payment history.
 */
export async function listAccountLedger(input: {
  tenantId: mongoose.Types.ObjectId; businessAccountId: mongoose.Types.ObjectId;
  page?: number; limit?: number; from?: Date; to?: Date;
}) {
  const authorizedTenantId = await getDataAccessTenantId();
  if (!authorizedTenantId || String(authorizedTenantId) !== String(input.tenantId)) throw new Error("Account ledger tenant access could not be verified.");
  const scope = { tenantId: input.tenantId, businessAccountId: input.businessAccountId };
  const directMatch = { ...scope, capturedAt: { $type: "date" }, status: { $in: ["CAPTURED", "ALLOCATED", "SETTLED", "REVIEW_REQUIRED", "REFUND_PENDING", "REFUNDED"] } };
  const pipeline: mongoose.PipelineStage[] = [
    { $match: directMatch },
    { $project: { _id: { $concat: ["razorpay:", { $toString: "$_id" }] }, createdAt: "$capturedAt", transactionType: { $cond: [{ $eq: ["$paymentPurpose", "SHIPMENT_AMENDMENT"] }, "RAZORPAY_AMENDMENT_PAYMENT", "RAZORPAY_BOOKING_PAYMENT"] }, direction: { $literal: "CREDIT" }, amountMinor: 1, currency: 1, shipmentDraftId: 1, reference: "$razorpayPaymentId", paymentSource: { $literal: "RAZORPAY" }, status: 1, description: { $literal: "Online payment received and applied to this shipment." } } },
    { $unionWith: { coll: ShipmentDirectPayment.collection.name, pipeline: [
      { $match: { ...scope, status: "REFUNDED", razorpayRefundedAt: { $type: "date" }, razorpayRefundAmountMinor: { $gt: 0 } } },
      { $project: { _id: { $concat: ["refund:", { $toString: "$_id" }] }, createdAt: "$razorpayRefundedAt", transactionType: { $literal: "RAZORPAY_REFUND" }, direction: { $literal: "DEBIT" }, amountMinor: "$razorpayRefundAmountMinor", currency: 1, shipmentDraftId: 1, reference: "$razorpayRefundId", paymentSource: { $literal: "RAZORPAY" }, status: 1, description: { $literal: "Refund returned to the original payment method." } } }
    ] } },
    { $unionWith: { coll: CashReceipt.collection.name, pipeline: [
      { $match: { ...scope, status: "FINALIZED", receiptType: { $ne: "STANDALONE" } } },
      { $project: { _id: { $concat: ["cash:", { $toString: "$_id" }] }, createdAt: "$issuedAt", transactionType: { $literal: "SHIPMENT_CASH_RECEIPT" }, direction: { $literal: "CREDIT" }, amountMinor: "$totalReceivedMinor", currency: 1, shipmentDraftId: 1, cashReceiptId: "$_id", reference: "$receiptNumber", paymentSource: { $literal: "CASH" }, status: 1, description: { $literal: "Cash received by Swiftline for this shipment." } } }
    ] } },
    { $unionWith: { coll: CashAllocationEvent.collection.name, pipeline: [
      { $match: { ...scope, eventType: "REFUNDED" } },
      { $project: { _id: { $concat: ["cash-refund:", { $toString: "$_id" }] }, createdAt: 1, transactionType: { $literal: "CASH_REFUND" }, direction: { $literal: "DEBIT" }, amountMinor: 1, currency: { $literal: "INR" }, shipmentDraftId: 1, cashReceiptId: "$cashReceiptId", reference: "$idempotencyKey", paymentSource: { $literal: "CASH" }, status: { $literal: "RECORDED" }, description: "$reason" } }
    ] } },
    ...(input.from || input.to ? [{ $match: { createdAt: { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) } } }] : []),
    { $sort: { createdAt: -1, _id: -1 } }
  ];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const page = Math.max(input.page ?? 1, 1);
  // The generic model aggregate guard rejects unions. This specific read model
  // checks the active tenant above and repeats the same owner in every branch.
  const [result] = await ShipmentDirectPayment.collection.aggregate<{ rows: AccountLedgerRow[]; count: Array<{ total: number }> }>([
    ...pipeline,
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: "total" }] } }
  ]).toArray();
  const total = result?.count[0]?.total ?? 0;
  return {
    transactions: await attachLedgerShipments(result?.rows ?? [], input.businessAccountId),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
}
