import type { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import crypto from "crypto";
import { BusinessAccount, businessAccountStatuses } from "../models/businessAccount.model.js";
import { PublicBusinessAccountOtp } from "../models/publicBusinessAccountOtp.model.js";
import { isRecaptchaEnabled, verifyRecaptcha } from "../services/recaptcha.service.js";
import { sendBusinessAccountOtpEmail } from "../services/mail.service.js";
import { BusinessAccount as BusinessAccountModel } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { isSupportedDocument } from "../services/storage/fileSignature.js";
import {
  businessAccountKycKey,
  deleteObject,
  putObject
} from "../services/storage/storage.service.js";
import { notifyActiveAdmins, notifyOperationsStaff } from "../services/portalNotification.service.js";
import { enqueueEmails } from "../services/email/enqueue.js";
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
import { recordBusinessAccountAudit, toAuditSnapshot } from "../services/businessAccountAudit.service.js";
import { isValidStateForCountry } from "../services/reference/geography.service.js";
import { getCountryCodeByName } from "../services/reference/portalCountries.js";
import { getSwiftlineTenantId } from "../services/swiftlineTenant.service.js";

// Reuse same OTP constants as auth.controller but public-specific
const PUBLIC_OTP_TTL_MS = 10 * 60 * 1000;
const PUBLIC_OTP_RESEND_INTERVAL_MS = 60 * 1000;
const PUBLIC_OTP_MAX_ATTEMPTS = 5;
const PUBLIC_VERIFICATION_TTL_MS = 30 * 60 * 1000;

// Strict captcha for public - fail-closed when secret configured
async function verifyPublicRecaptcha(token: string | undefined, remoteIp?: string): Promise<boolean> {
  // import env lazily to avoid circular
  const { env } = await import("../config/env.js");
  if (!isRecaptchaEnabled() || !env.RECAPTCHA_SECRET_KEY) return true;
  if (!token) return false;
  return verifyRecaptcha(token, remoteIp);
}

function hashPublicOtp(email: string, code: string) {
  return crypto.createHash("sha256").update(`${email.toLowerCase()}:${code}`).digest("hex");
}

function generatePublicOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function loginOtpMatches(email: string, code: string, storedHash: string) {
  try {
    const provided = Buffer.from(hashPublicOtp(email, code), "hex");
    const stored = Buffer.from(storedHash, "hex");
    return provided.length === stored.length && crypto.timingSafeEqual(provided, stored);
  } catch {
    return false;
  }
}

// Shared zod schemas - copied from businessAccount.controller for parity
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
type DocumentType = z.infer<typeof documentTypeSchema>;
const nullableCreditLimitSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.coerce.number().nonnegative().max(BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX, `Requested credit limit cannot exceed ${BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}.`).nullable().optional()
);
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
    }).optional().default({ addressLine1: "", addressLine2: "", city: "", stateOrProvince: "", postalCode: "", country: "" }),
    operatingCountries: z.array(z.string().trim().min(1).max(80)).default([]),
    website: z.string().trim().url().refine(isHttpOrHttpsUrl, "Website must start with http:// or https://").optional().or(z.literal("")).or(z.null()),
    industry: z.string().trim().max(100).optional().default(""),
    monthlyShipmentVolume: z.string().trim().max(80).optional().default(""),
    requestedCreditCurrency: z.string().trim().min(3).max(3).default("INR"),
    requestedCreditLimit: nullableCreditLimitSchema
  })
}).superRefine((data, context) => {
  if (!isValidPhoneForCountryCode(data.contact.countryCode, data.contact.mobileNumber)) {
    context.addIssue({ code: "custom", path: ["contact", "mobileNumber"], message: phoneValidationMessage });
  }
  const registrationId = data.company.registrationId.trim();
  const secondaryRegistrationId = data.company.secondaryRegistrationId.trim();
  const noCompany = data.company.noCompany;
  const allowsSkippingRegistration = data.company.registrationCountry !== "United States";
  const canSkipRegistration = countriesWithoutRegistrationId.has(data.company.registrationCountry)
    || (allowsSkippingRegistration && (noCompany || data.company.noCompanyRegistration));

  if (!noCompany && !data.company.companyType.trim()) {
    context.addIssue({ code: "custom", path: ["company", "companyType"], message: "Company type is required" });
  }
  if (!canSkipRegistration && !registrationId) {
    context.addIssue({ code: "custom", path: ["company", "registrationId"], message: "Registration ID is required for the selected country." });
  }
  const primaryRegistrationError = getPrimaryRegistrationError(data.company.registrationCountry, registrationId, data.company.registrationIdType);
  if (!canSkipRegistration && primaryRegistrationError) {
    context.addIssue({ code: "custom", path: ["company", "registrationId"], message: primaryRegistrationError });
  }
  if (!canSkipRegistration && countriesWithSecondaryRegistrationId.has(data.company.registrationCountry) && !secondaryRegistrationId) {
    context.addIssue({ code: "custom", path: ["company", "secondaryRegistrationId"], message: "Additional registration code is required for the selected country." });
  }
  const secondaryRegistrationError = getSecondaryRegistrationError(data.company.registrationCountry, secondaryRegistrationId);
  if (!canSkipRegistration && secondaryRegistrationError) {
    context.addIssue({ code: "custom", path: ["company", "secondaryRegistrationId"], message: secondaryRegistrationError });
  }
  const gstin = normalizeGstin(data.company.gstin);
  const gstExempt = data.company.gstExempt;
  const collectsGst = collectsGstin({ registrationCountry: data.company.registrationCountry, noCompany });
  if (collectsGst && gstExempt) {
    const reason = data.company.gstExemptReason.trim();
    if (reason.length < GST_EXEMPT_REASON_MIN) {
      context.addIssue({ code: "custom", path: ["company", "gstExemptReason"], message: `Explain why this business is not registered under GST, in at least ${GST_EXEMPT_REASON_MIN} characters.` });
    }
    if (gstin) {
      context.addIssue({ code: "custom", path: ["company", "gstin"], message: "Remove the GSTIN or untick GST exempt. An account cannot be both registered and exempt." });
    }
  }
  if (requiresGstin({ registrationCountry: data.company.registrationCountry, noCompany, gstExempt }) && !gstin) {
    context.addIssue({ code: "custom", path: ["company", "gstin"], message: "GSTIN is required for Indian business accounts. Tick GST exempt if the business is not registered under GST." });
  }
  const gstinError = collectsGst ? getGstinError(gstin) : "";
  if (gstinError) {
    context.addIssue({ code: "custom", path: ["company", "gstin"], message: gstinError });
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
        context.addIssue({ code: "custom", path: ["company", field], message });
      }
    }
    if (!data.company.operatingCountries.length) {
      context.addIssue({ code: "custom", path: ["company", "operatingCountries"], message: "Select at least one operating country" });
    }
    if (
      data.company.postalCode.trim()
      && data.company.addressCountry.trim()
      && !isValidPostalCodeForCountry(data.company.addressCountry, data.company.postalCode)
    ) {
      context.addIssue({ code: "custom", path: ["company", "postalCode"], message: getPostalCodeValidationMessage(data.company.addressCountry) });
    }
    const stateCountryCode = getCountryCodeByName(data.company.addressCountry);
    if (
      stateCountryCode
      && data.company.stateOrProvince.trim()
      && !isValidStateForCountry(stateCountryCode, data.company.stateOrProvince)
    ) {
      context.addIssue({ code: "custom", path: ["company", "stateOrProvince"], message: `Select a valid state or province for ${data.company.addressCountry}.` });
    }
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
        context.addIssue({ code: "custom", path: ["company", "billingAddress", "postalCode"], message: getPostalCodeValidationMessage(billing.country) });
      }
      const billingCountryCode = getCountryCodeByName(billing.country);
      if (billingCountryCode && billing.stateOrProvince.trim() && !isValidStateForCountry(billingCountryCode, billing.stateOrProvince)) {
        context.addIssue({ code: "custom", path: ["company", "billingAddress", "stateOrProvince"], message: `Select a valid state or province for ${billing.country}.` });
      }
    }
  }
});

