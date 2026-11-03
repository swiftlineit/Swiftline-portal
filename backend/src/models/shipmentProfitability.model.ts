import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";
import { profitabilityCostComponentValues, type ProfitabilityCostComponent } from "./vendorCostRate.model.js";

export const shipmentCostStateValues = ["MISSING", "ESTIMATED", "ACTUAL"] as const;
export type ShipmentCostState = (typeof shipmentCostStateValues)[number];

export const profitabilityCoverageValues = ["MISSING", "PARTIAL", "ESTIMATED", "ACTUAL"] as const;
export type ProfitabilityCoverage = (typeof profitabilityCoverageValues)[number];

export type ShipmentProfitabilityCost = {
  component: ProfitabilityCostComponent;
  amountMinor: number;
  state: ShipmentCostState;
  source: "NONE" | "VENDOR_RATE" | "MANUAL";
  vendorId?: mongoose.Types.ObjectId | null;
  rateId?: mongoose.Types.ObjectId | null;
  reference: string;
  note: string;
  updatedBy?: mongoose.Types.ObjectId | null;
  updatedAt?: Date | null;
};

export type ShipmentFlightAllocationCost = {
  component: "AIR_FREIGHT" | "AIR_FREIGHT_GST" | "EICF" | "CUSTOMS" | "TRANSPORTATION" | "CFL" | "DPD_LABEL";
  amountMinor: number;
  /** Optional visual equivalent using the flight sheet's locked GBP/INR rate. */
  amountMinorGbp?: number | null;
};

export interface IShipmentProfitability extends mongoose.Document, TenantOwnedFields {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  shipmentInvoiceId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  primaryVendorId?: mongoose.Types.ObjectId | null;
  costSource: "LEGACY" | "FLIGHT_ALLOCATION";
  flightCostSheetId?: mongoose.Types.ObjectId | null;
  operationsManifestId?: mongoose.Types.ObjectId | null;
  flightAllocation: ShipmentFlightAllocationCost[];
  flightFxGbpToInr?: number | null;
  awb: string;
  customerName: string;
  originCountryCode: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  serviceType: "COURIER" | "CARGO";
  serviceCode: string;
  chargeableWeightKg: number;
  bookedAt: Date;
  currency: "INR";
  customerSellingAmountMinor: number;
  revenueAdjustmentMinor: number;
  totalRevenueMinor: number;
  dutyTaxMinor: number;
  costs: ShipmentProfitabilityCost[];
  totalCostMinor: number;
  grossProfitMinor: number;
  marginBasisPoints?: number | null;
  coverage: ProfitabilityCoverage;
  version: number;
  revenueSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const costSchema = new mongoose.Schema<ShipmentProfitabilityCost>({
  component: { type: String, enum: profitabilityCostComponentValues, required: true },
  amountMinor: { type: Number, required: true, min: 0, default: 0 },
  state: { type: String, enum: shipmentCostStateValues, required: true, default: "MISSING" },
  source: { type: String, enum: ["NONE", "VENDOR_RATE", "MANUAL"], required: true, default: "NONE" },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "LogisticsVendor", default: null },
  rateId: { type: mongoose.Schema.Types.ObjectId, ref: "VendorCostRate", default: null },
  reference: { type: String, trim: true, maxlength: 120, default: "" },
  note: { type: String, trim: true, maxlength: 500, default: "" },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedAt: { type: Date, default: null }
}, { _id: false });

const flightAllocationSchema = new mongoose.Schema<ShipmentFlightAllocationCost>({
  component: { type: String, enum: ["AIR_FREIGHT", "AIR_FREIGHT_GST", "EICF", "CUSTOMS", "TRANSPORTATION", "CFL", "DPD_LABEL"], required: true },
  amountMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  amountMinorGbp: { type: Number, default: null, min: 0, validate: (value: number | null) => value === null || Number.isSafeInteger(value) }
}, { _id: false });

const schema = new mongoose.Schema<IShipmentProfitability>({
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, unique: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, unique: true, index: true },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", required: true, unique: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  primaryVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "LogisticsVendor", default: null, index: true },
  costSource: { type: String, enum: ["LEGACY", "FLIGHT_ALLOCATION"], required: true, default: "LEGACY", index: true },
  flightCostSheetId: { type: mongoose.Schema.Types.ObjectId, ref: "FlightCostSheet", default: null, index: true },
  operationsManifestId: { type: mongoose.Schema.Types.ObjectId, ref: "OperationsManifest", default: null, index: true },
  flightAllocation: { type: [flightAllocationSchema], required: true, default: [] },
  flightFxGbpToInr: { type: Number, default: null, min: 0.000001 },
  awb: { type: String, required: true, trim: true, maxlength: 40, index: true },
  customerName: { type: String, required: true, trim: true, maxlength: 160, index: true },
  originCountryCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 2, default: "IN" },
  destinationCountryCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
  destinationCountryName: { type: String, required: true, trim: true, maxlength: 80 },
  serviceType: { type: String, enum: ["COURIER", "CARGO"], required: true, index: true },
  serviceCode: { type: String, trim: true, maxlength: 40, default: "" },
  chargeableWeightKg: { type: Number, required: true, min: 0 },
  bookedAt: { type: Date, required: true, index: true },
  currency: { type: String, enum: ["INR"], default: "INR", required: true },
  customerSellingAmountMinor: { type: Number, required: true, default: 0 },
  revenueAdjustmentMinor: { type: Number, required: true, default: 0 },
  totalRevenueMinor: { type: Number, required: true, default: 0 },
  dutyTaxMinor: { type: Number, required: true, default: 0 },
  costs: { type: [costSchema], required: true, default: [] },
  totalCostMinor: { type: Number, required: true, min: 0, default: 0 },
  grossProfitMinor: { type: Number, required: true, default: 0 },
  marginBasisPoints: { type: Number, default: null },
  coverage: { type: String, enum: profitabilityCoverageValues, required: true, default: "MISSING", index: true },
  version: { type: Number, required: true, min: 1, default: 1 },
  revenueSyncedAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

schema.index({ branchId: 1, bookedAt: -1 });
schema.index({ businessAccountId: 1, bookedAt: -1 });
schema.index({ destinationCountryCode: 1, serviceType: 1, bookedAt: -1 });
schema.index({ branchId: 1, coverage: 1, grossProfitMinor: 1 });

addTenantOwnership(schema);

export const ShipmentProfitability = mongoose.model<IShipmentProfitability>("ShipmentProfitability", schema);
