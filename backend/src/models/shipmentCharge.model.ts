import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";
import {
  isMinorUnitInteger,
  paymentSourceValues,
  prepaidCurrencyValues,
  type PaymentSource,
  type PrepaidCurrency
} from "./financialTypes.js";

export const customerChargeStatusValues = ["RESERVED", "COMPLETED", "REVERSED", "REVIEW_REQUIRED", "TEST"] as const;
export type CustomerChargeStatus = (typeof customerChargeStatusValues)[number];

export interface IShipmentCharge extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId | null;
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId?: mongoose.Types.ObjectId | null;
  balanceReservationId?: mongoose.Types.ObjectId | null;
  parcelCount: number;
  paymentSource: PaymentSource;
  customerChargeMinor: number;
  customerCurrency: PrepaidCurrency;
  customerChargeStatus: CustomerChargeStatus;
  pricingSnapshot: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentChargeSchema = new mongoose.Schema<IShipmentCharge>(
  {
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    shipmentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    shipmentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShipmentDraft",
      required: true,
      unique: true,
      index: true
    },
    dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", default: null, index: true },
    balanceReservationId: { type: mongoose.Schema.Types.ObjectId, ref: "BalanceReservation", default: null, index: true },
    parcelCount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: isMinorUnitInteger, message: "parcelCount must be an integer" }
    },
    paymentSource: { type: String, enum: paymentSourceValues, required: true },
    customerChargeMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "customerChargeMinor must be an integer minor-unit amount" }
    },
    customerCurrency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
    customerChargeStatus: { type: String, enum: customerChargeStatusValues, required: true, index: true },
    pricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, default: {} }
  },
  { timestamps: true }
);

shipmentChargeSchema.index({ businessAccountId: 1, branchId: 1, createdAt: -1 });

addTenantOwnership(shipmentChargeSchema);

export const ShipmentCharge = mongoose.model<IShipmentCharge>(
  "ShipmentCharge",
  shipmentChargeSchema
);
