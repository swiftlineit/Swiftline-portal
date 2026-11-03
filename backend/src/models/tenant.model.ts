import mongoose from "mongoose";

export const tenantKindValues = ["SWIFTLINE", "OPERATOR"] as const;
export const tenantStatusValues = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export type TenantKind = (typeof tenantKindValues)[number];
export type TenantStatus = (typeof tenantStatusValues)[number];
export const tenantSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const tenantBrandLogoMimeTypes = ["image/jpeg", "image/png"] as const;
export type TenantBrandLogoMimeType = (typeof tenantBrandLogoMimeTypes)[number];

export interface ITenantBrandLogo {
  storageKey: string;
  mimeType: TenantBrandLogoMimeType;
  size: number;
  uploadedAt: Date;
}

export interface ITenantBrandBanner {
  _id: mongoose.Types.ObjectId;
  storageKey: string;
  mimeType: TenantBrandLogoMimeType;
  size: number;
  uploadedAt: Date;
  heading: string;
  description: string;
}

export interface ITenant extends mongoose.Document {
  kind: TenantKind;
  status: TenantStatus;
  companyName: string;
  slug: string;
  branding?: { logo?: ITenantBrandLogo; banners?: ITenantBrandBanner[] };
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new mongoose.Schema<ITenant>({
  kind: { type: String, enum: tenantKindValues, required: true },
  status: { type: String, enum: tenantStatusValues, required: true, default: "DRAFT" },
  companyName: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 63, match: tenantSlugPattern },
  branding: {
    logo: {
      storageKey: { type: String, trim: true, maxlength: 1024 },
      mimeType: { type: String, enum: tenantBrandLogoMimeTypes },
      size: { type: Number, min: 1, max: 2 * 1024 * 1024 },
      uploadedAt: { type: Date }
    },
    banners: [{
      storageKey: { type: String, trim: true, maxlength: 1024, required: true },
      mimeType: { type: String, enum: tenantBrandLogoMimeTypes, required: true },
      size: { type: Number, min: 1, max: 2 * 1024 * 1024, required: true },
      uploadedAt: { type: Date, required: true },
      heading: { type: String, trim: true, maxlength: 100, default: "" },
      description: { type: String, trim: true, maxlength: 240, default: "" }
    }]
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

tenantSchema.index({ slug: 1 }, { unique: true, name: "uniq_tenant_current_slug" });
tenantSchema.index(
  { kind: 1 },
  { unique: true, partialFilterExpression: { kind: "SWIFTLINE" }, name: "uniq_swiftline_tenant" }
);

export const Tenant = mongoose.model<ITenant>("Tenant", tenantSchema);