type BusinessAccountBody = z.infer<typeof businessAccountBodySchema>;

const requestPublicOtpSchema = z.object({
  email: z.string().trim().email().toLowerCase().refine(isValidBusinessContactEmail, emailValidationMessage),
  recaptchaToken: z.string().optional()
});
const verifyPublicOtpSchema = z.object({
  email: z.string().trim().email().toLowerCase().refine(isValidBusinessContactEmail, emailValidationMessage),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit verification code"),
  recaptchaToken: z.string().optional()
});

// helpers reused
function parseJsonField(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function parseBusinessAccountBody(request: Request) {
  const body = request.body as Record<string, unknown>;
  const payload = {
    contact: parseJsonField(body.contact),
    company: parseJsonField(body.company)
  };
  return businessAccountBodySchema.safeParse(payload);
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
function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === 11000;
}
function findInvalidDocumentSignature(files: Partial<Record<DocumentType, Express.Multer.File>>): DocumentType | null {
  for (const [type, file] of Object.entries(files) as [DocumentType, Express.Multer.File | undefined][]) {
    if (file && !isSupportedDocument(file.buffer)) return type;
  }
  return null;
}
async function discardStoredObjects(keys: string[]) {
  await Promise.all(keys.map((key) => deleteObject(key).catch(() => undefined)));
}
async function storeBusinessDocument(type: DocumentType, file: Express.Multer.File, businessAccountId: string) {
  const storageKey = businessAccountKycKey(businessAccountId, file.originalname);
  await putObject({ key: storageKey, body: file.buffer, contentType: file.mimetype, originalName: file.originalname });
  return { type, originalName: file.originalname, storageKey, mimeType: file.mimetype, size: file.size, uploadedAt: new Date() };
}
async function attachUploadedDocuments(documents: Partial<Record<DocumentType, any>>, files: Partial<Record<DocumentType, Express.Multer.File>>, businessAccountId: string): Promise<{ supersededKeys: string[]; storedKeys: string[] }> {
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
function resolveRegistrationIdStorage(company: BusinessAccountBody["company"], existingEncrypted = ""): { registrationId: string; registrationIdEncrypted: string } {
  if (company.registrationCountry !== "United States") {
    return { registrationId: compactRegistrationId(company.registrationId), registrationIdEncrypted: "" };
  }
  const taxIdType = isUsTaxIdType(company.registrationIdType) ? company.registrationIdType : "ein";
  if (!isSensitiveUsTaxIdType(taxIdType)) {
    return { registrationId: formatUsTaxId(company.registrationId, taxIdType), registrationIdEncrypted: "" };
  }
  if (isMaskedUsTaxId(company.registrationId)) {
    return { registrationId: company.registrationId, registrationIdEncrypted: existingEncrypted };
  }
  const digits = normalizeUsTaxId(company.registrationId);
  if (!digits) return { registrationId: "", registrationIdEncrypted: "" };
  return { registrationId: maskUsTaxId(digits, taxIdType), registrationIdEncrypted: encryptSecret(digits, "taxId") };
}
function buildAccountPayload(data: BusinessAccountBody, existingEncryptedRegistrationId = "") {
  const keepsGst = collectsGstin({ registrationCountry: data.company.registrationCountry, noCompany: data.company.noCompany });
  const registrationStorage = resolveRegistrationIdStorage(data.company, existingEncryptedRegistrationId);
  return {
    contact: data.contact,
    company: {
      registrationCountry: data.company.registrationCountry,
      registrationIdType: data.company.registrationIdType,
      registrationId: registrationStorage.registrationId,
      registrationIdEncrypted: registrationStorage.registrationIdEncrypted,
      registrationIdKey: registrationStorage.registrationIdEncrypted ? "" : compactRegistrationId(registrationStorage.registrationId),
      gstin: keepsGst ? normalizeGstin(data.company.gstin) : "",
      gstExempt: keepsGst ? data.company.gstExempt : false,
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
      billingAddress: data.company.useCompanyAddressAsBillingAddress ? null : data.company.billingAddress,
      operatingCountries: data.company.operatingCountries,
      website: data.company.website || null,
      industry: data.company.industry,
      monthlyShipmentVolume: data.company.monthlyShipmentVolume,
      requestedCreditLimit: { currency: data.company.requestedCreditCurrency, amount: data.company.requestedCreditLimit ?? null }
    }
  };
}
function normalGstBilling(version = 1): any {
  return { requestedTreatment: "GST_APPLICABLE", status: "NOT_REQUIRED", requestReason: "", requestedAt: null, requestedBy: null, reviewedAt: null, reviewedBy: null, decisionReason: "", effectiveFrom: null, effectiveUntil: null, version };
}
function generateAccountId(): string {
  const year = new Date().getFullYear();
  const sequence = Math.floor(100000 + Math.random() * 900000);
  return `BA-${year}-${sequence}`;
}
async function createBusinessAccountRecord(basePayload: Record<string, unknown>) {
  const tenantId = await getSwiftlineTenantId();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await BusinessAccount.create({ tenantId, accountId: generateAccountId(), ...basePayload }); }
    catch (error) {
      const collidedOnAccountId = isDuplicateKeyError(error) && Boolean((error as { keyPattern?: Record<string, unknown> }).keyPattern?.accountId);
      if (collidedOnAccountId) continue;
      throw error;
    }
  }
  throw new Error("Unable to generate a unique business account ID");
}
async function hasDuplicateBusinessIdentity(data: BusinessAccountBody, accountIdToExclude?: string): Promise<string | null> {
  const isSensitiveTaxId = data.company.registrationCountry === "United States" && isUsTaxIdType(data.company.registrationIdType) && isSensitiveUsTaxIdType(data.company.registrationIdType);
  const normalizedRegistrationId = isSensitiveTaxId ? "" : compactRegistrationId(data.company.registrationId);
  const identityChecks: Record<string, string>[] = [
    { "contact.email": data.contact.email },
    { "contact.countryCode": data.contact.countryCode, "contact.mobileNumber": data.contact.mobileNumber }
  ];
  if (normalizedRegistrationId) identityChecks.push({ "company.registrationId": normalizedRegistrationId });
  const liveFilter = { status: { $in: businessAccountStatuses.filter((s) => s !== "rejected") } };
  const duplicate = await BusinessAccount.findOne({ ...liveFilter, _id: accountIdToExclude ? { $ne: accountIdToExclude } : { $exists: true }, $or: identityChecks }).select("contact.email contact.countryCode contact.mobileNumber company.registrationId status").lean().exec();
  if (!duplicate) return null;
  if (duplicate.contact.email === data.contact.email) return "Email address already exists";
  if (duplicate.contact.countryCode === data.contact.countryCode && duplicate.contact.mobileNumber === data.contact.mobileNumber) return "Mobile number already exists";
  if (normalizedRegistrationId && duplicate.company.registrationId === normalizedRegistrationId) return "Company registration ID already exists";
  return null;
}
export function getDocumentRequirementError(documents: Partial<Record<DocumentType, any>>): string | null {
  if (!documents.aadhaarCard) return "Aadhaar Card is required";
  if (!documents.panCard) return "PAN Card Copy is required";
  return null;
}
function deriveKycOverallStatus(documents: Partial<Record<DocumentType, any>>, review: any, options: { gstExempt?: boolean } = {}) {
  const missing: string[] = [];
  if (!documents.aadhaarCard) missing.push("aadhaarCard");
  if (!documents.panCard) missing.push("panCard");
  if (missing.length) return "documents_pending";
  if (review.finalDecision === "rejected") return "rejected";
  // simplified: if documents present and not rejected, treat as submitted
  return "submitted";
}
function getDefaultKycReview(): any {
  return { overallStatus: "documents_pending", checks: {}, finalDecision: null, reviewStartedAt: null, reviewedAt: null, reviewedBy: null };
}
function applyDerivedKycStatus(account: { documents?: any; kycReview?: any; company?: any }) {
  const review = { ...getDefaultKycReview(), ...(account.kycReview ?? {}) , checks: { ...(account.kycReview?.checks ?? {}) } };
  review.overallStatus = deriveKycOverallStatus(account.documents ?? {}, review, { gstExempt: account.company?.gstExempt });
  return review;
}
async function getPopulatedBusinessAccount(accountId: string) {
  const account = await BusinessAccount.findOne({ accountId }).populate("createdBy", "email name").populate("assignedBranch", "name code status").lean().exec();
  if (!account) return null;
  // normalize minimal
  if ((account as any).status === "branch_assigned") (account as any).status = "approved";
  (account as any).creditLimitStatus = (account as any).creditLimitStatus ?? "not_reviewed";
  (account as any).depositStatus = (account as any).depositStatus ?? "not_required";
  (account as any).agreementStatus = (account as any).agreementStatus ?? "not_generated";
  (account as any).gstBilling = (account as any).gstBilling ?? normalGstBilling();
  return account;
}

