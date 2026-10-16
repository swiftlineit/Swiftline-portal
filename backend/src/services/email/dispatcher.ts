import { env } from "../../config/env.js";
import { EmailOutbox, type IEmailOutbox } from "../../models/emailOutbox.model.js";
import { EmailPreference } from "../../models/emailPreference.model.js";
import { EmailSuppression } from "../../models/emailSuppression.model.js";
import { resolveAttachments } from "./attachments.js";
import { renderEmail } from "./layout.js";
import { resolveInlineEmailImages } from "./inlineImages.js";
import { getEmailTemplate } from "./templates/index.js";
import { EmailSendError, getEmailTransport, isMailConfigured } from "./transport.js";

/** Exponential-ish backoff: 1m, 5m, 30m, 2h, 12h. */
const backoffMinutes = [1, 5, 30, 120, 720];

// A row claimed by a worker that then crashed would sit in SENDING forever.
const stuckSendingAfterMs = 10 * 60 * 1000;

function nextAttemptDelayMs(attempts: number) {
  const index = Math.min(Math.max(attempts - 1, 0), backoffMinutes.length - 1);
  return (backoffMinutes[index] ?? 720) * 60 * 1000;
}

function parseSafelist() {
  return (env.MAIL_SAFELIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The single biggest operational hazard is a non-production environment mailing
 * real clients, so the rule lives here rather than in configuration discipline.
 * Production always sends. Everywhere else: honour an explicit safelist, and if
 * SES is somehow selected without one, fail closed.
 */
export function isRecipientAllowed(email: string): { allowed: boolean; reason: string } {
  if (env.NODE_ENV === "production") return { allowed: true, reason: "" };

  const safelist = parseSafelist();
  const address = email.toLowerCase();

  if (safelist.length) {
    const allowed = safelist.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry));
    return allowed
      ? { allowed: true, reason: "" }
      : { allowed: false, reason: `${email} is not on MAIL_SAFELIST for ${env.NODE_ENV}.` };
  }

  if (env.MAIL_DRIVER === "ses") {
    return {
      allowed: false,
      reason: `MAIL_DRIVER=ses outside production without MAIL_SAFELIST. Refusing to send to ${email}.`
    };
  }

  return { allowed: true, reason: "" };
}

async function isSuppressed(email: string) {
  const suppression = await EmailSuppression.findOne({ email: email.toLowerCase() }).select("_id reason").lean().exec();
  return suppression ? suppression.reason : null;
}

async function isOptedOut(row: IEmailOutbox) {
  // Transactional mail is contractual and ignores preferences entirely.
  if (row.category === "TRANSACTIONAL") return false;
  if (!row.recipientUserId) return false;

  const preference = await EmailPreference.findOne({ userId: row.recipientUserId })
    .select("optedOutTypes operationalEmailsEnabled")
    .lean()
    .exec();
  if (!preference) return false;

  return !preference.operationalEmailsEnabled || preference.optedOutTypes.includes(row.notificationType);
}

function footerNoteFor(row: IEmailOutbox) {
  return row.category === "TRANSACTIONAL"
    ? "This is a transactional message about your Swiftline Portal account and cannot be unsubscribed."
    : "You are receiving this operational update because of your role on the Swiftline Portal. Reply to this email to change your preferences.";
}

async function settle(row: IEmailOutbox, update: Partial<IEmailOutbox>) {
  await EmailOutbox.updateOne({ _id: row._id }, { $set: { ...update, lockedAt: null } }).exec();
}

async function failRow(row: IEmailOutbox, message: string, retryable: boolean) {
  const exhausted = row.attempts >= env.EMAIL_MAX_ATTEMPTS;

  if (!retryable || exhausted) {
    await settle(row, { status: "FAILED", lastError: message.slice(0, 1000) });
    console.error("Email permanently failed.", {
      outboxId: String(row._id),
      type: row.notificationType,
      to: row.toEmail,
      attempts: row.attempts,
      retryable,
      message
    });
    return;
  }

  await settle(row, {
    status: "PENDING",
    lastError: message.slice(0, 1000),
    nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(row.attempts))
  });
}

