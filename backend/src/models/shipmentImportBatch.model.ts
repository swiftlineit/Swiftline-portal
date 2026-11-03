import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const shipmentImportBatchStatusValues = [
  "PARSED",
  "CREATING_DRAFTS",
  "COMPLETED",
  "PARTIAL",
  "FAILED"
] as const;

export type ShipmentImportBatchStatus = (typeof shipmentImportBatchStatusValues)[number];

export interface IShipmentImportBatch extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  status: ShipmentImportBatchStatus;
  fileCount: number;
  readyCount: number;
  needsReviewCount: number;
  invalidCount: number;
  createdCount: number;
  failedCount: number;
  confirmationKey: string;
  confirmedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentImportBatchSchema = new mongoose.Schema<IShipmentImportBatch>(
  {
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: shipmentImportBatchStatusValues, default: "PARSED", index: true },
    fileCount: { type: Number, min: 1, max: 25, required: true },
    readyCount: { type: Number, min: 0, default: 0 },
    needsReviewCount: { type: Number, min: 0, default: 0 },
    invalidCount: { type: Number, min: 0, default: 0 },
    createdCount: { type: Number, min: 0, default: 0 },
    failedCount: { type: Number, min: 0, default: 0 },
    confirmationKey: { type: String, trim: true, maxlength: 120, default: "" },
    confirmedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

shipmentImportBatchSchema.index(
  { uploadedBy: 1, confirmationKey: 1 },
  { unique: true, partialFilterExpression: { confirmationKey: { $type: "string", $gt: "" } } }
);

addTenantOwnership(shipmentImportBatchSchema);

export const ShipmentImportBatch = mongoose.model<IShipmentImportBatch>("ShipmentImportBatch", shipmentImportBatchSchema);
