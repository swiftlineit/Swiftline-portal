import mongoose from "mongoose";

export const pickupShipmentStatusValues = ["PENDING", "PARTIAL", "COLLECTED", "CANCELLED"] as const;
export const pickupParcelStatusValues = [
  "PENDING", "COLLECTED", "NOT_READY", "NOT_FOUND", "DAMAGED_AT_HANDOVER",
  "LABEL_INVALID", "CUSTOMER_REFUSED", "CANCELLED"
] as const;

export interface IPickupRequestShipment extends mongoose.Document {
  pickupRequestId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  trackingNumber: string;
  snapshotRevision: number;
  shipmentSnapshot: Record<string, unknown>;
  parcels: Array<{ parcelNumber: string; weightKg: number; status: (typeof pickupParcelStatusValues)[number]; exceptionReason?: string; collectedAt?: Date | null; hubReceiptOutcome?: "RECEIVED" | "NOT_RECEIVED" | null }>;
  hubReceiptRecordedAt?: Date | null;
  status: (typeof pickupShipmentStatusValues)[number];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const pickupRequestShipmentSchema = new mongoose.Schema<IPickupRequestShipment>(
  {
    pickupRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupRequest", required: true, index: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
    dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
    trackingNumber: { type: String, trim: true, maxlength: 120, default: "" },
    snapshotRevision: { type: Number, min: 1, default: 1 },
    shipmentSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    parcels: [{
      parcelNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
      weightKg: { type: Number, min: 0, required: true },
      status: { type: String, enum: pickupParcelStatusValues, default: "PENDING", required: true },
      exceptionReason: { type: String, trim: true, maxlength: 500, default: "" },
      collectedAt: { type: Date, default: null },
      hubReceiptOutcome: { type: String, enum: ["RECEIVED", "NOT_RECEIVED", null], default: null }
    }],
    hubReceiptRecordedAt: { type: Date, default: null },
    status: { type: String, enum: pickupShipmentStatusValues, default: "PENDING", required: true, index: true },
    active: { type: Boolean, default: true, required: true, index: true }
  },
  { timestamps: true }
);

pickupRequestShipmentSchema.index(
  { shipmentDraftId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: "uniq_active_pickup_per_shipment" }
);
pickupRequestShipmentSchema.index({ pickupRequestId: 1, status: 1 });

export const PickupRequestShipment = mongoose.model<IPickupRequestShipment>("PickupRequestShipment", pickupRequestShipmentSchema);