// Handlers
export async function requestPublicBusinessAccountEmailOtp(request: Request, response: Response): Promise<Response> {
  const parsed = requestPublicOtpSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });
  const email = parsed.data.email.toLowerCase();
  const recaptchaToken = parsed.data.recaptchaToken;
  const { env } = await import("../config/env.js");
  if (isRecaptchaEnabled() && env.RECAPTCHA_SECRET_KEY) {
    if (!recaptchaToken) return response.status(400).json({ success: false, message: "Captcha verification is required. Please complete the captcha." });
    const ok = await verifyRecaptcha(recaptchaToken, request.ip);
    if (!ok) return response.status(400).json({ success: false, message: "Captcha verification failed. Please try again." });
  }
  // Hard block if email already owns a live business account - don't send code, don't leak via OTP
  const liveExists = await BusinessAccount.exists({
    "contact.email": email,
    status: { $in: businessAccountStatuses.filter((s) => s !== "rejected") }
  });
  if (liveExists) {
    return response.status(409).json({ success: false, message: "Email address already exists" });
  }
  let record = await PublicBusinessAccountOtp.findOne({ email }).exec();
  const now = Date.now();
  if (record?.otpSentAt && now - record.otpSentAt.getTime() < PUBLIC_OTP_RESEND_INTERVAL_MS) {
    return response.status(200).json({ success: true, message: "Verification code sent if the email is valid.", expiresInSeconds: PUBLIC_OTP_TTL_MS / 1000, resendInSeconds: PUBLIC_OTP_RESEND_INTERVAL_MS / 1000 });
  }
  const code = generatePublicOtp();
  const expiresAt = new Date(now + PUBLIC_OTP_TTL_MS);
  const otpHash = hashPublicOtp(email, code);
  if (!record) {
    record = new PublicBusinessAccountOtp({ email, otpHash, otpExpiresAt: expiresAt, otpAttempts: 0, otpSentAt: new Date(), verifiedAt: null, verificationToken: null, verificationExpiresAt: null });
  } else {
    record.otpHash = otpHash;
    record.otpExpiresAt = expiresAt;
    record.otpAttempts = 0;
    record.otpSentAt = new Date();
    // keep verifiedAt/token until re-verified? clear verification on new code
    record.verifiedAt = null;
    record.verificationToken = null;
    record.verificationExpiresAt = null;
  }
  await record.save();
  try {
    await sendBusinessAccountOtpEmail({ to: email, name: email.split("@")[0] ?? email, code, expiresAt });
  } catch (error) {
    console.error("Public business account OTP email could not be sent.", { email, message: error instanceof Error ? error.message : "Unknown error" });
    // Still return 200 - don't leak delivery failure to allow enumeration difference
  }
  return response.status(200).json({ success: true, message: "Verification code sent to your email.", expiresInSeconds: PUBLIC_OTP_TTL_MS / 1000, resendInSeconds: PUBLIC_OTP_RESEND_INTERVAL_MS / 1000 });
}

