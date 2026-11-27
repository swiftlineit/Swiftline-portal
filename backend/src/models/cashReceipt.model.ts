import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const cashReceiptStatusValues = ["DRAFT", "FINALIZED", "REVERSED"] as const;
export type CashReceiptStatus = (typeof cashReceiptStatusValues)[number];
export const cashReceiptAllocationTypeValues = ["SHIPMENT", "CREDIT_STATEMENT", "UNAPPLIED"] as const;
export type CashReceiptAllocationType = (typeof cashReceiptAllocationTypeValues)[number];
export const cashReceiptTypeValues = ["SHIPMENT", "STANDALONE"] as const;
export type CashReceiptType = (typeof cashReceiptTypeValues)[number];

export type CashReceiptAllocation = {
  allocationType: CashReceiptAllocationType;
  targetId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
  reference: string;
};

export interface ICashReceipt extends mongoose.Document, TenantOwnedFields {
  receiptNumber: string;
  receiptType: CashReceiptType;
  standaloneIdempotencyKey?: string | null;
  status: CashReceiptStatus;
  customerType: "BUSINESS" | "INDIVIDUAL";
  // Standalone receipts may be issued without a business account; shipment
  // receipts always point at the account that funded the booking.
  businessAccountId?: mongoose.Types.ObjectId | null;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  activeShipmentKey?: string | null;
  pricingHash: string;
  pricingRevision: number;
  totalReceivedMinor: number;
  currency: "INR";
  allocations: CashReceiptAllocation[];
  unappliedAmountMinor: number;
  customerNameSnapshot: string;
  gstinSnapshot: string;
  addressSnapshot: string;
  businessMobileNumberSnapshot?: string;
  receiptDate: Date;
  accountIdSnapshot: string;
  destinationSnapshot: string;
  serviceSnapshot: string;
  piecesSnapshot: number | null;
  weightKgSnapshot: number | null;
  customerReference: string;
  cashCustodyReference: string;
  note: string;
  createdBy: mongoose.Types.ObjectId;
  createdByNameSnapshot: string;
  cashRecordedBy?: mongoose.Types.ObjectId | null;
  cashRecordedByNameSnapshot: string;
  bookedBy?: mongoose.Types.ObjectId | null;
  bookedByNameSnapshot: string;
  issuedAt?: Date | null;
  reversedAt?: Date | null;
  reversalReason: string;
  replacementReceiptId?: mongoose.Types.ObjectId | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const cashReceiptAllocationSchema = new mongoose.Schema<CashReceiptAllocation>({
  allocationType: { type: String, enum: cashReceiptAllocationTypeValues, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  amountMinor: { type: Number, required: true, min: 1, validate: { validator: isMinorUnitInteger, message: "allocation amount must be an integer minor-unit amount" } },
  reference: { type: String, trim: true, maxlength: 160, default: "" }
}, { _id: false });

const cashReceiptSchema = new mongoose.Schema<ICashReceipt>({
  receiptNumber: { type: String, required: true, trim: true, maxlength: 80 },
  receiptType: { type: String, enum: cashReceiptTypeValues, default: "SHIPMENT", required: true, index: true },
  standaloneIdempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
  status: { type: String, enum: cashReceiptStatusValues, required: true, default: "DRAFT", index: true },
  customerType: { type: String, enum: ["BUSINESS", "INDIVIDUAL"], required: true, index: true },
  businessAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BusinessAccount",
    default: null,
    index: true,
    // Manual/walk-in standalone receipts are not tied to an account; every
    // shipment receipt still must resolve to one.
    required: function (this: ICashReceipt): boolean { return this.receiptType !== "STANDALONE"; }
  },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", default: null, index: true },
  activeShipmentKey: { type: String, trim: true, default: null },
  pricingHash: { type: String, trim: true, maxlength: 128, default: "" },
  pricingRevision: { type: Number, default: 0, min: 0, validate: { validator: isMinorUnitInteger, message: "pricingRevision must be an integer" } },
  totalReceivedMinor: { type: Number, required: true, min: 1, validate: { validator: isMinorUnitInteger, message: "totalReceivedMinor must be an integer minor-unit amount" } },
  currency: { type: String, enum: ["INR"], default: "INR", required: true },
  allocations: { type: [cashReceiptAllocationSchema], default: [] },
  unappliedAmountMinor: { type: Number, default: 0, min: 0, validate: { validator: isMinorUnitInteger, message: "unappliedAmountMinor must be an integer minor-unit amount" } },
  customerNameSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
  gstinSnapshot: { type: String, trim: true, uppercase: true, maxlength: 15, default: "" },
  addressSnapshot: { type: String, trim: true, maxlength: 500, default: "" },
  businessMobileNumberSnapshot: { type: String, trim: true, maxlength: 32, default: "" },
  receiptDate: { type: Date, required: true, default: Date.now },
  accountIdSnapshot: { type: String, trim: true, maxlength: 100, default: "" },
  destinationSnapshot: { type: String, trim: true, maxlength: 200, default: "" },
  serviceSnapshot: {
    type: String,
    trim: true,
    maxlength: 120,
    default: "",
    required: function (this: ICashReceipt): boolean { return this.receiptType !== "STANDALONE"; }
  },
  piecesSnapshot: {
    type: Number,
    default: null,
    min: 1,
    required: function (this: ICashReceipt): boolean { return this.receiptType !== "STANDALONE"; },
    validate: { validator: (value: number | null | undefined) => value == null || isMinorUnitInteger(value), message: "piecesSnapshot must be an integer" }
  },
  weightKgSnapshot: {
    type: Number,
    default: null,
    min: 0,
    required: function (this: ICashReceipt): boolean { return this.receiptType !== "STANDALONE"; }
  },
  customerReference: { type: String, trim: true, maxlength: 160, default: "" },
  cashCustodyReference: { type: String, required: true, trim: true, maxlength: 160 },
  note: { type: String, trim: true, maxlength: 500, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  createdByNameSnapshot: { type: String, required: true, trim: true, maxlength: 160 },
  cashRecordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  cashRecordedByNameSnapshot: { type: String, trim: true, maxlength: 160, default: "" },
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  bookedByNameSnapshot: { type: String, trim: true, maxlength: 160, default: "" },
  issuedAt: { type: Date, default: null, index: true },
  reversedAt: { type: Date, default: null },
  reversalReason: { type: String, trim: true, maxlength: 500, default: "" },
  replacementReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "CashReceipt", default: null },
  version: { type: Number, default: 0, min: 0, validate: { validator: isMinorUnitInteger, message: "version must be an integer" } }
}, { timestamps: true });

cashReceiptSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true, name: "tenant_cash_receipt_number" });
cashReceiptSchema.index(
  { tenantId: 1, standaloneIdempotencyKey: 1 },
  { unique: true, name: "tenant_standalone_cash_receipt_idempotency", partialFilterExpression: { standaloneIdempotencyKey: { $type: "string" } } }
);
cashReceiptSchema.index(
  { tenantId: 1, shipmentDraftId: 1, status: 1 },
  { unique: true, name: "tenant_active_cash_receipt", partialFilterExpression: { shipmentDraftId: { $type: "objectId" }, status: { $in: ["DRAFT", "FINALIZED"] } } }
);
cashReceiptSchema.index({ tenantId: 1, businessAccountId: 1, issuedAt: -1 }, { name: "tenant_account_cash_receipts" });
cashReceiptSchema.index(
  { tenantId: 1, activeShipmentKey: 1 },
  { unique: true, name: "tenant_one_active_shipment_cash_receipt", partialFilterExpression: { activeShipmentKey: { $type: "string" } } }
);

addTenantOwnership(cashReceiptSchema);

export const CashReceipt = mongoose.model<ICashReceipt>("CashReceipt", cashReceiptSchema);
