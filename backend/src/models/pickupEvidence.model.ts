import mongoose from "mongoose";

export const pickupProofTypeValues = ["SIGNATURE", "PHOTO"] as const;

export interface IPickupScan extends mongoose.Document {
  pickupRequestId: mongoose.Types.ObjectId;
  pickupAttemptId: mongoose.Types.ObjectId;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  parcelNumber: string;
  scanRequestId: string;
  status: "ACCEPTED" | "REJECTED" | "REMOVED";
  message?: string;
  scannedBy: mongoose.Types.ObjectId;
  scannedAt: Date;
}

const pickupScanSchema = new mongoose.Schema<IPickupScan>({
  pickupRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupRequest", required: true, index: true },
  pickupAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupAttempt", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", default: null, index: true },
  parcelNumber: { type: String, trim: true, uppercase: true, required: true, maxlength: 80, index: true },
  scanRequestId: { type: String, trim: true, required: true, maxlength: 100, unique: true },
  status: { type: String, enum: ["ACCEPTED", "REJECTED", "REMOVED"], required: true, index: true },
  message: { type: String, trim: true, maxlength: 500, default: "" },
  scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  scannedAt: { type: Date, default: Date.now, required: true }
}, { timestamps: true });

pickupScanSchema.index({ parcelNumber: 1 }, { unique: true, partialFilterExpression: { status: "ACCEPTED" }, name: "uniq_collected_pickup_parcel" });

export const PickupScan = mongoose.model<IPickupScan>("PickupScan", pickupScanSchema);

export interface IPickupProof extends mongoose.Document {
  pickupRequestId: mongoose.Types.ObjectId;
  pickupAttemptId: mongoose.Types.ObjectId;
  type: (typeof pickupProofTypeValues)[number];
  source?: "DRIVER" | "STAFF";
  originalName: string;
  /** Storage service key, resolved through storage.service.ts. Never a path. */
  storageKey: string;
  mimeType: string;
  size: number;
  capturedBy: mongoose.Types.ObjectId;
  capturedAt: Date;
}

const pickupProofSchema = new mongoose.Schema<IPickupProof>({
  pickupRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupRequest", required: true, index: true },
  pickupAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupAttempt", required: true, index: true },
  type: { type: String, enum: pickupProofTypeValues, required: true, index: true },
  source: { type: String, enum: ["DRIVER", "STAFF"], default: "DRIVER" },
  originalName: { type: String, required: true },
  storageKey: { type: String, required: true, maxlength: 1024 },
  mimeType: { type: String, required: true },
  size: { type: Number, min: 1, required: true },
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  capturedAt: { type: Date, default: Date.now, required: true }
}, { timestamps: true });

pickupProofSchema.index({ pickupAttemptId: 1, type: 1, capturedAt: -1 });

export const PickupProof = mongoose.model<IPickupProof>("PickupProof", pickupProofSchema);
