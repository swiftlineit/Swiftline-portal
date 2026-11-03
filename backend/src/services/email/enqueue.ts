import mongoose from "mongoose";
import { EmailOutbox, type IEmailAttachmentRef } from "../../models/emailOutbox.model.js";
import { User } from "../../models/user.model.js";
import { Tenant } from "../../models/tenant.model.js";
import { getEmailPolicy } from "./catalog.js";
import { scheduleEmailDrain } from "./dispatcher.js";
import { getTenantContext } from "../tenantScope.service.js";

export type EmailRecipient = {
  userId?: mongoose.Types.ObjectId | null;
  email: string;
  name: string;
};

export type EnqueueEmailInput = {
  notificationType: string;
  /** Base key; the recipient address is appended to make it per-recipient. */
  idempotencyKey: string;
  recipients: EmailRecipient[];
  businessAccountId?: mongoose.Types.ObjectId | null;
  subject: string;
  payload?: Record<string, unknown>;
  /** Defaults to the notification type, which selects the generic template. */
  templateKey?: string;
  attachmentRefs?: IEmailAttachmentRef[];
};

/**
 * Resolves portal users to mailable recipients. Disabled accounts are dropped:
 * someone who has been offboarded should stop receiving account mail even while
 * their in-app notification rows are still written.
 */
export async function resolveUserRecipients(
  userIds: mongoose.Types.ObjectId[],
  session?: mongoose.ClientSession
): Promise<EmailRecipient[]> {
  if (!userIds.length) return [];

  const users = await User.find({ _id: { $in: userIds }, userStatus: { $ne: "disabled" } })
    .select("email firstName lastName name")
    .session(session ?? null)
    .lean()
    .exec();

  return users
    .filter((user) => Boolean(user.email))
    .map((user) => ({
      userId: user._id,
      email: user.email,
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()
    }));
}

/**
 * Writes queue rows. Nothing is sent here- enqueueing is a plain write that
 * can join the caller's transaction, so an email can never escape for a
 * shipment or payment that later rolled back.
 *
 * The unique `idempotencyKey` is the guard against duplicate sends across job
 * reruns, retries and concurrent workers: a second enqueue of the same event
 * upserts onto the same row instead of creating a second message.
 */
export async function enqueueEmails(input: EnqueueEmailInput, session?: mongoose.ClientSession) {
  const tenantContext = getTenantContext();
  if (tenantContext?.kind === "OPERATOR" && !await Tenant.exists({
    _id: tenantContext.tenantId, kind: "OPERATOR", status: "ACTIVE"
  }).session(session ?? null)) return { enqueued: 0 };

  const policy = getEmailPolicy(input.notificationType);
  // Absence from the catalogue is how a notification type stays in-app only.
  if (!policy) return { enqueued: 0 };

  const unique = [...new Map(
    input.recipients
      .filter((recipient) => Boolean(recipient.email))
      .map((recipient) => [recipient.email.toLowerCase(), recipient])
  ).values()];
  if (!unique.length) return { enqueued: 0 };

  const templateKey = input.templateKey ?? input.notificationType;
  const operations = unique.map((recipient) => {
    const idempotencyKey = `${input.idempotencyKey}:${recipient.email.toLowerCase()}:email`;

    return {
      updateOne: {
        filter: { idempotencyKey },
        update: {
          $setOnInsert: {
            idempotencyKey,
            recipientUserId: recipient.userId ?? null,
            toEmail: recipient.email.toLowerCase(),
            toName: recipient.name ?? "",
            businessAccountId: input.businessAccountId ?? null,
            notificationType: input.notificationType,
            templateKey,
            category: policy.category,
            priority: policy.priority,
            subject: input.subject,
            payload: input.payload ?? {},
            attachmentRefs: input.attachmentRefs ?? [],
            status: "PENDING" as const,
            attempts: 0,
            nextAttemptAt: new Date(),
            lastError: "",
            sesMessageId: "",
            lockedAt: null,
            sentAt: null
          }
        },
        upsert: true
      }
    };
  });

  await EmailOutbox.bulkWrite(operations, { ordered: false, session });
  scheduleEmailDrain();

  return { enqueued: operations.length };
}
