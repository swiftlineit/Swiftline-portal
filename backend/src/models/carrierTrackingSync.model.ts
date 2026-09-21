import mongoose from "mongoose";

export const carrierTrackingSyncStateValues = ["ACTIVE", "COMPLETED", "PAUSED", "ERROR"] as const;
export const carrierTrackingPollPhaseValues = ["PRE_DESTINATION", "DESTINATION", "OUT_FOR_DELIVERY"] as const;

export interface ICarrierTrackingSync extends mongoose.Document {
  provider: "ALS";
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  carrierAwbNumber: string;
  state: (typeof carrierTrackingSyncStateValues)[number];
  pollPhase: (typeof carrierTrackingPollPhaseValues)[number];
  nextPollAt?: Date | null;
  lastPolledAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastEventAt?: Date | null;
  lastManualRefreshAt?: Date | null;
  failureCount: number;
  lastError: string;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new mongoose.Schema<ICarrierTrackingSync>({
  provider: { type: String, enum: ["ALS"], required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
  carrierAwbNumber: { type: String, required: true, trim: true, maxlength: 120, index: true },
  state: { type: String, enum: carrierTrackingSyncStateValues, required: true, default: "ACTIVE", index: true },
  pollPhase: { type: String, enum: carrierTrackingPollPhaseValues, required: true, default: "PRE_DESTINATION" },
  nextPollAt: { type: Date, default: Date.now, index: true },
  lastPolledAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastEventAt: { type: Date, default: null },
  lastManualRefreshAt: { type: Date, default: null },
  failureCount: { type: Number, min: 0, default: 0 },
  lastError: { type: String, trim: true, maxlength: 1000, default: "" },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

schema.index({ provider: 1, carrierAwbNumber: 1 }, { unique: true });
schema.index({ state: 1, nextPollAt: 1 });

export const CarrierTrackingSync = mongoose.model<ICarrierTrackingSync>("CarrierTrackingSync", schema);