async function deliver(row: IEmailOutbox) {
  const suppressionReason = await isSuppressed(row.toEmail);
  if (suppressionReason) {
    await settle(row, { status: "SUPPRESSED", lastError: `Address suppressed: ${suppressionReason}` });
    return;
  }

  if (await isOptedOut(row)) {
    await settle(row, { status: "CANCELLED", lastError: "Recipient opted out of this operational email." });
    return;
  }

  const guard = isRecipientAllowed(row.toEmail);
  if (!guard.allowed) {
    await settle(row, { status: "CANCELLED", lastError: guard.reason });
    console.warn("Email blocked by environment safelist.", { outboxId: String(row._id), reason: guard.reason });
    return;
  }

  const resolution = await resolveAttachments(row.attachmentRefs);
  const content = getEmailTemplate(row.templateKey)({
    recipientName: row.toName,
    // The template decides its wording from what actually made it into the
    // message, so a dropped label set never produces "labels are attached".
    payload: {
      ...row.payload,
      labelsAttached: resolution.attachments.some((attachment) => attachment.kind === "LABEL_DOCUMENT"),
      pickupDocumentsAttached: resolution.attachments.filter((attachment) => attachment.kind === "PICKUP_DOCUMENT").length,
      attachmentsDropped: resolution.dropped
    },
    appUrl: env.CLIENT_URL
  });

  const inlineImages = await resolveInlineEmailImages(content).catch((error: unknown) => {
    // A missing illustration must not suppress a transactional pickup update.
    content.heroImage = undefined;
    console.error("Pickup email illustration could not be loaded.", error instanceof Error ? error.message : error);
    return [];
  });
  const { html, text } = renderEmail(content, footerNoteFor(row));
  const headers: Record<string, string> = {};
  if (row.category !== "TRANSACTIONAL" && env.MAIL_REPLY_TO) {
    headers["List-Unsubscribe"] = `<mailto:${env.MAIL_REPLY_TO}?subject=Unsubscribe%20${encodeURIComponent(row.notificationType)}>`;
  }

  const result = await getEmailTransport().send({
    to: row.toEmail,
    toName: row.toName,
    subject: content.subject,
    html,
    text,
    attachments: [...resolution.attachments, ...inlineImages],
    headers
  });

  await settle(row, {
    status: "SENT",
    sentAt: new Date(),
    sesMessageId: result.messageId,
    lastError: resolution.dropped ? `Sent without some attachments: ${resolution.droppedReason}` : ""
  });
}

/** Returns rows abandoned by a crashed worker to the queue. */
async function reclaimStuckRows() {
  await EmailOutbox.updateMany(
    { status: "SENDING", lockedAt: { $lt: new Date(Date.now() - stuckSendingAfterMs) } },
    { $set: { status: "PENDING", lockedAt: null } }
  ).exec();
}

/**
 * Claims one row atomically. The findOneAndUpdate is what makes concurrent
 * workers safe: whoever flips PENDING to SENDING first owns the row.
 */
async function claimNextRow() {
  return EmailOutbox.findOneAndUpdate(
    { status: "PENDING", nextAttemptAt: { $lte: new Date() } },
    { $set: { status: "SENDING", lockedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { priority: -1, nextAttemptAt: 1 }, returnDocument: "after" }
  ).exec();
}

export async function drainEmailOutbox(limit = env.EMAIL_DRAIN_BATCH_SIZE) {
  if (!isMailConfigured()) {
    console.warn("Email drain skipped: mail transport is not configured (MAIL_FROM / driver settings).");
    return { processed: 0, sent: 0, failed: 0 };
  }

  await reclaimStuckRows();

  let processed = 0;
  let sent = 0;
  let failed = 0;

  while (processed < limit) {
    const row = await claimNextRow();
    if (!row) break;

    processed += 1;

    try {
      await deliver(row);
      const settled = await EmailOutbox.findById(row._id).select("status").lean().exec();
      if (settled?.status === "SENT") sent += 1;
    } catch (error) {
      failed += 1;
      const retryable = error instanceof EmailSendError ? error.retryable : true;
      await failRow(row, error instanceof Error ? error.message : "Unknown send error", retryable);
    }
  }

  return { processed, sent, failed };
}

/**
 * Sends one queued row immediately and reports what happened.
 *
 * Used by the flows a person is actively waiting on- an invitation or a
 * password reset- where "we queued it" is not a good enough answer for the
 * admin staring at the screen. Everything else should go through the drain.
 */
export async function flushOutboxRow(idempotencyKey: string) {
  const row = await EmailOutbox.findOneAndUpdate(
    { idempotencyKey, status: "PENDING" },
    { $set: { status: "SENDING", lockedAt: new Date() }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).exec();

  if (!row) {
    // Already claimed, already sent, or never enqueued because the type is not
    // in the catalogue. None of those is an error for the caller.
    const existing = await EmailOutbox.findOne({ idempotencyKey }).select("status lastError").lean().exec();
    return {
      sent: existing?.status === "SENT",
      skipped: true,
      status: existing?.status ?? "NOT_QUEUED",
      error: existing?.lastError ?? ""
    };
  }

  try {
    await deliver(row);
  } catch (error) {
    const retryable = error instanceof EmailSendError ? error.retryable : true;
    await failRow(row, error instanceof Error ? error.message : "Unknown send error", retryable);
  }

  const settled = await EmailOutbox.findById(row._id).select("status lastError").lean().exec();
  return {
    sent: settled?.status === "SENT",
    skipped: false,
    status: settled?.status ?? "UNKNOWN",
    error: settled?.status === "SENT" ? "" : settled?.lastError ?? ""
  };
}

let pendingDrain: NodeJS.Timeout | null = null;

/**
 * Fire-and-forget drain used right after enqueue so mail leaves promptly
 * without the request waiting on SES.
 *
 * The delay is deliberate: some callers enqueue inside a Mongo transaction, and
 * a drain that ran immediately would query before the commit and see nothing.
 * Anything it still misses is picked up by `job:email:drain`.
 */
export function scheduleEmailDrain(delayMs = 1500) {
  if (pendingDrain) return;

  pendingDrain = setTimeout(() => {
    pendingDrain = null;
    void drainEmailOutbox().catch((error: unknown) => {
      console.error("Email drain failed.", error instanceof Error ? error.message : error);
    });
  }, delayMs);

  // A queued drain must never hold the process open at shutdown.
  pendingDrain.unref?.();
}
