import type { Request, Response } from "express";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { WebhookEvent } from "../models/webhookEvent.model.js";
import { hashWebhookPayload, verifyRazorpayWebhookSignature } from "../services/razorpay/signatures.js";
import { parseRazorpayWebhookPayload } from "../services/razorpay/webhook.js";
import {
  applyVerifiedCreditPayment,
  findCreditPaymentByRazorpayOrderId,
  markCreditPaymentFailed
} from "../services/creditPayment.service.js";
import { SYSTEM_ACTOR_ID } from "../utils/systemActor.js";
import { applyCapturedPublicPaymentWebhook, markPublicPaymentFailed } from "../services/publicShipmentBooking.service.js";
import {
  applyCapturedShipmentDirectPaymentWebhook,
  markShipmentDirectPaymentFailed
} from "../services/prepaid/shipmentDirectPayments.service.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { secureAmendmentDirectPayment } from "../services/prepaid/amendmentFunding.service.js";

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

async function markWebhookProcessed(providerEventId: string, status: "PROCESSED" | "IGNORED" | "FAILED", failureReason = "") {
  await WebhookEvent.updateOne(
    { provider: "RAZORPAY", providerEventId },
    {
      $set: {
        status,
        processedAt: new Date(),
        failureReason,
        lockedAt: null,
        lockToken: ""
      }
    }
  ).exec();
}

async function recordWebhookReceipt(input: {
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}) {
  const now = new Date();
  const lockToken = crypto.randomUUID();
  try {
    await WebhookEvent.create({
      provider: "RAZORPAY",
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payloadHash: input.payloadHash,
      payload: input.payload,
      status: "RECEIVED",
      attemptCount: 1,
      lockedAt: now,
      lockToken
    });

    return { shouldProcess: true as const, duplicate: false as const };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const existing = await WebhookEvent.findOne({
      provider: "RAZORPAY",
      providerEventId: input.providerEventId
    }).exec();

    if (!existing) throw error;
    if (existing.payloadHash !== input.payloadHash) {
      throw new Error("A Razorpay event id was reused with a different payload.");
    }
    if (existing.status === "PROCESSED") {
      return { shouldProcess: false as const, duplicate: true as const };
    }
    const staleBefore = new Date(now.getTime() - 2 * 60 * 1000);
    if (existing.status === "RECEIVED" && existing.lockedAt && existing.lockedAt > staleBefore) {
      return { shouldProcess: false as const, duplicate: true as const };
    }
    const claimed = await WebhookEvent.findOneAndUpdate(
      {
        _id: existing._id,
        status: { $in: ["RECEIVED", "FAILED", "IGNORED"] },
        $or: [{ lockedAt: null }, { lockedAt: { $lte: staleBefore } }]
      },
      {
        $set: {
          status: "RECEIVED",
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          payload: input.payload,
          failureReason: "",
          processedAt: null,
          lockedAt: now,
          lockToken
        },
        $inc: { attemptCount: 1 }
      },
      { returnDocument: "after", runValidators: true }
    ).exec();
    return { shouldProcess: Boolean(claimed), duplicate: true as const };
  }
}

