import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import {
  BusinessAccount,
  businessAccountStatuses,
  businessKycCheckStatuses,
  BusinessKycCheckKey,
  BusinessKycCheckStatus,
  BusinessKycOverallStatus,
  BusinessAccountStatus,
  DocumentType,
  GstBillingPreference,
  IBusinessAccount,
  IBusinessDocument,
  IBusinessGstBilling,
  IBusinessKycReview,
  gstBillingPreferenceValues
} from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import {
  CountryRateCard,
  internalRateCardBandValues,
  rateCardBandValues,
} from "../models/countryRateCard.model.js";
import { businessAccountBranchFilter } from "../middleware/businessAccountBranchAccess.middleware.js";
import { excludeSentinel } from "../services/individualCustomer.service.js";
import { isSupportedDocument } from "../services/storage/fileSignature.js";
import {
  StorageObjectNotFoundError,
  businessAccountKycKey,
  deleteObject,
  putObject,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import { notifyActiveAdmins, notifyBusinessAccountManagers } from "../services/portalNotification.service.js";
import {
  BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX,
  compactRegistrationId,
  countriesWithoutRegistrationId,
  countriesWithSecondaryRegistrationId,
  emailValidationMessage,
  getPostalCodeValidationMessage,
  getPrimaryRegistrationError,
  getSecondaryRegistrationError,
  isHttpOrHttpsUrl,
  isValidBusinessContactEmail,
  isValidPhoneForCountryCode,
  isValidPostalCodeForCountry,
  phoneValidationMessage
} from "../services/businessAccountRules.js";
import {
  GST_EXEMPT_REASON_MAX,
  GST_EXEMPT_REASON_MIN,
  collectsGstin,
  getGstinError,
  normalizeGstin,
  requiresGstin
} from "../services/gstin.js";
import {
  formatUsTaxId,
  isMaskedUsTaxId,
  isSensitiveUsTaxIdType,
  isUsTaxIdType,
  maskUsTaxId,
  normalizeUsTaxId
} from "../services/usTaxId.js";
import { encryptSecret } from "../services/credentialEncryption.service.js";
import {
  diffSnapshots,
  recordBusinessAccountAudit,
  toAuditSnapshot
} from "../services/businessAccountAudit.service.js";
import { IdempotencyKey } from "../models/idempotencyKey.model.js";
import { isValidStateForCountry } from "../services/reference/geography.service.js";

const idempotencyScope = "business-account-create";
import { getCountryCodeByName } from "../services/reference/portalCountries.js";

const shipmentTypeSchema = z.enum(["international_cargo", "international_courier"]);
const companyTypeSchema = z.enum(["pvt_ltd", "llp", "enterprise", "proprietorship"]).or(z.literal(""));
const registrationCountrySchema = z.enum([
  "United Kingdom",
  "United States",
  "India",
  "France",
  "Netherlands",
  "Kuwait",
  "Canada",
  "Switzerland",
  "Poland"
]);
const documentTypeSchema = z.enum([
  "aadhaarCard",
  "panCard",
  "adCertificate",
  "msmeCertificate",
  "tanCertificate",
  "otherCertificate",
  "gstCertificate",
  "iecCertificate"
]);
const businessAccountStatusSchema = z.enum(businessAccountStatuses);
const businessAccountOperationalActionSchema = z.enum([
  "deposit_required",
  "deposit_received",
  "ledger_viewed"
]);
const businessKycCheckKeySchema = z.enum([
  "contactDetails",
  "companyDetails",
  "gstExemption",
  "aadhaarCard",
  "panCard",
  "adCertificate",
  "msmeCertificate",
  "tanCertificate",
  "otherCertificate",
  "gstCertificate",
  "iecCertificate"
]);
const businessKycCheckStatusSchema = z.enum(businessKycCheckStatuses);
const assignBranchBodySchema = z.object({
  branchId: z.string().trim().refine((value) => mongoose.Types.ObjectId.isValid(value), "Invalid branch ID")
});
const assignRateCardBodySchema = z.object({
  // Band D is reserved for public online bookings and must never be assigned
  // to an internal business account.
  rateCardBand: z.enum(internalRateCardBandValues).nullable(),
  // Accept a historical Band D value for optimistic-concurrency checks so a
  // manually migrated account can still be cleared safely.
  expectedRateCardBand: z.enum(rateCardBandValues).nullable(),
  reason: z.string().trim().min(3, "Enter a reason for this rate-card change.").max(500)
});
const nullableCreditLimitSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.coerce.number().nonnegative().max(BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX, `Requested credit limit cannot exceed ${BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}.`).nullable().optional()
);
const gstBillingRequestSchema = z.object({
  requestedTreatment: z.enum(gstBillingPreferenceValues).optional().default("GST_APPLICABLE"),
  requestReason: z.string().trim().max(500).optional().default("")
}).superRefine((value, context) => {
  if (value.requestedTreatment === "NO_GST" && value.requestReason.length < 3) {
    context.addIssue({
      code: "custom",
      path: ["requestReason"],
      message: "Enter a reason for requesting no-GST shipment billing."
    });
  }
});
const gstBillingReviewBodySchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REVOKE"]),
  reason: z.string().trim().min(3, "Enter a reason for this decision.").max(500),
  expectedVersion: z.coerce.number().int().positive()
});

