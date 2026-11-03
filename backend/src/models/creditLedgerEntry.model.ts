import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditLedgerEntryTypeValues = [
  "CREDIT_REQUESTED", "CREDIT_APPROVED", "CREDIT_ACTIVATED", "CREDIT_REJECTED",
  "CREDIT_HOLD_APPLIED", "CREDIT_HOLD_RELEASED", "LIMIT_CHANGED", "MIGRATION_OPENING_BALANCE",
  "CUSTOMER_ADVANCE_RECEIVED", "BOOKING_RESERVED", "BOOKING_CONVERTED",
  "BOOKING_RELEASED", "BOOKING_REVIEW_REQUIRED", "AMENDMENT_INCREASE_APPLIED",
  "AMENDMENT_REDUCTION_APPLIED", "FINAL_CHARGE_INCREASE_APPLIED",
  "FINAL_CHARGE_REDUCTION_APPLIED", "BILLING_STATEMENT_ISSUED",
  "STATEMENT_PAYMENT_APPLIED", "EXCESS_PAYMENT_TO_ADVANCE",
  "SHIPMENT_CANCELLATION_APPLIED",
  "CREDIT_SUSPENDED", "CREDIT_REACTIVATED", "CREDIT_CLOSED", "CREDIT_EXPIRED",
  "STATEMENT_WRITTEN_OFF"
] as const;
export type CreditLedgerEntryType = (typeof creditLedgerEntryTypeValues)[number];

export interface ICreditLedgerEntry extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  type: CreditLedgerEntryType;
  reference: string;
  description: string;
  amountMinor: number;
  currency: "INR";
  availableCreditAfterMinor: number;
  availableAdvanceAfterMinor: number;
  idempotencyKey: string;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

const creditLedgerEntrySchema = new mongoose.Schema<ICreditLedgerEntry>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, index: true },
  type: { type: String, enum: creditLedgerEntryTypeValues, required: true, index: true },
  reference: { type: String, trim: true, required: true, maxlength: 120 },
  description: { type: String, trim: true, required: true, maxlength: 500 },
  amountMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger },
  currency: { type: String, enum: ["INR"], default: "INR" },
  availableCreditAfterMinor: { type: Number, required: true, validate: isMinorUnitInteger },
  availableAdvanceAfterMinor: { type: Number, required: true, validate: isMinorUnitInteger },
  idempotencyKey: { type: String, trim: true, required: true, maxlength: 240 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
});

creditLedgerEntrySchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, name: "uniq_tenant_credit_ledger_idempotency" }
);
addTenantOwnership(creditLedgerEntrySchema);

creditLedgerEntrySchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], function blockMutation() {
  throw new Error("Credit ledger entries are append-only.");
});

export const CreditLedgerEntry = mongoose.model<ICreditLedgerEntry>("CreditLedgerEntry", creditLedgerEntrySchema);
