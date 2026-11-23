import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const shipmentAmendmentStatusValues = [
  "AWAITING_PAYMENT",
  "PAYMENT_SECURED",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "APPLIED"
] as const;
export type ShipmentAmendmentStatus = (typeof shipmentAmendmentStatusValues)[number];
export const shipmentAmendmentPaymentStatusValues = [
  "NOT_REQUIRED",
  "AWAITING_PAYMENT",
  "SECURED",
  "COMPLETED",
  "RELEASED"
] as const;
export type ShipmentAmendmentPaymentStatus = (typeof shipmentAmendmentPaymentStatusValues)[number];

export interface IShipmentAmendment extends mongoose.Document, TenantOwnedFields {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  requestedBy: mongoose.Types.ObjectId;
  activeRequestKey?: string | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  actorRole: "admin" | "client";
  status: ShipmentAmendmentStatus;
  paymentStatus: ShipmentAmendmentPaymentStatus;
  paymentSource: "" | "BUSINESS_WALLET" | "CASH_RECEIPT" | "DIRECT_RAZORPAY";
  paymentAmountMinor: number;
  paymentReferenceId?: mongoose.Types.ObjectId | null;
  paymentSecuredAt?: Date | null;
  paymentCompletedAt?: Date | null;
  paymentMetadata?: Record<string, unknown> | null;
  refundStatus: "NOT_REQUIRED" | "CREDITED_TO_WALLET" | "CASH_REFUND_RECORDED";
  reason: string;
  reviewNote?: string;
  requestedChanges: Record<string, unknown>;
  previousSnapshot: Record<string, unknown>;
  changePreview: Array<{
    fieldName: string;
    originalValue: unknown;
    newValue: unknown;
  }>;
  pricingImpact?: Record<string, unknown> | null;
  fundingPreview?: Record<string, unknown> | null;
  billingAdjustment?: Record<string, unknown> | null;
  requestedSnapshot?: Record<string, unknown> | null;
  resultingSnapshot?: Record<string, unknown> | null;
  appliedChanges: Array<{
    fieldName: string;
    originalValue: unknown;
    newValue: unknown;
  }>;
  requestedAt: Date;
  reviewedAt?: Date | null;
  appliedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const appliedChangeSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true },
    originalValue: { type: mongoose.Schema.Types.Mixed, default: "" },
    newValue: { type: mongoose.Schema.Types.Mixed, default: "" }
  },
  { _id: false }
);

const shipmentAmendmentSchema = new mongoose.Schema<IShipmentAmendment>(
  {
    shipmentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShipmentDraft",
      required: true,
      index: true
    },
    dpdShipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DpdShipment",
      required: true,
      index: true
    },
    businessAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessAccount",
      required: true,
      index: true
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    activeRequestKey: { type: String, trim: true, default: null },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },
    actorRole: { type: String, enum: ["admin", "client"], required: true, index: true },
    status: { type: String, enum: shipmentAmendmentStatusValues, default: "REQUESTED", index: true },
    paymentStatus: { type: String, enum: shipmentAmendmentPaymentStatusValues, default: "NOT_REQUIRED", index: true },
    paymentSource: { type: String, enum: ["", "BUSINESS_WALLET", "CASH_RECEIPT", "DIRECT_RAZORPAY"], default: "" },
    paymentAmountMinor: { type: Number, min: 0, default: 0 },
    paymentReferenceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    paymentSecuredAt: { type: Date, default: null },
    paymentCompletedAt: { type: Date, default: null },
    paymentMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    refundStatus: { type: String, enum: ["NOT_REQUIRED", "CREDITED_TO_WALLET", "CASH_REFUND_RECORDED"], default: "NOT_REQUIRED" },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    reviewNote: { type: String, trim: true, maxlength: 500, default: "" },
    requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
    previousSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    changePreview: { type: [appliedChangeSchema], default: [] },
    pricingImpact: { type: mongoose.Schema.Types.Mixed, default: null },
    fundingPreview: { type: mongoose.Schema.Types.Mixed, default: null },
    billingAdjustment: { type: mongoose.Schema.Types.Mixed, default: null },
    requestedSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    resultingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    appliedChanges: { type: [appliedChangeSchema], default: [] },
    requestedAt: { type: Date, default: Date.now, index: true },
    reviewedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

shipmentAmendmentSchema.index({ shipmentDraftId: 1, requestedAt: -1 });
shipmentAmendmentSchema.index({ dpdShipmentId: 1, requestedAt: -1 });
shipmentAmendmentSchema.index({ tenantId: 1, status: 1, requestedAt: -1 }, { name: "tenant_amendment_queue" });
shipmentAmendmentSchema.index(
  { tenantId: 1, activeRequestKey: 1 },
  { unique: true, name: "tenant_one_active_shipment_amendment", partialFilterExpression: { activeRequestKey: { $type: "string" } } }
);

addTenantOwnership(shipmentAmendmentSchema);

export const ShipmentAmendment = mongoose.model<IShipmentAmendment>(
  "ShipmentAmendment",
  shipmentAmendmentSchema
);
