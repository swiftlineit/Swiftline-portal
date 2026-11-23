import mongoose from "mongoose";
import { PublicShipmentPayment } from "../../models/publicShipmentPayment.model.js";
import { ShipmentAmendment } from "../../models/shipmentAmendment.model.js";
import { ShipmentCancellation, type CancellationGatewayRefundPlan } from "../../models/shipmentCancellation.model.js";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import { ShipmentFunding } from "../../models/shipmentFunding.model.js";
import { createRazorpayRefund, fetchRazorpayRefund } from "../razorpay/client.js";

export type CancellationGatewayRefundResult = "NOT_GATEWAY" | "COMPLETED" | "PENDING";

type RefundAllocation = CancellationGatewayRefundPlan["allocations"][number];

export function allocateCancellationRefund(input: {
  amountMinor: number;
  candidates: Array<{ paymentId: string; amountMinor: number }>;
}) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("A cancellation refund allocation must be a positive integer amount.");
  }
  if (input.candidates.some((candidate) => !candidate.paymentId || !Number.isInteger(candidate.amountMinor) || candidate.amountMinor <= 0)) {
    throw new Error("Cancellation refund candidates must have valid captured amounts.");
  }
  const capturedTotal = input.candidates.reduce((total, payment) => total + payment.amountMinor, 0);
  if (capturedTotal < input.amountMinor) {
    throw new Error("Captured Razorpay payments do not cover the requested cancellation refund.");
  }

  let remaining = input.amountMinor;
  const allocations: Array<{ paymentId: string; amountMinor: number }> = [];
  for (const payment of input.candidates) {
    if (remaining <= 0) break;
    const amountMinor = Math.min(payment.amountMinor, remaining);
    allocations.push({ paymentId: payment.paymentId, amountMinor });
    remaining -= amountMinor;
  }
  if (remaining !== 0) throw new Error("Cancellation refund allocations could not be balanced.");
  return allocations;
}

function assertRefundResponse(
  refund: { payment_id: string; amount: number; currency: string },
  input: { paymentId: string; amountMinor: number }
) {
  if (refund.payment_id !== input.paymentId || refund.amount !== input.amountMinor || refund.currency !== "INR") {
    throw new Error("Razorpay refund details did not match the requested cancellation refund.");
  }
}

async function directPaymentPlan(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  sourcePaymentId: mongoose.Types.ObjectId;
  amountMinor: number;
}) {
  const original = await ShipmentDirectPayment.findOne({
    _id: input.sourcePaymentId,
    shipmentDraftId: input.shipmentDraftId,
    paymentPurpose: "SHIPMENT_BOOKING",
    status: "ALLOCATED"
  }).exec();
  if (!original || !original.razorpayPaymentId) throw new Error("The captured shipment payment could not be found.");

  const amendments = await ShipmentAmendment.find({
    shipmentDraftId: input.shipmentDraftId,
    status: { $in: ["APPROVED", "APPLIED"] },
    paymentStatus: "COMPLETED",
    paymentSource: "DIRECT_RAZORPAY",
    paymentReferenceId: { $ne: null }
  }).select("paymentReferenceId").lean().exec();
  const amendmentPaymentIds = amendments
    .map((amendment) => amendment.paymentReferenceId)
    .filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId);
  const amendmentPayments = amendmentPaymentIds.length
    ? await ShipmentDirectPayment.find({
        _id: { $in: amendmentPaymentIds },
        shipmentDraftId: input.shipmentDraftId,
        paymentPurpose: "SHIPMENT_AMENDMENT",
        status: "SETTLED"
      }).exec()
    : [];
  if (amendmentPayments.length !== amendmentPaymentIds.length) {
    throw new Error("An approved amendment payment could not be reconciled before cancellation.");
  }
  if (amendmentPayments.some((payment) => !payment.razorpayPaymentId)) {
    throw new Error("An approved amendment is missing its captured Razorpay payment.");
  }

  const candidates = [original, ...amendmentPayments].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const allocations = allocateCancellationRefund({
    amountMinor: input.amountMinor,
    candidates: candidates.map((payment) => ({ paymentId: String(payment._id), amountMinor: payment.amountMinor }))
  }).map((allocation) => ({ source: "DIRECT_RAZORPAY" as const, ...allocation }));
  return { amountMinor: input.amountMinor, allocations } satisfies CancellationGatewayRefundPlan;
}