export async function verifyPublicBusinessAccountEmailOtp(request: Request, response: Response): Promise<Response> {
  const parsed = verifyPublicOtpSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });
  const email = parsed.data.email.toLowerCase();
  const code = parsed.data.code;
  const recaptchaToken = parsed.data.recaptchaToken;
  const { env } = await import("../config/env.js");
  if (isRecaptchaEnabled() && env.RECAPTCHA_SECRET_KEY && recaptchaToken) {
    const ok = await verifyRecaptcha(recaptchaToken, request.ip);
    if (!ok) return response.status(400).json({ success: false, message: "Captcha verification failed. Please try again." });
  }
  const record = await PublicBusinessAccountOtp.findOne({ email }).select("+otpHash").exec() as any;
  if (!record?.otpHash || !record?.otpExpiresAt) return response.status(400).json({ success: false, message: "No verification code found. Please request a new one." });
  if (record.otpExpiresAt <= new Date() || (record.otpAttempts ?? 0) >= PUBLIC_OTP_MAX_ATTEMPTS) {
    record.otpHash = "";
    record.otpExpiresAt = null;
    record.otpAttempts = 0;
    await record.save();
    return response.status(400).json({ success: false, message: "Verification code is invalid or has expired. Request a new one." });
  }
  if (!loginOtpMatches(email, code, record.otpHash)) {
    record.otpAttempts = (record.otpAttempts ?? 0) + 1;
    if (record.otpAttempts >= PUBLIC_OTP_MAX_ATTEMPTS) {
      record.otpHash = "";
      record.otpExpiresAt = null;
    }
    await record.save();
    return response.status(400).json({ success: false, message: "Incorrect verification code. Please try again." });
  }
  // success
  record.otpHash = "";
  record.otpExpiresAt = null;
  record.otpAttempts = 0;
  record.otpSentAt = null;
  record.verifiedAt = new Date();
  const verificationToken = crypto.randomBytes(32).toString("hex");
  record.verificationToken = verificationToken;
  record.verificationExpiresAt = new Date(Date.now() + PUBLIC_VERIFICATION_TTL_MS);
  await record.save();
  return response.status(200).json({ success: true, message: "Email verified successfully.", verificationToken, verifiedEmail: email, expiresInSeconds: PUBLIC_VERIFICATION_TTL_MS / 1000 });
}

