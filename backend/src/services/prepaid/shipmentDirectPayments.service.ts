import mongoose from "mongoose";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import type { ShipmentDirectPaymentPurpose } from "../../models/shipmentDirectPayment.model.js";
import { ShipmentFunding } from "../../models/shipmentFunding.model.js";
import {
  captureRazorpayPayment,
  createRazorpayRefund,
  createRazorpayOrder,
  fetchRazorpayPayment
} from "../razorpay/client.js";

function assertPositiveMinor(amountMinor: number) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("The shipment payment amount must be a positive integer minor-unit value.");
  }
}

function assertIntentMatches(existing: InstanceType<typeof ShipmentDirectPayment>, input: {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  paymentPurpose?: ShipmentDirectPaymentPurpose;
  amendmentId?: mongoose.Types.ObjectId | null;
  clientUserId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
  pricingHash: string;
  pricingRevision: number;
}) {
  // The intent belongs to the authorized shipment and accepted price, not the
  // particular member who retries it or an unrelated draft __v increment.
  // The controller rechecks account membership and the current server price.
  if (
    String(existing.businessAccountId) !== String(input.businessAccountId)
    || String(existing.branchId) !== String(input.branchId)
    || String(existing.shipmentDraftId) !== String(input.shipmentDraftId)
    || existing.paymentPurpose !== (input.paymentPurpose ?? "SHIPMENT_BOOKING")
    || String(existing.amendmentId ?? "") !== String(input.amendmentId ?? "")
    || existing.amountMinor !== input.amountMinor
    || existing.pricingHash !== input.pricingHash
  ) throw new Error("Idempotency-Key was already used for a different shipment payment.");
}

async function createRazorpayOrderForIntent(
  payment: InstanceType<typeof ShipmentDirectPayment>,
  input: {
    businessAccountId: mongoose.Types.ObjectId;
    shipmentDraftId: mongoose.Types.ObjectId;
    paymentPurpose?: ShipmentDirectPaymentPurpose;
    amendmentId?: mongoose.Types.ObjectId | null;
    amountMinor: number;
  }
) {
  const purpose = input.paymentPurpose ?? "SHIPMENT_BOOKING";
  try {
    const order = await createRazorpayOrder({
      amountMinor: input.amountMinor,
      currency: "INR",
      receipt: payment.internalReference,
      notes: {
        purpose,
        shipmentDraftId: String(input.shipmentDraftId),
        businessAccountId: String(input.businessAccountId),
        paymentIntentId: String(payment._id),
        ...(input.amendmentId ? { amendmentId: String(input.amendmentId) } : {})
      }
    });
    const updated = await ShipmentDirectPayment.findOneAndUpdate(
      { _id: payment._id, status: "ORDER_CREATING", razorpayOrderId: "" },
      { $set: { razorpayOrderId: order.id, status: "ORDER_CREATED" } },
      { returnDocument: "after", runValidators: true }
    ).exec();
    if (!updated) throw new Error("Razorpay order could not be attached to the shipment payment intent.");
    return updated;
  } catch (error) {
    await ShipmentDirectPayment.updateOne(
      { _id: payment._id, status: "ORDER_CREATING", razorpayOrderId: "" },
      { $set: { status: "FAILED", failureDescription: error instanceof Error ? error.message : "Razorpay order creation failed." } },
      { runValidators: true }
    ).exec();
    throw error;
  }
}

