import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICreditBillingStatementCounter extends mongoose.Document, TenantOwnedFields {
  financialYear: string;
  sequence: number;
}

const creditBillingStatementCounterSchema = new mongoose.Schema<ICreditBillingStatementCounter>({
  financialYear: { type: String, required: true, trim: true },
  sequence: { type: Number, required: true, min: 0, default: 0 }
}, { timestamps: true });

creditBillingStatementCounterSchema.index(
  { tenantId: 1, financialYear: 1 },
  { unique: true, name: "uniq_tenant_credit_statement_counter_year" }
);
addTenantOwnership(creditBillingStatementCounterSchema);

export const CreditBillingStatementCounter = mongoose.model<ICreditBillingStatementCounter>(
  "CreditBillingStatementCounter",
  creditBillingStatementCounterSchema
);