export async function handleRazorpayWebhook(request: Request, response: Response): Promise<Response> {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return response.status(500).json({ success: false, message: "Razorpay webhook secret is not configured." });
  }

  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
  const signature = getHeaderValue(request.headers["x-razorpay-signature"]);
  const providerEventId = getHeaderValue(request.headers["x-razorpay-event-id"]);

  if (!providerEventId) return response.status(400).json({ success: false, message: "Razorpay event id is required." });
  if (!signature) return response.status(400).json({ success: false, message: "Razorpay signature is required." });

  const verified = verifyRazorpayWebhookSignature({
    rawBody,
    signature,
    secret: env.RAZORPAY_WEBHOOK_SECRET
  });

  if (!verified) return response.status(400).json({ success: false, message: "Invalid Razorpay webhook signature." });

  const payloadHash = hashWebhookPayload(rawBody);
  let payload;

  try {
    payload = parseRazorpayWebhookPayload(rawBody);
  } catch {
    return response.status(400).json({ success: false, message: "Invalid Razorpay webhook payload." });
  }

  const receipt = await recordWebhookReceipt({
    providerEventId,
    eventType: payload.event,
    payloadHash,
    payload: payload as unknown as Record<string, unknown>
  });

  if (!receipt.shouldProcess) {
    return response.status(200).json({ success: true, duplicate: receipt.duplicate });
  }

  try {
    const payment = payload.payload?.payment?.entity;
    const order = payload.payload?.order?.entity;
    const orderId = payment?.order_id || order?.id || "";

    if (payload.event === "payment.captured" || payload.event === "order.paid") {
      if (!payment?.id || !orderId) {
        await markWebhookProcessed(providerEventId, "IGNORED", "Captured event did not include a payment id and order id.");
        return response.status(200).json({ success: true, ignored: true });
      }

      const handledPublicBooking = await applyCapturedPublicPaymentWebhook({
        orderId,
        paymentId: payment.id,
        amountMinor: payment.amount,
        currency: payment.currency,
      });
      if (handledPublicBooking) {
        await markWebhookProcessed(providerEventId, "PROCESSED");
        return response.status(200).json({ success: true });
      }

      const handledDirectPayment = await applyCapturedShipmentDirectPaymentWebhook({
        orderId,
        paymentId: payment.id,
        amountMinor: payment.amount,
        currency: payment.currency
      });
      if (handledDirectPayment) {
        const directPayment = await ShipmentDirectPayment.findOne({ razorpayOrderId: orderId })
          .select("paymentPurpose amendmentId _id")
          .lean()
          .exec();
        if (directPayment?.paymentPurpose === "SHIPMENT_AMENDMENT" && directPayment.amendmentId) {
          await secureAmendmentDirectPayment({
            amendmentId: directPayment.amendmentId,
            paymentIntentId: directPayment._id
          });
        }
        await markWebhookProcessed(providerEventId, "PROCESSED");
        return response.status(200).json({ success: true });
      }

      const creditPayment = await findCreditPaymentByRazorpayOrderId(orderId);
      if (!creditPayment) {
        await markWebhookProcessed(providerEventId, "IGNORED", "No matching portal payment found.");
        return response.status(200).json({ success: true, ignored: true });
      }
      if (payment.amount !== creditPayment.amountMinor || payment.currency !== creditPayment.currency) {
        await markWebhookProcessed(providerEventId, "FAILED", "Payment amount or currency mismatch.");
        return response.status(400).json({ success: false, message: "Payment amount or currency mismatch." });
      }

      await applyVerifiedCreditPayment({
        paymentId: creditPayment._id as mongoose.Types.ObjectId,
        // Automated gateway confirmation is a system action, not something the
        // client who paid "verified" themselves.
        verifiedBy: SYSTEM_ACTOR_ID,
        razorpayPaymentId: payment.id,
      });
      await markWebhookProcessed(providerEventId, "PROCESSED");

      return response.status(200).json({ success: true });
    }

    if (payload.event === "payment.failed") {
      if (await markShipmentDirectPaymentFailed(
        orderId,
        payment?.id ?? "",
        payment?.error_code,
        payment?.error_description || payment?.error_code || "Razorpay payment failed."
      )) {
        // The direct shipment payment was marked failed.
      } else if (!await markPublicPaymentFailed(orderId, payment?.error_description || payment?.error_code || "Razorpay payment failed.")) {
        await markCreditPaymentFailed(orderId, payment?.error_description || payment?.error_code || "Razorpay payment failed.");
      }
      await markWebhookProcessed(providerEventId, "PROCESSED");
      return response.status(200).json({ success: true });
    }

    if (payload.event === "refund.processed" || payload.event === "refund.failed") {
      const refund = payload.payload?.refund?.entity;
      if (!refund?.payment_id) {
        await markWebhookProcessed(providerEventId, "IGNORED", "Refund event did not include a payment id.");
        return response.status(200).json({ success: true, ignored: true });
      }
      const processed = payload.event === "refund.processed";
      const status = processed ? "REFUNDED" : "REFUND_PENDING";
      const now = new Date();
      const publicRefundState = {
        status,
        razorpayRefundId: refund.id,
        razorpayRefundAmountMinor: refund.amount,
        refundedAt: processed ? now : null,
        razorpayRefundedAt: processed ? now : null,
        failureMessage: processed
          ? "Razorpay refund processed."
          : "Razorpay refund failed and requires reconciliation."
      };
      const processedRefundStatuses = ["REFUND_PENDING", "SETTLED", "ALLOCATED", "REFUNDED"] as const;
      const directRefundFilter = {
        razorpayPaymentId: refund.payment_id,
        status: {
          $in: processed
            ? [...processedRefundStatuses]
            : ["REFUND_PENDING" as const]
        },
        $or: [{ razorpayRefundId: "" }, { razorpayRefundId: refund.id }],
        ...(processed ? { $expr: { $gte: ["$razorpayRefundAmountMinor", refund.amount] } } : {})
      };
      // Refunds can be partial. The cumulative amount is already on the payment,
      // so the webhook only confirms the gateway event and downgrades the status
      // back to SETTLED/ALLOCATED until the full captured amount is returned.
      const directRefundUpdate = processed
        ? [{
            $set: {
              status: {
                $cond: [
                  { $gte: ["$razorpayRefundAmountMinor", "$amountMinor"] },
                  "REFUNDED",
                  { $cond: [{ $eq: ["$paymentPurpose", "SHIPMENT_AMENDMENT"] }, "ALLOCATED", "SETTLED"] }
                ]
              },
              razorpayRefundId: refund.id,
              razorpayRefundedAt: {
                $cond: [{ $gte: ["$razorpayRefundAmountMinor", "$amountMinor"] }, now, null]
              },
              failureDescription: "Razorpay refund processed."
            }
          }]
        : {
            $set: {
              razorpayRefundId: refund.id,
              failureDescription: "Razorpay refund failed and requires reconciliation."
            }
          };
      const [directResult, publicResult] = await Promise.all([
        ShipmentDirectPayment.updateOne(
          directRefundFilter,
          directRefundUpdate,
          { runValidators: true }
        ).exec(),
        PublicShipmentPayment.updateOne(
          {
            razorpayPaymentId: refund.payment_id,
            status: { $in: status === "REFUNDED" ? ["REFUND_PENDING", "REFUNDED"] : ["REFUND_PENDING"] },
            razorpayRefundAmountMinor: refund.amount,
            $or: [{ razorpayRefundId: "" }, { razorpayRefundId: refund.id }]
          },
          { $set: publicRefundState },
          { runValidators: true }
        ).exec()
      ]);
      const matched = Boolean(directResult.matchedCount || publicResult.matchedCount);
      const knownPayment = matched || await Promise.all([
        ShipmentDirectPayment.exists({ razorpayPaymentId: refund.payment_id }),
        PublicShipmentPayment.exists({ razorpayPaymentId: refund.payment_id })
      ]).then((results) => results.some(Boolean));
      await markWebhookProcessed(
        providerEventId,
        matched ? "PROCESSED" : knownPayment ? "FAILED" : "IGNORED",
        matched
          ? ""
          : knownPayment
            ? "Refund event did not match a pending refund amount or status; payment remains unchanged for reconciliation."
            : "No matching refundable portal payment found."
      );
      return response.status(200).json({ success: true });
    }

    await markWebhookProcessed(providerEventId, "IGNORED", `Unhandled event type: ${payload.event}`);
    return response.status(200).json({ success: true, ignored: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    await markWebhookProcessed(providerEventId, "FAILED", message);
    throw error;
  }
}