export async function createShipmentDirectPayment(input: {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  paymentPurpose?: ShipmentDirectPaymentPurpose;
  amendmentId?: mongoose.Types.ObjectId | null;
  clientUserId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
  pricingHash: string;
  pricingRevision: number;
  idempotencyKey: string;
}) {
  assertPositiveMinor(input.amountMinor);
  const existing = await ShipmentDirectPayment.findOne({ idempotencyKey: input.idempotencyKey }).exec();
  if (existing) {
    assertIntentMatches(existing, input);
    if (existing.status !== "FAILED") return { created: false as const, payment: existing };

    if (existing.razorpayOrderId) {
      const reopened = await ShipmentDirectPayment.findOneAndUpdate(
        { _id: existing._id, status: "FAILED", razorpayOrderId: existing.razorpayOrderId },
        {
          $set: {
            status: "ORDER_CREATED",
            razorpayPaymentId: "",
            razorpaySignature: "",
            failureCode: "",
            failureDescription: ""
          }
        },
        { returnDocument: "after", runValidators: true }
      ).exec();
      if (reopened) return { created: false as const, payment: reopened };
      const current = await ShipmentDirectPayment.findById(existing._id).exec();
      if (!current) throw new Error("Shipment payment intent disappeared while retrying.");
      assertIntentMatches(current, input);
      return { created: false as const, payment: current };
    }

    const retry = await ShipmentDirectPayment.findOneAndUpdate(
      { _id: existing._id, status: "FAILED", razorpayOrderId: "" },
      {
        $set: {
          status: "ORDER_CREATING",
          failureCode: "",
          failureDescription: ""
        }
      },
      { returnDocument: "after", runValidators: true }
    ).exec();
    if (!retry) {
      const current = await ShipmentDirectPayment.findById(existing._id).exec();
      if (!current) throw new Error("Shipment payment intent disappeared while retrying.");
      assertIntentMatches(current, input);
      return { created: false as const, payment: current };
    }
    return {
      created: false as const,
      payment: await createRazorpayOrderForIntent(retry, input)
    };
  }

  const paymentId = new mongoose.Types.ObjectId();
  const purpose = input.paymentPurpose ?? "SHIPMENT_BOOKING";
  if ((purpose === "SHIPMENT_AMENDMENT") !== Boolean(input.amendmentId)) {
    throw new Error("An amendment payment must include its amendment reference.");
  }
  const internalReference = `${purpose === "SHIPMENT_AMENDMENT" ? "AMD" : "SHIP"}-${paymentId.toString().slice(-10).toUpperCase()}`;
  let payment: InstanceType<typeof ShipmentDirectPayment> | undefined;
  try {
    [payment] = await ShipmentDirectPayment.create([{
      _id: paymentId,
      ...input,
      paymentPurpose: purpose,
      amendmentId: input.amendmentId ?? null,
      clientUserId: input.clientUserId ?? null,
      currency: "INR",
      internalReference,
      status: "ORDER_CREATING"
    }]);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000)) throw error;
    const raced = await ShipmentDirectPayment.findOne({ idempotencyKey: input.idempotencyKey }).exec();
    if (!raced) throw error;
    assertIntentMatches(raced, input);
    return { created: false as const, payment: raced };
  }
  if (!payment) throw new Error("Shipment payment intent could not be created.");

  return {
    created: true as const,
    payment: await createRazorpayOrderForIntent(payment, input)
  };
}

export async function recordCapturedShipmentDirectPayment(input: {
  paymentIntentId: mongoose.Types.ObjectId;
  razorpayPaymentId: string;
  razorpaySignature?: string;
  expectedOrderId: string;
  expectedAmountMinor: number;
  expectedCurrency: string;
}) {
  if (input.expectedCurrency !== "INR") throw new Error("Razorpay payment currency does not match this shipment payment.");
  const payment = await ShipmentDirectPayment.findById(input.paymentIntentId).exec();
  if (!payment) throw new Error("Shipment payment intent was not found.");
  if (
    payment.razorpayOrderId !== input.expectedOrderId
    || payment.amountMinor !== input.expectedAmountMinor
    || payment.currency !== input.expectedCurrency
  ) throw new Error("Razorpay payment details do not match this shipment payment.");
  if (["CAPTURED", "ALLOCATED", "SETTLED", "REFUND_PENDING", "REFUNDED"].includes(payment.status)) {
    if (payment.razorpayPaymentId !== input.razorpayPaymentId) {
      throw new Error("A different Razorpay payment is already attached to this shipment payment intent.");
    }
    return payment;
  }

  const updated = await ShipmentDirectPayment.findOneAndUpdate(
    {
      _id: payment._id,
      status: { $in: ["ORDER_CREATED", "PROCESSING"] },
      $or: [{ razorpayPaymentId: "" }, { razorpayPaymentId: input.razorpayPaymentId }]
    },
    {
      $set: {
        status: "CAPTURED",
        razorpayPaymentId: input.razorpayPaymentId,
        razorpaySignature: input.razorpaySignature ?? payment.razorpaySignature,
        capturedAt: new Date(),
        failureCode: "",
        failureDescription: ""
      }
    },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) throw new Error("Shipment payment could not be marked captured.");
  return updated;
}