const businessAccountBodySchema = z.object({
  contact: z.object({
    title: z.enum(["mr.", "mrs.", "ms.", "dr.", "prof."]),
    firstName: z.string().trim().min(3, "First name must be at least 3 characters.").max(22),
    lastName: z.string().trim().min(3, "Last name must be at least 3 characters.").max(22),
    email: z.string().trim().email().toLowerCase().refine(isValidBusinessContactEmail, emailValidationMessage),
    mobileType: z.enum(["mobile", "office"]),
    countryCode: z.string().trim().min(1).max(8),
    mobileNumber: z.string().trim().regex(/^\d{6,15}$/, "Mobile number must contain 6 to 15 digits"),
    jobTitle: z.string().trim().min(1).max(80),
    department: z.string().trim().min(1).max(80),
    shipmentTypes: z.array(shipmentTypeSchema).min(1)
  }),
  company: z.object({
    registrationCountry: registrationCountrySchema,
    registrationIdType: z.string().trim().max(80).optional().default(""),
    registrationId: z.string().trim().max(50).optional().default(""),
    // Shape is checked in the superRefine below so the message can name the part
    // that is wrong (state code, PAN section) instead of restating the format.
    gstin: z.string().trim().max(20).optional().default(""),
    gstExempt: z.coerce.boolean().optional().default(false),
    gstExemptReason: z.string().trim().max(GST_EXEMPT_REASON_MAX).optional().default(""),
    secondaryRegistrationId: z.string().trim().max(50).optional().default(""),
    noCompanyRegistration: z.coerce.boolean().optional().default(false),
    noCompany: z.coerce.boolean().optional().default(false),
    companyType: companyTypeSchema.default(""),
    companyName: z.string().trim().max(160).optional().default(""),
    registeredAddress: z.string().trim().max(500).optional().default(""),
    addressLine2: z.string().trim().max(200).optional().default(""),
    city: z.string().trim().max(80).optional().default(""),
    stateOrProvince: z.string().trim().max(80).optional().default(""),
    postalCode: z.string().trim().max(20).optional().default(""),
    addressCountry: z.string().trim().max(80).optional().default(""),
    useCompanyAddressAsBillingAddress: z.coerce.boolean().optional().default(true),
    billingAddress: z.object({
      addressLine1: z.string().trim().max(500).optional().default(""),
      addressLine2: z.string().trim().max(200).optional().default(""),
      city: z.string().trim().max(80).optional().default(""),
      stateOrProvince: z.string().trim().max(80).optional().default(""),
      postalCode: z.string().trim().max(20).optional().default(""),
      country: z.string().trim().max(80).optional().default("")
    }).optional().default({
      addressLine1: "",
      addressLine2: "",
      city: "",
      stateOrProvince: "",
      postalCode: "",
      country: ""
    }),
    operatingCountries: z.array(z.string().trim().min(1).max(80)).default([]),
    website: z.string().trim().url().refine(isHttpOrHttpsUrl, "Website must start with http:// or https://").optional().or(z.literal("")).or(z.null()),
    industry: z.string().trim().max(100).optional().default(""),
    monthlyShipmentVolume: z.string().trim().max(80).optional().default(""),
    requestedCreditCurrency: z.string().trim().min(3).max(3).default("INR"),
    requestedCreditLimit: nullableCreditLimitSchema
  }),
  gstBilling: gstBillingRequestSchema.optional()
}).superRefine((data, context) => {
  if (!isValidPhoneForCountryCode(data.contact.countryCode, data.contact.mobileNumber)) {
    context.addIssue({
      code: "custom",
      path: ["contact", "mobileNumber"],
      message: phoneValidationMessage
    });
  }

  const registrationId = data.company.registrationId.trim();
  const secondaryRegistrationId = data.company.secondaryRegistrationId.trim();
  const noCompany = data.company.noCompany;
  // Neither escape hatch applies to a US account: an individual with no company
  // still holds an SSN or an ITIN, so there is no route to a US account without
  // a taxpayer ID. Allowing either would be a one-request bypass of a mandatory
  // field.
  const allowsSkippingRegistration = data.company.registrationCountry !== "United States";
  const canSkipRegistration = countriesWithoutRegistrationId.has(data.company.registrationCountry)
    || (allowsSkippingRegistration && (noCompany || data.company.noCompanyRegistration));

  if (!noCompany && !data.company.companyType.trim()) {
    context.addIssue({
      code: "custom",
      path: ["company", "companyType"],
      message: "Company type is required"
    });
  }

  if (!canSkipRegistration && !registrationId) {
    context.addIssue({
      code: "custom",
      path: ["company", "registrationId"],
      message: "Registration ID is required for the selected country."
    });
  }

  const primaryRegistrationError = getPrimaryRegistrationError(data.company.registrationCountry, registrationId, data.company.registrationIdType);
  if (!canSkipRegistration && primaryRegistrationError) {
    context.addIssue({
      code: "custom",
      path: ["company", "registrationId"],
      message: primaryRegistrationError
    });
  }

  if (!canSkipRegistration && countriesWithSecondaryRegistrationId.has(data.company.registrationCountry) && !secondaryRegistrationId) {
    context.addIssue({
      code: "custom",
      path: ["company", "secondaryRegistrationId"],
      message: "Additional registration code is required for the selected country."
    });
  }

  const secondaryRegistrationError = getSecondaryRegistrationError(data.company.registrationCountry, secondaryRegistrationId);
  if (!canSkipRegistration && secondaryRegistrationError) {
    context.addIssue({
      code: "custom",
      path: ["company", "secondaryRegistrationId"],
      message: secondaryRegistrationError
    });
  }

  const gstin = normalizeGstin(data.company.gstin);
  const gstExempt = data.company.gstExempt;
  const collectsGst = collectsGstin({ registrationCountry: data.company.registrationCountry, noCompany });

  if (collectsGst && gstExempt) {
    const reason = data.company.gstExemptReason.trim();

    if (reason.length < GST_EXEMPT_REASON_MIN) {
      context.addIssue({
        code: "custom",
        path: ["company", "gstExemptReason"],
        message: `Explain why this business is not registered under GST, in at least ${GST_EXEMPT_REASON_MIN} characters.`
      });
    }

    if (gstin) {
      context.addIssue({
        code: "custom",
        path: ["company", "gstin"],
        message: "Remove the GSTIN or untick GST exempt. An account cannot be both registered and exempt."
      });
    }
  }

  if (requiresGstin({ registrationCountry: data.company.registrationCountry, noCompany, gstExempt }) && !gstin) {
    context.addIssue({
      code: "custom",
      path: ["company", "gstin"],
      message: "GSTIN is required for Indian business accounts. Tick GST exempt if the business is not registered under GST."
    });
  }

  // Scoped to accounts that actually capture a GSTIN. Validating it regardless
  // of country would reject a submission over a field the form does not show,
  // leaving the user an error they cannot act on.
  const gstinError = collectsGst ? getGstinError(gstin) : "";
  if (gstinError) {
    context.addIssue({
      code: "custom",
      path: ["company", "gstin"],
      message: gstinError
    });
  }

  if (!noCompany) {
    const requiredCompanyFields: [keyof typeof data.company, string][] = [
      ["companyName", "Company name is required"],
      ["registeredAddress", "Registered address is required"],
      ["city", "City is required"],
      ["stateOrProvince", "State or province is required"],
      ["postalCode", "Postal code is required"],
      ["addressCountry", "Country is required"],
      ["industry", "Company industry is required"],
      ["monthlyShipmentVolume", "Monthly shipment volume is required"]
    ];

    for (const [field, message] of requiredCompanyFields) {
      if (!String(data.company[field] ?? "").trim()) {
        context.addIssue({
          code: "custom",
          path: ["company", field],
          message
        });
      }
    }

    if (!data.company.operatingCountries.length) {
      context.addIssue({
        code: "custom",
        path: ["company", "operatingCountries"],
        message: "Select at least one operating country"
      });
    }

    if (
      data.company.postalCode.trim()
      && data.company.addressCountry.trim()
      && !isValidPostalCodeForCountry(data.company.addressCountry, data.company.postalCode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["company", "postalCode"],
        message: getPostalCodeValidationMessage(data.company.addressCountry)
      });
    }

    // The state must be one the selected country actually has. Countries with no
    // subdivision data accept anything, and the comparison ignores case,
    // accents and punctuation so a legacy spelling is not rejected on an
    // otherwise unrelated edit.
    const stateCountryCode = getCountryCodeByName(data.company.addressCountry);
    if (
      stateCountryCode
      && data.company.stateOrProvince.trim()
      && !isValidStateForCountry(stateCountryCode, data.company.stateOrProvince)
    ) {
      context.addIssue({
        code: "custom",
        path: ["company", "stateOrProvince"],
        message: `Select a valid state or province for ${data.company.addressCountry}.`
      });
    }

    // A separate billing address has to be as complete as the company one, or
    // invoices go somewhere unusable.
    if (!data.company.useCompanyAddressAsBillingAddress) {
      const billing = data.company.billingAddress;
      const requiredBillingFields: [keyof typeof billing, string][] = [
        ["addressLine1", "Billing address is required"],
        ["city", "Billing city is required"],
        ["stateOrProvince", "Billing state or province is required"],
        ["postalCode", "Billing postal code is required"],
        ["country", "Billing country is required"]
      ];

      for (const [field, message] of requiredBillingFields) {
        if (!String(billing[field] ?? "").trim()) {
          context.addIssue({ code: "custom", path: ["company", "billingAddress", field], message });
        }
      }

      if (billing.postalCode.trim() && billing.country.trim() && !isValidPostalCodeForCountry(billing.country, billing.postalCode)) {
        context.addIssue({
          code: "custom",
          path: ["company", "billingAddress", "postalCode"],
          message: getPostalCodeValidationMessage(billing.country)
        });
      }

      const billingCountryCode = getCountryCodeByName(billing.country);
      if (billingCountryCode && billing.stateOrProvince.trim() && !isValidStateForCountry(billingCountryCode, billing.stateOrProvince)) {
        context.addIssue({
          code: "custom",
          path: ["company", "billingAddress", "stateOrProvince"],
          message: `Select a valid state or province for ${billing.country}.`
        });
      }
    }
  }
});

/**
 * The shape the account builders accept.
 *
 * Taken from the draft schema rather than the strict one because it is the wider
 * of the two- a fully validated body is assignable to it, so one set of helpers
 * serves both the draft save and the real submission.
 */
type BusinessAccountBody = z.infer<typeof businessAccountDraftBodySchema>;

const businessKycReviewBodySchema = z.object({
  checks: z.partialRecord(
    businessKycCheckKeySchema,
    z.object({
      status: businessKycCheckStatusSchema,
      note: z.string().trim().max(50).optional().nullable()
    })
  ).optional(),
  finalDecision: z.enum(["rejected"]).nullable().optional(),
  startReview: z.boolean().optional()
}).superRefine((data, context) => {
  for (const [key, check] of Object.entries(data.checks ?? {}) as [BusinessKycCheckKey, { status: BusinessKycCheckStatus; note?: string | null }][]) {
    if (check.status === "information_required" && !check.note?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["checks", key, "note"],
        message: "Reason is required and must be 50 characters or less"
      });
    }

  }
});

type BusinessKycReviewBody = z.infer<typeof businessKycReviewBodySchema>;
type AssignBranchBody = z.infer<typeof assignBranchBodySchema>;

const statusActionMessages: Record<BusinessAccountStatus, string> = {
  draft: "Business account moved to draft.",
  pending_review: "Business account submitted for review.",
  approved: "Business account approved.",
  rejected: "Business account rejected.",
  active: "Business account activated.",
  suspended: "Business account suspended."
};

// Lifecycle decisions the client is told about. Statuses absent from this map
// (draft, pending_review) are internal steps and stay silent.
const clientVisibleStatusNotices: Partial<Record<BusinessAccountStatus, { title: string; message: string }>> = {
  approved: {
    title: "Business account approved",
    message: "Your business account passed review. Complete the remaining activation steps to start booking."
  },
  rejected: {
    title: "Business account rejected",
    message: "Your business account was not approved. Contact your Swiftline branch for the next steps."
  },
  active: {
    title: "Business account activated",
    message: "Your business account is now active and ready for bookings."
  },
  suspended: {
    title: "Business account suspended",
    message: "Your business account has been suspended. Contact your Swiftline branch to restore access."
  }
};

const operationalActionMessages: Record<z.infer<typeof businessAccountOperationalActionSchema>, string> = {
  deposit_required: "Deposit required.",
  deposit_received: "Deposit received.",
  ledger_viewed: "Ledger review marked."
};

// Allowed lifecycle transitions. Re-applying the current status is treated as a
// no-op; every other transition not listed here is rejected with a 409.
export const businessAccountStatusTransitions: Record<BusinessAccountStatus, BusinessAccountStatus[]> = {
  draft: ["pending_review"],
  pending_review: ["approved", "rejected"],
  approved: ["active", "rejected"],
  active: ["suspended"],
  suspended: ["active"],
  rejected: []
};

// Statuses that may only be reached once the KYC review is fully verified.
export const kycGatedStatuses: BusinessAccountStatus[] = ["approved", "active"];

function formatStatusLabel(status: string) {
  return status.replaceAll("_", " ");
}

// Escape user-supplied search text so it is matched literally instead of being
// interpreted as a regular expression (prevents regex injection and ReDoS).
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === 11000;
}

// Return the first uploaded document whose content is not a valid PDF/JPEG/PNG,
// or null when every uploaded file passes the signature check. The client-
// supplied MIME type is not trusted; the bytes that arrived are inspected.
function findInvalidDocumentSignature(
  files: Partial<Record<DocumentType, Express.Multer.File>>
): DocumentType | null {
  for (const [type, file] of Object.entries(files) as [DocumentType, Express.Multer.File | undefined][]) {
    if (file && !isSupportedDocument(file.buffer)) return type;
  }

  return null;
}

/**
 * Removes objects a request stored before it went on to fail, and documents
 * superseded by a successful update.
 *
 * Best effort in both cases: an orphaned object costs storage, whereas failing
 * the response over a failed delete would cost the user their submission.
 */
