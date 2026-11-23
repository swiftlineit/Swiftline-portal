import mongoose from "mongoose";
import { isMinorUnitInteger, prepaidCurrencyValues, type PrepaidCurrency } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const paymentTopUpStatusValues = [
  "CREATED",
  "CHECKOUT_OPENED",
  "AUTHORIZED",
  "PROCESSING",
  "CAPTURED",
  "FAILED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED"
] as const;
export type PaymentTopUpStatus = (typeof paymentTopUpStatusValues)[number];

export const paymentTopUpPurposeValues = [
  "CUSTOMER_ADVANCE",
  "SECURITY_DEPOSIT"
] as const;
export type PaymentTopUpPurpose = (typeof paymentTopUpPurposeValues)[number];

export interface IPaymentTopUp extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  clientUserId: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: PrepaidCurrency;
  purpose: PaymentTopUpPurpose;
  internalReference: string;
  idempotencyKey: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: PaymentTopUpStatus;
  failureCode?: string;
  failureDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

const paymentTopUpSchema = new mongoose.Schema<IPaymentTopUp>(
  {
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    clientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: isMinorUnitInteger, message: "amountMinor must be an integer minor-unit amount" }
    },
    currency: { type: String, enum: prepaidCurrencyValues, default: "INR", required: true },
    purpose: { type: String, enum: paymentTopUpPurposeValues, default: "CUSTOMER_ADVANCE", required: true },
    internalReference: { type: String, required: true, trim: true, maxlength: 120, index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 256 },
    razorpayOrderId: { type: String, trim: true, maxlength: 120, default: "" },
    razorpayPaymentId: { type: String, trim: true, maxlength: 120, default: "" },
    razorpaySignature: { type: String, trim: true, maxlength: 256, default: "" },
    status: { type: String, enum: paymentTopUpStatusValues, default: "CREATED", index: true },
    failureCode: { type: String, trim: true, maxlength: 120, default: "" },
    failureDescription: { type: String, trim: true, maxlength: 500, default: "" }
  },
  { timestamps: true }
);

paymentTopUpSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, name: "tenant_wallet_topup_idempotency" }
);

paymentTopUpSchema.index(
  { razorpayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayOrderId: { $type: "string", $gt: "" } }
  }
);

paymentTopUpSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayPaymentId: { $type: "string", $gt: "" } }
  }
);

paymentTopUpSchema.index({ tenantId: 1, businessAccountId: 1, createdAt: -1 }, { name: "tenant_wallet_topups" });
addTenantOwnership(paymentTopUpSchema);

export const PaymentTopUp = mongoose.model<IPaymentTopUp>(
  "PaymentTopUp",
  paymentTopUpSchema
);
