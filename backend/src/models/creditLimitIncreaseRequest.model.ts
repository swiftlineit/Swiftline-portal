import mongoose from "mongoose";
import { isMinorUnitInteger, maxCreditLimitMinor } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditLimitIncreaseStatusValues = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
export type CreditLimitIncreaseStatus = (typeof creditLimitIncreaseStatusValues)[number];

export interface ICreditLimitIncreaseRequest extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  /** The approved limit at the moment of asking, so a later change is visible. */
  currentLimitMinor: number;
  requestedLimitMinor: number;
  reason: string;
  status: CreditLimitIncreaseStatus;
  requestedBy: mongoose.Types.ObjectId;
  requestedAt: Date;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  /** What the reviewer actually granted, which need not be what was asked for. */
  decidedLimitMinor?: number | null;
  decisionNote: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A live customer asking for a higher limit.
 *
 * Deliberately its own record rather than a field on the credit account. The
 * account's own status drives whether credit is spendable at all- available
 * credit is zero unless the status is exactly ACTIVE- so routing a request
 * through it would take a working facility offline for as long as the request
 * sat unreviewed, breaking every booking in the meantime.
 *
 * Nothing here touches the account. The facility keeps working at its existing
 * limit until somebody decides.
 */
const creditLimitIncreaseRequestSchema = new mongoose.Schema<ICreditLimitIncreaseRequest>(
  {
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, index: true },
    currentLimitMinor: {
      type: Number,
      required: true,
      min: 0,
      max: maxCreditLimitMinor,
      validate: { validator: isMinorUnitInteger, message: "Amount must be an integer minor-unit value." }
    },
    requestedLimitMinor: {
      type: Number,
      required: true,
      min: 1,
      max: maxCreditLimitMinor,
      validate: { validator: isMinorUnitInteger, message: "Amount must be an integer minor-unit value." }
    },
    reason: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },
    status: { type: String, enum: creditLimitIncreaseStatusValues, default: "PENDING", required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now, index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    decidedLimitMinor: { type: Number, default: null, min: 0, max: maxCreditLimitMinor },
    decisionNote: { type: String, trim: true, maxlength: 500, default: "" }
  },
  { timestamps: true }
);

// One open request per business at a time. Partial, so decided requests accumulate
// as history rather than blocking the next ask.
creditLimitIncreaseRequestSchema.index(
  { tenantId: 1, businessAccountId: 1 },
  {
    unique: true,
    name: "uniq_tenant_pending_credit_limit_request_business",
    partialFilterExpression: { status: "PENDING" }
  }
);

addTenantOwnership(creditLimitIncreaseRequestSchema);

export const CreditLimitIncreaseRequest = mongoose.model<ICreditLimitIncreaseRequest>(
  "CreditLimitIncreaseRequest",
  creditLimitIncreaseRequestSchema
);
