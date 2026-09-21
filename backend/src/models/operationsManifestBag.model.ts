import mongoose from "mongoose";

export const operationsBagStatusValues = ["OPEN", "CLOSED", "READY", "REOPENED", "CANCELLED"] as const;
export type OperationsBagStatus = (typeof operationsBagStatusValues)[number];

export interface IOperationsManifestBag extends mongoose.Document {
  manifestId: mongoose.Types.ObjectId;
  sequence: number;
  bagNumber: string;
  barcode: string;
  status: OperationsBagStatus;
  totalConsignments: number;
  totalPhysicalParcels: number;
  totalWeightKg: number;
  createdBy: mongoose.Types.ObjectId;
  closedBy?: mongoose.Types.ObjectId | null;
  closedAt?: Date | null;
  readyBy?: mongoose.Types.ObjectId | null;
  readyAt?: Date | null;
  reopenedBy?: mongoose.Types.ObjectId | null;
  reopenedAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancelledAt?: Date | null;
  correctionReason: string;
  createdAt: Date;
  updatedAt: Date;
}

const operationsManifestBagSchema = new mongoose.Schema<IOperationsManifestBag>({
  manifestId: { type: mongoose.Schema.Types.ObjectId, ref: "OperationsManifest", required: true, index: true },
  sequence: { type: Number, required: true, min: 1 },
  bagNumber: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true, maxlength: 60 },
  barcode: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true, maxlength: 60 },
  status: { type: String, enum: operationsBagStatusValues, required: true, default: "OPEN", index: true },
  totalConsignments: { type: Number, required: true, min: 0, default: 0 },
  totalPhysicalParcels: { type: Number, required: true, min: 0, default: 0 },
  totalWeightKg: { type: Number, required: true, min: 0, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  closedAt: { type: Date, default: null },
  readyBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  readyAt: { type: Date, default: null },
  reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reopenedAt: { type: Date, default: null },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  cancelledAt: { type: Date, default: null },
  correctionReason: { type: String, trim: true, maxlength: 500, default: "" }
}, { timestamps: true });

operationsManifestBagSchema.index({ manifestId: 1, sequence: 1 }, { unique: true });
operationsManifestBagSchema.index({ manifestId: 1, status: 1 });

export const OperationsManifestBag = mongoose.model<IOperationsManifestBag>("OperationsManifestBag", operationsManifestBagSchema);