async function discardStoredObjects(keys: string[]) {
  await Promise.all(keys.map((key) => deleteObject(key).catch(() => undefined)));
}

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
    return null;
  }

  return new mongoose.Types.ObjectId(String(id));
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * What a draft must carry.
 *
 * Only the identity fields, because those are what the live-account unique
 * indexes key off and what duplicate detection needs; a draft that could not be
 * de-duplicated would let the same customer be onboarded twice. Everything else
 * is accepted as-is and re-validated in full by `submitBusinessAccount`.
 */
const businessAccountDraftBodySchema = z.object({
  contact: z.object({
    title: z.enum(["mr.", "mrs.", "ms.", "dr.", "prof."]).or(z.literal("")).optional().default(""),
    firstName: z.string().trim().min(3, "First name must be at least 3 characters.").max(22),
    lastName: z.string().trim().min(3, "Last name must be at least 3 characters.").max(22),
    email: z.string().trim().email().toLowerCase().refine(isValidBusinessContactEmail, emailValidationMessage),
    mobileType: z.enum(["mobile", "office"]).optional().default("mobile"),
    countryCode: z.string().trim().min(1).max(8),
    mobileNumber: z.string().trim().regex(/^\d{6,15}$/, "Mobile number must contain 6 to 15 digits"),
    jobTitle: z.string().trim().max(80).optional().default(""),
    department: z.string().trim().max(80).optional().default(""),
    shipmentTypes: z.array(shipmentTypeSchema).optional().default([])
  }),
  company: z.object({
    registrationCountry: registrationCountrySchema.or(z.literal("")).optional().default(""),
    registrationIdType: z.string().trim().max(80).optional().default(""),
    registrationId: z.string().trim().max(50).optional().default(""),
    gstin: z.string().trim().max(20).optional().default(""),
    gstExempt: z.coerce.boolean().optional().default(false),
    gstExemptReason: z.string().trim().max(GST_EXEMPT_REASON_MAX).optional().default(""),
    secondaryRegistrationId: z.string().trim().max(50).optional().default(""),
    noCompanyRegistration: z.coerce.boolean().optional().default(false),
    noCompany: z.coerce.boolean().optional().default(false),
    companyType: companyTypeSchema.optional().default(""),
    companyName: z.string().trim().max(160).optional().default(""),
    registeredAddress: z.string().trim().max(500).optional().default(""),
    addressLine2: z.string().trim().max(200).optional().default(""),
    city: z.string().trim().max(80).optional().default(""),
    stateOrProvince: z.string().trim().max(80).optional().default(""),
    postalCode: z.string().trim().max(20).optional().default(""),
    addressCountry: z.string().trim().max(80).optional().default(""),
    useCompanyAddressAsBillingAddress: z.coerce.boolean().optional().default(true),
    billingAddress: z.object({
      addressLine1: z.string().trim().max(500).optional().default(""),
      addressLine2: z.string().trim().max(200).optional().default(""),
      city: z.string().trim().max(80).optional().default(""),
      stateOrProvince: z.string().trim().max(80).optional().default(""),
      postalCode: z.string().trim().max(20).optional().default(""),
      country: z.string().trim().max(80).optional().default("")
    }).optional().default({
      addressLine1: "",
      addressLine2: "",
      city: "",
      stateOrProvince: "",
      postalCode: "",
      country: ""
    }),
    operatingCountries: z.array(z.string().trim().min(1).max(80)).optional().default([]),
    website: z.string().trim().max(200).optional().or(z.literal("")).or(z.null()),
    industry: z.string().trim().max(100).optional().default(""),
    monthlyShipmentVolume: z.string().trim().max(80).optional().default(""),
    requestedCreditCurrency: z.string().trim().min(3).max(3).optional().default("INR"),
    requestedCreditLimit: nullableCreditLimitSchema
  }),
  gstBilling: gstBillingRequestSchema.optional()
});

/** True when the caller asked to store the form as a draft rather than submit it. */
function isDraftSave(request: Request) {
  const body = request.body as Record<string, unknown>;
  return String(body.saveAsDraft ?? request.query.draft ?? "") === "true";
}

function parseBusinessAccountBody(request: Request, { draft = false } = {}) {
  const body = request.body as Record<string, unknown>;
  const payload = {
    contact: parseJsonField(body.contact),
    company: parseJsonField(body.company),
    gstBilling: parseJsonField(body.gstBilling)
  };

  return draft
    ? businessAccountDraftBodySchema.safeParse(payload)
    : businessAccountBodySchema.safeParse(payload);
}

function getUploadedFiles(request: Request): Partial<Record<DocumentType, Express.Multer.File>> {
  const files = request.files as Partial<Record<DocumentType, Express.Multer.File[]>> | undefined;

  return {
    aadhaarCard: files?.aadhaarCard?.[0],
    panCard: files?.panCard?.[0],
    adCertificate: files?.adCertificate?.[0],
    msmeCertificate: files?.msmeCertificate?.[0],
    tanCertificate: files?.tanCertificate?.[0],
    otherCertificate: files?.otherCertificate?.[0],
    gstCertificate: files?.gstCertificate?.[0],
    iecCertificate: files?.iecCertificate?.[0]
  };
}

async function storeBusinessDocument(
  type: DocumentType,
  file: Express.Multer.File,
  businessAccountId: string
): Promise<IBusinessDocument> {
  const storageKey = businessAccountKycKey(businessAccountId, file.originalname);
  await putObject({
    key: storageKey,
    body: file.buffer,
    contentType: file.mimetype,
    originalName: file.originalname
  });

  return {
    type,
    originalName: file.originalname,
    storageKey,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date()
  };
}

/**
 * Decides how a registration ID is stored.
 *
 * A US SSN or ITIN identifies a person, so only its mask goes in the readable
 * field and the number itself is encrypted alongside. An EIN is a public
 * business identifier and is stored like any other registration ID.
 *
 * Editing an account shows the mask, and submitting it unchanged must keep the
 * stored number rather than overwrite it with the mask.
 */
function resolveRegistrationIdStorage(
  company: BusinessAccountBody["company"],
  existingEncrypted = ""
): { registrationId: string; registrationIdEncrypted: string } {
  if (company.registrationCountry !== "United States") {
    return {
      registrationId: compactRegistrationId(company.registrationId),
      registrationIdEncrypted: ""
    };
  }

  const taxIdType = isUsTaxIdType(company.registrationIdType) ? company.registrationIdType : "ein";

  if (!isSensitiveUsTaxIdType(taxIdType)) {
    return {
      registrationId: formatUsTaxId(company.registrationId, taxIdType),
      registrationIdEncrypted: ""
    };
  }

  if (isMaskedUsTaxId(company.registrationId)) {
    return { registrationId: company.registrationId, registrationIdEncrypted: existingEncrypted };
  }

  const digits = normalizeUsTaxId(company.registrationId);

  if (!digits) return { registrationId: "", registrationIdEncrypted: "" };

  return {
    registrationId: maskUsTaxId(digits, taxIdType),
    registrationIdEncrypted: encryptSecret(digits, "taxId")
  };
}

function buildAccountPayload(data: BusinessAccountBody, existingEncryptedRegistrationId = "") {
  // GST fields belong only to accounts that capture them. Dropping them
  // otherwise stops a country switch- or a hand-rolled request- leaving GST
  // data stranded on an account that has no GST at all.
  const keepsGst = collectsGstin({
    registrationCountry: data.company.registrationCountry,
    noCompany: data.company.noCompany
  });

  const registrationStorage = resolveRegistrationIdStorage(data.company, existingEncryptedRegistrationId);

  return {
    contact: data.contact,
    company: {
      registrationCountry: data.company.registrationCountry,
      registrationIdType: data.company.registrationIdType,
      // Store the normalized registration ID so lookups and duplicate checks
      // stay consistent regardless of spacing or letter case on input.
      registrationId: registrationStorage.registrationId,
      registrationIdEncrypted: registrationStorage.registrationIdEncrypted,
      // Blank whenever the stored value is a mask, so masked tax IDs are left
      // out of the uniqueness index rather than colliding on their last digits.
      registrationIdKey: registrationStorage.registrationIdEncrypted
        ? ""
        : compactRegistrationId(registrationStorage.registrationId),
      // Normalized so a pasted certificate value matches a typed one.
      gstin: keepsGst ? normalizeGstin(data.company.gstin) : "",
      gstExempt: keepsGst ? data.company.gstExempt : false,
      // The reason only means anything alongside the claim it explains.
      gstExemptReason: keepsGst && data.company.gstExempt ? data.company.gstExemptReason : "",
      secondaryRegistrationId: data.company.secondaryRegistrationId,
      noCompanyRegistration: data.company.noCompanyRegistration,
      noCompany: data.company.noCompany,
      companyType: data.company.companyType,
      companyName: data.company.companyName,
      registeredAddress: data.company.registeredAddress,
      addressLine2: data.company.addressLine2,
      city: data.company.city,
      stateOrProvince: data.company.stateOrProvince,
      postalCode: data.company.postalCode,
      addressCountry: data.company.addressCountry,
      useCompanyAddressAsBillingAddress: data.company.useCompanyAddressAsBillingAddress,
      // Cleared when the company address is reused, so re-ticking the box cannot
      // leave a stale billing address behind on the record.
      billingAddress: data.company.useCompanyAddressAsBillingAddress ? null : data.company.billingAddress,
      operatingCountries: data.company.operatingCountries,
      website: data.company.website || null,
      industry: data.company.industry,
      monthlyShipmentVolume: data.company.monthlyShipmentVolume,
      requestedCreditLimit: {
        currency: data.company.requestedCreditCurrency,
        amount: data.company.requestedCreditLimit ?? null
      }
    }
  };
}

