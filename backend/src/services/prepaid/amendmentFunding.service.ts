import mongoose from "mongoose";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import { ShipmentAmendment } from "../../models/shipmentAmendment.model.js";
import type { AmendmentBillingAdjustment } from "../amendmentBilling.service.js";
import { refundCapturedShipmentDirectPayment } from "./shipmentDirectPayments.service.js";
import { fetchRazorpayRefund } from "../razorpay/client.js";

export class AmendmentPaymentError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = "AMENDMENT_PAYMENT_ERROR") {
    super(message);
  }
}

export async function secureAmendmentDirectPayment(input: {
  amendmentId: mongoose.Types.ObjectId;
  paymentIntentId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    let result: InstanceType<typeof ShipmentAmendment> | null = null;
    let refundRejectedCapture = false;
    await session.withTransaction(async () => {
      refundRejectedCapture = false;
      const amendment = await ShipmentAmendment.findById(input.amendmentId).session(session).exec();
      if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
      const amountMinor = storedDeltaMinor(amendment);
      if (amountMinor <= 0 || amendment.paymentAmountMinor !== amountMinor) {
        throw new AmendmentPaymentError(409, "This amendment does not require an additional payment.");
      }
      // A checkout can finish after staff rejects an unpaid request. Preserve
      // that rejection and return the captured money through the same refund.
      if (amendment.status === "REJECTED") {
        const captured = await ShipmentDirectPayment.findOne({
          _id: input.paymentIntentId,
          shipmentDraftId: amendment.shipmentDraftId,
          businessAccountId: amendment.businessAccountId,
          branchId: amendment.branchId,
          amendmentId: amendment._id,
          paymentPurpose: "SHIPMENT_AMENDMENT",
          amountMinor,
          currency: "INR",
          status: { $in: ["CAPTURED", "REFUND_PENDING", "REFUNDED"] }
        }).session(session).exec();
        if (!captured) throw new AmendmentPaymentError(409, "The rejected amendment payment could not be reconciled.");
        refundRejectedCapture = true;
        result = amendment;
        return;
      }
      if (
        ["APPROVED", "APPLIED"].includes(amendment.status)
        && amendment.paymentStatus === "COMPLETED"
        && amendment.paymentSource === "DIRECT_RAZORPAY"
        && String(amendment.paymentReferenceId) === String(input.paymentIntentId)
      ) {
        result = amendment;
        return;
      }
      if (
        amendment.status === "PAYMENT_SECURED"
        && amendment.paymentStatus === "SECURED"
        && amendment.paymentSource === "DIRECT_RAZORPAY"
        && String(amendment.paymentReferenceId) === String(input.paymentIntentId)
      ) {
        const securedPayment = await ShipmentDirectPayment.findOne({
          _id: input.paymentIntentId,
          amendmentId: amendment._id,
          paymentPurpose: "SHIPMENT_AMENDMENT",
          status: "ALLOCATED",
          amountMinor
        }).session(session).exec();
        if (!securedPayment) throw new AmendmentPaymentError(409, "The amendment payment is not available for approval.");
        result = amendment;
        return;
      }
      if (amendment.status !== "AWAITING_PAYMENT" || amendment.paymentStatus !== "AWAITING_PAYMENT") {
        throw new AmendmentPaymentError(409, "This amendment is no longer awaiting payment.");
      }
      if (amendment.paymentReferenceId && String(amendment.paymentReferenceId) !== String(input.paymentIntentId)) {
        throw new AmendmentPaymentError(409, "A different payment attempt is attached to this amendment.");
      }

      const payment = await ShipmentDirectPayment.findOne({
        _id: input.paymentIntentId,
        shipmentDraftId: amendment.shipmentDraftId,
        businessAccountId: amendment.businessAccountId,
        branchId: amendment.branchId,
        amendmentId: amendment._id,
        paymentPurpose: "SHIPMENT_AMENDMENT",
        amountMinor,
        currency: "INR",
        status: { $in: ["CAPTURED", "ALLOCATED"] }
      }).session(session).exec();
      if (!payment) throw new AmendmentPaymentError(402, "Razorpay must confirm the additional amount before approval.");
      if (payment.status === "CAPTURED") {
        const allocated = await ShipmentDirectPayment.findOneAndUpdate(
          { _id: payment._id, status: "CAPTURED", amendmentId: amendment._id },
          { $set: { status: "ALLOCATED", allocatedAt: new Date() } },
          { returnDocument: "after", runValidators: true, session }
        ).exec();
        if (!allocated) throw new AmendmentPaymentError(409, "The Razorpay payment changed while it was being secured.");
      }
      amendment.status = "PAYMENT_SECURED";
      amendment.paymentStatus = "SECURED";
      amendment.paymentSource = "DIRECT_RAZORPAY";
      amendment.paymentReferenceId = payment._id as mongoose.Types.ObjectId;
      amendment.paymentSecuredAt = new Date();
      await amendment.save({ session });
      result = amendment;
    });
    if (refundRejectedCapture) {
      const refund = await refundCapturedShipmentDirectPayment({
        paymentIntentId: input.paymentIntentId,
        reason: "Payment captured after the amendment was rejected."
      });
      if (refund?.status !== "REFUNDED") {
        throw new AmendmentPaymentError(502, "The rejected amendment payment refund is pending reconciliation.");
      }
      await ShipmentAmendment.updateOne({ _id: input.amendmentId, status: "REJECTED" }, {
        $set: { paymentStatus: "RELEASED", paymentSource: "DIRECT_RAZORPAY", paymentReferenceId: input.paymentIntentId }
      }).exec();
      return ShipmentAmendment.findById(input.amendmentId).orFail().exec();
    }
    if (!result) throw new AmendmentPaymentError(409, "Amendment payment could not be secured.");
    return result;
  } finally {
    await session.endSession();
  }
}

