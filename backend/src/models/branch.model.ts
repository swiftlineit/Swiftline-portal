import mongoose from "mongoose";
import { addTenantOwnership } from "./plugins/tenantOwnedSchema.plugin.js";

export const branchServiceValues = [
  "EXPRESS_COURIER",
  "AIR_FREIGHT",
  "SEA_FREIGHT",
  "ROAD_FREIGHT",
  "RAIL_FREIGHT",
  "CUSTOMS_CLEARANCE",
  "WAREHOUSING",
  "COMMERCIAL_CARGO",
  "PERSONAL_SHIPMENTS",
  "LAST_MILE_DELIVERY"
] as const;

export const shipmentCoverageValues = ["DOMESTIC", "INTERNATIONAL", "IMPORT", "EXPORT"] as const;
export const workingDayValues = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export const branchStatusValues = ["DRAFT", "ACTIVE", "INACTIVE", "SUSPENDED", "CLOSED"] as const;
export const branchDocumentTypeValues = ["PAN", "GST", "OTHER"] as const;

export type BranchService = (typeof branchServiceValues)[number];
export type ShipmentCoverage = (typeof shipmentCoverageValues)[number];
export type WorkingDay = (typeof workingDayValues)[number];
export type BranchStatus = (typeof branchStatusValues)[number];

export type BranchDocumentType = "PAN" | "GST" | "OTHER";

export interface IBranchDocument {
  type: BranchDocumentType;
  title: string;
  fileName: string;
  /** Storage service key, resolved through storage.service.ts. Never a path. */
  storageKey: string;
  mimeType: string;
  uploadedAt: Date;
}

/** One branch photo. Stored as a record so the key carries its content type. */
export interface IBranchImage {
  storageKey: string;
  fileName: string;
  mimeType: string;
  uploadedAt: Date;
}

export interface IBranchPhoneNumber {
  label: string;
  number: string;
}

export interface IBranch extends mongoose.Document {
  /** Tenant ownership; optional only while the staged Swiftline backfill is pending. */
  tenantId?: mongoose.Types.ObjectId;
  name: string;
  code: string;
  labelCode?: string;
  openingDate?: Date | null;
  description?: string;
  address: {
    countryCode?: string;
    countryName?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    address?: string;
  };
  contact: {
    email?: string;
    phone?: string;
  };
  operations: {
    supportedServices: BranchService[];
    shipmentCoverage: ShipmentCoverage[];
    operatingCountries: string[];
    workingDays: WorkingDay[];
  };
  baseCurrency?: string;
  gstin?: string;
  invoiceSacCode?: string;
  status: BranchStatus;
  // Set the first time a branch goes ACTIVE. Once set, code and labelCode are
  // frozen because they are baked into already-issued tracking numbers.
  activatedAt?: Date | null;
  images: IBranchImage[];
  documents: IBranchDocument[];
  phoneNumbers: IBranchPhoneNumber[];
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new mongoose.Schema<IBranch>(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", immutable: true },
    name: { type: String, required: true, trim: true, minlength: 3, maxlength: 100 },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z0-9-]{3,20}$/
    },
    labelCode: {
      type: String,
      uppercase: true,
      trim: true,
      match: /^[A-Z0-9]{2,4}$/,
      default: ""
    },
    openingDate: { type: Date, default: null },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    address: {
      countryCode: { type: String, uppercase: true, trim: true, default: "" },
      countryName: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      stateOrProvince: { type: String, trim: true, default: "" },
      postalCode: { type: String, trim: true, default: "" },
      address: { type: String, trim: true, maxlength: 500, default: "" }
    },
    contact: {
      email: { type: String, lowercase: true, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" }
    },
    operations: {
      supportedServices: [{ type: String, enum: branchServiceValues }],
      shipmentCoverage: [{ type: String, enum: shipmentCoverageValues }],
      operatingCountries: [{ type: String, uppercase: true, trim: true }],
      workingDays: [{ type: String, enum: workingDayValues }]
    },
    baseCurrency: { type: String, uppercase: true, trim: true, default: "" },
    gstin: { type: String, uppercase: true, trim: true, default: "", maxlength: 15 },
    invoiceSacCode: { type: String, trim: true, default: "", maxlength: 12 },
    status: { type: String, enum: branchStatusValues, default: "DRAFT", index: true },
    activatedAt: { type: Date, default: null },
    images: [{
      storageKey: { type: String, trim: true, required: true, maxlength: 1024 },
      fileName: { type: String, trim: true, default: "" },
      mimeType: { type: String, trim: true, default: "" },
      uploadedAt: { type: Date, default: Date.now }
    }],
    documents: [{
      type: { type: String, enum: ["PAN", "GST", "OTHER"], required: true },
      title: { type: String, trim: true, maxlength: 100, default: "" },
      fileName: { type: String, trim: true, required: true },
      storageKey: { type: String, trim: true, required: true, maxlength: 1024 },
      mimeType: { type: String, trim: true, default: "" },
      uploadedAt: { type: Date, default: Date.now }
    }],
    phoneNumbers: [{
      label: { type: String, trim: true, maxlength: 50, default: "" },
      number: { type: String, trim: true, default: "" }
    }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

branchSchema.index({ tenantId: 1 }, { name: "branch_tenant" });

addTenantOwnership(branchSchema);

branchSchema.index({ "address.countryCode": 1 });
branchSchema.index({ "address.city": 1 });
// Label codes prefix customer-facing tracking numbers, so they must be unique
// across branches. Empty codes (incomplete drafts) are excluded from the rule.
branchSchema.index(
  { labelCode: 1 },
  { unique: true, partialFilterExpression: { labelCode: { $gt: "" } } }
);

export const Branch = mongoose.model<IBranch>("Branch", branchSchema);
