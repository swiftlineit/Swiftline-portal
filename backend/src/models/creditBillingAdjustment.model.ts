import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICreditBillingAdjustment extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  shipmentInvoiceId: mongoose.Types.ObjectId;
  originalStatementId: mongoose.Types.ObjectId;
  sourceType: "AMENDMENT" | "FINAL_VERIFICATION" | "CANCELLATION";
  sourceId: mongoose.Types.ObjectId;
  amountMinor: number;
  affectsAmountDue: boolean;
  description: string;
  status: "PENDING" | "BILLED";
  billingStatementId?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  billedAt?: Date | null;
}

const creditBillingAdjustmentSchema = new mongoose.Schema<ICreditBillingAdjustment>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, index: true },
  shipmentInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentInvoice", required: true, index: true },
  originalStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", required: true, index: true },
  sourceType: { type: String, enum: ["AMENDMENT", "FINAL_VERIFICATION", "CANCELLATION"], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  amountMinor: {
    type: Number,
    required: true,
    validate: {
      validator: (value: number) => Number.isInteger(value) && value !== 0,
      message: "Billing adjustment must be a non-zero integer minor-unit value."
    }
  },
  affectsAmountDue: { type: Boolean, required: true },
  description: { type: String, required: true, trim: true, maxlength: 300 },
  status: { type: String, enum: ["PENDING", "BILLED"], default: "PENDING", required: true, index: true },
  billingStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now, index: true },
  billedAt: { type: Date, default: null }
});

creditBillingAdjustmentSchema.index(
  { tenantId: 1, sourceType: 1, sourceId: 1 },
  { unique: true, name: "uniq_tenant_credit_adjustment_source" }
);
creditBillingAdjustmentSchema.index({ businessAccountId: 1, status: 1, createdAt: 1 });

addTenantOwnership(creditBillingAdjustmentSchema);

export const CreditBillingAdjustment = mongoose.model<ICreditBillingAdjustment>(
  "CreditBillingAdjustment",
  creditBillingAdjustmentSchema
);