function normalGstBilling(version = 1): IBusinessGstBilling {
  return {
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
    version
  };
}

function initialGstBilling(
  request: BusinessAccountBody["gstBilling"],
  requestedBy: mongoose.Types.ObjectId
): IBusinessGstBilling {
  if (!request || request.requestedTreatment === "GST_APPLICABLE") return normalGstBilling();

  return {
    ...normalGstBilling(),
    requestedTreatment: "NO_GST",
    status: "PENDING",
    requestReason: request.requestReason,
    requestedAt: new Date(),
    requestedBy
  };
}

function resolveEditedGstBilling(
  current: IBusinessGstBilling | undefined,
  request: BusinessAccountBody["gstBilling"],
  requestedBy: mongoose.Types.ObjectId
): { value: IBusinessGstBilling; changed: boolean } {
  const existing = current ?? normalGstBilling();
  // Backwards compatibility for older internal clients that predate this form
  // field: omission means preserve, never revoke or create a request.
  if (!request) return { value: existing, changed: false };

  if (existing.status === "APPROVED") {
    if (request.requestedTreatment !== "NO_GST") {
      throw new Error("An approved no-GST permission must be revoked through the GST billing review with a reason.");
    }
    return { value: existing, changed: false };
  }

  if (request.requestedTreatment === "GST_APPLICABLE") {
    const changed = existing.requestedTreatment !== "GST_APPLICABLE" || existing.status !== "NOT_REQUIRED";
    return { value: changed ? normalGstBilling(existing.version + 1) : existing, changed };
  }

  const changed = existing.requestedTreatment !== "NO_GST"
    || existing.status !== "PENDING"
    || existing.requestReason !== request.requestReason;
  if (!changed) return { value: existing, changed: false };

  return {
    changed: true,
    value: {
      ...normalGstBilling(existing.version + 1),
      requestedTreatment: "NO_GST",
      status: "PENDING",
      requestReason: request.requestReason,
      requestedAt: new Date(),
      requestedBy
    }
  };
}

function generateAccountId(): string {
  const year = new Date().getFullYear();
  const sequence = Math.floor(100000 + Math.random() * 900000);
  return `BA-${year}-${sequence}`;
}

// Insert the account with a freshly generated ID, retrying only when the random
// suffix collides with an existing accountId. The retry is on the insert itself,
// so a concurrent create racing on the same suffix no longer surfaces as a 500.
async function createBusinessAccountRecord(basePayload: Record<string, unknown>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await BusinessAccount.create({ accountId: generateAccountId(), ...basePayload });
    } catch (error) {
      const collidedOnAccountId = isDuplicateKeyError(error)
        && Boolean((error as { keyPattern?: Record<string, unknown> }).keyPattern?.accountId);
      if (collidedOnAccountId) continue;
      throw error;
    }
  }

  throw new Error("Unable to generate a unique business account ID");
}

async function hasDuplicateBusinessIdentity(
  data: BusinessAccountBody,
  accountIdToExclude?: string
): Promise<string | null> {
  // An SSN or ITIN is stored only as its mask, so comparing it would flag two
  // unrelated people who happen to share the last four digits as duplicates-
  // and would be comparing masks, not numbers, in any case.
  const isSensitiveTaxId = data.company.registrationCountry === "United States"
    && isUsTaxIdType(data.company.registrationIdType)
    && isSensitiveUsTaxIdType(data.company.registrationIdType);
  const normalizedRegistrationId = isSensitiveTaxId ? "" : compactRegistrationId(data.company.registrationId);
  const identityChecks: Record<string, string>[] = [
    { "contact.email": data.contact.email },
    // The same local number under a different country code is a different phone,
    // so both fields must match for a mobile-number conflict.
    { "contact.countryCode": data.contact.countryCode, "contact.mobileNumber": data.contact.mobileNumber }
  ];

  if (normalizedRegistrationId) {
    identityChecks.push({ "company.registrationId": normalizedRegistrationId });
  }

  const duplicate = await BusinessAccount.findOne({
    _id: accountIdToExclude ? { $ne: accountIdToExclude } : { $exists: true },
    $or: identityChecks
  })
    .select("contact.email contact.countryCode contact.mobileNumber company.registrationId")
    .lean()
    .exec();

  if (!duplicate) return null;

  if (duplicate.contact.email === data.contact.email) return "Email address already exists";
  if (
    duplicate.contact.countryCode === data.contact.countryCode
    && duplicate.contact.mobileNumber === data.contact.mobileNumber
  ) {
    return "Mobile number already exists";
  }
  if (normalizedRegistrationId && duplicate.company.registrationId === normalizedRegistrationId) {
    return "Company registration ID already exists";
  }

  return null;
}

// Document requirements are the same for every shipment type today. The
// signatures intentionally omit shipmentTypes; reintroduce it here (and in the
// two helpers below) if per-type document rules are ever added.
export function getDocumentRequirementError(
  documents: Partial<Record<DocumentType, IBusinessDocument>>
): string | null {
  if (!documents.aadhaarCard) return "Aadhaar Card is required";
  if (!documents.panCard) return "PAN Card Copy is required";

  return null;
}

export function getRequiredKycCheckKeys(
  documents: Partial<Record<DocumentType, IBusinessDocument>>,
  options: { gstExempt?: boolean } = {}
): BusinessKycCheckKey[] {
  const keys: BusinessKycCheckKey[] = ["contactDetails", "companyDetails", "aadhaarCard", "panCard"];

  // An account claiming exemption from GST registration carries an extra check,
  // so it cannot reach "verified"- and therefore cannot be approved or
  // activated- until an admin has cleared the exemption.
  if (options.gstExempt) keys.push("gstExemption");

  for (const optionalKey of ["adCertificate", "msmeCertificate", "tanCertificate", "otherCertificate", "gstCertificate", "iecCertificate"] as DocumentType[]) {
    if (documents[optionalKey]) keys.push(optionalKey);
  }

  return keys;
}

export function getMissingRequiredDocuments(
  documents: Partial<Record<DocumentType, IBusinessDocument>>
) {
  const missing: DocumentType[] = [];

  if (!documents.aadhaarCard) missing.push("aadhaarCard");
  if (!documents.panCard) missing.push("panCard");

  return missing;
}

function getDefaultKycReview(): IBusinessKycReview {
  return {
    overallStatus: "documents_pending",
    checks: {},
    finalDecision: null,
    reviewStartedAt: null,
    reviewedAt: null,
    reviewedBy: null
  };
}

export function deriveKycOverallStatus(
  documents: Partial<Record<DocumentType, IBusinessDocument>>,
  review: IBusinessKycReview,
  options: { gstExempt?: boolean } = {}
): BusinessKycOverallStatus {
  const missingDocuments = getMissingRequiredDocuments(documents);
  if (missingDocuments.length) return "documents_pending";
  if (review.finalDecision === "rejected") return "rejected";

  const requiredKeys = getRequiredKycCheckKeys(documents, options);
  const statuses = requiredKeys.map((key) => review.checks?.[key]?.status ?? "not_started");
  const infoRequiredStatuses: BusinessKycCheckStatus[] = ["information_required"];

  if (statuses.some((status) => status === "reject")) {
    return "rejected";
  }

  if (statuses.some((status) => infoRequiredStatuses.includes(status))) {
    return "additional_information_required";
  }

  if (statuses.every((status) => status === "verified")) {
    return "verified";
  }

  if (!review.reviewStartedAt && statuses.every((status) => status === "not_started")) {
    return "submitted";
  }

  return "under_review";
}

function normalizeKycCheckStatus(status: string): BusinessKycCheckStatus {
  if (status === "failed") return "reject";
  if (status === "replacement_required" || status === "mismatched" || status === "unclear") return "information_required";
  if (businessKycCheckStatuses.includes(status as BusinessKycCheckStatus)) {
    return status as BusinessKycCheckStatus;
  }

  return "not_started";
}

function getSanitizedKycReview(currentReview?: IBusinessKycReview): IBusinessKycReview {
  const review: IBusinessKycReview = {
    ...getDefaultKycReview(),
    finalDecision: currentReview?.finalDecision ?? null,
    reviewStartedAt: currentReview?.reviewStartedAt ?? null,
    reviewedAt: currentReview?.reviewedAt ?? null,
    reviewedBy: currentReview?.reviewedBy ?? null,
    checks: {}
  };

  for (const [key, check] of Object.entries(currentReview?.checks ?? {}) as [BusinessKycCheckKey, { status?: string; note?: string | null; reviewedAt?: Date | null } | null | undefined][]) {
    if (!businessKycCheckKeySchema.safeParse(key).success || !check) continue;

    review.checks[key] = {
      status: normalizeKycCheckStatus(check.status ?? "not_started"),
      note: check.note ? check.note.slice(0, 50) : null,
      reviewedAt: check.reviewedAt ?? null
    };
  }

  return review;
}

function applyKycReviewUpdate(
  currentReview: IBusinessKycReview | undefined,
  data: BusinessKycReviewBody,
  userId: mongoose.Types.ObjectId
) {
  const now = new Date();
  const nextReview = getSanitizedKycReview(currentReview);

  if (data.startReview && !nextReview.reviewStartedAt) {
    nextReview.reviewStartedAt = now;
  }

  let hasNonRejectCheckUpdate = false;

  for (const [key, check] of Object.entries(data.checks ?? {}) as [BusinessKycCheckKey, { status: BusinessKycCheckStatus; note?: string | null }][]) {
    if (check.status !== "not_started" && !nextReview.reviewStartedAt) {
      nextReview.reviewStartedAt = now;
    }

    if (check.status !== "reject") {
      hasNonRejectCheckUpdate = true;
    }

    nextReview.checks[key] = {
      status: check.status,
      note: check.note || null,
      reviewedAt: check.status === "not_started" ? null : now
    };
  }

  if ("finalDecision" in data) {
    nextReview.finalDecision = data.finalDecision ?? null;
    if (data.finalDecision === "rejected" && !nextReview.reviewStartedAt) {
      nextReview.reviewStartedAt = now;
    }
  } else if (hasNonRejectCheckUpdate) {
    nextReview.finalDecision = null;
  }

  nextReview.reviewedBy = userId;
  return nextReview;
}

