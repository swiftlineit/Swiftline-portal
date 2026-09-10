import mongoose from "mongoose";

export const publicShipmentBookingStateValues = [
  "DRAFT",
  "QUOTED",
  "PAYMENT_PENDING",
  "PAYMENT_REVIEW_REQUIRED",
  "FULFILLING",
  "BOOKED",
  "REVIEW_REQUIRED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PublicShipmentBookingState = (typeof publicShipmentBookingStateValues)[number];

export interface IPublicShipmentBooking extends mongoose.Document {
  publicReference: string;
  sessionTokenHash: string;
  statusTokenHash: string;
  state: PublicShipmentBookingState;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  branchId?: mongoose.Types.ObjectId | null;
  senderEntityType: "INDIVIDUAL" | "COMPANY";
  customerName: string;
  email: string;
  revision: number;
  quotedRevision?: number | null;
  pricingHash: string;
  quoteAmountMinor?: number | null;
  quoteCurrency: "INR";
  quoteExpiresAt?: Date | null;
  acceptedPolicies: {
    termsVersion: string;
    cancellationVersion: string;
    prohibitedGoodsVersion: string;
    acceptedAt?: Date | null;
    acceptedIpHash: string;
  };
  dpdShipmentId?: mongoose.Types.ObjectId | null;
  shipmentInvoiceId?: mongoose.Types.ObjectId | null;
  swiftlineTrackingNumber: string;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const publicShipmentBookingSchema = new mongoose.Schema<IPublicShipmentBooking>({
  publicReference: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 32 },
  sessionTokenHash: { type: String, required: true, unique: true, trim: true, maxlength: 64, select: false },
  statusTokenHash: { type: String, trim: true, maxlength: 64, default: "", select: false },
  state: { type: String, enum: publicShipmentBookingStateValues, default: "DRAFT", required: true, index: true },
  // A public session has no shipment draft until the address and shipment
  // steps are saved. Uniqueness is declared below with a partial index so
  // multiple in-progress sessions may safely carry a null value.
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
  senderEntityType: { type: String, enum: ["INDIVIDUAL", "COMPANY"], default: "INDIVIDUAL", required: true },
  customerName: { type: String, trim: true, maxlength: 160, default: "" },
  email: { type: String, lowercase: true, trim: true, maxlength: 320, default: "", index: true },
  revision: { type: Number, min: 1, default: 1, required: true },
  quotedRevision: { type: Number, min: 1, default: null },
  pricingHash: { type: String, trim: true, maxlength: 64, default: "" },
  quoteAmountMinor: { type: Number, min: 1, default: null },
  quoteCurrency: { type: String, enum: ["INR"], default: "INR", required: true },
  quoteExpiresAt: { type: Date, default: null },
  acceptedPolicies: {
    termsVersion: { type: String, trim: true, maxlength: 40, default: "" },
    cancellationVersion: { type: String, trim: true, maxlength: 40, default: "" },
    prohibitedGoodsVersion: { type: String, trim: true, maxlength: 40, default: "" },
    acceptedAt: { type: Date, default: null },
    acceptedIpHash: { type: String, trim: true, maxlength: 64, default: "", select: false },
  },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", default: null },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", default: null },
  swiftlineTrackingNumber: { type: String, trim: true, maxlength: 40, default: "" },
  // Removed after a successful booking so paid shipment records are permanent.
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

// A scheduled cascade removes the booking, its draft and private uploads. A
// Mongo TTL index cannot perform that cascade and would leave sensitive orphan
// files behind, so this is a normal sweep index by design.
publicShipmentBookingSchema.index({ state: 1, expiresAt: 1 });
publicShipmentBookingSchema.index(
  { shipmentDraftId: 1 },
  { unique: true, partialFilterExpression: { shipmentDraftId: { $type: "objectId" } } },
);
publicShipmentBookingSchema.index(
  { statusTokenHash: 1 },
  { unique: true, partialFilterExpression: { statusTokenHash: { $type: "string", $gt: "" } } },
);

export const PublicShipmentBooking = mongoose.model<IPublicShipmentBooking>(
  "PublicShipmentBooking",
  publicShipmentBookingSchema,
);
