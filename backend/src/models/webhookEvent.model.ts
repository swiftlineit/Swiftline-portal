import mongoose from "mongoose";

export const webhookProviderValues = ["RAZORPAY"] as const;
export type WebhookProvider = (typeof webhookProviderValues)[number];

export const webhookEventStatusValues = ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"] as const;
export type WebhookEventStatus = (typeof webhookEventStatusValues)[number];

export interface IWebhookEvent extends mongoose.Document {
  provider: WebhookProvider;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  status: WebhookEventStatus;
  receivedAt: Date;
  processedAt?: Date | null;
  failureReason?: string;
  payload?: Record<string, unknown> | null;
  attemptCount: number;
  lockedAt?: Date | null;
  lockToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new mongoose.Schema<IWebhookEvent>(
  {
    provider: { type: String, enum: webhookProviderValues, required: true, index: true },
    providerEventId: { type: String, required: true, unique: true, trim: true, maxlength: 160 },
    eventType: { type: String, required: true, trim: true, maxlength: 120, index: true },
    payloadHash: { type: String, required: true, trim: true, maxlength: 128 },
    status: { type: String, enum: webhookEventStatusValues, default: "RECEIVED", index: true },
    receivedAt: { type: Date, default: Date.now, index: true },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, maxlength: 1000, default: "" },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
    lockedAt: { type: Date, default: null, index: true },
    lockToken: { type: String, trim: true, maxlength: 120, default: "" }
  },
  { timestamps: true }
);

webhookEventSchema.index({ status: 1, lockedAt: 1, receivedAt: 1 }, { name: "webhook_processing_queue" });

export const WebhookEvent = mongoose.model<IWebhookEvent>(
  "WebhookEvent",
  webhookEventSchema
);