function storedDeltaMinor(amendment: InstanceType<typeof ShipmentAmendment>) {
  const preview = amendment.fundingPreview as { deltaAmountMinor?: unknown } | null;
  const delta = preview?.deltaAmountMinor;
  if (typeof delta !== "number" || !Number.isInteger(delta)) {
    throw new AmendmentPaymentError(409, "The amendment payment amount is unavailable. Submit the amendment again.");
  }
  return delta;
}

function settledRefundStatus(payment: InstanceType<typeof ShipmentDirectPayment>) {
  return payment.paymentPurpose === "SHIPMENT_AMENDMENT" ? "ALLOCATED" as const : "SETTLED" as const;
}

/**
 * Starts a gateway refund for an approved reduction. When no captured gateway
 * payment remains, the caller must record a manual refund instead.
 */
export async function prepareAmendmentRefund(input: {
  amendmentId: mongoose.Types.ObjectId;
  amountMinor: number;
  reason: string;
}) {
  const amendment = await ShipmentAmendment.findById(input.amendmentId).exec();
  if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
  if (input.amountMinor <= 0) return amendment;
  if (["REFUNDED", "CASH_REFUND_RECORDED"].includes(amendment.refundStatus)) return amendment;

  const payment = await ShipmentDirectPayment.findOne({
    shipmentDraftId: amendment.shipmentDraftId,
    businessAccountId: amendment.businessAccountId,
    branchId: amendment.branchId,
    paymentPurpose: { $in: ["SHIPMENT_BOOKING", "SHIPMENT_AMENDMENT"] },
    status: { $in: ["CAPTURED", "SETTLED", "ALLOCATED", "REFUND_PENDING"] },
    razorpayPaymentId: { $ne: "" },
    $expr: { $lt: ["$razorpayRefundAmountMinor", "$amountMinor"] }
  }).sort({ createdAt: -1 }).exec();

  if (!payment) {
    throw new AmendmentPaymentError(
      409,
      "No captured online payment can cover this reduction. Record a manual refund before approval.",
      "MANUAL_REFUND_REQUIRED"
    );
  }

  const targetRefundMinor = (payment.razorpayRefundAmountMinor ?? 0) + input.amountMinor;
  const refunded = await refundCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    amountMinor: input.amountMinor,
    reason: input.reason
  });
  const completed = Boolean(refunded?.razorpayRefundId)
    && (refunded?.razorpayRefundAmountMinor ?? 0) >= targetRefundMinor
    && refunded?.status !== "REFUND_PENDING";

  amendment.refundReferenceId = payment._id as mongoose.Types.ObjectId;
  amendment.refundRequestedAt = new Date();
  amendment.refundStatus = completed ? "REFUNDED" : "REFUND_PENDING";
  amendment.refundMetadata = {
    amountMinor: input.amountMinor,
    cumulativeRefundAmountMinor: refunded?.razorpayRefundAmountMinor ?? targetRefundMinor,
    razorpayRefundId: refunded?.razorpayRefundId ?? "",
    providerStatus: refunded?.status ?? "REFUND_PENDING"
  };
  await amendment.save();
  return amendment;
}

