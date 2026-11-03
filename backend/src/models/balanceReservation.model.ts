import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";
import { isMinorUnitInteger, prepaidCurrencyValues, type PrepaidCurrency } from "./financialTypes.js";

export const balanceReservationStatusValues = [
  "ACTIVE",
  "CONSUMING",
  "CONVERTED",
  "RELEASED",
  "EXPIRED",
  "REVIEW_REQUIRED"
] as const;
export type BalanceReservationStatus = (typeof balanceReservationStatusValues)[number];

export interface IBalanceReservation extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  amountMinor: number;
  advanceAmountMinor: number;
  creditAmountMinor: number;
  currency: PrepaidCurrency;
  status: BalanceReservationStatus;
  idempotencyKey: string;
  expiresAt: Date;
  consumingAt?: Date | null;
  convertedAt?: Date | null;
  releasedAt?: Date | null;
  expiredAt?: Date | null;
  reviewRequiredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const balanceReservationSchema = new mongoose.Schema<IBalanceReservation>(
  {
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: isMinorUnitInteger, message: "amountMinor must be an integer minor-unit amount" }
    },
    advanceAmountMinor: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "advanceAmountMinor must be an integer minor-unit amount" }
    },
    creditAmountMinor: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: isMinorUnitInteger, message: "creditAmountMinor must be an integer minor-unit amount" }
    },
    currency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
    status: { type: String, enum: balanceReservationStatusValues, default: "ACTIVE", index: true },
    idempotencyKey: { type: String, required: true, unique: true, trim: true, maxlength: 256 },
    expiresAt: { type: Date, required: true, index: true },
    consumingAt: { type: Date, default: null },
    convertedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    reviewRequiredAt: { type: Date, default: null }
  },
  { timestamps: true }
);

balanceReservationSchema.pre("validate", function validateReservationAllocation() {
  if (this.advanceAmountMinor + this.creditAmountMinor !== this.amountMinor) {
    this.invalidate("amountMinor", "Advance and credit allocation must equal the reserved amount.");
  }
});

// The active reservation guard is scoped to shipment drafts so retries cannot
// create multiple live holds for the same label attempt.
balanceReservationSchema.index(
  { shipmentDraftId: 1 },
  {
    name: "unique_live_reservation_per_shipment_draft",
    unique: true,
    partialFilterExpression: { status: { $in: ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"] } }
  }
);

addTenantOwnership(balanceReservationSchema);

export const BalanceReservation = mongoose.model<IBalanceReservation>(
  "BalanceReservation",
  balanceReservationSchema
);
