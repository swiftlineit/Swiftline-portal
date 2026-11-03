import mongoose from "mongoose";
import { isMinorUnitInteger, maxCreditLimitMinor } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditAccountStatusValues = [
  "NOT_REQUESTED", "PENDING_REVIEW", "APPROVED", "ACTIVE", "ON_HOLD",
  "SUSPENDED", "EXPIRED", "REJECTED", "CLOSED"
] as const;
export type CreditAccountStatus = (typeof creditAccountStatusValues)[number];

export const creditBillingCycleValues = ["WEEKLY", "MONTHLY"] as const;
export type CreditBillingCycle = (typeof creditBillingCycleValues)[number];

export interface IBusinessCreditAccount extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  status: CreditAccountStatus;
  currency: "INR";
  requestedCreditLimitMinor: number;
  requestReason: string;
  requestedBy?: mongoose.Types.ObjectId | null;
  requestedAt?: Date | null;
  approvedCreditLimitMinor: number;
  reservedCreditMinor: number;
  unbilledCreditMinor: number;
  invoicedOutstandingMinor: number;
  customerAdvanceBalanceMinor: number;
  reservedAdvanceMinor: number;
  paymentTermsDays: number;
  billingCycle: CreditBillingCycle;
  validFrom?: Date | null;
  validUntil?: Date | null;
  gracePeriodDays: number;
  maxOverdueDays: number;
  creditWarningThresholdPercent: number;
  securityDepositRequiredMinor: number;
  assignedFinanceApprover?: mongoose.Types.ObjectId | null;
  riskCategory: "LOW" | "MEDIUM" | "HIGH";
  internalRemarks: string;
  holdReason: string;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  activatedBy?: mongoose.Types.ObjectId | null;
  activatedAt?: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const minorAmount = {
  type: Number,
  default: 0,
  min: 0,
  validate: { validator: isMinorUnitInteger, message: "Amount must be an integer minor-unit value." }
} as const;

const creditLimitAmount = {
  ...minorAmount,
  max: maxCreditLimitMinor
} as const;

const businessCreditAccountSchema = new mongoose.Schema<IBusinessCreditAccount>(
  {
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    status: { type: String, enum: creditAccountStatusValues, default: "NOT_REQUESTED", index: true },
    currency: { type: String, enum: ["INR"], default: "INR", required: true },
    requestedCreditLimitMinor: creditLimitAmount,
    requestReason: { type: String, trim: true, maxlength: 500, default: "" },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    requestedAt: { type: Date, default: null },
    approvedCreditLimitMinor: creditLimitAmount,
    reservedCreditMinor: minorAmount,
    unbilledCreditMinor: minorAmount,
    invoicedOutstandingMinor: minorAmount,
    customerAdvanceBalanceMinor: minorAmount,
    reservedAdvanceMinor: minorAmount,
    paymentTermsDays: { type: Number, enum: [0, 7, 15, 30, 45], default: 30 },
    billingCycle: { type: String, enum: creditBillingCycleValues, default: "MONTHLY" },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    gracePeriodDays: { type: Number, min: 0, max: 90, default: 0 },
    maxOverdueDays: { type: Number, min: 0, max: 365, default: 30 },
    creditWarningThresholdPercent: { type: Number, min: 1, max: 100, default: 70 },
    securityDepositRequiredMinor: minorAmount,
    assignedFinanceApprover: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    riskCategory: { type: String, enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" },
    internalRemarks: { type: String, trim: true, maxlength: 2000, default: "" },
    holdReason: { type: String, trim: true, maxlength: 500, default: "" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    activatedAt: { type: Date, default: null },
    version: { type: Number, min: 0, default: 0 }
  },
  { timestamps: true }
);

businessCreditAccountSchema.index(
  { tenantId: 1, businessAccountId: 1 },
  { unique: true, name: "uniq_credit_account_tenant_business" }
);
addTenantOwnership(businessCreditAccountSchema);

export const BusinessCreditAccount = mongoose.model<IBusinessCreditAccount>("BusinessCreditAccount", businessCreditAccountSchema);
