import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { WebhookEvent } from "../models/webhookEvent.model.js";
import { findPaymentTopUpByRazorpayOrderId, markPaymentTopUpFailed, creditCapturedTopUp } from "../services/prepaid/topups.service.js";
import { hashWebhookPayload, verifyRazorpayWebhookSignature } from "../services/razorpay/signatures.js";
import { parseRazorpayWebhookPayload } from "../services/razorpay/webhook.js";
import {
  applyVerifiedCreditPayment,
  findCreditPaymentByRazorpayOrderId,
  markCreditPaymentFailed
} from "../services/creditPayment.service.js";
import { SYSTEM_ACTOR_ID } from "../utils/systemActor.js";
import { applyCapturedPublicPaymentWebhook, markPublicPaymentFailed } from "../services/publicShipmentBooking.service.js";

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
        failureReason
      }
    }
  ).exec();
}

async function recordWebhookReceipt(input: {
  providerEventId: string;
  eventType: string;
  payloadHash: string;
}) {
  try {
    await WebhookEvent.create({
      provider: "RAZORPAY",
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payloadHash: input.payloadHash,
      status: "RECEIVED"
    });

    return { shouldProcess: true as const, duplicate: false as const };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const existing = await WebhookEvent.findOne({
      provider: "RAZORPAY",
      providerEventId: input.providerEventId
    }).exec();

    if (existing?.status === "PROCESSED") {
      return { shouldProcess: false as const, duplicate: true as const };
    }

    if (existing?.status === "FAILED") {
      existing.status = "RECEIVED";
      existing.eventType = input.eventType;
      existing.payloadHash = input.payloadHash;
      existing.failureReason = "";
      existing.processedAt = null;
      await existing.save();
      return { shouldProcess: true as const, duplicate: true as const };
    }

    return { shouldProcess: false as const, duplicate: true as const };
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
    payloadHash
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

      const topUp = await findPaymentTopUpByRazorpayOrderId(orderId);
      if (topUp) {
        if (payment.amount !== topUp.amountMinor || payment.currency !== topUp.currency) {
          await markWebhookProcessed(providerEventId, "FAILED", "Payment amount or currency mismatch.");
          return response.status(400).json({ success: false, message: "Payment amount or currency mismatch." });
        }

        await creditCapturedTopUp({
          paymentTopUpId: topUp._id as mongoose.Types.ObjectId,
          razorpayPaymentId: payment.id,
          idempotencyKey: `RAZORPAY_TOPUP:${payment.id}`,
          expectedAmountMinor: payment.amount,
          expectedCurrency: topUp.currency
        });
        await markWebhookProcessed(providerEventId, "PROCESSED");
        return response.status(200).json({ success: true });
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
      const topUp = await findPaymentTopUpByRazorpayOrderId(orderId);
      if (topUp) {
        await markPaymentTopUpFailed({
          razorpayOrderId: orderId,
          razorpayPaymentId: payment?.id,
          failureCode: payment?.error_code,
          failureDescription: payment?.error_description
        });
      } else if (!await markPublicPaymentFailed(orderId, payment?.error_description || payment?.error_code || "Razorpay payment failed.")) {
        await markCreditPaymentFailed(orderId, payment?.error_description || payment?.error_code || "Razorpay payment failed.");
      }
      await markWebhookProcessed(providerEventId, "PROCESSED");
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