// Decide the review completion timestamp. It is stamped only when the review
// first enters a terminal state (verified/rejected); an unchanged terminal state
// keeps its original timestamp, so unrelated saves no longer bump it.
function resolveKycReviewedAt(
  previousStatus: BusinessKycOverallStatus | undefined,
  previousReviewedAt: Date | null | undefined,
  nextStatus: BusinessKycOverallStatus
): Date | null {
  if (nextStatus !== "verified" && nextStatus !== "rejected") return null;
  if (previousStatus === nextStatus) return previousReviewedAt ?? new Date();
  return new Date();
}

function applyDerivedKycStatus(account: {
  documents?: Partial<Record<DocumentType, IBusinessDocument>>;
  kycReview?: IBusinessKycReview;
  company?: { gstExempt?: boolean };
}) {
  const previousStatus = account.kycReview?.overallStatus;
  const previousReviewedAt = account.kycReview?.reviewedAt ?? null;
  const review = getSanitizedKycReview(account.kycReview);

  review.overallStatus = deriveKycOverallStatus(account.documents ?? {}, review, {
    gstExempt: account.company?.gstExempt
  });
  review.reviewedAt = resolveKycReviewedAt(previousStatus, previousReviewedAt, review.overallStatus);

  return review;
}

// Reset the given KYC checks to not_started. Used when the underlying document or
// field group changes, so a prior verification cannot silently carry over.
function resetKycChecks(kycReview: IBusinessKycReview | undefined, keys: BusinessKycCheckKey[]) {
  if (!kycReview?.checks) return;

  for (const key of keys) {
    const check = kycReview.checks[key];
    if (check && check.status !== "not_started") {
      check.status = "not_started";
      check.note = null;
      check.reviewedAt = null;
    }
  }
}

function normalizeBusinessAccountSnapshot<T extends { status?: string; creditLimitStatus?: string; depositStatus?: string; agreementStatus?: string; ledgerViewedAt?: Date | string | null; updatedAt?: Date | string; gstBilling?: IBusinessGstBilling }>(account: T): T {
  // Lean reads do not run schema hooks. Normalize legacy milestone statuses in
  // API responses so old records behave like the new permanent data model.
  if (account.status === "branch_assigned") {
    account.status = "approved";
  } else if (account.status === "credit_limit_approved") {
    account.status = "approved";
    account.creditLimitStatus = account.creditLimitStatus ?? "approved";
  } else if (account.status === "credit_limit_not_approved") {
    account.status = "approved";
    account.creditLimitStatus = account.creditLimitStatus ?? "not_approved";
  } else if (account.status === "deposit_required") {
    account.status = "approved";
    account.depositStatus = account.depositStatus ?? "required";
  } else if (account.status === "deposit_received") {
    account.status = "approved";
    account.depositStatus = account.depositStatus ?? "received";
  } else if (account.status === "agreement_generated") {
    account.status = "approved";
    account.agreementStatus = account.agreementStatus ?? "generated";
  } else if (account.status === "ledger_viewed") {
    account.status = "approved";
    account.ledgerViewedAt = account.ledgerViewedAt ?? account.updatedAt ?? new Date();
  } else if (account.status === "more_info_needed") {
    account.status = "pending_review";
  }

  account.creditLimitStatus = account.creditLimitStatus ?? "not_reviewed";
  account.depositStatus = account.depositStatus ?? "not_required";
  account.agreementStatus = account.agreementStatus ?? "not_generated";
  account.ledgerViewedAt = account.ledgerViewedAt ?? null;
  account.gstBilling = account.gstBilling ?? normalGstBilling();

  return account;
}

async function getPopulatedBusinessAccount(accountId: string) {
  const account = await BusinessAccount.findOne({ accountId })
    .populate("createdBy", "email name")
    .populate("assignedBranch", "name code status")
    .lean()
    .exec();

  return account ? normalizeBusinessAccountSnapshot(account) : null;
}

// Store newly uploaded documents and return the storage keys of any they
// replaced, plus the keys just written. Superseded objects are deleted by the
// caller only after the save succeeds, so a failed save never removes a document
// the database still points at; the newly written keys let the caller unwind its
// own uploads if that save fails.
async function attachUploadedDocuments(
  documents: Partial<Record<DocumentType, IBusinessDocument>>,
  files: Partial<Record<DocumentType, Express.Multer.File>>,
  businessAccountId: string
): Promise<{ supersededKeys: string[]; storedKeys: string[] }> {
  const supersededKeys: string[] = [];
  const storedKeys: string[] = [];

  for (const type of ["aadhaarCard", "panCard", "adCertificate", "msmeCertificate", "tanCertificate", "otherCertificate", "gstCertificate", "iecCertificate"] as DocumentType[]) {
    const file = files[type];
    if (!file) continue;

    const previous = documents[type];
    if (previous?.storageKey) supersededKeys.push(previous.storageKey);
    documents[type] = await storeBusinessDocument(type, file, businessAccountId);
    storedKeys.push(documents[type].storageKey);
  }

  return { supersededKeys, storedKeys };
}

export async function validateBusinessAccountUniqueness(request: Request, response: Response): Promise<Response> {
  const email = typeof request.query.email === "string" ? request.query.email.trim().toLowerCase() : "";
  const mobileNumber = typeof request.query.mobileNumber === "string" ? request.query.mobileNumber.trim() : "";
  const countryCode = typeof request.query.countryCode === "string" ? request.query.countryCode.trim() : "";
  const rawRegistrationId = typeof request.query.registrationId === "string" ? request.query.registrationId : "";
  const excludeAccountId = typeof request.query.excludeAccountId === "string" ? request.query.excludeAccountId.trim() : "";

  // SSNs and ITINs are stored encrypted and never compared, so this endpoint
  // must not answer questions about them: a caller could otherwise confirm
  // whether a given SSN is on file by guessing one number at a time.
  const registrationIdType = typeof request.query.registrationIdType === "string" ? request.query.registrationIdType : "";
  const isSensitiveTaxId = isUsTaxIdType(registrationIdType) && isSensitiveUsTaxIdType(registrationIdType);
  const registrationId = isSensitiveTaxId ? "" : compactRegistrationId(rawRegistrationId);

  const checks: Record<string, boolean> = {
    email: false,
    mobileNumber: false,
    registrationId: false
  };

  const baseFilter = excludeAccountId ? { accountId: { $ne: excludeAccountId } } : {};
  // Match the country code alongside the number when it is supplied, mirroring the
  // duplicate rule so the same local number under different codes stays distinct.
  const mobileFilter = countryCode
    ? { ...baseFilter, "contact.countryCode": countryCode, "contact.mobileNumber": mobileNumber }
    : { ...baseFilter, "contact.mobileNumber": mobileNumber };

  const [emailMatch, mobileMatch, registrationMatch] = await Promise.all([
    email ? BusinessAccount.exists({ ...baseFilter, "contact.email": email }) : null,
    mobileNumber ? BusinessAccount.exists(mobileFilter) : null,
    registrationId ? BusinessAccount.exists({ ...baseFilter, "company.registrationId": registrationId }) : null
  ]);

  checks.email = Boolean(emailMatch);
  checks.mobileNumber = Boolean(mobileMatch);
  checks.registrationId = Boolean(registrationMatch);

  return response.status(200).json({ success: true, conflicts: checks });
}

export async function listBusinessAccounts(request: Request, response: Response): Promise<Response> {
  const { status, search, branchId } = request.query;
  // The individual-shipment sentinel is bookkeeping rather than a customer, so it
  // is kept out of the list, the counts and every search result.
  const filters: Record<string, unknown> = excludeSentinel({});

  if (typeof status === "string" && status) {
    filters.status = status;
  }

  if (typeof branchId === "string" && mongoose.Types.ObjectId.isValid(branchId)) {
    filters.assignedBranch = new mongoose.Types.ObjectId(branchId);
  }

  if (typeof search === "string" && search.trim()) {
    const pattern = new RegExp(escapeRegExp(search.trim()), "i");
    filters.$or = [
      { accountId: pattern },
      { "company.companyName": pattern },
      { "contact.firstName": pattern },
      { "contact.lastName": pattern },
      { "contact.email": pattern },
      { "contact.mobileNumber": pattern },
      { "company.registrationId": pattern }
    ];
  }

  // Operations sees only its own branches' accounts. The scope is `$and`-ed on
  // rather than merged, so it cannot be widened by the `$or` the search builds.
  const scope = await businessAccountBranchFilter(request);
  const scopedFilters = scope ? { $and: [filters, scope] } : filters;

  const query = BusinessAccount.find(scopedFilters)
    .populate("createdBy", "email name")
    .populate("assignedBranch", "name code status")
    .sort({ createdAt: -1 });

  // Pagination is opt-in. When a valid page is supplied we return a bounded window
  // plus the total count; without it the full list is returned (branch detail
  // relies on this to list every account for a single, already-scoped branch).
  const requestedPage = typeof request.query.page === "string" ? Number.parseInt(request.query.page, 10) : NaN;

  if (Number.isInteger(requestedPage) && requestedPage >= 1) {
    const requestedSize = typeof request.query.pageSize === "string" ? Number.parseInt(request.query.pageSize, 10) : NaN;
    const pageSize = Number.isInteger(requestedSize) ? Math.min(Math.max(requestedSize, 1), 100) : 10;
    const total = await BusinessAccount.countDocuments(scopedFilters);
    const accounts = await query.skip((requestedPage - 1) * pageSize).limit(pageSize).lean().exec();

    return response.status(200).json({
      success: true,
      accounts: accounts.map(normalizeBusinessAccountSnapshot),
      total,
      page: requestedPage,
      pageSize
    });
  }

  const accounts = await query.lean().exec();
  return response.status(200).json({ success: true, accounts: accounts.map(normalizeBusinessAccountSnapshot) });
}

