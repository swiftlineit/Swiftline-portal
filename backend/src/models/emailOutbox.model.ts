import mongoose from "mongoose";

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

export interface IEmailOutbox extends mongoose.Document {
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
    idempotencyKey: { type: String, required: true, unique: true, trim: true, maxlength: 400 },
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
    sesMessageId: { type: String, trim: true, maxlength: 200, default: "", index: true },
    // Set when a drain worker claims the row; lets a later sweep reclaim rows
    // abandoned by a worker that crashed mid-send.
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// The drain worker's claim query.
emailOutboxSchema.index({ status: 1, nextAttemptAt: 1, priority: -1 });
emailOutboxSchema.index({ businessAccountId: 1, createdAt: -1 });
emailOutboxSchema.index({ toEmail: 1, createdAt: -1 });

export const EmailOutbox = mongoose.model<IEmailOutbox>("EmailOutbox", emailOutboxSchema);
