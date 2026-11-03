import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

/**
 * A document the customer supplies for a shipment that is already booked.
 *
 * Deliberately separate from the KYC documents on `ShipmentDraft`. Those are
 * part of the booking record- the customs declaration and the claim snapshot
 * both read them- so writing to them after booking would rewrite history that
 * other things have already relied on. Customs asking for a commercial invoice
 * on a held shipment is a new fact about that shipment, not a correction to how
 * it was booked, and it belongs in its own record.
 */
export const shipmentSupportingDocumentTypeValues = [
  "COMMERCIAL_INVOICE",
  "PACKING_LIST",
  "CUSTOMS_DECLARATION",
  "AUTHORISATION_LETTER",
  "PRODUCT_CERTIFICATE",
  "OTHER"
] as const;
export type ShipmentSupportingDocumentType = (typeof shipmentSupportingDocumentTypeValues)[number];

export const shipmentSupportingDocumentLabels: Record<ShipmentSupportingDocumentType, string> = {
  COMMERCIAL_INVOICE: "Commercial Invoice",
  PACKING_LIST: "Packing List",
  CUSTOMS_DECLARATION: "Customs Declaration",
  AUTHORISATION_LETTER: "Authorisation Letter",
  PRODUCT_CERTIFICATE: "Product Certificate",
  OTHER: "Other Supporting Document"
};

export interface IShipmentSupportingDocument extends mongoose.Document, TenantOwnedFields {
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  documentType: ShipmentSupportingDocumentType;
  /** What the customer called it, kept so the operator recognises it. */
  originalName: string;
  /** Storage service key, resolved through storage.service.ts. Never a path. */
  storageKey: string;
  mimeType: string;
  size: number;
  /** Optional note from the customer explaining what they have sent. */
  note: string;
  uploadedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentSupportingDocumentSchema = new mongoose.Schema<IShipmentSupportingDocument>(
  {
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    documentType: { type: String, enum: shipmentSupportingDocumentTypeValues, required: true },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    storageKey: { type: String, required: true, trim: true, maxlength: 400 },
    mimeType: { type: String, required: true, trim: true, maxlength: 120 },
    size: { type: Number, required: true, min: 1 },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }
  },
  { timestamps: true }
);

// The shipment view lists these newest first.
shipmentSupportingDocumentSchema.index({ shipmentDraftId: 1, createdAt: -1 });

addTenantOwnership(shipmentSupportingDocumentSchema);

export const ShipmentSupportingDocument = mongoose.model<IShipmentSupportingDocument>(
  "ShipmentSupportingDocument",
  shipmentSupportingDocumentSchema
);
