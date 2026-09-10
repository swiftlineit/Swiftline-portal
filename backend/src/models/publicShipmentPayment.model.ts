import mongoose from "mongoose";

export const publicShipmentPaymentStatusValues = [
  "ORDER_CREATED",
  "VERIFYING",
  "PAYMENT_REVIEW_REQUIRED",
  "CAPTURED",
  "FULFILLING",
  "BOOKED",
  "REVIEW_REQUIRED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
] as const;
export type PublicShipmentPaymentStatus = (typeof publicShipmentPaymentStatusValues)[number];

export interface IPublicShipmentPayment extends mongoose.Document {
  bookingId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  bookingRevision: number;
  pricingHash: string;
  idempotencyKey: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpayRefundId: string;
  amountMinor: number;
  currency: "INR";
  status: PublicShipmentPaymentStatus;
  capturedAt?: Date | null;
  fulfilledAt?: Date | null;
  refundedAt?: Date | null;
  failureCode: string;
  failureMessage: string;
  createdAt: Date;
  updatedAt: Date;
}

const publicShipmentPaymentSchema = new mongoose.Schema<IPublicShipmentPayment>({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "PublicShipmentBooking", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  bookingRevision: { type: Number, required: true, min: 1 },
  pricingHash: { type: String, required: true, trim: true, maxlength: 64 },
  idempotencyKey: { type: String, required: true, unique: true, trim: true, maxlength: 160 },
  razorpayOrderId: { type: String, required: true, unique: true, trim: true, maxlength: 100 },
  razorpayPaymentId: { type: String, trim: true, maxlength: 100, default: "" },
  razorpayRefundId: { type: String, trim: true, maxlength: 100, default: "" },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ["INR"], default: "INR", required: true },
  status: { type: String, enum: publicShipmentPaymentStatusValues, required: true, index: true },
  capturedAt: { type: Date, default: null },
  fulfilledAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  failureCode: { type: String, trim: true, maxlength: 120, default: "" },
  failureMessage: { type: String, trim: true, maxlength: 1000, default: "" },
}, { timestamps: true });

publicShipmentPaymentSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string", $gt: "" } } },
);
publicShipmentPaymentSchema.index({ bookingId: 1, createdAt: -1 });

export const PublicShipmentPayment = mongoose.model<IPublicShipmentPayment>(
  "PublicShipmentPayment",
  publicShipmentPaymentSchema,
);
