import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const emailOutboxStatusValues = [
  "PENDING",
  "SENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
  "CANCELLED"
] as const;
export type EmailOutboxStatus = (typeof emailOutboxStatusValues)[number];

// TRANSACTIONAL mail cannot be unsubscribed: invoices, payments, security and
// legal agreements are contractual. OPERATIONAL mail is preference-controlled.
export const emailCategoryValues = ["TRANSACTIONAL", "OPERATIONAL", "MARKETING"] as const;
export type EmailCategory = (typeof emailCategoryValues)[number];

// Attachments are stored as references, never as bytes. A 2 MB invoice PDF on
// every queue row would bloat the collection and duplicate what the document
// services already generate on demand.
export const emailAttachmentKindValues = [
  "SHIPMENT_INVOICE_PDF",
  "LABEL_DOCUMENT",
  "SHIPMENT_MANIFEST_PDF",
  "CREDIT_BILLING_STATEMENT_PDF",
  "CREDIT_AGREEMENT_PDF",
  "CANCELLATION_DOCUMENT_PDF",
  "RATE_CARD_SHARE_PDF",
  "RATE_CARD_SHARE_XLSX",
  "PICKUP_DOCUMENT"
] as const;
export type EmailAttachmentKind = (typeof emailAttachmentKindValues)[number];

export interface IEmailAttachmentRef {
  kind: EmailAttachmentKind;
  refId: mongoose.Types.ObjectId;
  documentId?: mongoose.Types.ObjectId | null;
  revision?: number | null;
  filename?: string;
}

export interface IEmailOutbox extends mongoose.Document, TenantOwnedFields {
  idempotencyKey: string;
  recipientUserId?: mongoose.Types.ObjectId | null;
  toEmail: string;
  toName: string;
  businessAccountId?: mongoose.Types.ObjectId | null;
  notificationType: string;
  templateKey: string;
  category: EmailCategory;
  priority: number;
  subject: string;
  payload: Record<string, unknown>;
  attachmentRefs: IEmailAttachmentRef[];
  status: EmailOutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string;
  sesMessageId: string;
  lockedAt?: Date | null;
  sentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailAttachmentRefSchema = new mongoose.Schema<IEmailAttachmentRef>(
  {
    kind: { type: String, enum: emailAttachmentKindValues, required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    revision: { type: Number, default: null },
    filename: { type: String, trim: true, maxlength: 200, default: "" }
  },
  { _id: false }
);

const emailOutboxSchema = new mongoose.Schema<IEmailOutbox>(
  {
    // `${notificationKey}:${userId}:email`. The single guard against a double
    // send across job reruns, retries and concurrent drain workers.
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 400 },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // Resolved at enqueue time. If the user later changes their address we still
    // deliver to the address the event was raised against.
    toEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
    toName: { type: String, trim: true, maxlength: 200, default: "" },
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", default: null, index: true },
    notificationType: { type: String, required: true, trim: true, maxlength: 80, index: true },
    templateKey: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, enum: emailCategoryValues, required: true, index: true },
    // Higher sends first, so invoices and security mail overtake digests.
    priority: { type: Number, default: 0 },
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    // Denormalised at enqueue time so the template renders without re-querying
    // and cannot drift if the domain record changes before the send.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    attachmentRefs: { type: [emailAttachmentRefSchema], default: [] },
    status: { type: String, enum: emailOutboxStatusValues, default: "PENDING", required: true, index: true },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: { type: String, trim: true, maxlength: 1000, default: "" },
    // Correlates the SNS delivery/bounce/complaint events back to this row.
    sesMessageId: { type: String, trim: true, maxlength: 200, default: "" },
    // Set when a drain worker claims the row; lets a later sweep reclaim rows
    // abandoned by a worker that crashed mid-send.
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

addTenantOwnership(emailOutboxSchema);

emailOutboxSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, name: "tenant_email_outbox_idempotency_unique" }
);
// The drain worker's tenant-scoped claim query.
emailOutboxSchema.index(
  { tenantId: 1, status: 1, nextAttemptAt: 1, priority: -1 },
  { name: "tenant_email_outbox_drain" }
);
emailOutboxSchema.index(
  { tenantId: 1, businessAccountId: 1, createdAt: -1 },
  { name: "tenant_email_outbox_business_account" }
);
emailOutboxSchema.index(
  { tenantId: 1, toEmail: 1, createdAt: -1 },
  { name: "tenant_email_outbox_recipient" }
);
// SES callbacks discover an owner's tenant from the transport's global message ID.
emailOutboxSchema.index({ sesMessageId: 1 }, { name: "email_outbox_ses_message_id" });

export const EmailOutbox = mongoose.model<IEmailOutbox>("EmailOutbox", emailOutboxSchema);
