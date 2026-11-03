import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const operatorContactQueryKinds = ["ISSUE", "HELP"] as const;
export type OperatorContactQueryKind = (typeof operatorContactQueryKinds)[number];

export interface IOperatorContactQuery extends mongoose.Document, TenantOwnedFields {
  businessAccountId: mongoose.Types.ObjectId;
  businessAccountName: string;
  submittedBy: mongoose.Types.ObjectId;
  kind: OperatorContactQueryKind;
  subject: string;
  message: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  awbNumbers: string[];
  createdAt: Date;
  updatedAt: Date;
}

const operatorContactQuerySchema = new mongoose.Schema<IOperatorContactQuery>({
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true },
  businessAccountName: { type: String, required: true, trim: true, maxlength: 160 },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: operatorContactQueryKinds, required: true },
  subject: { type: String, required: true, trim: true, minlength: 5, maxlength: 120 },
  message: { type: String, required: true, trim: true, minlength: 10, maxlength: 3000 },
  contactName: { type: String, required: true, trim: true, minlength: 2, maxlength: 160 },
  contactEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  contactPhone: { type: String, trim: true, maxlength: 30, default: "" },
  awbNumbers: [{ type: String, trim: true, uppercase: true, maxlength: 40 }]
}, { timestamps: true });

operatorContactQuerySchema.index({ tenantId: 1, createdAt: -1, _id: -1 }, { name: "operator_contact_queries_recent" });
operatorContactQuerySchema.index({ tenantId: 1, businessAccountId: 1, createdAt: -1 }, { name: "operator_contact_queries_account" });
operatorContactQuerySchema.index({ tenantId: 1, submittedBy: 1, createdAt: -1 }, { name: "operator_contact_queries_submitter" });
addTenantOwnership(operatorContactQuerySchema);

export const OperatorContactQuery = mongoose.model<IOperatorContactQuery>("OperatorContactQuery", operatorContactQuerySchema);