export async function createBusinessAccount(request: Request, response: Response): Promise<Response> {
  // Uploads arrive as in-memory buffers, so every rejection below can return
  // without cleanup: nothing has been stored yet.
  const files = getUploadedFiles(request);
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = parseBusinessAccountBody(request, { draft: isDraftSave(request) });
  if (!parsed.success) {
    return response.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const duplicateMessage = await hasDuplicateBusinessIdentity(parsed.data);
  if (duplicateMessage) {
    return response.status(409).json({ success: false, message: duplicateMessage });
  }

  const invalidDocument = findInvalidDocumentSignature(files);
  if (invalidDocument) {
    return response.status(400).json({ success: false, message: "One or more documents are not a valid PDF, JPG, or PNG file." });
  }

  // A repeat of the same submission returns the account the first one created,
  // rather than creating a second. Covers a duplicate tab or a retried request,
  // which the disabled button on the form cannot.
  const idempotencyKey = typeof request.headers["idempotency-key"] === "string"
    ? request.headers["idempotency-key"].trim().slice(0, 100)
    : "";

  if (idempotencyKey) {
    const existing = await IdempotencyKey
      .findOne({ scope: idempotencyScope, userId, key: idempotencyKey })
      .lean()
      .exec();

    if (existing) {
      const alreadyCreated = await BusinessAccount.findById(existing.entityId).lean().exec();
      if (alreadyCreated) {
        const populated = await getPopulatedBusinessAccount(alreadyCreated.accountId);
        return response.status(200).json({ success: true, account: populated ?? alreadyCreated });
      }
    }
  }

  // Generated up front because KYC storage keys are namespaced by the account
  // they belong to, and the documents must be stored before the record that
  // references them exists.
  const accountObjectId = new mongoose.Types.ObjectId();
  const documents: Partial<Record<DocumentType, IBusinessDocument>> = {};
  const { storedKeys } = await attachUploadedDocuments(documents, files, String(accountObjectId));

  try {
    const account = await createBusinessAccountRecord({
      _id: accountObjectId,
      status: "draft",
      ...buildAccountPayload(parsed.data),
      gstBilling: initialGstBilling(parsed.data.gstBilling, userId),
      documents,
      createdBy: userId,
      updatedBy: userId
    });

    if (idempotencyKey) {
      // Best effort: a lost race here only means a retry could create a second
      // account, which the duplicate-identity check and unique indexes catch.
      await IdempotencyKey
        .create({ scope: idempotencyScope, userId, key: idempotencyKey, entityId: account._id })
        .catch(() => undefined);
    }

    await recordBusinessAccountAudit("BUSINESS_ACCOUNT_CREATED", account, userId);
    if (account.gstBilling.status === "PENDING") {
      await recordBusinessAccountAudit("BUSINESS_ACCOUNT_GST_BILLING_REQUESTED", account, userId, {
        "gstBilling.requestedTreatment": { from: "GST_APPLICABLE", to: "NO_GST" },
        "gstBilling.status": { from: "NOT_REQUIRED", to: "PENDING" }
      });
    }

    const populatedAccount = await getPopulatedBusinessAccount(account.accountId);
    return response.status(201).json({ success: true, account: populatedAccount ?? account });
  } catch (error) {
    await discardStoredObjects(storedKeys);
    throw error;
  }
}

export async function getBusinessAccount(request: Request, response: Response): Promise<Response> {
  const account = await BusinessAccount.findOne({ accountId: request.params.accountId })
    .populate("createdBy", "email name")
    .populate("assignedBranch", "name code status")
    .lean()
    .exec();

  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  return response.status(200).json({ success: true, account: normalizeBusinessAccountSnapshot(account) });
}

export async function updateBusinessAccount(request: Request, response: Response): Promise<Response> {
  // Uploads are buffered in memory and stored only once every check has passed,
  // so the rejections below simply return.
  const files = getUploadedFiles(request);
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  // The encrypted tax ID is `select: false`, so it has to be asked for
  // explicitly- an edit that leaves the masked field untouched needs it to
  // write the same value back rather than blanking it.
  const account = await BusinessAccount
    .findOne({ accountId: request.params.accountId })
    .select("+company.registrationIdEncrypted")
    .exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const parsed = parseBusinessAccountBody(request, { draft: isDraftSave(request) });
  if (!parsed.success) {
    return response.status(400).json({ success: false, errors: parsed.error.format() });
  }

  // Captured before the payload is applied, so the audit entry can say what
  // actually changed rather than just that something did.
  const auditSnapshotBefore = toAuditSnapshot(account);
  const gstBillingBefore = account.gstBilling
    ? JSON.parse(JSON.stringify(account.gstBilling)) as IBusinessGstBilling
    : normalGstBilling();

  const duplicateMessage = await hasDuplicateBusinessIdentity(parsed.data, String(account._id));
  if (duplicateMessage) {
    return response.status(409).json({ success: false, message: duplicateMessage });
  }

  const invalidDocument = findInvalidDocumentSignature(files);
  if (invalidDocument) {
    return response.status(400).json({ success: false, message: "One or more documents are not a valid PDF, JPG, or PNG file." });
  }

  // Snapshot the field groups before applying the update so we can tell which
  // previously reviewed checks are now invalidated by the change.
  const previousContact = JSON.stringify(account.contact);
  const previousCompany = JSON.stringify(account.company);
  const replacedDocumentTypes = (Object.keys(files) as DocumentType[]).filter((type) => files[type]);

  const documents = account.documents ?? {};
  const { supersededKeys, storedKeys } = await attachUploadedDocuments(documents, files, String(account._id));

  let gstBillingUpdate: { value: IBusinessGstBilling; changed: boolean };
  try {
    gstBillingUpdate = resolveEditedGstBilling(account.gstBilling, parsed.data.gstBilling, userId);
  } catch (error) {
    await discardStoredObjects(storedKeys);
    return response.status(409).json({
      success: false,
      message: error instanceof Error ? error.message : "Unable to update GST billing request"
    });
  }

  account.set({
    ...buildAccountPayload(parsed.data, account.company?.registrationIdEncrypted ?? ""),
    gstBilling: gstBillingUpdate.value,
    documents,
    updatedBy: userId
  });

  // A replaced document or an edited contact/company field group must not keep a
  // prior "verified" outcome, so reset those checks for re-review before deriving
  // the overall KYC status.
  const invalidatedChecks: BusinessKycCheckKey[] = [...replacedDocumentTypes];
  if (JSON.stringify(account.contact) !== previousContact) invalidatedChecks.push("contactDetails");
  if (JSON.stringify(account.company) !== previousCompany) {
    // Any company edit reopens the exemption too: the claim an admin approved
    // was about the company as it stood then.
    invalidatedChecks.push("companyDetails", "gstExemption");
  }
  resetKycChecks(account.kycReview, invalidatedChecks);

  account.kycReview = applyDerivedKycStatus(account);

  try {
    await account.save();
  } catch (error) {
    // The save failed, so the newly stored objects are unreferenced. Remove them
    // and leave the previously stored documents untouched.
    await discardStoredObjects(storedKeys);
    if (isDuplicateKeyError(error)) {
      return response.status(409).json({ success: false, message: "A business account with these details already exists." });
    }
    throw error;
  }

  // Save succeeded: the replaced documents are no longer referenced, so remove them.
  await discardStoredObjects(supersededKeys);

  await recordBusinessAccountAudit(
    "BUSINESS_ACCOUNT_UPDATED",
    account,
    userId,
    diffSnapshots(auditSnapshotBefore, toAuditSnapshot(account))
  );
  if (gstBillingUpdate.changed) {
    await recordBusinessAccountAudit("BUSINESS_ACCOUNT_GST_BILLING_REQUESTED", account, userId, {
      "gstBilling.requestedTreatment": { from: gstBillingBefore.requestedTreatment, to: account.gstBilling.requestedTreatment },
      "gstBilling.status": { from: gstBillingBefore.status, to: account.gstBilling.status }
    });
  }

  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);

  // This handler loaded `account` with the encrypted tax ID selected in so an
  // untouched masked field could be written back. It must not travel to a
  // client on the fallback path, even as ciphertext; the refetched copy leaves
  // it out already because the field is `select: false`.
  account.set("company.registrationIdEncrypted", undefined);

  return response.status(200).json({ success: true, account: updatedAccount ?? account });
}