/** Refreshes a pending gateway refund before the revised invoice is allowed through. */
export async function reconcileAmendmentRefund(input: {
  amendmentId: mongoose.Types.ObjectId;
}) {
  const amendment = await ShipmentAmendment.findById(input.amendmentId).exec();
  if (!amendment || amendment.refundStatus !== "REFUND_PENDING" || !amendment.refundReferenceId) return amendment;
  const payment = await ShipmentDirectPayment.findById(amendment.refundReferenceId).exec();
  if (!payment?.razorpayRefundId) return amendment;
  const refund = await fetchRazorpayRefund(payment.razorpayRefundId);
  if (refund.status !== "processed") return amendment;

  const targetRefundMinor = payment.razorpayRefundAmountMinor;
  await ShipmentDirectPayment.updateOne(
    { _id: payment._id, status: "REFUND_PENDING" },
    {
      $set: {
        status: targetRefundMinor >= payment.amountMinor ? "REFUNDED" : settledRefundStatus(payment),
        razorpayRefundedAt: targetRefundMinor >= payment.amountMinor ? new Date() : payment.razorpayRefundedAt ?? null,
        failureDescription: "Gateway refund completed."
      }
    },
    { runValidators: true }
  ).exec();
  amendment.refundStatus = "REFUNDED";
  amendment.refundCompletedAt = new Date();
  amendment.refundMetadata = {
    ...(amendment.refundMetadata ?? {}),
    razorpayRefundId: refund.id,
    providerStatus: refund.status
  };
  await amendment.save();
  return amendment;
}

export async function recordManualAmendmentRefund(input: {
  amendmentId: mongoose.Types.ObjectId;
  reference: string;
  note: string;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const amendment = await ShipmentAmendment.findById(input.amendmentId).session(input.session).exec();
  if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
  amendment.refundStatus = "CASH_REFUND_RECORDED";
  amendment.refundCompletedAt = new Date();
  amendment.refundMetadata = {
    method: "CASH",
    reference: input.reference,
    note: input.note,
    recordedBy: String(input.createdBy)
  };
  await amendment.save({ session: input.session });
  return amendment;
}

/**
 * Settles a secured increase or verifies that a reduction has already been
 * refunded. Approved amendments never create or consume wallet funds.
 */
export async function applyAmendmentPaymentMovement(input: {
  amendmentId: mongoose.Types.ObjectId;
  adjustment: AmendmentBillingAdjustment;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const amendment = await ShipmentAmendment.findById(input.amendmentId).session(input.session).exec();
  if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
  const delta = input.adjustment.deltaAmountMinor;

  if (delta > 0) {
    if (
      amendment.paymentSource !== "DIRECT_RAZORPAY"
      || amendment.status !== "PAYMENT_SECURED"
      || amendment.paymentStatus !== "SECURED"
      || amendment.paymentAmountMinor !== delta
      || !amendment.paymentReferenceId
    ) throw new AmendmentPaymentError(402, "Complete the online amendment payment before approval.");

    const payment = await ShipmentDirectPayment.findOne({
      _id: amendment.paymentReferenceId,
      amendmentId: amendment._id,
      paymentPurpose: "SHIPMENT_AMENDMENT",
      status: "ALLOCATED",
      amountMinor: delta
    }).session(input.session).exec();
    if (!payment) throw new AmendmentPaymentError(402, "The secured online payment could not be found.");
    const settledPayment = await ShipmentDirectPayment.findOneAndUpdate(
      {
        _id: payment._id,
        amendmentId: amendment._id,
        paymentPurpose: "SHIPMENT_AMENDMENT",
        status: "ALLOCATED",
        amountMinor: delta
      },
      { $set: { status: "SETTLED" } },
      { returnDocument: "after", runValidators: true, session: input.session }
    ).exec();
    if (!settledPayment) throw new AmendmentPaymentError(409, "The amendment payment changed while approval was being applied.");
    await ShipmentAmendment.updateOne(
      { _id: amendment._id, paymentStatus: "SECURED", paymentSource: "DIRECT_RAZORPAY" },
      { $set: { paymentStatus: "COMPLETED", paymentCompletedAt: new Date() } },
      { runValidators: true, session: input.session }
    ).exec();
    return { paymentStatus: "COMPLETED" as const, refundStatus: amendment.refundStatus };
  }

  if (delta < 0) {
    if (amendment.refundStatus === "REFUND_PENDING") {
      throw new AmendmentPaymentError(409, "The amendment refund is still processing. Approval will reopen after it completes.");
    }
    if (!["REFUNDED", "CASH_REFUND_RECORDED"].includes(amendment.refundStatus)) {
      throw new AmendmentPaymentError(402, "Record the amendment refund before approval.");
    }
  }

  return { paymentStatus: amendment.paymentStatus, refundStatus: amendment.refundStatus };
}
