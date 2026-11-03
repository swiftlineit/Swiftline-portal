import mongoose from "mongoose";
import { isMinorUnitInteger, maxCreditLimitMinor } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const creditAgreementStatusValues = [
  "DRAFT", "GENERATED", "SENT", "VIEWED", "SIGNED", "DECLINED", "EXPIRED", "SUPERSEDED"
] as const;
export type CreditAgreementStatus = (typeof creditAgreementStatusValues)[number];

export type CreditAgreementDocument = {
  storageKey: string;
  originalName: string;
  mimeType: "application/pdf";
  size: number;
  checksumSha256: string;
  storedAt: Date;
};

export type CreditAgreementSnapshot = {
  business: {
    accountId: string;
    companyName: string;
    gstin: string;
    registrationId: string;
    registeredAddress: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    addressCountry: string;
    contactName: string;
    contactEmail: string;
    contactJobTitle: string;
  };
  credit: {
    currency: "INR";
    approvedCreditLimitMinor: number;
    paymentTermsDays: number;
    billingCycle: "WEEKLY" | "MONTHLY";
    validFrom: Date | null;
    validUntil: Date | null;
    gracePeriodDays: number;
    maxOverdueDays: number;
    creditWarningThresholdPercent: number;
    securityDepositRequiredMinor: number;
  };
};

export interface ICreditAgreement extends mongoose.Document, TenantOwnedFields {
  agreementNumber: string;
  businessAccountId: mongoose.Types.ObjectId;
  creditAccountId: mongoose.Types.ObjectId;
  version: number;
  status: CreditAgreementStatus;
  termsVersion: string;
  snapshot: CreditAgreementSnapshot;
  generatedDocument?: CreditAgreementDocument | null;
  signedDocument?: CreditAgreementDocument | null;
  sentAt?: Date | null;
  viewedAt?: Date | null;
  signedAt?: Date | null;
  declinedAt?: Date | null;
  expiredAt?: Date | null;
  supersededAt?: Date | null;
  signer?: {
    userId?: mongoose.Types.ObjectId | null;
    name: string;
    email: string;
    jobTitle: string;
    ipAddress: string;
    userAgent: string;
  } | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new mongoose.Schema<CreditAgreementDocument>({
  storageKey: { type: String, required: true, trim: true, maxlength: 500 },
  originalName: { type: String, required: true, trim: true, maxlength: 240 },
  mimeType: { type: String, enum: ["application/pdf"], required: true },
  size: { type: Number, required: true, min: 1 },
  checksumSha256: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/ },
  storedAt: { type: Date, required: true }
}, { _id: false });

const snapshotSchema = new mongoose.Schema<CreditAgreementSnapshot>({
  business: {
    accountId: { type: String, required: true, trim: true },
    companyName: { type: String, required: true, trim: true },
    gstin: { type: String, trim: true, default: "" },
    registrationId: { type: String, trim: true, default: "" },
    registeredAddress: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    stateOrProvince: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
    addressCountry: { type: String, trim: true, default: "" },
    contactName: { type: String, required: true, trim: true },
    contactEmail: { type: String, required: true, trim: true, lowercase: true },
    contactJobTitle: { type: String, trim: true, default: "" }
  },
  credit: {
    currency: { type: String, enum: ["INR"], required: true },
    approvedCreditLimitMinor: { type: Number, required: true, min: 1, max: maxCreditLimitMinor, validate: isMinorUnitInteger },
    paymentTermsDays: { type: Number, enum: [0, 7, 15, 30, 45], required: true },
    billingCycle: { type: String, enum: ["WEEKLY", "MONTHLY"], required: true },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    gracePeriodDays: { type: Number, required: true, min: 0, max: 90 },
    maxOverdueDays: { type: Number, required: true, min: 0, max: 365 },
    creditWarningThresholdPercent: { type: Number, required: true, min: 1, max: 100 },
    securityDepositRequiredMinor: { type: Number, required: true, min: 0, validate: isMinorUnitInteger }
  }
}, { _id: false });

const signerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  name: { type: String, trim: true, required: true, maxlength: 160 },
  email: { type: String, trim: true, lowercase: true, required: true, maxlength: 240 },
  jobTitle: { type: String, trim: true, default: "", maxlength: 120 },
  ipAddress: { type: String, trim: true, required: true, maxlength: 100 },
  userAgent: { type: String, trim: true, default: "", maxlength: 500 }
}, { _id: false });

const creditAgreementSchema = new mongoose.Schema<ICreditAgreement>({
  agreementNumber: { type: String, required: true, immutable: true, trim: true, maxlength: 80 },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, immutable: true, index: true },
  creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCreditAccount", required: true, immutable: true, index: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  status: { type: String, enum: creditAgreementStatusValues, default: "DRAFT", required: true, index: true },
  termsVersion: { type: String, required: true, immutable: true, trim: true, maxlength: 40 },
  snapshot: { type: snapshotSchema, required: true, immutable: true },
  generatedDocument: { type: documentSchema, default: null },
  signedDocument: { type: documentSchema, default: null },
  sentAt: { type: Date, default: null },
  viewedAt: { type: Date, default: null },
  signedAt: { type: Date, default: null },
  declinedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
  supersededAt: { type: Date, default: null },
  signer: { type: signerSchema, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

creditAgreementSchema.index(
  { tenantId: 1, agreementNumber: 1 },
  { unique: true, name: "uniq_tenant_credit_agreement_number" }
);
creditAgreementSchema.index(
  { tenantId: 1, businessAccountId: 1, version: 1 },
  { unique: true, name: "uniq_tenant_credit_agreement_version" }
);
creditAgreementSchema.index({ businessAccountId: 1, createdAt: -1 });
creditAgreementSchema.index(
  { tenantId: 1, businessAccountId: 1 },
  {
    name: "one_open_credit_agreement_per_tenant_business",
    unique: true,
    partialFilterExpression: { status: { $in: ["DRAFT", "GENERATED", "SENT", "VIEWED"] } }
  }
);

addTenantOwnership(creditAgreementSchema);

export const CreditAgreement = mongoose.model<ICreditAgreement>("CreditAgreement", creditAgreementSchema);
