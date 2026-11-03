import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICancellationDocumentCounter extends mongoose.Document, TenantOwnedFields {
  financialYear: string;
  documentType: "CREDIT_NOTE" | "FEE_INVOICE";
  sequence: number;
}

const schema = new mongoose.Schema<ICancellationDocumentCounter>({
  financialYear: { type: String, required: true, trim: true },
  documentType: { type: String, enum: ["CREDIT_NOTE", "FEE_INVOICE"], required: true },
  sequence: { type: Number, required: true, default: 0, min: 0 }
}, { timestamps: true });

schema.index(
  { tenantId: 1, financialYear: 1, documentType: 1 },
  { unique: true, name: "tenant_cancellation_doc_counter_year_type_unique" }
);

addTenantOwnership(schema);

export const CancellationDocumentCounter = mongoose.model<ICancellationDocumentCounter>(
  "CancellationDocumentCounter",
  schema
);