export async function validatePublicBusinessAccountUniqueness(request: Request, response: Response): Promise<Response> {
  const email = typeof request.query.email === "string" ? request.query.email.trim().toLowerCase() : "";
  const mobileNumber = typeof request.query.mobileNumber === "string" ? request.query.mobileNumber.trim() : "";
  const countryCode = typeof request.query.countryCode === "string" ? request.query.countryCode.trim() : "";
  const rawRegistrationId = typeof request.query.registrationId === "string" ? request.query.registrationId : "";
  const registrationIdType = typeof request.query.registrationIdType === "string" ? request.query.registrationIdType : "";
  const isSensitiveTaxId = isUsTaxIdType(registrationIdType) && isSensitiveUsTaxIdType(registrationIdType);
  const registrationId = isSensitiveTaxId ? "" : compactRegistrationId(rawRegistrationId);
  const checks: Record<string, boolean> = { email: false, mobileNumber: false, registrationId: false };
  // Only live accounts block reuse - rejected can re-apply (matches uniq_live indexes)
  const liveFilter = { status: { $in: businessAccountStatuses.filter((s) => s !== "rejected") } };
  const mobileFilter = countryCode
    ? { ...liveFilter, "contact.countryCode": countryCode, "contact.mobileNumber": mobileNumber }
    : { ...liveFilter, "contact.mobileNumber": mobileNumber };
  const [emailMatch, mobileMatch, registrationMatch] = await Promise.all([
    email ? BusinessAccount.exists({ ...liveFilter, "contact.email": email }) : null,
    mobileNumber ? BusinessAccount.exists(mobileFilter) : null,
    registrationId ? BusinessAccount.exists({ ...liveFilter, "company.registrationId": registrationId }) : null
  ]);
  checks.email = Boolean(emailMatch);
  checks.mobileNumber = Boolean(mobileMatch);
  checks.registrationId = Boolean(registrationMatch);
  return response.status(200).json({ success: true, conflicts: checks });
}

