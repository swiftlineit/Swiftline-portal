import mongoose from "mongoose";

export const operationsConsignmentStatusValues = ["PARTIAL", "COMPLETE", "REMOVED"] as const;
export type OperationsConsignmentStatus = (typeof operationsConsignmentStatusValues)[number];
export const operationsParcelDispositionValues = ["HELD", "DEFERRED_TO_NEXT_MANIFEST", "CANCELLED"] as const;
export type OperationsParcelDisposition = (typeof operationsParcelDispositionValues)[number];
type ParcelItemSnapshot = {
  description: string;
  hsnCode: string;
  unitType: string;
  quantity: number;
  unitRate: number;
};

export interface IOperationsManifestConsignment extends mongoose.Document {
  manifestId: mongoose.Types.ObjectId;
  bagId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  consignmentNumber: string;
  expectedParcelNumbers: string[];
  scannedParcelNumbers: string[];
  parcelDispositions: Array<{
    parcelNumber: string;
    disposition: OperationsParcelDisposition;
    reason: string;
    recordedBy: mongoose.Types.ObjectId;
    recordedAt: Date;
  }>;
  // Per-parcel facts captured at scan time. Each one prints as its own manifest row.
  // `valueMinor` is the box's own declared goods value from the shipment snapshot.
  parcelWeightSnapshots: Array<{
    parcelNumber: string;
    weightKg: number;
    contentsDescription?: string;
    items?: ParcelItemSnapshot[];
    valueMinor?: number | null;
  }>;
  manifestPieces: 1;
  weightKg: number;
  status: OperationsConsignmentStatus;
  consignorSnapshot: Record<string, unknown>;
  consigneeSnapshot: Record<string, unknown>;
  description: string;
  declaredValueMinor?: number | null;
  currency: "INR";
  serviceInfo: string;
  dpdLabelGenerated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const operationsManifestConsignmentSchema = new mongoose.Schema<IOperationsManifestConsignment>({
  manifestId: { type: mongoose.Schema.Types.ObjectId, ref: "OperationsManifest", required: true, index: true },
  bagId: { type: mongoose.Schema.Types.ObjectId, ref: "OperationsManifestBag", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  consignmentNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 80, index: true },
  expectedParcelNumbers: [{ type: String, required: true, trim: true, uppercase: true, maxlength: 80 }],
  scannedParcelNumbers: [{ type: String, required: true, trim: true, uppercase: true, maxlength: 80 }],
  parcelDispositions: [{
    _id: false,
    parcelNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
    disposition: { type: String, enum: operationsParcelDispositionValues, required: true },
    reason: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recordedAt: { type: Date, required: true }
  }],
  parcelWeightSnapshots: [{
    _id: false,
    parcelNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
    weightKg: { type: Number, required: true, min: 0.001 },
    contentsDescription: { type: String, trim: true, maxlength: 1000, default: "" },
    items: [{
      _id: false,
      description: { type: String, trim: true, maxlength: 500, default: "" },
      hsnCode: { type: String, trim: true, maxlength: 20, default: "" },
      unitType: { type: String, trim: true, maxlength: 20, default: "Pcs" },
      quantity: { type: Number, min: 0, default: 0 },
      unitRate: { type: Number, min: 0, default: 0 }
    }],
    valueMinor: { type: Number, min: 1, default: null }
  }],
  manifestPieces: { type: Number, required: true, enum: [1], default: 1 },
  weightKg: { type: Number, required: true, min: 0 },
  status: { type: String, enum: operationsConsignmentStatusValues, required: true, default: "PARTIAL", index: true },
  consignorSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  consigneeSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  declaredValueMinor: { type: Number, min: 0, default: null },
  currency: { type: String, enum: ["INR"], required: true, default: "INR" },
  serviceInfo: { type: String, required: true, trim: true, maxlength: 40 },
  dpdLabelGenerated: { type: Boolean, required: true, default: false }
}, { timestamps: true });

operationsManifestConsignmentSchema.index({ manifestId: 1, shipmentDraftId: 1 }, { unique: true });
operationsManifestConsignmentSchema.index({ manifestId: 1, bagId: 1, status: 1 });

export const OperationsManifestConsignment = mongoose.model<IOperationsManifestConsignment>("OperationsManifestConsignment", operationsManifestConsignmentSchema);