async function publicPaymentPlan(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  sourcePaymentId: mongoose.Types.ObjectId;
  amountMinor: number;
}) {
  const payment = await PublicShipmentPayment.findOne({
    _id: input.sourcePaymentId,
    shipmentDraftId: input.shipmentDraftId,
    status: "BOOKED"
  }).exec();
  if (!payment || !payment.razorpayPaymentId) throw new Error("The captured public shipment payment could not be found.");
  if (payment.amountMinor < input.amountMinor) {
    throw new Error("The public Razorpay payment does not cover the requested cancellation refund.");
  }
  return {
    amountMinor: input.amountMinor,
    allocations: [{
      source: "PUBLIC_RAZORPAY" as const,
      paymentId: String(payment._id),
      amountMinor: input.amountMinor
    }]
  } satisfies CancellationGatewayRefundPlan;
}

async function ensureRefundPlan(input: {
  cancellationId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  source: "DIRECT_RAZORPAY" | "PUBLIC_RAZORPAY";
  sourcePaymentId: mongoose.Types.ObjectId;
  amountMinor: number;
}) {
  const cancellation = await ShipmentCancellation.findOne({
    _id: input.cancellationId,
    shipmentDraftId: input.shipmentDraftId,
    status: "REQUESTED"
  }).select("gatewayRefundPlan").exec();
  if (!cancellation) throw new Error("The pending shipment cancellation could not be found.");
  const existingPlan = cancellation.gatewayRefundPlan;
  if (existingPlan) {
    if (existingPlan.amountMinor !== input.amountMinor) {
      throw new Error("The cancellation refund amount was already fixed. Retry with the original reviewed fee.");
    }
    return existingPlan;
  }

  const planned = input.source === "DIRECT_RAZORPAY"
    ? await directPaymentPlan({
        shipmentDraftId: input.shipmentDraftId,
        sourcePaymentId: input.sourcePaymentId,
        amountMinor: input.amountMinor
      })
    : await publicPaymentPlan({
        shipmentDraftId: input.shipmentDraftId,
        sourcePaymentId: input.sourcePaymentId,
        amountMinor: input.amountMinor
      });
  const saved = await ShipmentCancellation.findOneAndUpdate(
    {
      _id: input.cancellationId,
      shipmentDraftId: input.shipmentDraftId,
      status: "REQUESTED",
      $or: [{ gatewayRefundPlan: null }, { gatewayRefundPlan: { $exists: false } }]
    },
    { $set: { gatewayRefundPlan: planned } },
    { returnDocument: "after", runValidators: true }
  ).select("gatewayRefundPlan").exec();
  if (saved?.gatewayRefundPlan) return saved.gatewayRefundPlan;

  const raced = await ShipmentCancellation.findById(input.cancellationId).select("gatewayRefundPlan").lean().exec();
  if (raced?.gatewayRefundPlan && raced.gatewayRefundPlan.amountMinor === input.amountMinor) {
    return raced.gatewayRefundPlan as CancellationGatewayRefundPlan;
  }
  throw new Error("The cancellation refund plan changed while it was being secured.");
}

