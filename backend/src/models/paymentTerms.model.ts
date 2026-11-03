import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IPaymentTermsDocument extends mongoose.Document, TenantOwnedFields {
  version: string;
  title: string;
  effectiveFrom: Date;
  sections: Array<{ heading: string; content: string }>;
  status: "DRAFT" | "PUBLISHED" | "RETIRED";
  publishedBy?: mongoose.Types.ObjectId | null;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const paymentTermsDocumentSchema = new mongoose.Schema<IPaymentTermsDocument>({
  version: { type: String, trim: true, required: true, maxlength: 40 },
  title: { type: String, trim: true, required: true, maxlength: 160 },
  effectiveFrom: { type: Date, required: true },
  sections: [{ _id: false, heading: { type: String, trim: true, required: true }, content: { type: String, trim: true, required: true } }],
  status: { type: String, enum: ["DRAFT", "PUBLISHED", "RETIRED"], default: "DRAFT", index: true },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  publishedAt: { type: Date, default: null }
}, { timestamps: true });

paymentTermsDocumentSchema.index(
  { tenantId: 1, version: 1 },
  { unique: true, name: "uniq_tenant_payment_terms_version" }
);
addTenantOwnership(paymentTermsDocumentSchema);

export const PaymentTermsDocument = mongoose.model<IPaymentTermsDocument>("PaymentTermsDocument", paymentTermsDocumentSchema);

export interface IPaymentTermsAcceptance extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  termsVersion: string;
  acceptedAt: Date;
  ipAddress: string;
  userAgent: string;
  paymentReference: string;
}

const paymentTermsAcceptanceSchema = new mongoose.Schema<IPaymentTermsAcceptance>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  termsVersion: { type: String, trim: true, required: true, index: true },
  acceptedAt: { type: Date, default: Date.now, index: true },
  ipAddress: { type: String, trim: true, maxlength: 100, required: true },
  userAgent: { type: String, trim: true, maxlength: 500, default: "" },
  paymentReference: { type: String, trim: true, maxlength: 120, default: "" }
});

paymentTermsAcceptanceSchema.index(
  { tenantId: 1, businessAccountId: 1, userId: 1, termsVersion: 1, paymentReference: 1 },
  { unique: true, name: "uniq_tenant_payment_terms_acceptance" }
);
addTenantOwnership(paymentTermsAcceptanceSchema);

export const PaymentTermsAcceptance = mongoose.model<IPaymentTermsAcceptance>("PaymentTermsAcceptance", paymentTermsAcceptanceSchema);
