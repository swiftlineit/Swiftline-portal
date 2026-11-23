import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const shipmentDirectPaymentStatusValues = [
  "ORDER_CREATING",
  "ORDER_CREATED",
  "PROCESSING",
  "CAPTURED",
  "ALLOCATED",
  "SETTLED",
  "REVIEW_REQUIRED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
  "CANCELLED"
] as const;
export type ShipmentDirectPaymentStatus = (typeof shipmentDirectPaymentStatusValues)[number];
export const shipmentDirectPaymentPurposeValues = ["SHIPMENT_BOOKING", "SHIPMENT_AMENDMENT"] as const;
export type ShipmentDirectPaymentPurpose = (typeof shipmentDirectPaymentPurposeValues)[number];

export interface IShipmentDirectPayment extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  paymentPurpose: ShipmentDirectPaymentPurpose;
  amendmentId?: mongoose.Types.ObjectId | null;
  clientUserId?: mongoose.Types.ObjectId | null;
  amountMinor: number;
  currency: "INR";
  pricingHash: string;
  pricingRevision: number;
  idempotencyKey: string;
  internalReference: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  razorpayRefundId: string;
  razorpayRefundAmountMinor: number;
  razorpayRefundedAt?: Date | null;
  status: ShipmentDirectPaymentStatus;
  capturedAt?: Date | null;
  allocatedAt?: Date | null;
  failureCode: string;
  failureDescription: string;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentDirectPaymentSchema = new mongoose.Schema<IShipmentDirectPayment>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  paymentPurpose: { type: String, enum: shipmentDirectPaymentPurposeValues, default: "SHIPMENT_BOOKING", required: true, index: true },
  amendmentId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentAmendment", default: null, index: true },
  clientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  amountMinor: { type: Number, required: true, min: 1, validate: { validator: isMinorUnitInteger, message: "amountMinor must be an integer minor-unit amount" } },
  currency: { type: String, enum: ["INR"], default: "INR", required: true },
  pricingHash: { type: String, required: true, trim: true, maxlength: 128 },
  pricingRevision: { type: Number, required: true, min: 0, validate: { validator: isMinorUnitInteger, message: "pricingRevision must be an integer" } },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 256 },
  internalReference: { type: String, required: true, trim: true, maxlength: 120 },
  razorpayOrderId: { type: String, trim: true, maxlength: 120, default: "" },
  razorpayPaymentId: { type: String, trim: true, maxlength: 120, default: "" },
  razorpaySignature: { type: String, trim: true, maxlength: 256, default: "" },
  razorpayRefundId: { type: String, trim: true, maxlength: 120, default: "" },
  razorpayRefundAmountMinor: { type: Number, min: 0, default: 0, validate: { validator: isMinorUnitInteger, message: "refund amount must be an integer minor-unit amount" } },
  razorpayRefundedAt: { type: Date, default: null },
  status: { type: String, enum: shipmentDirectPaymentStatusValues, required: true, default: "ORDER_CREATING", index: true },
  capturedAt: { type: Date, default: null },
  allocatedAt: { type: Date, default: null },
  failureCode: { type: String, trim: true, maxlength: 120, default: "" },
  failureDescription: { type: String, trim: true, maxlength: 500, default: "" }
}, { timestamps: true });

shipmentDirectPaymentSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, name: "tenant_direct_payment_idempotency" });
shipmentDirectPaymentSchema.index(
  { tenantId: 1, razorpayOrderId: 1 },
  { unique: true, name: "tenant_direct_payment_order", partialFilterExpression: { razorpayOrderId: { $type: "string", $gt: "" } } }
);
shipmentDirectPaymentSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, name: "direct_payment_gateway_payment", partialFilterExpression: { razorpayPaymentId: { $type: "string", $gt: "" } } }
);

addTenantOwnership(shipmentDirectPaymentSchema);

export const ShipmentDirectPayment = mongoose.model<IShipmentDirectPayment>("ShipmentDirectPayment", shipmentDirectPaymentSchema);