export async function reconcileShipmentDirectPayment(input: {
  paymentIntentId: mongoose.Types.ObjectId;
  razorpayPaymentId: string;
  razorpaySignature?: string;
}) {
  const intent = await ShipmentDirectPayment.findById(input.paymentIntentId).exec();
  if (!intent) throw new Error("Shipment payment intent was not found.");
  if (!intent.razorpayOrderId) throw new Error("Shipment payment order is still being created.");

  let payment = await fetchRazorpayPayment(input.razorpayPaymentId);
  if (
    payment.order_id !== intent.razorpayOrderId
    || payment.amount !== intent.amountMinor
    || payment.currency !== intent.currency
  ) throw new Error("Razorpay payment details do not match this shipment payment.");

  await ShipmentDirectPayment.updateOne(
    { _id: intent._id, status: "ORDER_CREATED" },
    { $set: { status: "PROCESSING", razorpayPaymentId: payment.id, razorpaySignature: input.razorpaySignature ?? "" } },
    { runValidators: true }
  ).exec();

  if (payment.status === "authorized") {
    try {
      payment = await captureRazorpayPayment({ paymentId: payment.id, amountMinor: intent.amountMinor, currency: "INR" });
    } catch (captureError) {
      payment = await fetchRazorpayPayment(payment.id);
      if (payment.status !== "captured") throw captureError;
    }
  }
  if (payment.status !== "captured") return { captured: false as const, payment: intent };

  return {
    captured: true as const,
    payment: await recordCapturedShipmentDirectPayment({
      paymentIntentId: intent._id as mongoose.Types.ObjectId,
      razorpayPaymentId: payment.id,
      razorpaySignature: input.razorpaySignature,
      expectedOrderId: payment.order_id,
      expectedAmountMinor: payment.amount,
      expectedCurrency: payment.currency
    })
  };
}

export async function applyCapturedShipmentDirectPaymentWebhook(input: {
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
}) {
  const intent = await ShipmentDirectPayment.findOne({ razorpayOrderId: input.orderId }).exec();
  if (!intent) return false;
  await recordCapturedShipmentDirectPayment({
    paymentIntentId: intent._id as mongoose.Types.ObjectId,
    razorpayPaymentId: input.paymentId,
    expectedOrderId: input.orderId,
    expectedAmountMinor: input.amountMinor,
    expectedCurrency: input.currency
  });
  return true;
}

export function buildShipmentDirectPaymentFailureTransition(input: {
  orderId: string;
  paymentId: string;
  code?: string;
  description?: string;
}): {
  filter: {
    razorpayOrderId: string;
    status: { $in: Array<"ORDER_CREATED" | "PROCESSING"> };
    $or: Array<{ razorpayPaymentId: string }>;
  };
  update: {
    $set: {
      status: "ORDER_CREATED";
      razorpayPaymentId: string;
      razorpaySignature: string;
      failureCode: string;
      failureDescription: string;
    };
  };
} | null {
  if (!input.orderId || !input.paymentId) return null;
  return {
    filter: {
      razorpayOrderId: input.orderId,
      status: { $in: ["ORDER_CREATED", "PROCESSING"] },
      $or: [{ razorpayPaymentId: "" }, { razorpayPaymentId: input.paymentId }]
    },
    update: {
      $set: {
        status: "ORDER_CREATED" as const,
        razorpayPaymentId: "",
        razorpaySignature: "",
        failureCode: input.code ?? "",
        failureDescription: input.description ?? ""
      }
    }
  };
}

export async function markShipmentDirectPaymentFailed(orderId: string, paymentId: string, code = "", description = "") {
  const transition = buildShipmentDirectPaymentFailureTransition({ orderId, paymentId, code, description });
  if (!transition) return null;
  return ShipmentDirectPayment.findOneAndUpdate(
    transition.filter,
    transition.update,
    { returnDocument: "after", runValidators: true }
  ).exec();
}

