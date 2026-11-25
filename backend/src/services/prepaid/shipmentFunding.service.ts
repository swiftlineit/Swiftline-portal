import mongoose from "mongoose";
import { CashAllocationEvent } from "../../models/cashAllocationEvent.model.js";
import { CashReceipt } from "../../models/cashReceipt.model.js";
import { PublicShipmentPayment } from "../../models/publicShipmentPayment.model.js";
import { ShipmentCharge } from "../../models/shipmentCharge.model.js";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentInvoice } from "../../models/shipmentInvoice.model.js";
import { ShipmentAmendment } from "../../models/shipmentAmendment.model.js";
import {
  ShipmentFunding,
  type ShipmentFundingSource
} from "../../models/shipmentFunding.model.js";
import type { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { buildPricingHash } from "../shipmentCostEstimate.service.js";
import type { ShipmentPricingEstimate } from "../shipmentPricing.service.js";
import { refundCapturedShipmentDirectPayment } from "./shipmentDirectPayments.service.js";
import { getTenantContext } from "../tenantScope.service.js";

type ShipmentDraftDocument = InstanceType<typeof ShipmentDraft>;

// Wallet rows are historical only. They are still recognised when deciding
// whether an already-booked shipment can display its labels.
const RECOGNISED_FUNDING_SOURCES = ["BUSINESS_WALLET", "DIRECT_RAZORPAY", "CASH_RECEIPT", "PUBLIC_RAZORPAY"];

function toMinor(pricing: ShipmentPricingEstimate) {
  const amountMinor = Math.round(pricing.totalAmount * 100);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("BOOKING_AMOUNT_INVALID");
  return amountMinor;
}

function pricingRevision(draft: ShipmentDraftDocument) {
  const revision = (draft as ShipmentDraftDocument & { __v?: number }).__v ?? 0;
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function sourcePaymentSource(source: ShipmentFundingSource) {
  switch (source) {
    case "BUSINESS_WALLET": return "BUSINESS_WALLET" as const;
    case "DIRECT_RAZORPAY": return "DIRECT_RAZORPAY" as const;
    case "CASH_RECEIPT": return "CASH_RECEIPT" as const;
    case "PUBLIC_RAZORPAY": return "PUBLIC_RAZORPAY" as const;
    case "OPERATOR_LEGACY": return "BUSINESS_ACCOUNT" as const;
    case "TEST": return "TEST" as const;
  }
}

function assertFundingMatches(existing: InstanceType<typeof ShipmentFunding>, input: {
  draft: ShipmentDraftDocument;
  amountMinor: number;
  pricingHash: string;
  source: ShipmentFundingSource;
  sourceReferenceId?: mongoose.Types.ObjectId | null;
}) {
  if (
    String(existing.businessAccountId) !== String(input.draft.businessAccountId)
    || String(existing.branchId) !== String(input.draft.branchId)
    || existing.amountMinor !== input.amountMinor
    || existing.pricingHash !== input.pricingHash
    || existing.source !== input.source
    || String(existing.sourceReferenceId ?? "") !== String(input.sourceReferenceId ?? "")
  ) {
    throw new Error("A different payment is already secured for this shipment draft.");
  }
}

async function createFundingAndCharge(input: {
  draft: ShipmentDraftDocument;
  pricing: ShipmentPricingEstimate;
  pricingHash: string;
  source: ShipmentFundingSource;
  sourceReferenceId?: mongoose.Types.ObjectId | null;
  bookingAttemptId: string;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const amountMinor = toMinor(input.pricing);
  const fundingFields = {
    businessAccountId: input.draft.businessAccountId,
    branchId: input.draft.branchId,
    shipmentDraftId: input.draft._id,
    amountMinor,
    currency: "INR" as const,
    source: input.source,
    sourceReferenceId: input.sourceReferenceId ?? null,
    pricingHash: input.pricingHash,
    pricingRevision: pricingRevision(input.draft),
    status: "SECURED" as const,
    bookingAttemptId: input.bookingAttemptId,
    securedBy: input.createdBy,
    securedAt: new Date()
  };
  const released = await ShipmentFunding.findOne({ shipmentDraftId: input.draft._id, status: "RELEASED" })
    .session(input.session).exec();
  let funding: InstanceType<typeof ShipmentFunding> | null | undefined;
  if (released) {
    funding = await ShipmentFunding.findOneAndUpdate(
      { _id: released._id, status: "RELEASED", version: released.version },
      {
        $set: { ...fundingFields, consumingAt: null, completedAt: null, releasedAt: null, releaseReason: "" },
        $inc: { version: 1 },
        $push: { previousAttempts: {
          bookingAttemptId: released.bookingAttemptId,
          source: released.source,
          sourceReferenceId: released.sourceReferenceId ?? null,
          amountMinor: released.amountMinor,
          pricingHash: released.pricingHash,
          securedAt: released.securedAt,
          releasedAt: released.releasedAt,
          releaseReason: released.releaseReason
        } }
      },
      { returnDocument: "after", runValidators: true, session: input.session }
    ).exec();
  } else {
    [funding] = await ShipmentFunding.create([{ ...fundingFields, version: 0 }], { session: input.session });
  }
  if (!funding) throw new Error("Shipment funding could not be created.");

  await ShipmentCharge.findOneAndUpdate(
    { shipmentDraftId: input.draft._id },
    {
      $set: {
        businessAccountId: input.draft.businessAccountId,
        branchId: input.draft.branchId,
        shipmentDraftId: input.draft._id,
        shipmentId: null,
        dpdShipmentId: null,
        balanceReservationId: null,
        parcelCount: Math.max(input.draft.parcelList.length || input.draft.parcelCount || 1, 1),
        paymentSource: sourcePaymentSource(input.source),
        customerChargeMinor: amountMinor,
        customerCurrency: "INR",
        customerChargeStatus: "RESERVED",
        pricingSnapshot: input.pricing
      }
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
      session: input.session
    }
  ).exec();

  return funding;
}

export async function securePaidShipmentFunding(input: {
  draft: ShipmentDraftDocument;
  pricing: ShipmentPricingEstimate;
  pricingHash: string;
  source: Extract<ShipmentFundingSource, "DIRECT_RAZORPAY" | "CASH_RECEIPT" | "PUBLIC_RAZORPAY">;
  sourceReferenceId: mongoose.Types.ObjectId;
  bookingAttemptId: string;
  createdBy: mongoose.Types.ObjectId;
}) {
  const amountMinor = toMinor(input.pricing);
  if (buildPricingHash(input.pricing) !== input.pricingHash) throw new Error("The secured payment does not match the current shipment price.");

  const existing = await ShipmentFunding.findOne({ shipmentDraftId: input.draft._id }).exec();
  if (existing && existing.status !== "RELEASED") {
    assertFundingMatches(existing, { ...input, amountMinor });
    return { funding: existing, secured: false as const };
  }

  const session = await mongoose.startSession();
  try {
    let funding: InstanceType<typeof ShipmentFunding> | null = null;
    await session.withTransaction(async () => {
      if (input.source === "DIRECT_RAZORPAY") {
        const payment = await ShipmentDirectPayment.findOne({
          _id: input.sourceReferenceId,
          shipmentDraftId: input.draft._id,
          businessAccountId: input.draft.businessAccountId,
          amountMinor,
          currency: "INR",
          pricingHash: input.pricingHash,
          paymentPurpose: "SHIPMENT_BOOKING",
          status: "CAPTURED"
        }).session(session).exec();
        if (!payment) throw new Error("Payment verification is pending. Your shipment can be confirmed after payment is captured.");
      } else if (input.source === "CASH_RECEIPT") {
        const receipt = await CashReceipt.findOne({
          _id: input.sourceReferenceId,
          shipmentDraftId: input.draft._id,
          businessAccountId: input.draft.businessAccountId,
          status: "FINALIZED",
          allocations: { $elemMatch: { allocationType: "SHIPMENT", targetId: input.draft._id, amountMinor } }
        }).session(session).exec();
        if (!receipt) throw new Error("A finalized cash receipt for the full shipment amount is required.");
      } else {
        const payment = await PublicShipmentPayment.findOne({
          _id: input.sourceReferenceId,
          shipmentDraftId: input.draft._id,
          amountMinor,
          currency: "INR",
          pricingHash: input.pricingHash,
          status: { $in: ["CAPTURED", "FULFILLING", "BOOKED", "REVIEW_REQUIRED"] }
        }).session(session).exec();
        if (!payment) throw new Error("Payment verification is pending. Your shipment can be confirmed after payment is captured.");
      }

      funding = await createFundingAndCharge({ ...input, session });
      if (input.source === "DIRECT_RAZORPAY") {
        const allocated = await ShipmentDirectPayment.findOneAndUpdate(
          { _id: input.sourceReferenceId, status: "CAPTURED" },
          { $set: { status: "ALLOCATED", allocatedAt: new Date() } },
          { returnDocument: "after", runValidators: true, session }
        ).exec();
        if (!allocated) throw new Error("The direct payment has already been allocated.");
      }
    });
    if (!funding) throw new Error("Shipment funding could not be secured.");
    return { funding, secured: true as const };
  } finally {
    await session.endSession();
  }
}

export async function markShipmentFundingConsuming(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  bookingAttemptId: string;
}) {
  const funding = await ShipmentFunding.findOneAndUpdate(
    { shipmentDraftId: input.shipmentDraftId, status: "SECURED" },
    { $set: { status: "CONSUMING", consumingAt: new Date(), bookingAttemptId: input.bookingAttemptId }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (funding) return funding;

  const existing = await ShipmentFunding.findOne({ shipmentDraftId: input.shipmentDraftId }).exec();
  if (!existing || !["CONSUMING", "COMPLETED", "REVIEW_REQUIRED"].includes(existing.status)) {
    throw new Error("Shipment payment is not secured for carrier booking.");
  }
  return existing;
}

export async function completeShipmentFunding(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    let result: InstanceType<typeof ShipmentFunding> | null = null;
    await session.withTransaction(async () => {
      const funding = await ShipmentFunding.findOne({ shipmentDraftId: input.shipmentDraftId }).session(session).exec();
      if (!funding) return;
      if (funding.status === "COMPLETED") {
        result = funding;
        return;
      }
      if (!(["SECURED", "CONSUMING"] as const).includes(funding.status as "SECURED" | "CONSUMING")) {
        throw new Error("Shipment payment cannot be completed from its current state.");
      }

      result = await ShipmentFunding.findOneAndUpdate(
        { _id: funding._id, status: { $in: ["SECURED", "CONSUMING"] }, version: funding.version },
        { $set: { status: "COMPLETED", completedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!result) throw new Error("Shipment funding changed while it was being completed.");

      await ShipmentCharge.updateOne(
        { shipmentDraftId: input.shipmentDraftId, customerChargeStatus: { $in: ["RESERVED", "REVIEW_REQUIRED"] } },
        { $set: { customerChargeStatus: "COMPLETED", dpdShipmentId: input.dpdShipmentId } },
        { session, runValidators: true }
      ).exec();
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function releaseShipmentFunding(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  reason: string;
}) {
  const session = await mongoose.startSession();
  let releasedFunding: InstanceType<typeof ShipmentFunding> | null = null;
  try {
    let result: InstanceType<typeof ShipmentFunding> | null = null;
    await session.withTransaction(async () => {
      const funding = await ShipmentFunding.findOne({ shipmentDraftId: input.shipmentDraftId }).session(session).exec();
      if (!funding || funding.status === "RELEASED") {
        result = funding;
        return;
      }
      if (funding.status === "COMPLETED" || funding.status === "REVIEW_REQUIRED") {
        throw new Error("Completed or uncertain shipment funding requires an explicit reconciliation action.");
      }

      if (funding.source === "CASH_RECEIPT" && funding.sourceReferenceId) {
        await CashAllocationEvent.create([{
          cashReceiptId: funding.sourceReferenceId,
          businessAccountId: funding.businessAccountId,
          branchId: funding.branchId,
          eventType: "RELEASED",
          amountMinor: funding.amountMinor,
          shipmentDraftId: funding.shipmentDraftId,
          idempotencyKey: `CASH_SHIPMENT_RELEASE:${String(funding._id)}:${funding.version}`,
          reason: `${input.reason} Funds remain held as unapplied cash for a retry.`,
          createdBy: input.createdBy
        }], { session });
      } else if (funding.source === "DIRECT_RAZORPAY" && funding.sourceReferenceId) {
        await ShipmentDirectPayment.updateOne(
          { _id: funding.sourceReferenceId, status: "ALLOCATED" },
          { $set: { status: "REFUND_PENDING", failureDescription: input.reason } },
          { session, runValidators: true }
        ).exec();
      }

      result = await ShipmentFunding.findOneAndUpdate(
        { _id: funding._id, status: { $in: ["SECURED", "CONSUMING"] }, version: funding.version },
        { $set: { status: "RELEASED", releasedAt: new Date(), releaseReason: input.reason }, $inc: { version: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!result) throw new Error("Shipment funding changed while it was being released.");

      await ShipmentCharge.updateOne(
        { shipmentDraftId: input.shipmentDraftId, customerChargeStatus: "RESERVED" },
        { $set: { customerChargeStatus: "REVERSED" } },
        { session, runValidators: true }
      ).exec();
    });
    releasedFunding = result;
  } finally {
    await session.endSession();
  }
  const fundingToRefund = releasedFunding as InstanceType<typeof ShipmentFunding> | null;
  if (fundingToRefund?.source === "DIRECT_RAZORPAY" && fundingToRefund.sourceReferenceId) {
    await refundCapturedShipmentDirectPayment({
      paymentIntentId: fundingToRefund.sourceReferenceId,
      reason: input.reason
    });
  }
  return fundingToRefund;
}

export async function markShipmentFundingReviewRequired(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  reason: string;
}) {
  const funding = await ShipmentFunding.findOneAndUpdate(
    { shipmentDraftId: input.shipmentDraftId, status: { $in: ["SECURED", "CONSUMING"] } },
    { $set: { status: "REVIEW_REQUIRED", releaseReason: input.reason }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (funding) {
    await ShipmentCharge.updateOne(
      { shipmentDraftId: input.shipmentDraftId, customerChargeStatus: "RESERVED" },
      { $set: { customerChargeStatus: "REVIEW_REQUIRED", dpdShipmentId: input.dpdShipmentId } },
      { runValidators: true }
    ).exec();
  }
  return funding ?? ShipmentFunding.findOne({ shipmentDraftId: input.shipmentDraftId }).exec();
}

export class ShipmentPaymentRequiredError extends Error {
  readonly statusCode = 402;

  constructor(message = "Shipment payment must be completed before this operation.") {
    super(message);
  }
}

export async function completedShipmentDraftIds(
  shipmentDraftIds: mongoose.Types.ObjectId[],
  session?: mongoose.ClientSession
) {
  const completed = new Set<string>();
  if (getTenantContext()?.kind === "OPERATOR") {
    shipmentDraftIds.forEach((id) => completed.add(String(id)));
    return completed;
  }
  const ids = [...new Set(shipmentDraftIds.map(String))].map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return completed;
  const [fundings, shipments] = await Promise.all([
    ShipmentFunding.find({ shipmentDraftId: { $in: ids } }).select("shipmentDraftId status").session(session ?? null).lean().exec(),
    DpdShipment.find({ shipmentDraftId: { $in: ids } }).select("shipmentDraftId paymentSource").session(session ?? null).lean().exec()
  ]);
  const fundingByDraft = new Map(fundings.map((funding) => [String(funding.shipmentDraftId), funding.status]));
  const sourceByDraft = new Map(shipments.map((shipment) => [String(shipment.shipmentDraftId), shipment.paymentSource]));
  const legacyCandidateIds = ids.filter((id) => {
    const key = String(id);
    if (fundingByDraft.has(key)) {
      if (fundingByDraft.get(key) === "COMPLETED") completed.add(key);
      return false;
    }
    return !RECOGNISED_FUNDING_SOURCES.includes(sourceByDraft.get(key) ?? "");
  });
  if (legacyCandidateIds.length) {
    const invoices = await ShipmentInvoice.find({ shipmentDraftId: { $in: legacyCandidateIds } })
      .select("shipmentDraftId paymentStatus creditOutstandingMinor")
      .session(session ?? null)
      .lean()
      .exec();
    for (const invoice of invoices) {
      if (invoice.paymentStatus === "PAID" && invoice.creditOutstandingMinor === 0) {
        completed.add(String(invoice.shipmentDraftId));
      }
    }
  }
  const pendingIncreases = await ShipmentAmendment.find({
    shipmentDraftId: { $in: ids },
    status: { $nin: ["REJECTED", "APPLIED"] },
    paymentAmountMinor: { $gt: 0 },
    paymentStatus: { $ne: "COMPLETED" }
  }).select("shipmentDraftId").session(session ?? null).lean().exec();
  pendingIncreases.forEach((amendment) => completed.delete(String(amendment.shipmentDraftId)));
  return completed;
}

export async function isShipmentPaymentCompleted(shipmentDraftId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  const completed = await completedShipmentDraftIds([shipmentDraftId], session);
  return completed.has(String(shipmentDraftId));
}

/**
 * Label access under the prepaid policy must be backed by the canonical
 * completed funding record. Unlike completedShipmentDraftIds, this deliberately
 * does not accept legacy invoice settlement as a fallback.
 */
export async function isShipmentFundingRecordCompleted(shipmentDraftId: mongoose.Types.ObjectId) {
  const funding = await ShipmentFunding.findOne({ shipmentDraftId })
    .select("status source")
    .lean()
    .exec();
  if (
    funding?.status !== "COMPLETED"
    || !RECOGNISED_FUNDING_SOURCES.includes(funding.source)
  ) return false;

  const pendingIncrease = await ShipmentAmendment.findOne({
    shipmentDraftId,
    status: { $nin: ["REJECTED", "APPLIED"] },
    paymentAmountMinor: { $gt: 0 },
    paymentStatus: { $ne: "COMPLETED" }
  }).select("_id").lean().exec();
  return !pendingIncrease;
}

export async function assertShipmentFundingCompleted(shipmentDraftId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  if (!await isShipmentPaymentCompleted(shipmentDraftId, session)) throw new ShipmentPaymentRequiredError();
}

export async function assertShipmentsFundingCompleted(shipmentDraftIds: mongoose.Types.ObjectId[], session?: mongoose.ClientSession) {
  const completed = await completedShipmentDraftIds(shipmentDraftIds, session);
  if (shipmentDraftIds.some((id) => !completed.has(String(id)))) throw new ShipmentPaymentRequiredError();
}
