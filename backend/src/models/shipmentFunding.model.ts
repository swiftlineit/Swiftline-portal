import mongoose from "mongoose";
import { isMinorUnitInteger, prepaidCurrencyValues, type PrepaidCurrency } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const shipmentFundingSourceValues = [
  "BUSINESS_WALLET",
  "DIRECT_RAZORPAY",
  "CASH_RECEIPT",
  "PUBLIC_RAZORPAY",
  "OPERATOR_LEGACY",
  "TEST"
] as const;
export type ShipmentFundingSource = (typeof shipmentFundingSourceValues)[number];

export const shipmentFundingStatusValues = [
  "SECURED",
  "CONSUMING",
  "COMPLETED",
  "REVIEW_REQUIRED",
  "RELEASED"
] as const;
export type ShipmentFundingStatus = (typeof shipmentFundingStatusValues)[number];

export interface IShipmentFunding extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: PrepaidCurrency;
  source: ShipmentFundingSource;
  sourceReferenceId?: mongoose.Types.ObjectId | null;
  pricingHash: string;
  pricingRevision: number;
  status: ShipmentFundingStatus;
  bookingAttemptId: string;
  securedBy?: mongoose.Types.ObjectId | null;
  securedAt: Date;
  consumingAt?: Date | null;
  completedAt?: Date | null;
  releasedAt?: Date | null;
  releaseReason: string;
  version: number;
  previousAttempts: Array<{
    bookingAttemptId: string;
    source: ShipmentFundingSource;
    sourceReferenceId?: mongoose.Types.ObjectId | null;
    amountMinor: number;
    pricingHash: string;
    securedAt: Date;
    releasedAt?: Date | null;
    releaseReason: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentFundingSchema = new mongoose.Schema<IShipmentFunding>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  amountMinor: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: isMinorUnitInteger, message: "amountMinor must be an integer minor-unit amount" }
  },
  currency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
  source: { type: String, enum: shipmentFundingSourceValues, required: true, index: true },
  sourceReferenceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  pricingHash: { type: String, required: true, trim: true, maxlength: 128 },
  pricingRevision: { type: Number, required: true, min: 0, validate: { validator: isMinorUnitInteger, message: "pricingRevision must be an integer" } },
  status: { type: String, enum: shipmentFundingStatusValues, required: true, default: "SECURED", index: true },
  bookingAttemptId: { type: String, required: true, trim: true, maxlength: 160 },
  securedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  securedAt: { type: Date, required: true, default: Date.now },
  consumingAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  releaseReason: { type: String, trim: true, maxlength: 500, default: "" },
  previousAttempts: { type: [{
    _id: false,
    bookingAttemptId: String,
    source: { type: String, enum: shipmentFundingSourceValues },
    sourceReferenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    amountMinor: Number,
    pricingHash: String,
    securedAt: Date,
    releasedAt: Date,
    releaseReason: String
  }], default: [] },
  version: { type: Number, default: 0, min: 0, validate: { validator: isMinorUnitInteger, message: "version must be an integer" } }
}, { timestamps: true });

shipmentFundingSchema.index({ tenantId: 1, shipmentDraftId: 1 }, { unique: true, name: "tenant_shipment_funding" });
shipmentFundingSchema.index(
  { tenantId: 1, source: 1, sourceReferenceId: 1 },
  {
    unique: true,
    name: "tenant_funding_source_once",
    partialFilterExpression: { sourceReferenceId: { $type: "objectId" } }
  }
);
shipmentFundingSchema.index({ tenantId: 1, status: 1, updatedAt: 1 }, { name: "tenant_funding_reconciliation" });

addTenantOwnership(shipmentFundingSchema);

export const ShipmentFunding = mongoose.model<IShipmentFunding>("ShipmentFunding", shipmentFundingSchema);
