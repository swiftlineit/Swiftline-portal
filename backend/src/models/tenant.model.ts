import mongoose from "mongoose";

export const tenantKindValues = ["SWIFTLINE", "OPERATOR"] as const;
export const tenantStatusValues = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export type TenantKind = (typeof tenantKindValues)[number];
export type TenantStatus = (typeof tenantStatusValues)[number];
export const tenantSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ITenant extends mongoose.Document {
  kind: TenantKind;
  status: TenantStatus;
  companyName: string;
  slug: string;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new mongoose.Schema<ITenant>({
  kind: { type: String, enum: tenantKindValues, required: true },
  status: { type: String, enum: tenantStatusValues, required: true, default: "DRAFT" },
  companyName: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 63, match: tenantSlugPattern },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

tenantSchema.index({ slug: 1 }, { unique: true, name: "uniq_tenant_current_slug" });
tenantSchema.index(
  { kind: 1 },
  { unique: true, partialFilterExpression: { kind: "SWIFTLINE" }, name: "uniq_swiftline_tenant" }
);

export const Tenant = mongoose.model<ITenant>("Tenant", tenantSchema);
