import mongoose from "mongoose";
import { paymentSourceValues, type PaymentSource } from "./financialTypes.js";

// Retained verbatim from when bookings were placed with an external carrier.
// The values are written into every existing booking row and audit entry, so
// they stay as the stored vocabulary: DPD_CREATED means the booking record is
// durable but its documents are not yet complete, and DPD_REJECTED means the
// attempt failed before anything was created.
export const dpdShipmentStatusValues = [
  "DPD_CREATING",
  "DPD_CREATED",
  "LABEL_RECEIVED",
  "DPD_REJECTED",
  "DPD_STATUS_UNKNOWN"
] as const;

export type DpdShipmentStatus = (typeof dpdShipmentStatusValues)[number];

export interface IDpdShipment extends mongoose.Document {
  shipmentDraftId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  dpdShipmentId?: string;
  dpdTransactionId?: string;
  forwardingNumber?: string;
  entryNumber?: string;
  swiftlineTrackingNumber?: string;
  parcelNumbers: string[];
  serviceCode: string;
  bookingSnapshot: Record<string, unknown>;
  currentShipmentSnapshot: Record<string, unknown>;
  snapshotRevision: number;
  requestSnapshot: Record<string, unknown>;
  responseSnapshot: Record<string, unknown>;
  paymentSource: PaymentSource;
  status: DpdShipmentStatus;
  createdAt: Date;
  updatedAt: Date;
}

const dpdShipmentSchema = new mongoose.Schema<IDpdShipment>(
  {
    shipmentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShipmentDraft",
      required: true,
      unique: true,
      index: true
    },
    idempotencyKey: { type: String, required: true, unique: true, trim: true, maxlength: 256 },
    dpdShipmentId: { type: String, trim: true, maxlength: 120, default: "" },
    dpdTransactionId: { type: String, trim: true, maxlength: 120, default: "" },
    forwardingNumber: { type: String, trim: true, maxlength: 120, default: "" },
    entryNumber: { type: String, trim: true, maxlength: 120, default: "" },
    swiftlineTrackingNumber: { type: String, trim: true, maxlength: 40, default: "" },
    parcelNumbers: [{ type: String, trim: true, maxlength: 80 }],
    serviceCode: { type: String, required: true, trim: true, maxlength: 40 },
    bookingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    currentShipmentSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    snapshotRevision: { type: Number, min: 1, default: 1 },
    requestSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    responseSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    paymentSource: { type: String, enum: paymentSourceValues, default: "ADMIN_DIRECT", required: true },
    status: { type: String, enum: dpdShipmentStatusValues, default: "DPD_CREATING", index: true }
  },
  { timestamps: true }
);

dpdShipmentSchema.index({ status: 1, updatedAt: -1 });
// The dashboard/list endpoint orders by creation time, with or without a
// carrier-status filter. The status-plus-draft index also covers the distinct
// booked-draft lookup used by scoped shipment lists and summaries.
dpdShipmentSchema.index(
  { createdAt: -1 },
  { name: "dpdShipment_createdAt_desc" }
);
dpdShipmentSchema.index(
  { status: 1, createdAt: -1 },
  { name: "dpdShipment_status_createdAt_desc" }
);
dpdShipmentSchema.index(
  { status: 1, shipmentDraftId: 1 },
  { name: "dpdShipment_status_draft" }
);
dpdShipmentSchema.index(
  { swiftlineTrackingNumber: 1 },
  { unique: true, partialFilterExpression: { swiftlineTrackingNumber: { $type: "string", $gt: "" } } }
);

export const DpdShipment = mongoose.model<IDpdShipment>(
  "DpdShipment",
  dpdShipmentSchema
);