export async function submitBusinessAccount(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });
  if (account.status !== "draft") {
    return response.status(409).json({ success: false, message: "Only draft accounts can be submitted" });
  }

  // Drafts are stored against a relaxed schema, so this is the first point the
  // full rules are applied. Without it, saving as a draft would be a route around
  // every onboarding requirement.
  // The form payload and stored account deliberately use different shapes for
  // billing and credit. Convert the stored values back to the form contract
  // before re-validating the draft: a reused company address is stored as null,
  // while credit is stored as { currency, amount }.
  const completeness = businessAccountBodySchema.safeParse({
    contact: account.contact,
    company: {
      ...account.company,
      billingAddress: account.company.billingAddress ?? undefined,
      requestedCreditCurrency: account.company.requestedCreditLimit.currency,
      requestedCreditLimit: account.company.requestedCreditLimit.amount
    },
    gstBilling: {
      requestedTreatment: account.gstBilling?.requestedTreatment ?? "GST_APPLICABLE",
      requestReason: account.gstBilling?.requestReason ?? ""
    }
  });
  if (!completeness.success) {
    return response.status(400).json({
      success: false,
      message: "Complete every required field before submitting this account for review.",
      errors: completeness.error.format()
    });
  }

  const requirementError = getDocumentRequirementError(account.documents ?? {});
  if (requirementError) {
    return response.status(400).json({ success: false, message: requirementError });
  }

  account.status = "pending_review";
  account.submittedAt = new Date();
  account.updatedBy = userId;
  account.kycReview = applyDerivedKycStatus(account);
  await account.save();

  await recordBusinessAccountAudit("BUSINESS_ACCOUNT_SUBMITTED", account, userId);

  await notifyActiveAdmins({
    type: "BUSINESS_ACCOUNT_SUBMITTED",
    title: "Business account submitted for review",
    message: `${account.company.companyName || account.accountId} submitted its onboarding documents for KYC review.`,
    href: `/dashboard/business-accounts/${account.accountId}#kyc`,
    idempotencyKey: `BUSINESS_ACCOUNT_SUBMITTED:${String(account._id)}:${account.submittedAt.getTime()}`,
    businessAccountId: account._id as mongoose.Types.ObjectId,
    metadata: { accountId: account.accountId }
  });

  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);

  return response.status(200).json({
    success: true,
    message: "Business account created successfully and submitted for review.",
    account: updatedAccount
  });
}

export async function updateBusinessAccountStatus(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = businessAccountStatusSchema.safeParse((request.body as { status?: unknown }).status);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid business account status" });
  }

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const currentStatus = account.status;
  const targetStatus = parsed.data;

  // Enforce the lifecycle state machine. Re-applying the current status is a
  // harmless no-op; any transition not defined in the map is rejected.
  if (targetStatus !== currentStatus && !businessAccountStatusTransitions[currentStatus].includes(targetStatus)) {
    return response.status(409).json({
      success: false,
      message: `Cannot change status from ${formatStatusLabel(currentStatus)} to ${formatStatusLabel(targetStatus)}.`
    });
  }

  // Approval and activation require a fully verified KYC review.
  if (
    targetStatus !== currentStatus
    && kycGatedStatuses.includes(targetStatus)
    && account.kycReview?.overallStatus !== "verified"
  ) {
    return response.status(409).json({
      success: false,
      message: "KYC must be verified before the account can be approved or activated."
    });
  }

  if (targetStatus === "pending_review" && !account.submittedAt) {
    const requirementError = getDocumentRequirementError(account.documents ?? {});
    if (requirementError) {
      return response.status(400).json({ success: false, message: requirementError });
    }

    account.submittedAt = new Date();
  }

  account.status = targetStatus;
  account.updatedBy = userId;
  account.kycReview = applyDerivedKycStatus(account);
  await account.save();

  if (targetStatus !== currentStatus) {
    await recordBusinessAccountAudit("BUSINESS_ACCOUNT_STATUS_CHANGED", account, userId, {
      status: { from: currentStatus, to: targetStatus }
    });
  }

  // Only lifecycle decisions the client can act on are worth a notification;
  // moving an account back to draft or into review is internal housekeeping.
  if (targetStatus !== currentStatus && clientVisibleStatusNotices[targetStatus]) {
    const notice = clientVisibleStatusNotices[targetStatus];
    await notifyBusinessAccountManagers(account._id as mongoose.Types.ObjectId, {
      type: "BUSINESS_ACCOUNT_STATUS_CHANGED",
      title: notice.title,
      message: notice.message,
      href: "/client/dashboard#business-accounts",
      idempotencyKey: `BUSINESS_ACCOUNT_STATUS:${String(account._id)}:${targetStatus}:${account.updatedAt.getTime()}`,
      metadata: { accountId: account.accountId, fromStatus: currentStatus, toStatus: targetStatus }
    });
    // Public self-serve accounts have no portal members yet; still email the applicant on decision.
    if (account.origin === "PUBLIC" && account.contact?.email) {
      const { enqueueEmails } = await import("../services/email/enqueue.js");
      const applicantName = `${account.contact.firstName ?? ""} ${account.contact.lastName ?? ""}`.trim() || account.contact.email;
      await enqueueEmails({
        notificationType: "BUSINESS_ACCOUNT_STATUS_CHANGED",
        idempotencyKey: `BUSINESS_ACCOUNT_STATUS:${String(account._id)}:${targetStatus}:${account.updatedAt.getTime()}:applicant`,
        recipients: [{ email: account.contact.email.toLowerCase(), name: applicantName, userId: null }],
        businessAccountId: account._id as mongoose.Types.ObjectId,
        subject: notice.title,
        payload: { title: notice.title, message: notice.message, href: "/request/business-account", accountId: account.accountId }
      }).catch(() => undefined);
    }
  }

  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);

  return response.status(200).json({
    success: true,
    message: statusActionMessages[parsed.data],
    account: updatedAccount
  });
}

export async function updateBusinessAccountOperationalAction(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = businessAccountOperationalActionSchema.safeParse((request.body as { action?: unknown }).action);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid business account operational action" });
  }

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  // Operational actions update their own row/field. They must not overwrite
  // account lifecycle status such as approved, active, suspended, or rejected.
  if (parsed.data === "deposit_required") {
    account.depositStatus = "required";
  } else if (parsed.data === "deposit_received") {
    account.depositStatus = "received";
  } else if (parsed.data === "ledger_viewed") {
    account.ledgerViewedAt = new Date();
  }

  account.updatedBy = userId;
  await account.save();

  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);

  return response.status(200).json({
    success: true,
    message: operationalActionMessages[parsed.data],
    account: updatedAccount
  });
}

export async function assignBusinessAccountBranch(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = assignBranchBodySchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const branchId = new mongoose.Types.ObjectId((parsed.data as AssignBranchBody).branchId);
  const branch = await Branch.findOne({ _id: branchId, status: "ACTIVE" }).select("_id").lean().exec();
  if (!branch) return response.status(404).json({ success: false, message: "Active branch not found" });

  // Branch assignment is an operational field. It must not change lifecycle
  // status, otherwise approved accounts become impossible to use downstream.
  account.assignedBranch = branchId;
  account.updatedBy = userId;
  await account.save();

  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);

  return response.status(200).json({
    success: true,
    message: "Branch assigned successfully.",
    account: updatedAccount
  });
}

export async function assignBusinessAccountRateCard(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = assignRateCardBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Select a valid rate card."
    });
  }

  const account = await BusinessAccount.findOne({
    accountId: request.params.accountId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const nextBand = parsed.data.rateCardBand;
  if (nextBand) {
    const hasRates = await CountryRateCard.exists({ band: nextBand }).exec();
    if (!hasRates) {
      return response.status(409).json({
        success: false,
        code: "RATE_CARD_EMPTY",
        message: "Add at least one valid rate to this card before assigning it."
      });
    }
  }

  const previousBand = account.rateCardBand ?? null;
  if (previousBand !== parsed.data.expectedRateCardBand) {
    return response.status(409).json({
      success: false,
      code: "RATE_CARD_ASSIGNMENT_CHANGED",
      message: "This account's rate card changed while you were editing. Refresh and try again."
    });
  }

  const updated = await BusinessAccount.findOneAndUpdate(
    {
      _id: account._id,
      rateCardBand: parsed.data.expectedRateCardBand
    },
    {
      $set: {
        rateCardBand: nextBand,
        updatedBy: userId
      }
    },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) {
    return response.status(409).json({
      success: false,
      code: "RATE_CARD_ASSIGNMENT_CHANGED",
      message: "This account's rate card changed while you were editing. Refresh and try again."
    });
  }

  await AuditLog.create({
    action: "BUSINESS_ACCOUNT_RATE_CARD_ASSIGNED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: updated._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      previousRateCardBand: previousBand,
      rateCardBand: nextBand,
      reason: parsed.data.reason
    }
  });

  const updatedAccount = await getPopulatedBusinessAccount(updated.accountId);
  const configuredRoutes = await CountryRateCard.find({})
    .select("band countryCode service")
    .lean()
    .exec();
  const allRoutes = new Set(configuredRoutes.map((rate) => `${rate.countryCode}:${rate.service}`));
  const selectedRoutes = new Set(
    configuredRoutes
      .filter((rate) => rate.band === nextBand)
      .map((rate) => `${rate.countryCode}:${rate.service}`)
  );
  const missingRouteCount = nextBand
    ? [...allRoutes].filter((route) => !selectedRoutes.has(route)).length
    : 0;
  const coverageWarning = missingRouteCount
    ? `This card has no configured slabs for ${missingRouteCount} route(s) available in other bands. Those routes will remain blocked.`
    : null;

  return response.status(200).json({
    success: true,
    message: nextBand
      ? "Rate card assigned successfully. New and ongoing pricing will use it."
      : "Rate card removed. New estimates, quotes and bookings are now paused.",
    coverageWarning,
    account: updatedAccount
  });
}

export async function listBusinessAccountRateCardHistory(request: Request, response: Response): Promise<Response> {
  const account = await BusinessAccount.findOne({
    accountId: request.params.accountId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  }).select("_id").lean().exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const history = await AuditLog.find({
    action: "BUSINESS_ACCOUNT_RATE_CARD_ASSIGNED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: account._id
  })
    .populate("performedBy", "firstName lastName email")
    .sort({ performedAt: -1 })
    .limit(100)
    .lean()
    .exec();

  return response.status(200).json({
    success: true,
    history: history.map((entry) => {
      const performer = entry.performedBy as unknown as {
        firstName?: string;
        lastName?: string;
        email?: string;
      } | null;
      return {
        id: String(entry._id),
        previousRateCardBand: entry.metadata.previousRateCardBand ?? null,
        rateCardBand: entry.metadata.rateCardBand ?? null,
        reason: String(entry.metadata.reason ?? ""),
        performedAt: entry.performedAt,
        performedBy: {
          name: [performer?.firstName, performer?.lastName].filter(Boolean).join(" "),
          email: performer?.email ?? ""
        }
      };
    })
  });
}

