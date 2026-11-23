import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import { canAccessBranch } from "../middleware/branchAccess.middleware.js";
import { BusinessAccountMember, shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { getRazorpayPublicConfig } from "../services/razorpay/client.js";
import { verifyRazorpayCheckoutSignature } from "../services/razorpay/signatures.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import { buildPricingInputFromDraft, calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import {
  createShipmentDirectPayment,
  reconcileShipmentDirectPayment
} from "../services/prepaid/shipmentDirectPayments.service.js";

const createSchema = z.object({
  acceptedPricingHash: z.string().trim().min(1).max(128)
});

const verifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(120),
  razorpay_payment_id: z.string().trim().min(1).max(120),
  razorpay_signature: z.string().trim().min(1).max(256)
});

function userIdFrom(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function serialize(payment: InstanceType<typeof ShipmentDirectPayment>) {
  return {
    id: String(payment._id),
    shipmentDraftId: String(payment.shipmentDraftId),
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    pricingHash: payment.pricingHash,
    razorpayOrderId: payment.razorpayOrderId,
    razorpayPaymentId: payment.razorpayPaymentId,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt
  };
}

async function loadDraftForPayment(request: Request, client: boolean) {
  const userId = userIdFrom(request);
  const draftId = String(request.params.id ?? "");
  if (!userId || !mongoose.Types.ObjectId.isValid(draftId)) return null;

  const draft = await ShipmentDraft.findOne({
    _id: draftId,
    bookingState: { $in: ["EDITABLE", "BOOKING"] },
    deletedAt: null
  }).exec();
  if (!draft) return null;

  if (client) {
    const membership = await BusinessAccountMember.findOne({
      user: userId,
      businessAccount: draft.businessAccountId,
      status: "active",
      role: { $in: shipmentBookingRoles }
    }).select("assignedBranches role").lean().exec();
    if (!membership) return null;
    if (
      membership.role !== "account_owner"
      && membership.role !== "account_admin"
      && membership.assignedBranches.length
      && !membership.assignedBranches.some((branchId) => String(branchId) === String(draft.branchId))
    ) return null;
  } else if (!canAccessBranch(request, draft.branchId)) {
    return null;
  }

  return { draft, userId };
}

async function createPayment(request: Request, response: Response, client: boolean) {
  const parsed = createSchema.safeParse(request.body ?? {});
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });
  const access = await loadDraftForPayment(request, client);
  if (!access) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const idempotencyKey = request.header("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 160) {
    return response.status(400).json({ success: false, message: "Idempotency-Key header is required." });
  }

  const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(access.draft));
  if (pricing.missingRate) return response.status(409).json({ success: false, message: "Rates are not available for this shipment." });
  const pricingHash = buildPricingHash(pricing);
  if (pricingHash !== parsed.data.acceptedPricingHash) {
    return response.status(409).json({
      success: false,
      code: "SHIPMENT_PRICE_CHANGED",
      message: "The shipment price changed. Review the updated total before paying.",
      pricing,
      pricingHash
    });
  }

  try {
    const result = await createShipmentDirectPayment({
      businessAccountId: access.draft.businessAccountId,
      branchId: access.draft.branchId,
      shipmentDraftId: access.draft._id as mongoose.Types.ObjectId,
      clientUserId: client ? access.userId : null,
      amountMinor: Math.round(pricing.totalAmount * 100),
      pricingHash,
      pricingRevision: access.draft.__v ?? 0,
      idempotencyKey
    });
    if (!result.payment.razorpayOrderId) {
      return response.status(202).json({
        success: true,
        message: "Payment order creation is in progress. Please retry this request with the same Idempotency-Key.",
        payment: serialize(result.payment)
      });
    }
    return response.status(result.created ? 201 : 200).json({
      success: true,
      duplicate: !result.created,
      razorpay: getRazorpayPublicConfig(),
      payment: serialize(result.payment)
    });
  } catch (error) {
    return response.status(409).json({ success: false, message: error instanceof Error ? error.message : "Shipment payment could not be created." });
  }
}

async function verifyPayment(request: Request, response: Response, client: boolean) {
  const parsed = verifySchema.safeParse(request.body ?? {});
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });
  const access = await loadDraftForPayment(request, client);
  if (!access) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  if (!env.RAZORPAY_KEY_SECRET) return response.status(500).json({ success: false, message: "Razorpay credentials are not configured." });

  const intent = await ShipmentDirectPayment.findOne({
    shipmentDraftId: access.draft._id,
    razorpayOrderId: parsed.data.razorpay_order_id
  }).exec();
  if (!intent) return response.status(404).json({ success: false, message: "Shipment payment not found" });

  const verified = verifyRazorpayCheckoutSignature({
    orderId: parsed.data.razorpay_order_id,
    paymentId: parsed.data.razorpay_payment_id,
    signature: parsed.data.razorpay_signature,
    secret: env.RAZORPAY_KEY_SECRET
  });
  if (!verified) return response.status(400).json({ success: false, message: "Invalid Razorpay signature." });

  try {
    const result = await reconcileShipmentDirectPayment({
      paymentIntentId: intent._id as mongoose.Types.ObjectId,
      razorpayPaymentId: parsed.data.razorpay_payment_id,
      razorpaySignature: parsed.data.razorpay_signature
    });
    if (!result.captured) {
      return response.status(202).json({
        success: true,
        message: "Payment verification is pending. Your shipment can be booked after confirmation.",
        payment: serialize(result.payment)
      });
    }
    return response.status(200).json({
      success: true,
      message: "Payment confirmed. You can now create this shipment.",
      payment: serialize(result.payment)
    });
  } catch (error) {
    return response.status(502).json({
      success: false,
      message: error instanceof Error ? error.message : "Payment verification failed."
    });
  }
}

export function createStaffShipmentDirectPayment(request: Request, response: Response) {
  return createPayment(request, response, false);
}

export function verifyStaffShipmentDirectPayment(request: Request, response: Response) {
  return verifyPayment(request, response, false);
}

export function createClientShipmentDirectPayment(request: Request, response: Response) {
  return createPayment(request, response, true);
}

export function verifyClientShipmentDirectPayment(request: Request, response: Response) {
  return verifyPayment(request, response, true);
}