async function ensureDirectAllocationRefund(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  cancellationId: mongoose.Types.ObjectId;
  allocation: RefundAllocation;
}) {
  const payment = await ShipmentDirectPayment.findOne({
    _id: input.allocation.paymentId,
    shipmentDraftId: input.shipmentDraftId
  }).exec();
  if (
    !payment
    || !["SHIPMENT_BOOKING", "SHIPMENT_AMENDMENT"].includes(payment.paymentPurpose)
    || !payment.razorpayPaymentId
    || input.allocation.amountMinor > payment.amountMinor
  ) {
    throw new Error("A captured shipment payment could not be matched to the cancellation refund plan.");
  }
  if (payment.status === "REFUNDED") {
    if (payment.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
      throw new Error("A different refund amount was already completed for a cancellation payment.");
    }
    return "COMPLETED" as const;
  }
  if (payment.status === "REFUND_PENDING" && payment.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
    throw new Error("A different refund amount is already processing for a cancellation payment.");
  }
  const baseStatus = payment.paymentPurpose === "SHIPMENT_AMENDMENT" ? "SETTLED" : "ALLOCATED";
  if (![baseStatus, "REFUND_PENDING"].includes(payment.status)) {
    throw new Error("A shipment payment is not in a refundable cancellation state.");
  }

  const claim = await ShipmentDirectPayment.updateOne(
    {
      _id: payment._id,
      shipmentDraftId: input.shipmentDraftId,
      status: { $in: [baseStatus, "REFUND_PENDING"] },
      ...(payment.status === "REFUND_PENDING" ? { razorpayRefundAmountMinor: input.allocation.amountMinor } : {})
    },
    {
      $set: {
        status: "REFUND_PENDING",
        razorpayRefundAmountMinor: input.allocation.amountMinor,
        failureDescription: "Shipment cancellation refund is processing."
      }
    },
    { runValidators: true }
  ).exec();
  if (!claim.matchedCount) {
    const current = await ShipmentDirectPayment.findById(payment._id).select("status razorpayRefundAmountMinor").lean().exec();
    if (current?.status === "REFUNDED" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "COMPLETED" as const;
    if (current?.status !== "REFUND_PENDING" || current.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
      throw new Error("The shipment payment changed while its cancellation refund was being secured.");
    }
  }

  try {
    const refund = payment.razorpayRefundId ? await fetchRazorpayRefund(payment.razorpayRefundId) : await createRazorpayRefund({
      paymentId: payment.razorpayPaymentId,
      amountMinor: input.allocation.amountMinor,
      idempotencyKey: `SHIP_CANCEL_REFUND_${String(input.cancellationId)}_${String(payment._id)}`
    });
    assertRefundResponse(refund, { paymentId: payment.razorpayPaymentId, amountMinor: input.allocation.amountMinor });
    const completed = refund.status === "processed";
    const updated = await ShipmentDirectPayment.updateOne(
      { _id: payment._id, status: "REFUND_PENDING", razorpayRefundAmountMinor: input.allocation.amountMinor },
      {
        $set: {
          razorpayRefundId: refund.id,
          status: completed ? "REFUNDED" : "REFUND_PENDING",
          razorpayRefundedAt: completed ? new Date() : null,
          failureDescription: completed ? "Shipment cancellation refund processed." : "Razorpay cancellation refund is processing."
        }
      },
      { runValidators: true }
    ).exec();
    if (updated.matchedCount) return completed ? "COMPLETED" : "PENDING";
  } catch (error) {
    await ShipmentDirectPayment.updateOne(
      { _id: payment._id, status: "REFUND_PENDING", razorpayRefundAmountMinor: input.allocation.amountMinor },
      {
        $set: {
          failureDescription: `Cancellation refund requires reconciliation: ${error instanceof Error ? error.message : "Unknown provider error."}`.slice(0, 500)
        }
      }
    ).exec();
    throw error;
  }

  const current = await ShipmentDirectPayment.findById(payment._id).select("status razorpayRefundAmountMinor").lean().exec();
  if (current?.status === "REFUNDED" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "COMPLETED";
  if (current?.status === "REFUND_PENDING" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "PENDING";
  throw new Error("The shipment payment refund state changed during reconciliation.");
}

async function ensurePublicAllocationRefund(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  cancellationId: mongoose.Types.ObjectId;
  allocation: RefundAllocation;
}) {
  const payment = await PublicShipmentPayment.findOne({
    _id: input.allocation.paymentId,
    shipmentDraftId: input.shipmentDraftId
  }).exec();
  if (!payment || !payment.razorpayPaymentId || input.allocation.amountMinor > payment.amountMinor) {
    throw new Error("The public shipment payment could not be matched to the cancellation refund plan.");
  }
  if (payment.status === "REFUNDED") {
    if (payment.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
      throw new Error("A different refund amount was already completed for the public cancellation.");
    }
    return "COMPLETED" as const;
  }
  if (payment.status === "REFUND_PENDING" && payment.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
    throw new Error("A different public payment refund is already processing.");
  }
  if (!["BOOKED", "REFUND_PENDING"].includes(payment.status)) {
    throw new Error("The public payment is not in a refundable cancellation state.");
  }

  const claim = await PublicShipmentPayment.updateOne(
    {
      _id: payment._id,
      shipmentDraftId: input.shipmentDraftId,
      status: { $in: ["BOOKED", "REFUND_PENDING"] },
      ...(payment.status === "REFUND_PENDING" ? { razorpayRefundAmountMinor: input.allocation.amountMinor } : {})
    },
    {
      $set: {
        status: "REFUND_PENDING",
        razorpayRefundAmountMinor: input.allocation.amountMinor,
        failureMessage: "Public shipment cancellation refund is processing."
      }
    }
  ).exec();
  if (!claim.matchedCount) {
    const current = await PublicShipmentPayment.findById(payment._id).select("status razorpayRefundAmountMinor").lean().exec();
    if (current?.status === "REFUNDED" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "COMPLETED" as const;
    if (current?.status !== "REFUND_PENDING" || current.razorpayRefundAmountMinor !== input.allocation.amountMinor) {
      throw new Error("The public payment changed while its cancellation refund was being secured.");
    }
  }

  try {
    const refund = payment.razorpayRefundId ? await fetchRazorpayRefund(payment.razorpayRefundId) : await createRazorpayRefund({
      paymentId: payment.razorpayPaymentId,
      amountMinor: input.allocation.amountMinor,
      idempotencyKey: `SHIP_CANCEL_REFUND_${String(input.cancellationId)}_${String(payment._id)}`
    });
    assertRefundResponse(refund, { paymentId: payment.razorpayPaymentId, amountMinor: input.allocation.amountMinor });
    const completed = refund.status === "processed";
    const updated = await PublicShipmentPayment.updateOne(
      { _id: payment._id, status: "REFUND_PENDING", razorpayRefundAmountMinor: input.allocation.amountMinor },
      {
        $set: {
          razorpayRefundId: refund.id,
          status: completed ? "REFUNDED" : "REFUND_PENDING",
          refundedAt: completed ? new Date() : null,
          razorpayRefundedAt: completed ? new Date() : null,
          failureMessage: completed ? "Public shipment cancellation refund processed." : "Razorpay cancellation refund is processing."
        }
      }
    ).exec();
    if (updated.matchedCount) return completed ? "COMPLETED" : "PENDING";
  } catch (error) {
    await PublicShipmentPayment.updateOne(
      { _id: payment._id, status: "REFUND_PENDING", razorpayRefundAmountMinor: input.allocation.amountMinor },
      {
        $set: {
          failureMessage: `Cancellation refund requires reconciliation: ${error instanceof Error ? error.message : "Unknown provider error."}`.slice(0, 1000)
        }
      }
    ).exec();
    throw error;
  }

  const current = await PublicShipmentPayment.findById(payment._id).select("status razorpayRefundAmountMinor").lean().exec();
  if (current?.status === "REFUNDED" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "COMPLETED";
  if (current?.status === "REFUND_PENDING" && current.razorpayRefundAmountMinor === input.allocation.amountMinor) return "PENDING";
  throw new Error("The public payment refund state changed during reconciliation.");
}

export async function ensureCancellationGatewayRefund(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  cancellationId: mongoose.Types.ObjectId;
  amountMinor: number;
}): Promise<CancellationGatewayRefundResult> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new Error("The cancellation refund amount must be a non-negative integer minor-unit value.");
  }
  if (input.amountMinor === 0) return "COMPLETED";

  const funding = await ShipmentFunding.findOne({
    shipmentDraftId: input.shipmentDraftId,
    status: "COMPLETED"
  }).select("source sourceReferenceId").lean().exec();
  if (!funding || !["DIRECT_RAZORPAY", "PUBLIC_RAZORPAY"].includes(funding.source)) return "NOT_GATEWAY";
  if (!funding.sourceReferenceId) throw new Error("The shipment payment reference is missing.");

  const plan = await ensureRefundPlan({
    cancellationId: input.cancellationId,
    shipmentDraftId: input.shipmentDraftId,
    source: funding.source as "DIRECT_RAZORPAY" | "PUBLIC_RAZORPAY",
    sourcePaymentId: funding.sourceReferenceId,
    amountMinor: input.amountMinor
  });
  for (const allocation of plan.allocations) {
    const result = allocation.source === "DIRECT_RAZORPAY"
      ? await ensureDirectAllocationRefund({ ...input, allocation })
      : await ensurePublicAllocationRefund({ ...input, allocation });
    if (result === "PENDING") return "PENDING";
  }
  return "COMPLETED";
}
