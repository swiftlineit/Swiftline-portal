import mongoose from "mongoose";
import { isMinorUnitInteger, prepaidCurrencyValues, type PrepaidCurrency } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const prepaidAccountStatusValues = ["ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type PrepaidAccountStatus = (typeof prepaidAccountStatusValues)[number];

export interface IPrepaidAccount extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  currency: PrepaidCurrency;
  cashBalanceMinor: number;
  reservedBalanceMinor: number;
  status: PrepaidAccountStatus;
  version: number;
  minimumBalanceWarningMinor: number;
  fundingCycleSequence: number;
  fundingCycleBaselineMinor: number;
  fundingCycleStartedAt?: Date | null;
  lowBalanceAlertedCycle?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const prepaidAccountSchema = new mongoose.Schema<IPrepaidAccount>(
  {
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    currency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
    cashBalanceMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "cashBalanceMinor must be an integer minor-unit amount" }
    },
    reservedBalanceMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "reservedBalanceMinor must be an integer minor-unit amount" }
    },
    status: { type: String, enum: prepaidAccountStatusValues, default: "ACTIVE", index: true },
    version: { type: Number, default: 0, min: 0, validate: { validator: isMinorUnitInteger, message: "version must be an integer" } },
    minimumBalanceWarningMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "minimumBalanceWarningMinor must be an integer minor-unit amount" }
    },
    fundingCycleSequence: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "fundingCycleSequence must be an integer" }
    },
    fundingCycleBaselineMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "fundingCycleBaselineMinor must be an integer minor-unit amount" }
    },
    fundingCycleStartedAt: { type: Date, default: null },
    lowBalanceAlertedCycle: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (value: unknown) => value == null || isMinorUnitInteger(value),
        message: "lowBalanceAlertedCycle must be an integer"
      }
    }
  },
  { timestamps: true }
);

prepaidAccountSchema.index({ tenantId: 1, businessAccountId: 1 }, { unique: true, name: "tenant_business_wallet" });
addTenantOwnership(prepaidAccountSchema);

export const PrepaidAccount = mongoose.model<IPrepaidAccount>(
  "PrepaidAccount",
  prepaidAccountSchema
);
