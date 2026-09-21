import mongoose from "mongoose";
import { shipmentEventStatusValues, type ShipmentEventStatus } from "./shipmentEvent.model.js";

export const carrierTrackingProcessingValues = ["APPLIED", "IGNORED", "REVIEW_REQUIRED"] as const;
export type CarrierTrackingProcessingStatus = (typeof carrierTrackingProcessingValues)[number];

export interface ICarrierTrackingEvent extends mongoose.Document {
  provider: "ALS";
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  carrierAwbNumber: string;
  providerEventKey: string;
  providerEventId: string;
  eventState: string;
  description: string;
  location: string;
  eventAt: Date;
  mappedStatus?: ShipmentEventStatus | null;
  processingStatus: CarrierTrackingProcessingStatus;
  processingNote: string;
  rawPayload: Record<string, unknown>;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new mongoose.Schema<ICarrierTrackingEvent>({
  provider: { type: String, enum: ["ALS"], required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
  carrierAwbNumber: { type: String, required: true, trim: true, maxlength: 120, index: true },
  providerEventKey: { type: String, required: true, trim: true, maxlength: 160 },
  providerEventId: { type: String, trim: true, maxlength: 120, default: "" },
  eventState: { type: String, required: true, trim: true, maxlength: 80, index: true },
  description: { type: String, trim: true, maxlength: 1000, default: "" },
  location: { type: String, trim: true, maxlength: 200, default: "" },
  eventAt: { type: Date, required: true, index: true },
  mappedStatus: { type: String, enum: [...shipmentEventStatusValues, null], default: null, index: true },
  processingStatus: { type: String, enum: carrierTrackingProcessingValues, required: true, index: true },
  processingNote: { type: String, trim: true, maxlength: 500, default: "" },
  rawPayload: { type: mongoose.Schema.Types.Mixed, required: true },
  receivedAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

schema.index({ provider: 1, carrierAwbNumber: 1, providerEventKey: 1 }, { unique: true });
schema.index({ processingStatus: 1, receivedAt: -1 });

export const CarrierTrackingEvent = mongoose.model<ICarrierTrackingEvent>("CarrierTrackingEvent", schema);