/** Refund an unallocated booking payment or a secured amendment before rejection. */
export async function refundCapturedShipmentDirectPayment(input: {
  paymentIntentId: mongoose.Types.ObjectId;
  reason: string;
}) {
  const intent = await ShipmentDirectPayment.findById(input.paymentIntentId).exec();
  if (!intent) throw new Error("Shipment payment intent was not found.");
  if (intent.status === "REFUNDED") return intent;
  const amendmentRefund = intent.paymentPurpose === "SHIPMENT_AMENDMENT" && intent.status === "ALLOCATED";
  if (!amendmentRefund && !["CAPTURED", "REFUND_PENDING"].includes(intent.status)) {
    throw new Error("Only an unallocated captured payment can be refunded.");
  }
  if (!intent.razorpayPaymentId) throw new Error("Captured Razorpay payment ID is missing.");
  if (intent.status === "REFUND_PENDING" && intent.razorpayRefundAmountMinor !== 0
    && intent.razorpayRefundAmountMinor !== intent.amountMinor) {
    throw new Error("A different Razorpay refund amount is already pending for this payment.");
  }

  const claim = await ShipmentDirectPayment.updateOne(
    {
      _id: intent._id,
      status: amendmentRefund ? { $in: ["ALLOCATED", "REFUND_PENDING"] } : { $in: ["CAPTURED", "REFUND_PENDING"] },
      ...(intent.status === "REFUND_PENDING" ? { razorpayRefundAmountMinor: { $in: [0, intent.amountMinor] } } : {})
    },
    { $set: { status: "REFUND_PENDING", razorpayRefundAmountMinor: intent.amountMinor, failureDescription: input.reason } },
    { runValidators: true }
  ).exec();
  if (!claim.matchedCount) {
    const current = await ShipmentDirectPayment.findById(intent._id).exec();
    if (current?.status === "REFUNDED" && current.razorpayRefundAmountMinor === intent.amountMinor) return current;
    if (current?.status !== "REFUND_PENDING" || current.razorpayRefundAmountMinor !== intent.amountMinor) {
      throw new Error("The shipment payment changed and can no longer be refunded.");
    }
  }

  try {
    const refund = await createRazorpayRefund({
      paymentId: intent.razorpayPaymentId,
      amountMinor: intent.amountMinor,
      idempotencyKey: `SHIPMENT_REFUND_${String(intent._id)}`
    });
    if (refund.payment_id !== intent.razorpayPaymentId || refund.amount !== intent.amountMinor || refund.currency !== "INR") {
      throw new Error("Razorpay refund details did not match this amendment payment.");
    }
    await ShipmentDirectPayment.updateOne(
      { _id: intent._id, status: "REFUND_PENDING" },
      {
        $set: {
          razorpayRefundId: refund.id,
          razorpayRefundAmountMinor: intent.amountMinor,
          status: refund.status === "processed" ? "REFUNDED" : "REFUND_PENDING",
          razorpayRefundedAt: refund.status === "processed" ? new Date() : null,
          failureDescription: refund.status === "processed" ? input.reason : "Razorpay refund is processing."
        }
      },
      { runValidators: true }
    ).exec();
  } catch (error) {
    await ShipmentDirectPayment.updateOne(
      { _id: intent._id, status: "REFUND_PENDING" },
      { $set: { failureDescription: `${input.reason} Refund requires reconciliation: ${error instanceof Error ? error.message : "Unknown provider error."}`.slice(0, 500) } },
      { runValidators: true }
    ).exec();
  }

  return ShipmentDirectPayment.findById(intent._id).exec();
}

/** Reconcile a captured checkout when booking ended before funding was secured. */
export async function refundUnallocatedShipmentDirectPayment(input: {
  paymentIntentId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  clientUserId?: mongoose.Types.ObjectId | null;
  reason: string;
}) {
  const intent = await ShipmentDirectPayment.findOne({
    _id: input.paymentIntentId,
    shipmentDraftId: input.shipmentDraftId,
    ...(input.clientUserId !== undefined ? { clientUserId: input.clientUserId } : {})
  }).exec();
  if (!intent) return null;

  const [funding, shipment] = await Promise.all([
    ShipmentFunding.findOne({ source: "DIRECT_RAZORPAY", sourceReferenceId: intent._id }).select("_id").lean().exec(),
    DpdShipment.findOne({ shipmentDraftId: input.shipmentDraftId }).select("_id").lean().exec()
  ]);
  if (funding || shipment) return intent;
  if (!["CAPTURED", "REFUND_PENDING", "REFUNDED"].includes(intent.status)) return intent;

  return refundCapturedShipmentDirectPayment({
    paymentIntentId: intent._id as mongoose.Types.ObjectId,
    reason: input.reason
  });
}