export async function viewBusinessAccountDocument(request: Request, response: Response): Promise<void | Response> {
  const parsed = documentTypeSchema.safeParse(request.params.documentType);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid document type" });
  }

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).lean().exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const document = account.documents?.[parsed.data];
  if (!document) return response.status(404).json({ success: false, message: "Document not found" });

  // Streamed rather than handed out as a signed URL: KYC documents carry
  // Aadhaar, PAN, and tax identifiers, and a signed URL stays readable by
  // whoever holds it for its whole lifetime, wherever it is forwarded.
  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: document.mimeType,
      filename: document.originalName,
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Document file is no longer available" });
    }
    throw error;
  }
}

export async function updateBusinessAccountKycReview(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = businessKycReviewBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  let reviewedAccount: IBusinessAccount | null = null;
  try {
    const nextReview = applyKycReviewUpdate(account.kycReview, parsed.data, userId);
    nextReview.overallStatus = deriveKycOverallStatus(account.documents ?? {}, nextReview, {
      gstExempt: account.company?.gstExempt
    });
    nextReview.reviewedAt = resolveKycReviewedAt(account.kycReview?.overallStatus, account.kycReview?.reviewedAt, nextReview.overallStatus);

    // Optimistic concurrency: apply only if the document is unchanged since it was
    // read, so two reviewers editing the same account cannot silently overwrite
    // one another. A version mismatch means someone else saved first.
    const expectedVersion = account.get("__v") as number;
    const updated = await BusinessAccount.findOneAndUpdate(
      { _id: account._id, __v: expectedVersion },
      { $set: { kycReview: nextReview, updatedBy: userId }, $inc: { __v: 1 } },
      { new: true }
    ).exec();

    if (!updated) {
      return response.status(409).json({
        success: false,
        message: "This KYC review was just updated by someone else. Reload and try again."
      });
    }

    // Only a settled outcome is worth telling the client about- intermediate
    // per-document edits would otherwise generate noise on every save.
    if (
      nextReview.overallStatus !== account.kycReview?.overallStatus
      && ["verified", "rejected"].includes(nextReview.overallStatus)
    ) {
      reviewedAccount = updated;
    }
  } catch (error) {
    console.error("KYC review update failed:", error);
    return response.status(400).json({
      success: false,
      message: error instanceof Error ? error.message : "Unable to update KYC review"
    });
  }

  if (reviewedAccount) {
    const verified = reviewedAccount.kycReview.overallStatus === "verified";
    await notifyBusinessAccountManagers(reviewedAccount._id as mongoose.Types.ObjectId, {
      type: "BUSINESS_ACCOUNT_KYC_REVIEWED",
      title: verified ? "KYC verified" : "KYC rejected",
      message: verified
        ? "Your KYC documents have been verified by Swiftline."
        : "One or more KYC documents were rejected. Re-upload the corrected documents to continue.",
      href: "/client/dashboard#business-accounts",
      idempotencyKey: `BUSINESS_ACCOUNT_KYC:${String(reviewedAccount._id)}:${reviewedAccount.kycReview.overallStatus}:${reviewedAccount.updatedAt.getTime()}`,
      metadata: { accountId: reviewedAccount.accountId, overallStatus: reviewedAccount.kycReview.overallStatus }
    });
  }

  // Return the populated snapshot (matching the other endpoints) so the client
  // keeps a fully-shaped account- notably a populated assignedBranch, which the
  // Users & Access panel depends on to unlock client-login creation.
  const updatedAccount = await getPopulatedBusinessAccount(account.accountId);
  return response.status(200).json({
    success: true,
    account: updatedAccount ?? account,
    kycReview: (updatedAccount ?? account).kycReview
  });
}

export async function updateBusinessAccountGstBillingReview(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = gstBillingReviewBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  const current = account.gstBilling ?? normalGstBilling();
  if (account.status === "draft" && parsed.data.decision !== "REVOKE") {
    return response.status(409).json({
      success: false,
      message: "Submit the business account and its Aadhaar/PAN documents before reviewing the no-GST request."
    });
  }
  if (current.version !== parsed.data.expectedVersion) {
    return response.status(409).json({
      success: false,
      message: "This GST billing request was just updated by someone else. Reload and try again."
    });
  }

  const allowed = (parsed.data.decision === "APPROVE" || parsed.data.decision === "REJECT")
    ? current.status === "PENDING"
    : current.status === "APPROVED";
  if (!allowed) {
    return response.status(409).json({
      success: false,
      message: parsed.data.decision === "REVOKE"
        ? "Only an approved no-GST permission can be revoked."
        : "Only a pending no-GST request can be approved or rejected."
    });
  }

  const now = new Date();
  const nextStatus = parsed.data.decision === "APPROVE"
    ? "APPROVED"
    : parsed.data.decision === "REJECT" ? "REJECTED" : "REVOKED";
  // `current` is a Mongoose single-nested document at runtime. Do not spread it:
  // doing so copies Mongoose's internal `_doc`, and casting a whole-subdocument
  // update can then silently prefer that stale snapshot over the review fields.
  const next: IBusinessGstBilling = {
    requestedTreatment: current.requestedTreatment,
    status: nextStatus,
    requestReason: current.requestReason,
    requestedAt: current.requestedAt ?? null,
    requestedBy: current.requestedBy ?? null,
    reviewedAt: now,
    reviewedBy: userId,
    decisionReason: parsed.data.reason,
    effectiveFrom: parsed.data.decision === "APPROVE" ? now : current.effectiveFrom ?? null,
    effectiveUntil: parsed.data.decision === "REVOKE" ? now : null,
    version: current.version + 1
  };

  const updated = await BusinessAccount.findOneAndUpdate(
    { _id: account._id, "gstBilling.version": parsed.data.expectedVersion },
    {
      $set: {
        "gstBilling.status": next.status,
        "gstBilling.reviewedAt": next.reviewedAt,
        "gstBilling.reviewedBy": next.reviewedBy,
        "gstBilling.decisionReason": next.decisionReason,
        "gstBilling.effectiveFrom": next.effectiveFrom,
        "gstBilling.effectiveUntil": next.effectiveUntil,
        "gstBilling.version": next.version,
        updatedBy: userId
      }
    },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) {
    return response.status(409).json({
      success: false,
      message: "This GST billing request was just updated by someone else. Reload and try again."
    });
  }
  if (updated.gstBilling.status !== next.status || updated.gstBilling.version !== next.version) {
    return response.status(500).json({
      success: false,
      message: "GST billing review could not be persisted. Reload the account and try again."
    });
  }

  await recordBusinessAccountAudit("BUSINESS_ACCOUNT_GST_BILLING_REVIEWED", updated, userId, {
    "gstBilling.status": { from: current.status, to: next.status },
    "gstBilling.version": { from: current.version, to: next.version }
  });

  await notifyBusinessAccountManagers(updated._id as mongoose.Types.ObjectId, {
    type: "BUSINESS_ACCOUNT_GST_BILLING_REVIEWED",
    title: next.status === "APPROVED" ? "No-GST billing approved" : next.status === "REJECTED" ? "No-GST billing rejected" : "No-GST billing revoked",
    message: next.status === "APPROVED"
      ? "Future shipments can now be booked without GST unless Apply GST is selected during booking."
      : "Future shipments will use normal GST billing.",
    href: "/client/dashboard#business-accounts",
    idempotencyKey: `BUSINESS_ACCOUNT_GST_BILLING:${String(updated._id)}:${next.version}`,
    metadata: { accountId: updated.accountId, status: next.status }
  });

  const populated = await getPopulatedBusinessAccount(updated.accountId);
  return response.status(200).json({ success: true, account: populated ?? updated });
}

/**
 * Removes a business account that was never submitted for review.
 *
 * Hard delete, unlike shipment drafts: a draft account has no branch, no
 * members, no credit, and no shipments- nothing downstream can reference it,
 * and the checks below refuse the delete if anything does. Its uploaded KYC
 * documents go with it, since holding identity documents for an abandoned
 * application is exactly what should not happen.
 */
export async function deleteBusinessAccountDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const account = await BusinessAccount.findOne({ accountId: request.params.accountId }).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found" });

  if (account.status !== "draft") {
    return response.status(409).json({
      success: false,
      message: "Only draft accounts can be deleted. Reject or suspend this account instead."
    });
  }

  const [members, shipments] = await Promise.all([
    BusinessAccountMember.countDocuments({
      businessAccount: account._id,
      status: { $ne: "removed" }
    }).exec(),
    ShipmentDraft.countDocuments({ businessAccountId: account._id, deletedAt: null }).exec()
  ]);

  if (members || shipments) {
    return response.status(409).json({
      success: false,
      message: "This account already has users or shipments and cannot be deleted."
    });
  }

  // Audited before the record goes, so the log can describe what was removed.
  await recordBusinessAccountAudit("BUSINESS_ACCOUNT_DRAFT_DELETED", account, userId);

  // Best effort: a document that cannot be removed from storage must not leave
  // the account stranded in draft forever.
  await discardStoredObjects(
    Object.values(account.documents ?? {})
      .map((document: IBusinessDocument | undefined) => document?.storageKey)
      .filter((key): key is string => Boolean(key))
  );

  await account.deleteOne();

  return response.status(200).json({ success: true, message: "Business account draft deleted." });
}
