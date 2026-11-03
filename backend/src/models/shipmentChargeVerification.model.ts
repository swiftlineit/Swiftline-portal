import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

type ShipmentParcelSnapshot = {
  sequence: number;
  weightKg: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  shipmentContentType: string;
  contentsDescription: string;
  shipmentReference1: string;
  shipmentReference2: string;
};

export interface IShipmentChargeVerification extends mongoose.Document, TenantOwnedFields {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  previousParcelList: ShipmentParcelSnapshot[];
  verifiedParcelList: ShipmentParcelSnapshot[];
  previousPricingSnapshot: Record<string, unknown>;
  verifiedPricingSnapshot: Record<string, unknown>;
  previousAmountMinor: number;
  verifiedAmountMinor: number;
  billingMode: "BUSINESS_ACCOUNT" | "DIRECT" | "TEST";
  billingAdjustment: Record<string, unknown>;
  invoiceNumber: string;
  invoiceRevision: number;
  note: string;
  verifiedBy: mongoose.Types.ObjectId;
  verifiedAt: Date;
  createdAt: Date;
}

const shipmentParcelSnapshotSchema = new mongoose.Schema<ShipmentParcelSnapshot>({
  sequence: { type: Number, required: true, min: 1 },
  weightKg: { type: Number, required: true, min: 0 },
  lengthCm: { type: Number, default: null },
  widthCm: { type: Number, default: null },
  heightCm: { type: Number, default: null },
  shipmentContentType: { type: String, required: true },
  contentsDescription: { type: String, default: "" },
  shipmentReference1: { type: String, default: "" },
  shipmentReference2: { type: String, default: "" }
}, { _id: false });

const shipmentChargeVerificationSchema = new mongoose.Schema<IShipmentChargeVerification>({
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, unique: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, unique: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  previousParcelList: { type: [shipmentParcelSnapshotSchema], required: true },
  verifiedParcelList: { type: [shipmentParcelSnapshotSchema], required: true },
  previousPricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  verifiedPricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  previousAmountMinor: { type: Number, required: true, min: 0 },
  verifiedAmountMinor: { type: Number, required: true, min: 0 },
  billingMode: { type: String, enum: ["BUSINESS_ACCOUNT", "DIRECT", "TEST"], required: true },
  billingAdjustment: { type: mongoose.Schema.Types.Mixed, required: true },
  invoiceNumber: { type: String, required: true, trim: true, maxlength: 32 },
  invoiceRevision: { type: Number, required: true, min: 1 },
  note: { type: String, trim: true, maxlength: 500, default: "" },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  verifiedAt: { type: Date, required: true, default: Date.now, index: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

shipmentChargeVerificationSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany"],
  function blockMutation() {
    throw new Error("Shipment charge verifications are immutable.");
  }
);
shipmentChargeVerificationSchema.pre("save", function blockSavedMutation() {
  if (!this.isNew) throw new Error("Shipment charge verifications are immutable.");
});

addTenantOwnership(shipmentChargeVerificationSchema);

export const ShipmentChargeVerification = mongoose.model<IShipmentChargeVerification>(
  "ShipmentChargeVerification",
  shipmentChargeVerificationSchema
);
