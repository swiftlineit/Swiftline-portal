import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditPaymentMethodValues = [
  "RAZORPAY", "BANK_TRANSFER", "UPI", "CASH", "CHEQUE"
] as const;
export type CreditPaymentMethod = (typeof creditPaymentMethodValues)[number];

export const creditPaymentStatusValues = [
  "CREATED", "PENDING_VERIFICATION", "PROCESSING", "VERIFIED", "FAILED"
] as const;
export type CreditPaymentStatus = (typeof creditPaymentStatusValues)[number];

export type CreditPaymentInvoiceAllocation = {
  sourceType: "SHIPMENT_INVOICE" | "CANCELLATION_FEE_INVOICE";
  shipmentInvoiceId?: mongoose.Types.ObjectId | null;
  cancellationFeeInvoiceId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
};

export type CreditPaymentStatementAllocation = {
  statementId: mongoose.Types.ObjectId;
  amountMinor: number;
  invoiceAllocations: CreditPaymentInvoiceAllocation[];
};

export interface ICreditPayment extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  requestedStatementId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
  currency: "INR";
  method: CreditPaymentMethod;
  status: CreditPaymentStatus;
  internalReference: string;
  idempotencyKey: string;
  externalReference: string;
  notes: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  allocations: CreditPaymentStatementAllocation[];
  advanceAmountMinor: number;
  submittedBy: mongoose.Types.ObjectId;
  verifiedBy?: mongoose.Types.ObjectId | null;
  verifiedAt?: Date | null;
  failureReason: string;
  createdAt: Date;
  updatedAt: Date;
}

const minorAmount = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: isMinorUnitInteger, message: "Amount must be an integer minor-unit value." }
} as const;

const invoiceAllocationSchema = new mongoose.Schema<CreditPaymentInvoiceAllocation>({
  sourceType: { type: String, enum: ["SHIPMENT_INVOICE", "CANCELLATION_FEE_INVOICE"], required: true, default: "SHIPMENT_INVOICE" },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", default: null },
  cancellationFeeInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "CancellationFeeInvoice", default: null },
  amountMinor: minorAmount
}, { _id: false });

const statementAllocationSchema = new mongoose.Schema<CreditPaymentStatementAllocation>({
  statementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", required: true },
  amountMinor: minorAmount,
  invoiceAllocations: { type: [invoiceAllocationSchema], default: [] }
}, { _id: false });

const creditPaymentSchema = new mongoose.Schema<ICreditPayment>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, index: true },
  requestedStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", default: null, index: true },
  amountMinor: { ...minorAmount, min: 1 },
  currency: { type: String, enum: ["INR"], required: true, default: "INR" },
  method: { type: String, enum: creditPaymentMethodValues, required: true, index: true },
  status: { type: String, enum: creditPaymentStatusValues, required: true, index: true },
  internalReference: { type: String, required: true, trim: true, maxlength: 120 },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 240 },
  externalReference: { type: String, trim: true, maxlength: 160, default: "" },
  notes: { type: String, trim: true, maxlength: 500, default: "" },
  razorpayOrderId: { type: String, trim: true, maxlength: 120, default: "" },
  razorpayPaymentId: { type: String, trim: true, maxlength: 120, default: "" },
  razorpaySignature: { type: String, trim: true, maxlength: 256, default: "" },
  allocations: { type: [statementAllocationSchema], default: [] },
  advanceAmountMinor: { ...minorAmount, default: 0 },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  verifiedAt: { type: Date, default: null },
  failureReason: { type: String, trim: true, maxlength: 500, default: "" }
}, { timestamps: true });

creditPaymentSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: "string", $gt: "" } } }
);
creditPaymentSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string", $gt: "" } } }
);
creditPaymentSchema.index(
  { tenantId: 1, internalReference: 1 },
  { unique: true, name: "uniq_tenant_credit_payment_internal_reference" }
);
creditPaymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, name: "uniq_tenant_credit_payment_idempotency" }
);
creditPaymentSchema.index(
  { tenantId: 1, businessAccountId: 1, method: 1, externalReference: 1 },
  {
    unique: true,
    name: "uniq_tenant_credit_payment_external_reference",
    partialFilterExpression: { externalReference: { $type: "string", $gt: "" } }
  }
);
creditPaymentSchema.index({ businessAccountId: 1, createdAt: -1 });

addTenantOwnership(creditPaymentSchema);

export const CreditPayment = mongoose.model<ICreditPayment>("CreditPayment", creditPaymentSchema);
