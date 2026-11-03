import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

const shipmentInvoiceTaxTreatmentValues = ["GST_APPLICABLE", "NO_GST"] as const;
export type ShipmentInvoiceTaxTreatment = (typeof shipmentInvoiceTaxTreatmentValues)[number];

export type ShipmentInvoiceTaxType = "CGST_SGST" | "IGST";

export interface IShipmentInvoiceRevision {
  revision: number;
  revisedAt: Date;
  supplier: Record<string, unknown>;
  customer: Record<string, unknown>;
  shipment: Record<string, unknown>;
  sacCode: string;
  taxableValueMinor: number;
  gstRatePercent: number;
  taxTreatment?: ShipmentInvoiceTaxTreatment;
  taxType: ShipmentInvoiceTaxType;
  cgstAmountMinor: number;
  sgstAmountMinor: number;
  igstAmountMinor: number;
  totalTaxAmountMinor: number;
  totalAmountMinor: number;
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  pricingSnapshot: Record<string, unknown>;
  description?: string;
  reverseCharge?: boolean;
  status?: "DRAFT" | "ISSUED";
  validationWarnings?: string[];
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "VOID";
}

export interface IShipmentInvoice extends mongoose.Document, TenantOwnedFields {
  invoiceNumber: string;
  financialYear: string;
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  currency: string;
  supplier: Record<string, unknown>;
  customer: Record<string, unknown>;
  shipment: Record<string, unknown>;
  sacCode: string;
  description: string;
  taxableValueMinor: number;
  gstRatePercent: number;
  taxTreatment: ShipmentInvoiceTaxTreatment;
  taxType: ShipmentInvoiceTaxType;
  cgstAmountMinor: number;
  sgstAmountMinor: number;
  igstAmountMinor: number;
  totalTaxAmountMinor: number;
  totalAmountMinor: number;
  reverseCharge: boolean;
  status: "DRAFT" | "ISSUED";
  validationWarnings: string[];
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "VOID";
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  pricingSnapshot: Record<string, unknown>;
  revision: number;
  revisions: IShipmentInvoiceRevision[];
  issuedAt: Date;
  revisedAt?: Date | null;
  /**
   * When this shipment's charge stopped being provisional, which is what makes
   * the invoice eligible for a billing statement.
   *
   * Set once, by whichever came first: the hub receiving the parcel
   * (Warehouse Scan In, meaning nobody found a difference worth correcting) or
   * Operations recording a corrected weight. Null while the amount can still
   * move on its own, and on shipments that never reached the hub.
   */
  chargeFinalizedAt?: Date | null;
  billingStatementId?: mongoose.Types.ObjectId | null;
  billedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentInvoiceRevisionSchema = new mongoose.Schema<IShipmentInvoiceRevision>(
  {
    revision: { type: Number, required: true },
    revisedAt: { type: Date, required: true },
    supplier: { type: mongoose.Schema.Types.Mixed, required: true },
    customer: { type: mongoose.Schema.Types.Mixed, required: true },
    shipment: { type: mongoose.Schema.Types.Mixed, required: true },
    sacCode: { type: String, default: "" },
    taxableValueMinor: { type: Number, required: true },
    gstRatePercent: { type: Number, required: true },
    taxTreatment: { type: String, enum: shipmentInvoiceTaxTreatmentValues, default: "GST_APPLICABLE" },
    taxType: { type: String, enum: ["CGST_SGST", "IGST"], required: true },
    cgstAmountMinor: { type: Number, required: true },
    sgstAmountMinor: { type: Number, required: true },
    igstAmountMinor: { type: Number, required: true },
    totalTaxAmountMinor: { type: Number, required: true },
    totalAmountMinor: { type: Number, required: true },
    advanceAppliedMinor: { type: Number, required: true, min: 0, default: 0 },
    creditOutstandingMinor: { type: Number, required: true, min: 0, default: 0 },
    pricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, trim: true },
    reverseCharge: { type: Boolean },
    status: { type: String, enum: ["DRAFT", "ISSUED"] },
    validationWarnings: [{ type: String, trim: true, maxlength: 240 }],
    paymentStatus: { type: String, enum: ["UNPAID", "PARTIALLY_PAID", "PAID", "VOID"] }
  },
  { _id: false }
);

const shipmentInvoiceSchema = new mongoose.Schema<IShipmentInvoice>(
  {
    invoiceNumber: { type: String, required: true, trim: true, maxlength: 16 },
    financialYear: { type: String, required: true, trim: true, index: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true },
    dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true },
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    currency: { type: String, uppercase: true, trim: true, default: "INR" },
    supplier: { type: mongoose.Schema.Types.Mixed, required: true },
    customer: { type: mongoose.Schema.Types.Mixed, required: true },
    shipment: { type: mongoose.Schema.Types.Mixed, required: true },
    sacCode: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, required: true, maxlength: 240 },
    taxableValueMinor: { type: Number, required: true, min: 0 },
    gstRatePercent: { type: Number, required: true, min: 0, default: 18 },
    taxTreatment: { type: String, enum: shipmentInvoiceTaxTreatmentValues, required: true, default: "GST_APPLICABLE" },
    taxType: { type: String, enum: ["CGST_SGST", "IGST"], required: true },
    cgstAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    sgstAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    igstAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    totalTaxAmountMinor: { type: Number, required: true, min: 0 },
    totalAmountMinor: { type: Number, required: true, min: 0 },
    reverseCharge: { type: Boolean, default: false },
    status: { type: String, enum: ["DRAFT", "ISSUED"], default: "DRAFT", index: true },
    validationWarnings: [{ type: String, trim: true, maxlength: 240 }],
    paymentStatus: { type: String, enum: ["UNPAID", "PARTIALLY_PAID", "PAID", "VOID"], default: "UNPAID", index: true },
    advanceAppliedMinor: { type: Number, required: true, min: 0, default: 0 },
    creditOutstandingMinor: { type: Number, required: true, min: 0, default: 0 },
    pricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    revision: { type: Number, required: true, min: 1, default: 1 },
    revisions: { type: [shipmentInvoiceRevisionSchema], default: [] },
    issuedAt: { type: Date, required: true, default: Date.now, index: true },
    revisedAt: { type: Date, default: null },
    chargeFinalizedAt: { type: Date, default: null },
    billingStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", default: null, index: true },
    billedAt: { type: Date, default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

shipmentInvoiceSchema.index({ businessAccountId: 1, branchId: 1, issuedAt: -1 });
shipmentInvoiceSchema.index({ businessAccountId: 1, billingStatementId: 1, issuedAt: 1 });
// Drives the billing cycle's "which shipments settled in this period" query.
shipmentInvoiceSchema.index({ businessAccountId: 1, chargeFinalizedAt: 1, billingStatementId: 1 });
shipmentInvoiceSchema.index(
  { tenantId: 1, invoiceNumber: 1 },
  { unique: true, name: "tenant_invoice_number_unique" }
);
shipmentInvoiceSchema.index(
  { tenantId: 1, shipmentDraftId: 1 },
  { unique: true, name: "tenant_shipment_draft_invoice_unique" }
);
shipmentInvoiceSchema.index(
  { tenantId: 1, dpdShipmentId: 1 },
  { unique: true, name: "tenant_dpd_shipment_invoice_unique" }
);

addTenantOwnership(shipmentInvoiceSchema);

export const ShipmentInvoice = mongoose.model<IShipmentInvoice>("ShipmentInvoice", shipmentInvoiceSchema);
