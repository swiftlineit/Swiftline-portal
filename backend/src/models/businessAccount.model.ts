import mongoose from "mongoose";
import { rateCardBandValues, type RateCardBand } from "./countryRateCard.model.js";

export type ShipmentType = "international_cargo" | "international_courier";
export const businessAccountStatuses = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "active",
  "suspended"
] as const;
export type BusinessAccountStatus = (typeof businessAccountStatuses)[number];
export const creditLimitStatusValues = ["not_reviewed", "approved", "not_approved"] as const;
export type CreditLimitStatus = (typeof creditLimitStatusValues)[number];
export const depositStatusValues = ["not_required", "required", "received"] as const;
export type DepositStatus = (typeof depositStatusValues)[number];
export const agreementStatusValues = ["not_generated", "generated", "signed"] as const;
export type AgreementStatus = (typeof agreementStatusValues)[number];
export const gstBillingPreferenceValues = ["GST_APPLICABLE", "NO_GST"] as const;
export type GstBillingPreference = (typeof gstBillingPreferenceValues)[number];
export const gstBillingReviewStatusValues = [
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REVOKED"
] as const;
export type GstBillingReviewStatus = (typeof gstBillingReviewStatusValues)[number];
export type DocumentType =
  | "aadhaarCard"
  | "panCard"
  | "adCertificate"
  | "msmeCertificate"
  | "tanCertificate"
  | "otherCertificate"
  | "gstCertificate"
  | "iecCertificate";
export const businessKycCheckStatuses = [
  "not_started",
  "under_review",
  "verified",
  "information_required",
  "reject"
] as const;
export type BusinessKycCheckStatus = (typeof businessKycCheckStatuses)[number];
export const businessKycOverallStatuses = [
  "documents_pending",
  "submitted",
  "under_review",
  "additional_information_required",
  "verified",
  "rejected"
] as const;
export type BusinessKycOverallStatus = (typeof businessKycOverallStatuses)[number];
// `gstExemption` is only a required check on accounts that claim exemption from
// GST registration; see getRequiredKycCheckKeys.
export type BusinessKycCheckKey = "contactDetails" | "companyDetails" | "gstExemption" | DocumentType;

export interface IBusinessAddress {
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: string;
}

