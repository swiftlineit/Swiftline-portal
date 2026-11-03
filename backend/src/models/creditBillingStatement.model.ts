import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditBillingStatementStatusValues = [
  "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"
] as const;
export type CreditBillingStatementStatus = (typeof creditBillingStatementStatusValues)[number];

export type CreditBillingStatementLine = {
  sourceType: "SHIPMENT_INVOICE" | "CANCELLATION_FEE_INVOICE";
  shipmentInvoiceId?: mongoose.Types.ObjectId | null;
  cancellationFeeInvoiceId?: mongoose.Types.ObjectId | null;
  shipmentDraftId: mongoose.Types.ObjectId;
  invoiceNumber: string;
  invoiceRevision: number;
  invoiceIssuedAt: Date;
  outstandingAmountMinor: number;
};

export type CreditBillingStatementAdjustment = {
  adjustmentId: mongoose.Types.ObjectId;
  shipmentInvoiceId: mongoose.Types.ObjectId;
  originalStatementId: mongoose.Types.ObjectId;
  description: string;
  amountMinor: number;
  affectsAmountDue: boolean;
};

export interface ICreditBillingStatement extends mongoose.Document, TenantOwnedFields {
  statementNumber: string;
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  billingCycle: "WEEKLY" | "MONTHLY";
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  dueAt: Date;
  currency: "INR";
  lines: CreditBillingStatementLine[];
  adjustments: CreditBillingStatementAdjustment[];
  totalAmountMinor: number;
  paidAmountMinor: number;
  creditAdjustmentMinor: number;
  outstandingAmountMinor: number;
  status: CreditBillingStatementStatus;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const minorAmount = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: isMinorUnitInteger, message: "Amount must be an integer minor-unit value." }
} as const;

const statementLineSchema = new mongoose.Schema<CreditBillingStatementLine>({
  sourceType: { type: String, enum: ["SHIPMENT_INVOICE", "CANCELLATION_FEE_INVOICE"], required: true, default: "SHIPMENT_INVOICE" },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", default: null },
  cancellationFeeInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "CancellationFeeInvoice", default: null },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true },
  invoiceNumber: { type: String, required: true, trim: true, maxlength: 32 },
  invoiceRevision: { type: Number, required: true, min: 1 },
  invoiceIssuedAt: { type: Date, required: true },
  outstandingAmountMinor: minorAmount
}, { _id: false });

const statementAdjustmentSchema = new mongoose.Schema<CreditBillingStatementAdjustment>({
  adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingAdjustment", required: true },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", required: true },
  originalStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", required: true },
  description: { type: String, required: true, trim: true, maxlength: 300 },
  amountMinor: { type: Number, required: true, validate: { validator: Number.isInteger, message: "Adjustment must use minor units." } },
  affectsAmountDue: { type: Boolean, required: true }
}, { _id: false });

const creditBillingStatementSchema = new mongoose.Schema<ICreditBillingStatement>({
  statementNumber: { type: String, required: true, immutable: true, trim: true, maxlength: 32 },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, immutable: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, immutable: true, index: true },
  billingCycle: { type: String, enum: ["WEEKLY", "MONTHLY"], required: true, immutable: true },
  periodStart: { type: Date, required: true, immutable: true },
  periodEnd: { type: Date, required: true, immutable: true },
  issuedAt: { type: Date, required: true, immutable: true, default: Date.now },
  dueAt: { type: Date, required: true, immutable: true, index: true },
  currency: { type: String, enum: ["INR"], required: true, immutable: true, default: "INR" },
  lines: { type: [statementLineSchema], required: true, immutable: true },
  adjustments: { type: [statementAdjustmentSchema], default: [], immutable: true },
  totalAmountMinor: { ...minorAmount, immutable: true },
  paidAmountMinor: { ...minorAmount, default: 0 },
  creditAdjustmentMinor: { ...minorAmount, default: 0 },
  outstandingAmountMinor: minorAmount,
  status: { type: String, enum: creditBillingStatementStatusValues, required: true, default: "ISSUED", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true }
}, { timestamps: true });

creditBillingStatementSchema.index(
  { tenantId: 1, statementNumber: 1 },
  { unique: true, name: "uniq_tenant_credit_statement_number" }
);
creditBillingStatementSchema.index(
  { tenantId: 1, businessAccountId: 1, billingCycle: 1, periodStart: 1, periodEnd: 1 },
  { unique: true, name: "uniq_tenant_credit_statement_period" }
);
creditBillingStatementSchema.index({ businessAccountId: 1, status: 1, dueAt: 1 });

creditBillingStatementSchema.pre("validate", function validateStatementTotals() {
  if (this.periodStart >= this.periodEnd) {
    this.invalidate("periodEnd", "Billing period end must be after its start.");
  }
  if (this.dueAt < this.issuedAt) {
    this.invalidate("dueAt", "Statement due date cannot be before its issue date.");
  }
  if (!this.lines.length && !this.adjustments.length) {
    this.invalidate("lines", "A billing statement requires at least one shipment invoice or adjustment.");
  }

  const invoiceIds = this.lines.map((line) =>
    `${line.sourceType}:${String(line.shipmentInvoiceId ?? line.cancellationFeeInvoiceId)}`
  );
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    this.invalidate("lines", "A shipment invoice can appear only once in a billing statement.");
  }
  for (const line of this.lines) {
    const hasShipmentInvoice = Boolean(line.shipmentInvoiceId);
    const hasFeeInvoice = Boolean(line.cancellationFeeInvoiceId);
    if (hasShipmentInvoice === hasFeeInvoice) {
      this.invalidate("lines", "Each statement line must reference exactly one financial document.");
    }
  }

  const lineTotalMinor = this.lines.reduce((total, line) => total + line.outstandingAmountMinor, 0)
    + this.adjustments.reduce((total, adjustment) => total + (adjustment.affectsAmountDue ? adjustment.amountMinor : 0), 0);
  if (lineTotalMinor !== this.totalAmountMinor) {
    this.invalidate("totalAmountMinor", "Statement total must match its shipment invoices and financial adjustments.");
  }
  if (this.paidAmountMinor + this.creditAdjustmentMinor + this.outstandingAmountMinor !== this.totalAmountMinor) {
    this.invalidate("outstandingAmountMinor", "Statement payment allocation must match its total.");
  }
});

addTenantOwnership(creditBillingStatementSchema);

export const CreditBillingStatement = mongoose.model<ICreditBillingStatement>(
  "CreditBillingStatement",
  creditBillingStatementSchema
);
