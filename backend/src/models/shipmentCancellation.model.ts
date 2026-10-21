import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import type { ShipmentInvoiceTaxTreatment } from "./shipmentInvoice.model.js";

export const shipmentCancellationStatusValues = ["REQUESTED", "COMPLETED", "REJECTED"] as const;
export type ShipmentCancellationStatus = (typeof shipmentCancellationStatusValues)[number];

export interface IShipmentCancellation extends mongoose.Document {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  shipmentInvoiceId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  requestedBy: mongoose.Types.ObjectId;
  requesterType: "CLIENT" | "ADMIN";
  requesterRole: string;
  reason: string;
  shipmentStatusAtRequest: string;
  status: ShipmentCancellationStatus;
  originalAmountMinor: number;
  taxTreatment: ShipmentInvoiceTaxTreatment;
  requestedFeeBaseMinor: number;
  approvedFeeBaseMinor?: number | null;
  feeGstMinor?: number | null;
  feeTotalMinor?: number | null;
  refundableAmountMinor?: number | null;
  feeReason: string;
  carrierConfirmed: boolean;
  settlementConfirmed: boolean;
  carrierReference: string;
  reviewNote: string;
  reviewedBy?: mongoose.Types.ObjectId | null;
  requestedAt: Date;
  reviewedAt?: Date | null;
  completedAt?: Date | null;
  settlement?: {
    originalCreditReversedMinor: number;
    cancellationFeeCreditMinor: number;
    netCreditReleasedMinor: number;
    statementCreditAppliedMinor: number;
    customerAdvanceCreditedMinor: number;
  } | null;
  creditNoteId?: mongoose.Types.ObjectId | null;
  cancellationFeeInvoiceId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const optionalMinorAmount = {
  type: Number,
  default: null,
  min: 0,
  validate: { validator: (value: number | null) => value === null || isMinorUnitInteger(value) }
} as const;

const shipmentCancellationSchema = new mongoose.Schema<IShipmentCancellation>({
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
  dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", required: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  requesterType: { type: String, enum: ["CLIENT", "ADMIN"], required: true },
  requesterRole: { type: String, required: true, trim: true, maxlength: 40 },
  reason: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },
  shipmentStatusAtRequest: { type: String, required: true, trim: true, maxlength: 60 },
  status: { type: String, enum: shipmentCancellationStatusValues, default: "REQUESTED", required: true, index: true },
  originalAmountMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger },
  taxTreatment: { type: String, enum: ["GST_APPLICABLE", "NO_GST"], required: true, default: "GST_APPLICABLE" },
  requestedFeeBaseMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger },
  approvedFeeBaseMinor: optionalMinorAmount,
  feeGstMinor: optionalMinorAmount,
  feeTotalMinor: optionalMinorAmount,
  refundableAmountMinor: optionalMinorAmount,
  feeReason: { type: String, trim: true, maxlength: 500, default: "" },
  carrierConfirmed: { type: Boolean, default: false },
  settlementConfirmed: { type: Boolean, default: false },
  carrierReference: { type: String, trim: true, maxlength: 120, default: "" },
  reviewNote: { type: String, trim: true, maxlength: 500, default: "" },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  requestedAt: { type: Date, default: Date.now, required: true, index: true },
  reviewedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  settlement: { type: mongoose.Schema.Types.Mixed, default: null },
  creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentCreditNote", default: null },
  cancellationFeeInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "CancellationFeeInvoice", default: null }
}, { timestamps: true });

shipmentCancellationSchema.index({ businessAccountId: 1, requestedAt: -1 });
shipmentCancellationSchema.index(
  { shipmentDraftId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "REQUESTED" } }
);

export const ShipmentCancellation = mongoose.model<IShipmentCancellation>(
  "ShipmentCancellation",
  shipmentCancellationSchema
);
