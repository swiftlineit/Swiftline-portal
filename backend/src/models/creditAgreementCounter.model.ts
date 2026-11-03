import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICreditAgreementCounter extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  version: number;
}

const creditAgreementCounterSchema = new mongoose.Schema<ICreditAgreementCounter>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  version: { type: Number, required: true, min: 0, default: 0 }
}, { timestamps: true });

creditAgreementCounterSchema.index(
  { tenantId: 1, businessAccountId: 1 },
  { unique: true, name: "uniq_tenant_credit_agreement_counter_business" }
);
addTenantOwnership(creditAgreementCounterSchema);

export const CreditAgreementCounter = mongoose.model<ICreditAgreementCounter>(
  "CreditAgreementCounter",
  creditAgreementCounterSchema
);
