import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { EmailOutbox, type EmailOutboxStatus } from "../models/emailOutbox.model.js";
import { EmailSuppression, type EmailSuppressionReason } from "../models/emailSuppression.model.js";
import { Tenant } from "../models/tenant.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

type SnsEnvelope = {
  Type?: string;
  SubscribeURL?: string;
  Message?: string;
  TopicArn?: string;
};

type SesEventRecipient = {
  emailAddress?: string;
  diagnosticCode?: string;
};

type SesEvent = {
  eventType?: string;
  mail?: { messageId?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesEventRecipient[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: SesEventRecipient[];
  };
};

// Three soft bounces to one address is no longer transient.
const softBounceSuppressionThreshold = 3;

async function suppress(email: string, reason: EmailSuppressionReason, detail: string, sesMessageId: string) {
  await EmailSuppression.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $set: { reason, detail: detail.slice(0, 1000), sesMessageId, suppressedAt: new Date() },
      $setOnInsert: { email: email.toLowerCase() }
    },
    { upsert: true }
  ).exec();
}

async function recordSoftBounce(email: string, detail: string, sesMessageId: string) {
  const record = await EmailSuppression.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $inc: { softBounceCount: 1 },
      $set: { detail: detail.slice(0, 1000), sesMessageId },
      $setOnInsert: { email: email.toLowerCase(), reason: "SOFT_BOUNCE_LIMIT", suppressedAt: new Date() }
    },
    { upsert: true, returnDocument: "after" }
  ).exec();

  // Below the threshold the row exists only as a counter, so it must not block
  // sending. Clearing suppressedAt is not enough: the dispatcher matches on the
  // document, so the row is removed until the count justifies keeping it.
  if (record && record.softBounceCount < softBounceSuppressionThreshold) {
    await EmailSuppression.deleteOne({ _id: record._id }).exec();
  }
}

async function markOutboxStatus(sesMessageId: string, status: EmailOutboxStatus, lastError: string) {
  if (!sesMessageId) return;

  // SES message IDs are global to the transport, so discovery is a deliberate
  // system-level read. Every mutation then re-enters the owner's tenant scope.
  const rows = await EmailOutbox.collection.find(
    { sesMessageId },
    { projection: { _id: 1, tenantId: 1 } }
  ).toArray();

  for (const row of rows) {
    if (!mongoose.isValidObjectId(row.tenantId)) {
      throw new Error("Email outbox row has no valid tenant owner.");
    }
    const tenantId = new mongoose.Types.ObjectId(String(row.tenantId));
    const tenant = await Tenant.findById(tenantId).select("_id kind").lean().exec();
    if (!tenant) throw new Error("Email outbox tenant owner was not found.");

    await runWithTenantContext({ tenantId, kind: tenant.kind }, async () => {
      await EmailOutbox.updateOne(
        { _id: row._id },
        { $set: { status, lastError: lastError.slice(0, 1000) } }
      ).exec();
    });
  }
}

async function handleSesEvent(event: SesEvent) {
  const sesMessageId = event.mail?.messageId ?? "";

  if (event.eventType === "Bounce") {
    const permanent = event.bounce?.bounceType === "Permanent";
    const detail = `${event.bounce?.bounceType ?? "Bounce"}/${event.bounce?.bounceSubType ?? "Unknown"}`;

    for (const recipient of event.bounce?.bouncedRecipients ?? []) {
      if (!recipient.emailAddress) continue;
      const reasonDetail = `${detail} ${recipient.diagnosticCode ?? ""}`.trim();
      if (permanent) await suppress(recipient.emailAddress, "HARD_BOUNCE", reasonDetail, sesMessageId);
      else await recordSoftBounce(recipient.emailAddress, reasonDetail, sesMessageId);
    }

    await markOutboxStatus(sesMessageId, "BOUNCED", detail);
    return;
  }

  if (event.eventType === "Complaint") {
    const detail = event.complaint?.complaintFeedbackType ?? "complaint";
    for (const recipient of event.complaint?.complainedRecipients ?? []) {
      if (!recipient.emailAddress) continue;
      // A complaint is never retried and never re-mailed: it is the strongest
      // possible signal, and complaint rate is what suspends an SES account.
      await suppress(recipient.emailAddress, "COMPLAINT", detail, sesMessageId);
    }

    await markOutboxStatus(sesMessageId, "COMPLAINED", detail);
    return;
  }

  if (event.eventType === "Delivery") {
    await markOutboxStatus(sesMessageId, "DELIVERED", "");
    return;
  }

  if (event.eventType === "Reject" || event.eventType === "RenderingFailure") {
    await markOutboxStatus(sesMessageId, "FAILED", event.eventType);
  }
}

/**
 * Receives SES delivery events via SNS.
 *
 * SNS cannot send custom headers, so the shared secret travels in the query
 * string over HTTPS. Subscribe the topic to
 * `https://<host>/api/v1/webhooks/ses?token=<SES_WEBHOOK_SECRET>`.
 */
export async function handleSesWebhook(request: Request, response: Response): Promise<Response> {
  if (!env.SES_WEBHOOK_SECRET || request.query.token !== env.SES_WEBHOOK_SECRET) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  let envelope: SnsEnvelope;
  try {
    // SNS posts with Content-Type text/plain, so the body arrives as a string.
    envelope = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  } catch {
    return response.status(400).json({ success: false, message: "Malformed SNS payload" });
  }

  // Confirming the subscription is what activates the topic; without it SES
  // events never arrive.
  if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
    try {
      await fetch(envelope.SubscribeURL);
      console.info("SES SNS subscription confirmed.", { topicArn: envelope.TopicArn });
    } catch (error) {
      console.error("SES SNS subscription confirmation failed.", error);
      return response.status(502).json({ success: false, message: "Subscription confirmation failed" });
    }

    return response.status(200).json({ success: true });
  }

  if (envelope.Type === "Notification" && envelope.Message) {
    try {
      await handleSesEvent(JSON.parse(envelope.Message) as SesEvent);
    } catch (error) {
      // Returning non-2xx makes SNS redeliver. A payload we cannot parse will
      // never parse, so it is acknowledged and logged instead of retried.
      console.error("SES event could not be processed.", error);
    }
  }

  return response.status(200).json({ success: true });
}