export async function createPublicBusinessAccount(request: Request, response: Response): Promise<Response> {
  // multipart form with files
  const files = getUploadedFiles(request);
  const body = request.body as Record<string, unknown>;
  // verification token may come as header or body field
  const headerToken = typeof request.headers["x-verification-token"] === "string" ? String(request.headers["x-verification-token"]).trim() : "";
  const bodyToken = typeof body.verificationToken === "string" ? String(body.verificationToken).trim() : "";
  const verificationToken = headerToken || bodyToken;
  const recaptchaToken = typeof body.recaptchaToken === "string" ? String(body.recaptchaToken).trim() : undefined;
  const { env } = await import("../config/env.js");
  if (isRecaptchaEnabled() && env.RECAPTCHA_SECRET_KEY) {
    if (!recaptchaToken) return response.status(400).json({ success: false, message: "Captcha verification is required." });
    const ok = await verifyRecaptcha(recaptchaToken, request.ip);
    if (!ok) return response.status(400).json({ success: false, message: "Captcha verification failed. Please try again." });
  }
  if (String(body.saveAsDraft ?? "") === "true") {
    return response.status(400).json({ success: false, message: "Draft saving is not available for public requests." });
  }
  if (!verificationToken) {
    return response.status(400).json({ success: false, message: "Email verification is required. Please verify your email first." });
  }
  const parsed = parseBusinessAccountBody(request);
  if (!parsed.success) {
    return response.status(400).json({ success: false, errors: parsed.error.format() });
  }
  const emailLower = parsed.data.contact.email.toLowerCase();
  const otpRecord = await PublicBusinessAccountOtp.findOne({ email: emailLower, verificationToken }).exec();
  if (!otpRecord || !otpRecord.verifiedAt || !otpRecord.verificationExpiresAt || otpRecord.verificationExpiresAt <= new Date()) {
    return response.status(400).json({ success: false, message: "Email verification has expired. Please verify again." });
  }
  // ensure token belongs to same email as form (already matched by query)
  const duplicateMessage = await hasDuplicateBusinessIdentity(parsed.data);
  if (duplicateMessage) {
    return response.status(409).json({ success: false, message: duplicateMessage });
  }
  const invalidDocument = findInvalidDocumentSignature(files);
  if (invalidDocument) {
    return response.status(400).json({ success: false, message: "One or more documents are not a valid PDF, JPG, or PNG file." });
  }
  const documents: Partial<Record<DocumentType, any>> = {};
  const accountObjectId = new mongoose.Types.ObjectId();
  let storedKeys: string[] = [];
  try {
    const attach = await attachUploadedDocuments(documents, files, String(accountObjectId));
    storedKeys = attach.storedKeys;
    const documentError = getDocumentRequirementError(documents);
    if (documentError) {
      await discardStoredObjects(storedKeys);
      return response.status(400).json({ success: false, message: documentError });
    }
    const account = await createBusinessAccountRecord({
      _id: accountObjectId,
      status: "pending_review",
      origin: "PUBLIC",
      ...buildAccountPayload(parsed.data),
      gstBilling: normalGstBilling(),
      documents,
      kycReview: applyDerivedKycStatus({ documents, company: parsed.data.company }),
      createdBy: null,
      updatedBy: null,
      submittedAt: new Date()
    });
    // consume verification token
    otpRecord.verificationToken = null;
    otpRecord.verificationExpiresAt = null;
    await otpRecord.save().catch(() => undefined);

    await recordBusinessAccountAudit("BUSINESS_ACCOUNT_CREATED", account, null as any);
    await recordBusinessAccountAudit("BUSINESS_ACCOUNT_SUBMITTED", account, null as any);

    const href = `/dashboard/business-accounts/${account.accountId}#kyc`;
    const idempBase = `BUSINESS_ACCOUNT_SUBMITTED:${String(account._id)}:${account.submittedAt!.getTime()}`;

    // Notify admins and ops
    await notifyActiveAdmins({
      type: "BUSINESS_ACCOUNT_SUBMITTED",
      title: "New business account request",
      message: `${account.company.companyName || account.accountId} submitted a business account request via the public portal.`,
      href,
      idempotencyKey: `${idempBase}:admin`,
      businessAccountId: account._id as mongoose.Types.ObjectId,
      metadata: { accountId: account.accountId, origin: "PUBLIC" }
    }).catch(() => undefined);

    await notifyOperationsStaff({
      type: "BUSINESS_ACCOUNT_SUBMITTED",
      title: "New business account request",
      message: `${account.company.companyName || account.accountId} submitted a business account request via the public portal.`,
      href,
      idempotencyKey: `${idempBase}:ops`,
      businessAccountId: account._id as mongoose.Types.ObjectId,
      metadata: { accountId: account.accountId, origin: "PUBLIC" }
    }).catch(() => undefined);

    // Applicant acknowledgement email
    const applicantName = `${parsed.data.contact.firstName} ${parsed.data.contact.lastName}`.trim();
    await enqueueEmails({
      notificationType: "BUSINESS_ACCOUNT_SUBMITTED",
      idempotencyKey: `${idempBase}:applicant`,
      recipients: [{ email: emailLower, name: applicantName || emailLower, userId: null }],
      businessAccountId: account._id as mongoose.Types.ObjectId,
      subject: "Your Swiftline business account request is received",
      payload: { accountId: account.accountId, companyName: account.company.companyName, title: "Request received", message: "Your business account request has been received and is now under review.", href: "" },
      templateKey: "BUSINESS_ACCOUNT_SUBMITTED"
    }).catch(() => undefined);

    const populated = await getPopulatedBusinessAccount(account.accountId);
    return response.status(201).json({ success: true, message: "Business account request submitted successfully. You will be notified on approval.", account: populated ?? account });
  } catch (error) {
    await discardStoredObjects(storedKeys);
    if (isDuplicateKeyError(error)) {
      return response.status(409).json({ success: false, message: "A business account with these details already exists." });
    }
    throw error;
  }
}
