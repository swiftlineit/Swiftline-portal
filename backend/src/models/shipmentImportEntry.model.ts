import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const shipmentImportEntryStatusValues = [
  "READY",
  "NEEDS_REVIEW",
  "INVALID",
  "DRAFT_CREATED",
  "CREATE_FAILED"
] as const;

export type ShipmentImportEntryStatus = (typeof shipmentImportEntryStatusValues)[number];

export interface IShipmentImportEntry extends mongoose.Document, TenantOwnedFields {
  batchId: mongoose.Types.ObjectId;
  position: number;
  originalFilename: string;
  storageKey: string;
  fileChecksum: string;
  parsedData: Record<string, unknown>;
  warnings: string[];
  importErrors: string[];
  status: ShipmentImportEntryStatus;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentImportEntrySchema = new mongoose.Schema<IShipmentImportEntry>(
  {
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentImportBatch", required: true, index: true },
    position: { type: Number, min: 1, required: true },
    originalFilename: { type: String, trim: true, maxlength: 255, required: true },
    storageKey: { type: String, trim: true, maxlength: 1024, required: true },
    fileChecksum: { type: String, trim: true, maxlength: 128, required: true, index: true },
    parsedData: { type: mongoose.Schema.Types.Mixed, default: {} },
    warnings: [{ type: String, trim: true, maxlength: 500 }],
    importErrors: [{ type: String, trim: true, maxlength: 500 }],
    status: { type: String, enum: shipmentImportEntryStatusValues, required: true, index: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", default: null, index: true }
  },
  { timestamps: true }
);

shipmentImportEntrySchema.index({ batchId: 1, position: 1 }, { unique: true });

addTenantOwnership(shipmentImportEntrySchema);

export const ShipmentImportEntry = mongoose.model<IShipmentImportEntry>("ShipmentImportEntry", shipmentImportEntrySchema);
