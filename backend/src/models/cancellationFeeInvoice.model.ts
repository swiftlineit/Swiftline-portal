import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";
import type { ShipmentInvoiceTaxTreatment, ShipmentInvoiceTaxType } from "./shipmentInvoice.model.js";

export interface ICancellationFeeInvoice extends mongoose.Document, TenantOwnedFields {
  invoiceNumber: string;
  financialYear: string;
  cancellationId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  supplier: Record<string, unknown>;
  customer: Record<string, unknown>;
  taxableValueMinor: number;
  gstRatePercent: number;
  taxTreatment: ShipmentInvoiceTaxTreatment;
  taxType: ShipmentInvoiceTaxType;
  cgstAmountMinor: number;
  sgstAmountMinor: number;
  igstAmountMinor: number;
  totalTaxAmountMinor: number;
  totalAmountMinor: number;
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID";
  billingStatementId?: mongoose.Types.ObjectId | null;
  billedAt?: Date | null;
  feeReason: string;
  issuedAt: Date;
  createdBy: mongoose.Types.ObjectId;
}

const schema = new mongoose.Schema<ICancellationFeeInvoice>({
  invoiceNumber: { type: String, required: true, immutable: true, trim: true, maxlength: 32 },
  financialYear: { type: String, required: true, immutable: true, trim: true },
  cancellationId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentCancellation", required: true, immutable: true },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, immutable: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, immutable: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, immutable: true },
  supplier: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  customer: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  taxableValueMinor: { type: Number, required: true, immutable: true, min: 0 },
  gstRatePercent: { type: Number, required: true, immutable: true, min: 0 },
  taxTreatment: { type: String, enum: ["GST_APPLICABLE", "NO_GST"], required: true, immutable: true, default: "GST_APPLICABLE" },
  taxType: { type: String, enum: ["CGST_SGST", "IGST"], required: true, immutable: true },
  cgstAmountMinor: { type: Number, required: true, immutable: true, min: 0 },
  sgstAmountMinor: { type: Number, required: true, immutable: true, min: 0 },
  igstAmountMinor: { type: Number, required: true, immutable: true, min: 0 },
  totalTaxAmountMinor: { type: Number, required: true, immutable: true, min: 0 },
  totalAmountMinor: { type: Number, required: true, immutable: true, min: 0 },
  advanceAppliedMinor: { type: Number, required: true, immutable: true, min: 0 },
  creditOutstandingMinor: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ["UNPAID", "PARTIALLY_PAID", "PAID"], required: true, default: "UNPAID", index: true },
  billingStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", default: null, index: true },
  billedAt: { type: Date, default: null },
  feeReason: { type: String, required: true, immutable: true, trim: true, maxlength: 500 },
  issuedAt: { type: Date, required: true, immutable: true, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true }
}, { timestamps: true });

schema.pre(["deleteOne", "deleteMany"], function blockDeletion() {
  throw new Error("Issued cancellation fee invoices are immutable.");
});

schema.index(
  { tenantId: 1, invoiceNumber: 1 },
  { unique: true, name: "tenant_cancellation_invoice_number_unique" }
);
schema.index(
  { tenantId: 1, cancellationId: 1 },
  { unique: true, name: "tenant_cancellation_invoice_cancellation_unique" }
);

addTenantOwnership(schema);

export const CancellationFeeInvoice = mongoose.model<ICancellationFeeInvoice>("CancellationFeeInvoice", schema);
