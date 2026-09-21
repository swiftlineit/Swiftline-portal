import mongoose from "mongoose";

export type ShipmentManifestActorRole = "admin" | "client";

export interface ShipmentManifestLineSnapshot {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  consignmentNumber: string;
  pieces: number;
  weightKg: number;
  /** Shipment-level chargeable weight (max of actual vs volumetric, per parcel). */
  chargeableWeightKg?: number;
  consignor: Record<string, unknown>;
  consignee: Record<string, unknown>;
  description: string;
  declaredValueMinor: number;
  currency: "INR";
  bagNumber: string;
  serviceInfo: string;
  /**
   * Handover-document columns, captured at seal time beside the existing fields.
   * All optional: manifests sealed before the handover PDF existed do not carry
   * them, so every reader falls back to the older fields above.
   */
  awbNumbers?: string[];
  forwardingNumbers?: string[];
  destination?: string;
  shipperName?: string;
  receiverName?: string;
  product?: string;
  remark?: string;
  /** The Swiftline service the customer bought: COURIER or CARGO. */
  service?: string;
  /**
   * One entry per physical parcel. The handover manifest gives each parcel its
   * own row, so these carry the per-parcel barcode, forwarding number, weight
   * and product rather than a joined summary.
   */
  parcels?: ShipmentManifestParcelSnapshot[];
}

export interface ShipmentManifestParcelSnapshot {
  awbNumber: string;
  forwardingNumber: string;
  weightKg: number;
  /** That parcel's own chargeable weight; absent on lines sealed before it was captured. */
  chargeableWeightKg?: number;
  product: string;
}

export interface IShipmentManifest extends mongoose.Document {
  manifestNumber: string;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftIds: mongoose.Types.ObjectId[];
  headerSnapshot: Record<string, unknown>;
  lineSnapshots: ShipmentManifestLineSnapshot[];
  totalPieces: number;
  totalWeightKg: number;
  totalBags: number;
  createdBy: mongoose.Types.ObjectId;
  actorRole: ShipmentManifestActorRole;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const manifestLineSchema = new mongoose.Schema<ShipmentManifestLineSnapshot>({
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true },
  consignmentNumber: { type: String, required: true, trim: true, maxlength: 80 },
  pieces: { type: Number, required: true, min: 1 },
  weightKg: { type: Number, required: true, min: 0 },
  chargeableWeightKg: { type: Number, min: 0 },
  consignor: { type: mongoose.Schema.Types.Mixed, required: true },
  consignee: { type: mongoose.Schema.Types.Mixed, required: true },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  declaredValueMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ["INR"], default: "INR", required: true },
  bagNumber: { type: String, required: true, trim: true, maxlength: 40 },
  serviceInfo: { type: String, required: true, trim: true, maxlength: 40 },
  awbNumbers: [{ type: String, trim: true, maxlength: 80 }],
  forwardingNumbers: [{ type: String, trim: true, maxlength: 80 }],
  destination: { type: String, trim: true, maxlength: 120 },
  shipperName: { type: String, trim: true, maxlength: 200 },
  receiverName: { type: String, trim: true, maxlength: 200 },
  product: { type: String, trim: true, maxlength: 60 },
  remark: { type: String, trim: true, maxlength: 120 },
  service: { type: String, trim: true, maxlength: 40 },
  parcels: {
    type: [new mongoose.Schema<ShipmentManifestParcelSnapshot>({
      awbNumber: { type: String, trim: true, maxlength: 80, default: "" },
      forwardingNumber: { type: String, trim: true, maxlength: 80, default: "" },
      weightKg: { type: Number, min: 0, default: 0 },
      chargeableWeightKg: { type: Number, min: 0 },
      product: { type: String, trim: true, maxlength: 60, default: "" }
    }, { _id: false })],
    default: undefined
  }
}, { _id: false });

const shipmentManifestSchema = new mongoose.Schema<IShipmentManifest>({
  manifestNumber: { type: String, required: true, unique: true, index: true, trim: true, maxlength: 40 },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  shipmentDraftIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true }],
  headerSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  lineSnapshots: { type: [manifestLineSchema], required: true },
  totalPieces: { type: Number, required: true, min: 1 },
  totalWeightKg: { type: Number, required: true, min: 0 },
  totalBags: { type: Number, required: true, min: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  actorRole: { type: String, enum: ["admin", "client"], required: true },
  generatedAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

shipmentManifestSchema.index({ businessAccountId: 1, branchId: 1, generatedAt: -1 });
shipmentManifestSchema.index({ "lineSnapshots.shipmentDraftId": 1, generatedAt: -1 });
shipmentManifestSchema.index(
  { shipmentDraftIds: 1, actorRole: 1 },
  { unique: true, name: "shipmentDraftIds_1_actorRole_1" }
);

export const ShipmentManifest = mongoose.model<IShipmentManifest>(
  "ShipmentManifest",
  shipmentManifestSchema
);
