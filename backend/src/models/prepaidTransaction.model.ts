import mongoose from "mongoose";
import {
  isMinorUnitInteger,
  paymentSourceValues,
  prepaidCurrencyValues,
  type PaymentSource,
  type PrepaidCurrency
} from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const prepaidTransactionTypeValues = [
  "TOP_UP_SUCCESS",
  "TOP_UP_FAILED",
  "LABEL_CHARGE_RESERVED",
  "LABEL_RESERVATION_RELEASED",
  "LABEL_RESERVATION_EXPIRED",
  "LABEL_CHARGE_COMPLETED",
  "LABEL_CHARGE_REVERSED",
  "SHIPMENT_PAYMENT_RESERVED",
  "SHIPMENT_PAYMENT_RELEASED",
  "SHIPMENT_PAYMENT_COMPLETED",
  "AMENDMENT_PAYMENT_RESERVED",
  "AMENDMENT_PAYMENT_RELEASED",
  "AMENDMENT_PAYMENT_COMPLETED",
  "AMENDMENT_ADJUSTMENT_CREDITED",
  "OPENING_BALANCE_TRANSFER",
  "SHIPMENT_CANCELLATION_REFUND",
  "ADMIN_CREDIT",
  "ADMIN_DEBIT",
  "PAYMENT_REFUND_PENDING",
  "PAYMENT_REFUNDED",
  "TEST_SHIPMENT"
] as const;
export type PrepaidTransactionType = (typeof prepaidTransactionTypeValues)[number];

export const prepaidTransactionDirectionValues = ["CREDIT", "DEBIT", "NONE"] as const;
export type PrepaidTransactionDirection = (typeof prepaidTransactionDirectionValues)[number];

export const prepaidTransactionReferenceTypeValues = [
  "PAYMENT_TOP_UP",
  "BALANCE_RESERVATION",
  "SHIPMENT_CHARGE",
  "DPD_SHIPMENT",
  "ADMIN_ADJUSTMENT",
  "WEBHOOK_EVENT",
  "SHIPMENT_FUNDING",
  "SHIPMENT_AMENDMENT",
  "SHIPMENT_CANCELLATION"
] as const;
export type PrepaidTransactionReferenceType = (typeof prepaidTransactionReferenceTypeValues)[number];

export interface IPrepaidTransaction extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId?: mongoose.Types.ObjectId | null;
  transactionType: PrepaidTransactionType;
  direction: PrepaidTransactionDirection;
  amountMinor: number;
  currency: PrepaidCurrency;
  referenceType: PrepaidTransactionReferenceType;
  referenceId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  paymentSource: PaymentSource;
  cashBalanceBeforeMinor: number;
  cashBalanceAfterMinor: number;
  reservedBalanceBeforeMinor: number;
  reservedBalanceAfterMinor: number;
  description: string;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const minorUnitField = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: isMinorUnitInteger, message: "Amount fields must be integer minor-unit amounts" }
};

const prepaidTransactionSchema = new mongoose.Schema<IPrepaidTransaction>(
  {
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    transactionType: { type: String, enum: prepaidTransactionTypeValues, required: true, index: true },
    direction: { type: String, enum: prepaidTransactionDirectionValues, required: true },
    amountMinor: minorUnitField,
    currency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
    referenceType: { type: String, enum: prepaidTransactionReferenceTypeValues, required: true, index: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 256 },
    paymentSource: { type: String, enum: paymentSourceValues, default: "CLIENT_PREPAID", required: true },
    cashBalanceBeforeMinor: minorUnitField,
    cashBalanceAfterMinor: minorUnitField,
    reservedBalanceBeforeMinor: minorUnitField,
    reservedBalanceAfterMinor: minorUnitField,
    description: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

prepaidTransactionSchema.index({ businessAccountId: 1, createdAt: -1 });
prepaidTransactionSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, name: "tenant_wallet_transaction_idempotency" });

const rejectLedgerMutation = () => {
  throw new Error("Prepaid ledger entries are append-only.");
};
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  prepaidTransactionSchema.pre(operation as mongoose.MongooseQueryMiddleware, { document: false, query: true }, rejectLedgerMutation);
}
prepaidTransactionSchema.pre("save", function rejectExistingLedgerSave() {
  if (!this.isNew) rejectLedgerMutation();
});

addTenantOwnership(prepaidTransactionSchema, { allowReadOnlyAuditAppend: true });

export const PrepaidTransaction = mongoose.model<IPrepaidTransaction>(
  "PrepaidTransaction",
  prepaidTransactionSchema
);