export interface IBusinessDocument {
  type: DocumentType;
  originalName: string;
  /** Storage service key, resolved through storage.service.ts. Never a path. */
  storageKey: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

/**
 * Nearly every account is a real onboarded business. `INDIVIDUAL_SENTINEL` marks
 * the single system-owned record that individual (walk-in) shipments are booked
 * against: those customers have no company, no KYC file and no portal login, but
 * the shipment chain requires a business account to point at. The sentinel is
 * excluded from every account listing- see `individualCustomer.service.ts`.
 */
export const businessAccountKinds = ["BUSINESS", "INDIVIDUAL_SENTINEL"] as const;
export type BusinessAccountKind = (typeof businessAccountKinds)[number];

export interface IBusinessKycCheck {
  status: BusinessKycCheckStatus;
  note?: string | null;
  reviewedAt?: Date | null;
}

export interface IBusinessKycReview {
  overallStatus: BusinessKycOverallStatus;
  checks: Partial<Record<BusinessKycCheckKey, IBusinessKycCheck>>;
  finalDecision?: "rejected" | null;
  reviewStartedAt?: Date | null;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
}

export interface IBusinessGstBilling {
  requestedTreatment: GstBillingPreference;
  status: GstBillingReviewStatus;
  requestReason: string;
  requestedAt?: Date | null;
  requestedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  decisionReason: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  version: number;
}

export interface IBusinessAccount extends mongoose.Document {
  accountId: string;
  accountKind: BusinessAccountKind;
  status: BusinessAccountStatus;
  contact: {
    title: string;
    firstName: string;
    lastName: string;
    email: string;
    mobileType: "mobile" | "office";
    countryCode: string;
    mobileNumber: string;
    jobTitle: string;
    department: string;
    shipmentTypes: ShipmentType[];
  };
  company: {
    registrationCountry: string;
    registrationIdType?: string;
    // For a US SSN or ITIN this holds only the mask (•••-••-6789); the number
    // itself lives encrypted in registrationIdEncrypted. Every other country
    // stores its registration ID here in the clear.
    registrationId: string;
    registrationIdEncrypted?: string;
    // The comparable form of registrationId, used for the uniqueness index.
    // Blank when the stored value is a mask and so cannot be compared.
    registrationIdKey?: string;
    gstin?: string;
    gstExempt?: boolean;
    gstExemptReason?: string;
    secondaryRegistrationId?: string;
    noCompanyRegistration?: boolean;
    noCompany?: boolean;
    companyType: string;
    companyName: string;
    registeredAddress: string;
    // Building, floor, unit or landmark. Entered by hand and never overwritten
    // by an address lookup.
    addressLine2?: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    addressCountry?: string;
    useCompanyAddressAsBillingAddress?: boolean;
    // Only meaningful when useCompanyAddressAsBillingAddress is false; it is
    // cleared whenever the company address is reused, so a stale billing
    // address cannot survive the checkbox being re-ticked.
    billingAddress?: IBusinessAddress;
    operatingCountries: string[];
    website?: string | null;
    industry: string;
    monthlyShipmentVolume: string;
    requestedCreditLimit: {
      currency: string;
      amount: number | null;
    };
  };
  documents: Partial<Record<DocumentType, IBusinessDocument>>;
  kycReview: IBusinessKycReview;
  /**
   * Approval to omit GST from Swiftline shipment charges. This is deliberately
   * separate from `company.gstExempt`, which only records that the customer is
   * not registered for GST and does not make Swiftline's supply tax-free.
   */
  gstBilling: IBusinessGstBilling;
  creditLimitStatus: CreditLimitStatus;
  depositStatus: DepositStatus;
  agreementStatus: AgreementStatus;
  ledgerViewedAt?: Date | null;
  assignedBranch?: mongoose.Types.ObjectId | null;
  rateCardBand?: RateCardBand | null;
  origin?: "STAFF" | "PUBLIC";
  createdBy: mongoose.Types.ObjectId | null;
  updatedBy?: mongoose.Types.ObjectId;
  submittedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const businessAddressSchema = new mongoose.Schema<IBusinessAddress>(
  {
    addressLine1: { type: String, default: "", trim: true, maxlength: 500 },
    addressLine2: { type: String, default: "", trim: true, maxlength: 200 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    stateOrProvince: { type: String, default: "", trim: true, maxlength: 80 },
    postalCode: { type: String, default: "", trim: true, maxlength: 20 },
    country: { type: String, default: "", trim: true, maxlength: 80 }
  },
  { _id: false }
);

const businessDocumentSchema = new mongoose.Schema<IBusinessDocument>(
  {
    type: {
      type: String,
      enum: ["aadhaarCard", "panCard", "adCertificate", "msmeCertificate", "tanCertificate", "otherCertificate", "gstCertificate", "iecCertificate"],
      required: true
    },
    originalName: { type: String, required: true },
    storageKey: { type: String, required: true, maxlength: 1024 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const businessKycCheckSchema = new mongoose.Schema<IBusinessKycCheck>(
  {
    status: {
      type: String,
      enum: businessKycCheckStatuses,
      default: "not_started",
      required: true
    },
    note: { type: String, default: null, maxlength: 50, trim: true },
    reviewedAt: { type: Date, default: null }
  },
  { _id: false }
);

const businessKycReviewSchema = new mongoose.Schema<IBusinessKycReview>(
  {
    overallStatus: {
      type: String,
      enum: businessKycOverallStatuses,
      default: "documents_pending",
      index: true
    },
    checks: {
      contactDetails: { type: businessKycCheckSchema },
      companyDetails: { type: businessKycCheckSchema },
      gstExemption: { type: businessKycCheckSchema },
      aadhaarCard: { type: businessKycCheckSchema },
      panCard: { type: businessKycCheckSchema },
      adCertificate: { type: businessKycCheckSchema },
      msmeCertificate: { type: businessKycCheckSchema },
      tanCertificate: { type: businessKycCheckSchema },
      otherCertificate: { type: businessKycCheckSchema },
      gstCertificate: { type: businessKycCheckSchema },
      iecCertificate: { type: businessKycCheckSchema }
    },
    finalDecision: {
      type: String,
      enum: ["rejected", null],
      default: null
    },
    reviewStartedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { _id: false }
);

const businessGstBillingSchema = new mongoose.Schema<IBusinessGstBilling>(
  {
    requestedTreatment: {
      type: String,
      enum: gstBillingPreferenceValues,
      default: "GST_APPLICABLE",
      required: true
    },
    status: {
      type: String,
      enum: gstBillingReviewStatusValues,
      default: "NOT_REQUIRED",
      required: true,
      index: true
    },
    requestReason: { type: String, trim: true, maxlength: 500, default: "" },
    requestedAt: { type: Date, default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decisionReason: { type: String, trim: true, maxlength: 500, default: "" },
    effectiveFrom: { type: Date, default: null },
    effectiveUntil: { type: Date, default: null },
    version: { type: Number, min: 1, default: 1, required: true }
  },
  { _id: false }
);

const businessAccountSchema = new mongoose.Schema<IBusinessAccount>(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    // Defaults to BUSINESS so every existing account keeps its meaning without a
    // migration; only the sentinel is ever written as INDIVIDUAL_SENTINEL.
    accountKind: { type: String, enum: businessAccountKinds, default: "BUSINESS", required: true, index: true },
    status: {
      type: String,
      enum: businessAccountStatuses,
      default: "draft",
      index: true
    },
    /**
     * Identity fields (name, email, mobile) stay required: they are what the
     * live-account unique indexes below key off, so a draft without them could
     * not be de-duplicated and blanks would collide with each other.
     *
     * The descriptive fields are optional so a draft can be saved from the first
     * step. Completeness is enforced on the way out of draft, by
     * `submitBusinessAccount`- never here, or drafts could not be saved at all.
     */
    contact: {
      title: { type: String, enum: ["mr.", "mrs.", "ms.", "dr.", "prof.", ""], default: "", trim: true },
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, required: true, trim: true },
      email: { type: String, required: true, lowercase: true, trim: true, index: true },
      mobileType: { type: String, enum: ["mobile", "office"], required: true, default: "mobile", trim: true },
      countryCode: { type: String, required: true, trim: true },
      mobileNumber: { type: String, required: true, trim: true, index: true },
      jobTitle: { type: String, default: "", trim: true },
      department: { type: String, default: "", trim: true },
      shipmentTypes: {
        type: [String],
        enum: ["international_cargo", "international_courier"],
        default: []
      }
    },
    company: {
      registrationCountry: { type: String, default: "", trim: true },
      registrationIdType: { type: String, default: "", trim: true },
      registrationId: { type: String, default: "", trim: true, index: true },
      // AES-256-GCM, keyed by TAX_ID_ENCRYPTION_KEY. Never indexed and never
      // returned to a client- see toSafeBusinessAccount.
      registrationIdEncrypted: { type: String, default: "", select: false },
      registrationIdKey: { type: String, default: "", trim: true },
      gstin: { type: String, uppercase: true, trim: true, default: "", maxlength: 15 },
      // Set when the business is legally not registered under GST. The reason is
      // mandatory alongside it and the exemption must be cleared by an admin in
      // the KYC review before the account can be approved.
      gstExempt: { type: Boolean, default: false },
      gstExemptReason: { type: String, default: "", trim: true, maxlength: 300 },
      secondaryRegistrationId: { type: String, default: "", trim: true },
      noCompanyRegistration: { type: Boolean, default: false },
      noCompany: { type: Boolean, default: false },
      companyType: { type: String, enum: ["", "pvt_ltd", "llp", "enterprise", "proprietorship"], default: "", trim: true },
      companyName: { type: String, default: "", trim: true },
      registeredAddress: { type: String, default: "", trim: true },
      addressLine2: { type: String, default: "", trim: true, maxlength: 200 },
      city: { type: String, default: "", trim: true },
      stateOrProvince: { type: String, default: "", trim: true },
      postalCode: { type: String, default: "", trim: true },
      addressCountry: { type: String, default: "", trim: true },
      useCompanyAddressAsBillingAddress: { type: Boolean, default: true },
      billingAddress: { type: businessAddressSchema, default: null },
      operatingCountries: {
        type: [String],
        required: true,
        validate: {
          // Accounts flagged as having no company skip operating-country capture;
          // every other account must list at least one operating country.
          validator: function (this: IBusinessAccount, value: string[]) {
            return this?.company?.noCompany ? true : value.length > 0;
          },
          message: "At least one operating country is required"
        }
      },
      website: { type: String, default: null, trim: true },
      industry: { type: String, default: "", trim: true },
      monthlyShipmentVolume: { type: String, default: "", trim: true },
      requestedCreditLimit: {
        currency: { type: String, default: "INR", trim: true },
        amount: { type: Number, min: 0, max: 100000, default: null }
      }
    },
    documents: {
      aadhaarCard: { type: businessDocumentSchema },
      panCard: { type: businessDocumentSchema },
      adCertificate: { type: businessDocumentSchema },
      msmeCertificate: { type: businessDocumentSchema },
      tanCertificate: { type: businessDocumentSchema },
      otherCertificate: { type: businessDocumentSchema },
      gstCertificate: { type: businessDocumentSchema },
      iecCertificate: { type: businessDocumentSchema }
    },
    kycReview: {
      type: businessKycReviewSchema,
      default: () => ({
        overallStatus: "documents_pending",
        checks: {}
      })
    },
    // Existing accounts read as ordinary GST accounts. No migration can
    // accidentally grant a no-GST entitlement because APPROVED must be written
    // by the dedicated review endpoint.
    gstBilling: {
      type: businessGstBillingSchema,
      default: () => ({
        requestedTreatment: "GST_APPLICABLE",
        status: "NOT_REQUIRED",
        version: 1
      })
    },
    creditLimitStatus: {
      type: String,
      enum: creditLimitStatusValues,
      default: "not_reviewed",
      index: true
    },
    depositStatus: {
      type: String,
      enum: depositStatusValues,
      default: "not_required",
      index: true
    },
    agreementStatus: {
      type: String,
      enum: agreementStatusValues,
      default: "not_generated",
      index: true
    },
    ledgerViewedAt: { type: Date, default: null },
    assignedBranch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    // New business accounts stay paused until an authorised team member assigns
    // their commercial rate card. The individual-shipment sentinel always uses
    // the dedicated Band D individual tariff.
    rateCardBand: { type: String, enum: [...rateCardBandValues, null], default: null, index: true },
    // Public self-serve accounts have no internal creator; admin creates with a user.
    origin: { type: String, enum: ["STAFF", "PUBLIC"], default: "STAFF", index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false, default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    submittedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

/**
 * Uniqueness enforced by the database, not only by the pre-flight query in the
 * controller- two simultaneous requests can both pass that check and both
 * insert.
 *
 * Partial on purpose. A rejected application must be able to re-apply with the
 * same email and phone, so rejected accounts are excluded; and blank values are
 * excluded so the many accounts with no registration ID do not all collide with
 * each other.
 *
 * These indexes fail to build if the collection already holds duplicates. Run
 * `npm run check:duplicate-accounts` and clear anything it reports before
 * deploying.
 */
// Spelled as the list of live statuses rather than `{ $ne: "rejected" }`, which
// MongoDB rewrites to `$not: { $eq: ... }` and rejects: `$not` is outside the
// operator set a partial index filter allows, so an index defined that way is
// silently never built and enforces nothing. Any new status must be added here or
// accounts holding it fall outside the uniqueness guarantee.
const liveAccountFilter = {
  status: { $in: businessAccountStatuses.filter((status) => status !== "rejected") }
};

businessAccountSchema.index(
  { "contact.email": 1 },
  { unique: true, partialFilterExpression: liveAccountFilter, name: "uniq_live_contact_email" }
);

businessAccountSchema.index(
  { "contact.countryCode": 1, "contact.mobileNumber": 1 },
  { unique: true, partialFilterExpression: liveAccountFilter, name: "uniq_live_contact_mobile" }
);

businessAccountSchema.index(
  { "company.registrationIdKey": 1 },
  {
    unique: true,
    // Keyed off registrationIdKey rather than registrationId because a US SSN or
    // ITIN is stored only as its mask: two unrelated people whose numbers end in
    // the same four digits share the string "•••-••-6789". The key is left blank
    // for those, and blanks are excluded here, so they never collide.
    partialFilterExpression: { ...liveAccountFilter, "company.registrationIdKey": { $type: "string", $gt: "" } },
    name: "uniq_live_company_registration_id"
  }
);

businessAccountSchema.pre("validate", function normalizeLegacyWorkflowStatus() {
  const account = this as IBusinessAccount & { status: BusinessAccountStatus | string };
  const status = String(account.status);

  if (account.accountKind === "INDIVIDUAL_SENTINEL") {
    account.rateCardBand = "BAND_D";
    account.gstBilling = {
      requestedTreatment: "GST_APPLICABLE",
      status: "NOT_REQUIRED",
      requestReason: "",
      requestedAt: null,
      requestedBy: null,
      reviewedAt: null,
      reviewedBy: null,
      decisionReason: "",
      effectiveFrom: null,
      effectiveUntil: null,
      version: account.gstBilling?.version ?? 1
    };
  }

  // Historical workflow milestones used to live in `status`. Keep lifecycle
  // status permanent and move those legacy values into their dedicated fields.
  if (status === "branch_assigned") {
    account.status = "approved";
  } else if (status === "credit_limit_approved") {
    account.status = "approved";
    account.creditLimitStatus = "approved";
  } else if (status === "credit_limit_not_approved") {
    account.status = "approved";
    account.creditLimitStatus = "not_approved";
  } else if (status === "deposit_required") {
    account.status = "approved";
    account.depositStatus = "required";
  } else if (status === "deposit_received") {
    account.status = "approved";
    account.depositStatus = "received";
  } else if (status === "agreement_generated") {
    account.status = "approved";
    account.agreementStatus = "generated";
  } else if (status === "ledger_viewed") {
    account.status = "approved";
    account.ledgerViewedAt = account.ledgerViewedAt ?? new Date();
  } else if (status === "more_info_needed") {
    account.status = "pending_review";
  }
});

export const BusinessAccount = mongoose.model<IBusinessAccount>(
  "BusinessAccount",
  businessAccountSchema
);
