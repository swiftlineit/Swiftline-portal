import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICreditLimitHistory extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  previousLimitMinor: number;
  newLimitMinor: number;
  reason: string;
  changedBy: mongoose.Types.ObjectId;
  changedAt: Date;
}

const creditLimitHistorySchema = new mongoose.Schema<ICreditLimitHistory>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, index: true },
  previousLimitMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger },
  newLimitMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger },
  reason: { type: String, trim: true, maxlength: 500, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  changedAt: { type: Date, default: Date.now, index: true }
});

addTenantOwnership(creditLimitHistorySchema);

export const CreditLimitHistory = mongoose.model<ICreditLimitHistory>("CreditLimitHistory", creditLimitHistorySchema);
