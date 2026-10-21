import mongoose from "mongoose";
import { tenantSlugPattern } from "./tenant.model.js";

export interface ITenantSlug extends mongoose.Document {
  slug: string;
  tenantId: mongoose.Types.ObjectId;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSlugSchema = new mongoose.Schema<ITenantSlug>({
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 63, match: tenantSlugPattern },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  isCurrent: { type: Boolean, required: true, default: true }
}, { timestamps: true });

// Historical slugs remain owned by their original tenant so old links can redirect.
tenantSlugSchema.index({ slug: 1 }, { unique: true, name: "uniq_tenant_slug_history" });
tenantSlugSchema.index(
  { tenantId: 1, isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: "uniq_tenant_active_slug" }
);

export const TenantSlug = mongoose.model<ITenantSlug>("TenantSlug", tenantSlugSchema);
