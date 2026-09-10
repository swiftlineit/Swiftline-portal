"use client";

import { FormEvent, useMemo, useRef, useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import {
  FiCheck,
  FiCheckCircle,
  FiClock,
  FiFileText,
  FiShield,
  FiBriefcase,
  FiUsers,
  FiArrowLeft,
  FiArrowRight,
  FiAlertCircle,
  FiLoader,
} from "react-icons/fi";
import {
  BusinessAccountFiles,
  BusinessAccountFormData,
  DocumentType,
  emptyBusinessAddress,
} from "@/lib/businessAccounts";
import {
  createPublicBusinessAccount,
  createPublicIdempotencyKey,
  requestPublicEmailOtp,
  verifyPublicEmailOtp,
  validatePublicBusinessAccountUnique,
} from "@/lib/publicBusinessAccounts";
import {
  emailValidationMessage,
  getPhoneValidationError,
  isValidBusinessContactEmail,
} from "@/lib/businessAccountContactRules";
import {
  fieldLabels,
  getStepIssues,
  isStepValid,
  stepFieldKeys,
  validateBusinessAccountForm,
} from "@/lib/businessAccountValidation";
import { documentTooltips } from "@/lib/businessAccountTooltips";
import {
  businessAccountSteps,
  Field,
  SearchableSelect,
  CountryCodeField,
  type UniqueField,
  shipmentTypeOptions,
  titleOptions,
  mobileTypeOptions,
  toOptions,
  registrationConfig,
  getDocumentLabel,
  formatShipmentType,
  type FieldStatus,
} from "@/components/business-accounts/FormFieldControls";
import { OtpCodeInput } from "@/components/auth/OtpCodeInput";
import {
  isSensitiveUsTaxIdType,
  isUsTaxIdType,
  type UsTaxIdType,
} from "@/lib/usTaxId";
import {
  departments,
  jobTitleOptions,
  isListedJobTitle,
  OTHER_JOB_TITLE,
} from "@/lib/businessAccountOptions";
import { CompanyStep } from "@/components/business-accounts/CompanyStep";
import PublicBusinessAccountSidebar from "@/components/public-business-account/PublicBusinessAccountSidebar";
import PublicBusinessAccountDocumentCard from "@/components/public-business-account/PublicBusinessAccountDocumentCard";
import PublicBusinessAccountReviewCard from "@/components/public-business-account/PublicBusinessAccountReviewCard";
import PublicBusinessAccountSuccess from "@/components/public-business-account/PublicBusinessAccountSuccess";
import styles from "./PublicBusinessAccountForm.module.css";

const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || "";
type RecaptchaClient = {
  ready: (callback: () => void) => void;
  execute: (siteKey: string, options: { action: string }) => Promise<string>;
};

const defaultFormData: BusinessAccountFormData = {
  contact: {
    title: "mr.",
    firstName: "",
    lastName: "",
    email: "",
    mobileType: "mobile",
    countryCode: "+91",
    mobileNumber: "",
    jobTitle: "",
    department: "",
    shipmentTypes: ["international_courier"],
  },
  company: {
    registrationCountry: "India",
    registrationIdType: "pan",
    registrationId: "",
    gstin: "",
    gstExempt: false,
    gstExemptReason: "",
    secondaryRegistrationId: "",
    noCompanyRegistration: false,
    noCompany: false,
    companyType: "",
    companyName: "",
    registeredAddress: "",
    addressLine2: "",
    city: "",
    stateOrProvince: "",
    postalCode: "",
    addressCountry: "India",
    useCompanyAddressAsBillingAddress: true,
    billingAddress: emptyBusinessAddress,
    operatingCountries: ["India"],
    website: "",
    industry: "",
    monthlyShipmentVolume: "",
    requestedCreditCurrency: "INR",
    requestedCreditLimit: "",
  },
  gstBilling: { requestedTreatment: "GST_APPLICABLE", requestReason: "" },
};

const duplicateMessages: Record<UniqueField, string> = {
  email: "Email address already exists.",
  mobileNumber: "Mobile number already exists.",
  registrationId: "Company registration ID already exists.",
};

const maxDocumentSizeBytes = 5 * 1024 * 1024;
const allowedDocumentTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const allowedDocumentExtensions = new Set(["pdf", "jpg", "jpeg", "png"]);

function getDocumentFileError(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isAllowedType =
    allowedDocumentTypes.has(file.type) ||
    allowedDocumentExtensions.has(extension);
  if (!isAllowedType)
    return "Only PDF, JPG, JPEG, and PNG files are supported.";
  if (file.size <= 0) return "The selected file is empty or corrupted.";
  if (file.size > maxDocumentSizeBytes)
    return "File size must not exceed 5 MB.";
  return "";
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const PUBLIC_DRAFT_KEY = "public:request-business-account:v1";

function loadPublicDraft(): Partial<{
  formData: BusinessAccountFormData;
  step: number;
  touched: Record<string, boolean>;
  verifiedEmail: string | null;
  verificationToken: string | null;
  verificationExpiresAt: number | null;
}> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PUBLIC_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const PUBLIC_FILES_DB = "public-business-account-draft";
const PUBLIC_FILES_STORE = "files";
const FILES_TTL_MS = 30 * 60 * 1000;
type StoredFileDraft = {
  timestamp: number;
  files: Record<string, { name: string; type: string; buffer: ArrayBuffer }>;
};

function openDraftDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PUBLIC_FILES_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PUBLIC_FILES_STORE))
        db.createObjectStore(PUBLIC_FILES_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFilesToStorage(files: BusinessAccountFiles) {
  try {
    const entries: [
      string,
      { name: string; type: string; buffer: ArrayBuffer },
    ][] = [];
    for (const [key, file] of Object.entries(files)) {
      if (!(file instanceof File)) continue;
      const buffer = await (file as File).arrayBuffer();
      entries.push([
        key,
        { name: (file as File).name, type: (file as File).type, buffer },
      ]);
    }
    const db = await openDraftDB();
    const tx = db.transaction(PUBLIC_FILES_STORE, "readwrite");
    const store = tx.objectStore(PUBLIC_FILES_STORE);
    if (entries.length === 0) {
      store.delete("draftFiles");
    } else {
      store.put(
        { files: Object.fromEntries(entries), timestamp: Date.now() },
        "draftFiles",
      );
    }
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {}
}

async function loadFilesFromStorage(): Promise<BusinessAccountFiles | null> {
  try {
    const db = await openDraftDB();
    const tx = db.transaction(PUBLIC_FILES_STORE, "readonly");
    const store = tx.objectStore(PUBLIC_FILES_STORE);
    const req = store.get("draftFiles");
    const result = await new Promise<StoredFileDraft | undefined>(
      (res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      },
    );
    db.close();
    if (!result) return null;
    if (Date.now() - result.timestamp > FILES_TTL_MS) {
      await clearFilesFromStorage();
      return null;
    }
    const restored: BusinessAccountFiles = {};
    for (const [key, meta] of Object.entries(result.files)) {
      const blob = new Blob([meta.buffer], { type: meta.type });
      const file = new File([blob], meta.name, { type: meta.type });
      restored[key as DocumentType] = file;
    }
    return restored;
  } catch {
    return null;
  }
}

async function clearFilesFromStorage() {
  try {
    const db = await openDraftDB();
    const tx = db.transaction(PUBLIC_FILES_STORE, "readwrite");
    tx.objectStore(PUBLIC_FILES_STORE).delete("draftFiles");
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {}
}

export default function PublicBusinessAccountPage() {
  const [step, setStep] = useState(0);
  const [formData, setFormData] =
    useState<BusinessAccountFormData>(defaultFormData);
  const [files, setFiles] = useState<BusinessAccountFiles>({});
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{
    accountId: string;
    companyName: string;
  } | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [documentErrors, setDocumentErrors] = useState<
    Partial<Record<DocumentType, string>>
  >({});
  const [showOptionalDocuments, setShowOptionalDocuments] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<UniqueField, string>>
  >({});
  const [validatingFields, setValidatingFields] = useState<
    Partial<Record<UniqueField, boolean>>
  >({});
  const [saving, setSaving] = useState(false);

  // Email verification state
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [otpResendAt, setOtpResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(
    null,
  );
  const [verificationExpiresAt, setVerificationExpiresAt] = useState<
    number | null
  >(null);
  const [otpError, setOtpError] = useState("");
  const [otpNotice, setOtpNotice] = useState("");
  const idempotencyKeyRef = useRef("");

  // Hydrate from storage after mount (avoids SSR mismatch)
  useEffect(() => {
    const draft = loadPublicDraft();
    if (draft) {
      // Hydration is intentionally client-only to avoid an SSR/localStorage mismatch.
      if (draft.formData) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFormData({
          ...draft.formData,
          // GST treatment is assigned through the internal account workflow.
          gstBilling: defaultFormData.gstBilling,
        });
      }
      if (typeof draft.step === "number") setStep(draft.step);
      if (draft.touched) setTouched(draft.touched);
      if (draft.verifiedEmail) setVerifiedEmail(draft.verifiedEmail);
      if (draft.verificationToken)
        setVerificationToken(draft.verificationToken);
      if (draft.verificationExpiresAt)
        setVerificationExpiresAt(draft.verificationExpiresAt);
    }
    void loadFilesFromStorage().then((stored) => {
      if (stored && Object.keys(stored).length) setFiles(stored);
    });
  }, []);

  // Persist public draft across refresh
  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      formData,
      step,
      touched,
      verifiedEmail,
      verificationToken,
      verificationExpiresAt,
    };
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PUBLIC_DRAFT_KEY, JSON.stringify(payload));
      } catch {}
    }, 400);
    return () => window.clearTimeout(id);
  }, [
    formData,
    step,
    touched,
    verifiedEmail,
    verificationToken,
    verificationExpiresAt,
  ]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void saveFilesToStorage(files);
    }, 400);
    return () => window.clearTimeout(id);
  }, [files]);

  useEffect(() => {
    if (success && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(PUBLIC_DRAFT_KEY);
      } catch {}
      void clearFilesFromStorage();
    }
  }, [success]);

  // Job title other logic
  const [otherPicked, setOtherPicked] = useState(false);
  const showsOtherJobTitle =
    otherPicked ||
    (Boolean(formData.contact.jobTitle) &&
      !isListedJobTitle(formData.contact.jobTitle));

  const usesCompanyAddressForBilling = Boolean(
    formData.company.useCompanyAddressAsBillingAddress,
  );
  const billingAddress =
    formData.company.billingAddress ?? emptyBusinessAddress;
  const requiresSecondaryRegistration = Boolean(
    registrationConfig[formData.company.registrationCountry]?.secondaryLabel,
  );

  useEffect(() => {
    if (!otpSent || !otpExpiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [otpSent, otpExpiresAt]);

  useEffect(() => {
    if (!verificationExpiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [verificationExpiresAt]);

  const secondsToResend = otpResendAt
    ? Math.max(0, Math.ceil((otpResendAt - now) / 1000))
    : 0;
  const secondsToExpiry = otpExpiresAt
    ? Math.max(0, Math.ceil((otpExpiresAt - now) / 1000))
    : 0;

  const validation = useMemo(
    () => validateBusinessAccountForm(formData),
    [formData],
  );

  const validationErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const [key, field] of Object.entries(validation)) {
      if (touched[key] && field.error) errors[key] = field.error;
    }
    if (touched.confirmation && !confirmation) {
      errors.confirmation = "Please confirm the information has been reviewed.";
    }
    return errors;
  }, [validation, touched, confirmation]);

  const fieldStatus = useMemo(() => {
    const statuses: Record<string, FieldStatus> = {};
    for (const [key, field] of Object.entries(validation)) {
      if (validatingFields[key as UniqueField]) statuses[key] = "validating";
      else if (validationErrors[key] || fieldErrors[key as UniqueField])
        statuses[key] = "invalid";
      else if (field.filled && !field.error) statuses[key] = "valid";
      else statuses[key] = "idle";
    }
    return statuses;
  }, [validation, validationErrors, fieldErrors, validatingFields]);

  const fieldWarnings = useMemo(() => {
    const warnings: Record<string, string> = {};
    for (const [key, field] of Object.entries(validation)) {
      if (field.warning) warnings[key] = field.warning;
    }
    return warnings;
  }, [validation]);

  const hasUniqueConflict = Object.values(fieldErrors).some(Boolean);
  const isCheckingUnique = Object.values(validatingFields).some(Boolean);
  const documentsComplete =
    Boolean(files.aadhaarCard) &&
    Boolean(files.panCard) &&
    !Object.values(documentErrors).some(Boolean);
  const isEmailVerified = Boolean(
    verifiedEmail &&
    verifiedEmail.toLowerCase() ===
      formData.contact.email.trim().toLowerCase() &&
    verificationToken &&
    verificationExpiresAt &&
    verificationExpiresAt > now,
  );

  // When email changes after verification, reset verification
  useEffect(() => {
    const currentEmailLower = formData.contact.email.trim().toLowerCase();
    if (verifiedEmail && verifiedEmail.toLowerCase() !== currentEmailLower) {
      // Verification belongs to the previous email and must be cleared immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVerifiedEmail(null);
      setVerificationToken(null);
      setVerificationExpiresAt(null);
      setOtpSent(false);
      setOtp("");
      setOtpError("");
      setOtpNotice("");
    }
  }, [formData.contact.email, verifiedEmail]);

  const canLeaveStep = (() => {
    if (step === 0)
      return (
        isStepValid(validation, 0) &&
        isEmailVerified &&
        !isCheckingUnique &&
        !hasUniqueConflict
      );
    if (step === 1)
      return (
        isStepValid(validation, 1) && !isCheckingUnique && !hasUniqueConflict
      );
    if (step === 2) return documentsComplete;
    if (step === 3) return true;
    return false;
  })();

  const canSubmit =
    isStepValid(validation, 0) &&
    isStepValid(validation, 1) &&
    documentsComplete &&
    confirmation &&
    isEmailVerified &&
    !hasUniqueConflict &&
    !isCheckingUnique;

  const outstandingIssues = useMemo(() => {
    if (step === 2)
      return documentsComplete
        ? []
        : ["Aadhaar Card and PAN Card Copy are required."];
    if (step === 3) {
      const issues = [0, 1].flatMap((stepIndex) =>
        getStepIssues(validation, stepIndex).map(
          (key) => `${fieldLabels[key] ?? key}: ${validation[key].error}`,
        ),
      );
      if (!documentsComplete)
        issues.push("Aadhaar Card and PAN Card Copy are required.");
      if (!confirmation)
        issues.push("Confirm the information has been reviewed.");
      if (!isEmailVerified)
        issues.push("Email: Please verify your email via OTP.");
      return issues;
    }
    const stepStarted = (stepFieldKeys[step] ?? []).some((key) => touched[key]);
    if (!stepStarted) return [];
    const base = getStepIssues(validation, step).map(
      (key) => `${fieldLabels[key] ?? key}: ${validation[key].error}`,
    );
    if (step === 0 && !isEmailVerified)
      base.push("Email verification is required to continue.");
    return base;
  }, [
    step,
    validation,
    touched,
    documentsComplete,
    confirmation,
    isEmailVerified,
  ]);

  const documentFields = useMemo(
    () => [
      {
        type: "aadhaarCard" as DocumentType,
        required: true,
        info: documentTooltips.aadhaarCard,
      },
      {
        type: "panCard" as DocumentType,
        required: true,
        info: documentTooltips.panCard,
      },
      {
        type: "adCertificate" as DocumentType,
        required: false,
        info: documentTooltips.adCertificate,
      },
      {
        type: "msmeCertificate" as DocumentType,
        required: false,
        info: documentTooltips.msmeCertificate,
      },
      {
        type: "tanCertificate" as DocumentType,
        required: false,
        info: documentTooltips.tanCertificate,
      },
      {
        type: "gstCertificate" as DocumentType,
        required: false,
        info: documentTooltips.gstCertificate,
      },
      {
        type: "iecCertificate" as DocumentType,
        required: false,
        info: documentTooltips.iecCertificate,
      },
      {
        type: "otherCertificate" as DocumentType,
        required: false,
        info: documentTooltips.otherCertificate,
      },
    ],
    [],
  );
  const requiredDocumentFields = documentFields.filter(
    (field) => field.required,
  );
  const optionalDocumentFields = documentFields.filter(
    (field) => !field.required,
  );
  const uploadedDocumentFields = documentFields.filter((field) =>
    Boolean(files[field.type]),
  );

  function markTouched(...keys: string[]) {
    setTouched((current) => {
      const next = { ...current };
      for (const key of keys) next[key] = true;
      return next;
    });
  }
  function markStepTouched(stepToReveal: number) {
    markTouched(...(stepFieldKeys[stepToReveal] ?? []));
  }

  function updateContact<Key extends keyof BusinessAccountFormData["contact"]>(
    key: Key,
    value: BusinessAccountFormData["contact"][Key],
  ) {
    if (key === "email" || key === "mobileNumber")
      setFieldErrors((c) => ({ ...c, [key]: undefined }));
    if (key === "countryCode")
      setFieldErrors((c) => ({ ...c, mobileNumber: undefined }));
    setFormData((current) => ({
      ...current,
      contact: { ...current.contact, [key]: value },
    }));
  }
  function updateCompany<Key extends keyof BusinessAccountFormData["company"]>(
    key: Key,
    value: BusinessAccountFormData["company"][Key],
  ) {
    if (key === "registrationId")
      setFieldErrors((c) => ({ ...c, registrationId: undefined }));
    if (key === "registrationCountry") {
      setFieldErrors((c) => ({ ...c, registrationId: undefined }));
      setTouched((c) => ({
        ...c,
        registrationId: false,
        secondaryRegistrationId: false,
      }));
    }
    setFormData((current) => ({
      ...current,
      company: { ...current.company, [key]: value },
    }));
  }
  function getUniqueFieldValue(field: UniqueField) {
    if (field === "email") return formData.contact.email.trim();
    if (field === "mobileNumber") return formData.contact.mobileNumber.trim();
    return formData.company.registrationId.trim();
  }

  async function getRecaptchaToken(
    action: string,
  ): Promise<string | undefined> {
    const recaptcha =
      typeof window !== "undefined"
        ? (window as Window & { grecaptcha?: RecaptchaClient }).grecaptcha
        : undefined;
    if (!RECAPTCHA_SITE_KEY || typeof window === "undefined" || !recaptcha)
      return undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        recaptcha.ready(() => {
          recaptcha
            .execute(RECAPTCHA_SITE_KEY, { action })
            .then(resolve, reject);
        });
      });
    } catch {
      return undefined;
    }
  }

  async function validateUniqueField(field: UniqueField): Promise<boolean> {
    const value = getUniqueFieldValue(field);
    if (!value) {
      setFieldErrors((c) => ({ ...c, [field]: undefined }));
      return true;
    }
    if (field === "email" && !isValidBusinessContactEmail(value)) {
      setFieldErrors((c) => ({ ...c, email: emailValidationMessage }));
      return false;
    }
    if (field === "mobileNumber") {
      const phoneError = getPhoneValidationError(
        formData.contact.countryCode,
        value,
      );
      if (phoneError) {
        setFieldErrors((c) => ({ ...c, mobileNumber: phoneError }));
        return false;
      }
    }
    if (field === "registrationId" && validation.registrationId?.error)
      return false;
    if (
      field === "registrationId" &&
      formData.company.registrationCountry === "United States" &&
      isUsTaxIdType(formData.company.registrationIdType ?? "") &&
      isSensitiveUsTaxIdType(formData.company.registrationIdType as UsTaxIdType)
    ) {
      setFieldErrors((c) => ({ ...c, registrationId: undefined }));
      return true;
    }
    setValidatingFields((c) => ({ ...c, [field]: true }));
    try {
      const result = await validatePublicBusinessAccountUnique({
        [field]: value,
        ...(field === "mobileNumber"
          ? { countryCode: formData.contact.countryCode.trim() }
          : {}),
        ...(field === "registrationId"
          ? { registrationIdType: formData.company.registrationIdType ?? "" }
          : {}),
      });
      if (getUniqueFieldValue(field) !== value) return true;
      const hasConflict = result.conflicts[field];
      setFieldErrors((c) => ({
        ...c,
        [field]: hasConflict ? duplicateMessages[field] : undefined,
      }));
      return !hasConflict;
    } catch {
      setFieldErrors((c) => ({
        ...c,
        [field]: "Unable to validate this value right now.",
      }));
      return false;
    } finally {
      setValidatingFields((c) => ({ ...c, [field]: false }));
    }
  }

  async function validateStepUniqueFields(
    stepToValidate: number,
  ): Promise<boolean> {
    const fields: UniqueField[] =
      stepToValidate === 0
        ? ["email", "mobileNumber"]
        : stepToValidate === 1
          ? formData.company.registrationId.trim()
            ? ["registrationId"]
            : []
          : [];
    if (!fields.length) return true;
    const results = await Promise.all(
      fields.map((field) => validateUniqueField(field)),
    );
    const isValid = results.every(Boolean);
    if (!isValid)
      setError(
        "Please fix the highlighted duplicate fields before continuing.",
      );
    return isValid;
  }

  function handleDocumentChange(type: DocumentType, file: File | null) {
    if (!file) {
      setFiles((c) => ({ ...c, [type]: null }));
      setDocumentErrors((c) => ({ ...c, [type]: undefined }));
      return;
    }
    const fileError = getDocumentFileError(file);
    if (fileError) {
      setFiles((c) => ({ ...c, [type]: null }));
      setDocumentErrors((c) => ({ ...c, [type]: fileError }));
      return;
    }
    setFiles((c) => ({ ...c, [type]: file }));
    setDocumentErrors((c) => ({ ...c, [type]: undefined }));
  }

  function getDocumentValidationErrors() {
    const nextErrors: Partial<Record<DocumentType, string>> = {
      ...documentErrors,
    };
    if (!files.aadhaarCard)
      nextErrors.aadhaarCard = "Aadhaar Card is required.";
    if (!files.panCard) nextErrors.panCard = "PAN Card Copy is required.";
    return nextErrors;
  }

  async function validateStep(stepToValidate: number) {
    setError("");
    if (stepToValidate === 2) {
      const nextDocumentErrors = getDocumentValidationErrors();
      setDocumentErrors(nextDocumentErrors);
      if (Object.values(nextDocumentErrors).some(Boolean)) {
        setError(
          "Please fix the highlighted document issues before continuing.",
        );
        return false;
      }
      return true;
    }
    if (stepToValidate === 3) {
      markTouched("confirmation");
      if (!confirmation) {
        setError("Please confirm the information has been reviewed.");
        return false;
      }
      if (!isEmailVerified) {
        setError("Please verify your email before submitting.");
        return false;
      }
      return true;
    }
    markStepTouched(stepToValidate);
    if (!isStepValid(validation, stepToValidate)) {
      setError("Please fill the highlighted fields before continuing.");
      return false;
    }
    if (stepToValidate === 0 && !isEmailVerified) {
      setError("Please verify your email to continue.");
      return false;
    }
    return validateStepUniqueFields(stepToValidate);
  }

  async function handleSendOtp() {
    setOtpError("");
    setOtpNotice("");
    const emailRaw = formData.contact.email.trim();
    if (!isValidBusinessContactEmail(emailRaw)) {
      setOtpError(emailValidationMessage);
      return;
    }
    // Block OTP if email already taken â€” don't spam inbox for an account that can't be created
    const uniqueOk = await validateUniqueField("email");
    if (!uniqueOk) {
      setOtpError(fieldErrors.email || duplicateMessages.email);
      // ensure field shows invalid state
      markTouched("email");
      return;
    }
    if (fieldErrors.email) {
      setOtpError(fieldErrors.email);
      return;
    }
    setSendingOtp(true);
    try {
      const recaptchaToken = await getRecaptchaToken(
        "public_business_account_email_otp",
      );
      const result = await requestPublicEmailOtp({
        email: emailRaw,
        recaptchaToken,
      });
      const issuedAt = Date.now();
      setNow(issuedAt);
      setOtpExpiresAt(issuedAt + result.expiresInSeconds * 1000);
      setOtpResendAt(issuedAt + result.resendInSeconds * 1000);
      setOtpSent(true);
      setOtp("");
      setOtpNotice(result.message || "Verification code sent to your email.");
    } catch (caught) {
      const msg =
        caught instanceof Error
          ? caught.message
          : "Unable to send verification code.";
      // 409 from backend means live account exists â€” surface as field error too
      if (msg.toLowerCase().includes("already exists")) {
        setFieldErrors((c) => ({ ...c, email: duplicateMessages.email }));
      }
      setOtpError(msg);
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerifyOtp(codeOverride?: string) {
    const codeToVerify = codeOverride ?? otp;
    if (codeToVerify.length !== 6) {
      setOtpError("Enter the 6-digit code.");
      return;
    }
    setVerifyingOtp(true);
    setOtpError("");
    try {
      const recaptchaToken = await getRecaptchaToken(
        "public_business_account_verify",
      );
      const result = await verifyPublicEmailOtp({
        email: formData.contact.email.trim(),
        code: codeToVerify,
        recaptchaToken,
      });
      setVerifiedEmail(result.verifiedEmail);
      setVerificationToken(result.verificationToken);
      setVerificationExpiresAt(Date.now() + result.expiresInSeconds * 1000);
      setOtpNotice("Email verified successfully.");
      setOtpError("");
      // mark email field as touched to show valid tick
      markTouched("email");
    } catch (caught) {
      setOtpError(
        caught instanceof Error
          ? caught.message
          : "Invalid code. Please try again.",
      );
    } finally {
      setVerifyingOtp(false);
    }
  }

  async function submitForReview() {
    for (const stepToValidate of [0, 1, 2, 3]) {
      if (!(await validateStep(stepToValidate))) {
        setStep(stepToValidate);
        return;
      }
    }
    if (!verificationToken || !isEmailVerified) {
      setError("Please verify your email before submitting.");
      setStep(0);
      return;
    }
    setSaving(true);
    try {
      idempotencyKeyRef.current ||= createPublicIdempotencyKey();
      const recaptchaToken = await getRecaptchaToken(
        "public_business_account_submit",
      );
      const result = await createPublicBusinessAccount(
        formData,
        files,
        verificationToken,
        recaptchaToken,
        idempotencyKeyRef.current,
      );
      setSuccess({
        accountId: result.account.accountId,
        companyName:
          result.account.company.companyName || formData.company.companyName,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to submit business account request.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await validateStep(step))) return;
    setStep((current) => Math.min(current + 1, 3));
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(PUBLIC_DRAFT_KEY);
    } catch {}
    void clearFilesFromStorage();
    setFormData(defaultFormData);
    setStep(0);
    setTouched({});
    setVerifiedEmail(null);
    setVerificationToken(null);
    setVerificationExpiresAt(null);
    setOtpSent(false);
    setOtp("");
    setOtpError("");
    setOtpNotice("");
    setFiles({});
    setFieldErrors({});
    setDocumentErrors({});
    setError("");
    setConfirmation(false);
  }

  if (success) {
    return (
      <>
        <PublicBusinessAccountSuccess
          accountId={success.accountId}
          companyName={success.companyName}
          email={formData.contact.email}
        />
        {RECAPTCHA_SITE_KEY ? (
          <Script
            src={`https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`}
            strategy="afterInteractive"
          />
        ) : null}
      </>
    );
  }

  // UI copy used by the step header and the responsive progress trackers.
  const stepsMeta = [
    {
      icon: FiUsers,
      label: "Contact",
      desc: "Contact & verification",
      summary:
        "Add the primary contact, verify the work email and tell us what you normally ship.",
    },
    {
      icon: FiBriefcase,
      label: "Company",
      desc: "Registration & billing",
      summary:
        "Provide registration, company address, billing details and the business profile used for account review.",
    },
    {
      icon: FiFileText,
      label: "Documents",
      desc: "KYC & certificates",
      summary:
        "Upload the required KYC documents and any supporting certificates that apply to your business.",
    },
    {
      icon: FiShield,
      label: "Review",
      desc: "Check & submit",
      summary:
        "Confirm the contact, company and document details before submitting the application for approval.",
    },
  ];

  return (
    <>
      {/* Page content theme */}
      <div className="bg-gray-200">
        <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start xl:grid-cols-[20rem_minmax(0,1fr)] xl:gap-8">
            <PublicBusinessAccountSidebar />

            {/* Right application workspace */}
            <div className="flex min-w-0 w-full flex-col rounded-xl px-3 lg:min-h-180 xl:max-w-238 xl:min-h-190  2xl:max-w-none">
              <main className="mt-4 flex min-h-0 flex-1 flex-col lg:mt-0">
                {error ? (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-[#FF0000]"
                  >
                    <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{" "}
                    <span>{error}</span>
                  </div>
                ) : null}

                {/* Current step heading */}
                <div className="relative mb-4 overflow-hidden rounded-xl border border-slate-200 bg-[#F7F9F9] px-4 py-5 sm:px-6 sm:py-6">
                  {/* Decorative illustration */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 right-4 hidden h-full w-52.5 items-end justify-end lg:flex"
                  >
                    <Image
                      src="/steps_header.png"
                      alt=""
                      width={220}
                      height={170}
                      className="max-h-31.25 w-auto object-contain opacity-90"
                    />
                  </div>

                  <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 lg:max-w-[calc(100%-230px)]">
                      <p className="text-xs font-semibold text-[#0D1282]">
                        Step {step + 1} of 4
                      </p>

                      <h2 className="mt-1.5 text-xl font-bold tracking-[-0.02em] text-slate-950 sm:text-[22px]">
                        {businessAccountSteps[step]}
                      </h2>

                      <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-600">
                        {stepsMeta[step].summary}
                      </p>
                    </div>

                  </div>
                </div>

                {/* Public application form */}
                <form
                  noValidate
                  onSubmit={handleContinue}
                  className={`${styles.form} public-business-form flex min-h-0 flex-1 flex-col rounded-b-xl border border-gray-200 `}
                >
                  {step === 2 ? (
                    <div className="flex shrink-0 items-center gap-2 bg-[#F1F8F8] px-5 py-2.5 text-xs text-slate-500 sm:px-6">
                      <FiClock className="h-3.5 w-3.5 shrink-0 text-[#0D1282]" />
                      Uploaded files are kept temporarily on this device while
                      you complete the application.
                    </div>
                  ) : null}

                  <div className="flex-1 bg-white px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
                    {/* Step 1: contact details */}
                    {step === 0 ? (
<div className="space-y-5 rounded-none border-0 bg-transparent px-0 py-5 sm:rounded-xl sm:border sm:border-[#D6E5E7] sm:bg-[#F8FBFB] sm:px-6">                        {/* Contact name */}
                        <div className="grid gap-4 md:grid-cols-3">
                          <SearchableSelect
                            label="Title"
                            value={formData.contact.title}
                            onChange={(value) => {
                              markTouched("title");
                              updateContact(
                                "title",
                                value as BusinessAccountFormData["contact"]["title"],
                              );
                            }}
                            options={titleOptions}
                            error={validationErrors.title}
                            status={fieldStatus.title}
                            required
                          />
                          <Field
                            label="First Name"
                            value={formData.contact.firstName}
                            onChange={(v) => updateContact("firstName", v)}
                            onBlur={() => markTouched("firstName")}
                            error={validationErrors.firstName}
                            status={fieldStatus.firstName}
                            maxLength={22}
                            required
                          />
                          <Field
                            label="Last Name"
                            value={formData.contact.lastName}
                            onChange={(v) => updateContact("lastName", v)}
                            onBlur={() => markTouched("lastName")}
                            error={validationErrors.lastName}
                            status={fieldStatus.lastName}
                            maxLength={22}
                            required
                          />
                        </div>
                        {/* Work email and OTP verification */}
                        <div className="rounded-lg-4 ">
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-start">
                            <div className="min-w-0">
                              <Field
                                label="Email Address"
                                type="email"
                                value={formData.contact.email}
                                onChange={(value) =>
                                  updateContact("email", value)
                                }
                                onBlur={() => {
                                  markTouched("email");
                                  void validateUniqueField("email");
                                }}
                                error={
                                  validationErrors.email || fieldErrors.email
                                }
                                status={fieldStatus.email}
                                placeholder="name@company.com"
                                helper={
                                  validatingFields.email
                                    ? "Checking email..."
                                    : undefined
                                }
                                required
                              />
                            </div>

                            <div className="w-full sm:pt-0">
                              <button
                                type="button"
                                onClick={() => void handleSendOtp()}
                                disabled={
                                  sendingOtp ||
                                  isEmailVerified ||
                                  !isValidBusinessContactEmail(
                                    formData.contact.email.trim(),
                                  )
                                }
                                className={`inline-flex h-14 mt-5 w-full shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition disabled:cursor-not-allowed ${
                                  isEmailVerified
                                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border border-[#0D1282] bg-[#0D1282] text-white hover:bg-[#0A0F6D] disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                                }`}
                              >
                                {sendingOtp ? (
                                  <>
                                    <FiLoader className="h-4 w-4 animate-spin" />
                                    Sending…
                                  </>
                                ) : isEmailVerified ? (
                                  <>
                                    <FiCheckCircle className="h-4 w-4" />
                                    Verified
                                  </>
                                ) : otpSent ? (
                                  "Resend code"
                                ) : (
                                  "Send verification code"
                                )}
                              </button>
                            </div>
                          </div>

                          {otpError &&
                          !(validationErrors.email || fieldErrors.email) ? (
                            <p
                              role="alert"
                              className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs font-medium text-[#FF0000]"
                            >
                              <FiAlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              {otpError}
                            </p>
                          ) : null}

                          {otpNotice && !otpError && !isEmailVerified ? (
                            <p className="mt-3 text-xs font-medium text-emerald-700">
                              {otpNotice}
                            </p>
                          ) : null}

                          {otpSent && !isEmailVerified ? (
                            <div className="mt-4 border-t border-[#BBD5DA] pt-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-slate-900">
                                  Enter the 6-digit code
                                </p>
                                <span className="text-xs text-slate-500">
                                  {secondsToExpiry > 0
                                    ? `Expires in ${formatCountdown(secondsToExpiry)}`
                                    : "Code expired - request a new one"}
                                </span>
                              </div>
                              <p className="mt-1 truncate text-xs text-slate-500">
                                Sent to {formData.contact.email.trim()}
                              </p>

                              <div className="mt-3">
                                <OtpCodeInput
                                  label="Verification code"
                                  value={otp}
                                  onChange={setOtp}
                                  onComplete={(c) => void handleVerifyOtp(c)}
                                  disabled={verifyingOtp}
                                  invalid={Boolean(otpError)}
                                />
                              </div>

                              <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
                                <button
                                  type="button"
                                  disabled={secondsToResend > 0 || sendingOtp}
                                  onClick={() => void handleSendOtp()}
                                  className="text-xs font-semibold text-slate-700 transition hover:underline disabled:text-slate-400"
                                >
                                  {secondsToResend > 0
                                    ? `Resend in ${secondsToResend}s`
                                    : "Resend code"}
                                </button>

                                <button
                                  type="button"
                                  disabled={verifyingOtp || otp.length !== 6}
                                  onClick={() => void handleVerifyOtp()}
                                  className="inline-flex items-center justify-center rounded-lg bg-[#0D1282] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#0A0F6D] disabled:cursor-not-allowed disabled:bg-slate-300"
                                >
                                  {verifyingOtp ? "Verifying…" : "Verify email"}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        {/* Phone details */}
                        <div className="grid gap-4 md:grid-cols-3">
                          <SearchableSelect
                            label="Phone Type"
                            value={formData.contact.mobileType}
                            onChange={(value) => {
                              markTouched("mobileType");
                              updateContact(
                                "mobileType",
                                value as BusinessAccountFormData["contact"]["mobileType"],
                              );
                            }}
                            options={mobileTypeOptions}
                            error={validationErrors.mobileType}
                            status={fieldStatus.mobileType}
                            required
                          />
                          <CountryCodeField
                            value={formData.contact.countryCode}
                            onChange={(v) => updateContact("countryCode", v)}
                            error={validationErrors.countryCode}
                            required
                          />
                          <Field
                            label="Mobile Number"
                            value={formData.contact.mobileNumber}
                            onChange={(v) => updateContact("mobileNumber", v)}
                            onBlur={() => {
                              markTouched("mobileNumber");
                              void validateUniqueField("mobileNumber");
                            }}
                            error={
                              validationErrors.mobileNumber ||
                              fieldErrors.mobileNumber
                            }
                            status={fieldStatus.mobileNumber}
                            placeholder="Without country code"
                            helper={
                              validatingFields.mobileNumber
                                ? "Checking…"
                                : undefined
                            }
                            required
                          />
                        </div>

                        {/* Role, department and shipment preference */}
                        <div className="grid gap-4 md:grid-cols-3 md:items-start">
                          <div className="grid gap-3">
                            <SearchableSelect
                              label="Job Title"
                              value={
                                showsOtherJobTitle
                                  ? OTHER_JOB_TITLE
                                  : formData.contact.jobTitle
                              }
                              onChange={(next) => {
                                if (next === OTHER_JOB_TITLE) {
                                  setOtherPicked(true);
                                  updateContact("jobTitle", "");
                                  return;
                                }
                                markTouched("jobTitle");
                                setOtherPicked(false);
                                updateContact("jobTitle", next);
                              }}
                              options={jobTitleOptions}
                              error={
                                showsOtherJobTitle
                                  ? undefined
                                  : validationErrors.jobTitle
                              }
                              status={
                                showsOtherJobTitle
                                  ? "idle"
                                  : fieldStatus.jobTitle
                              }
                              required
                            />
                            {showsOtherJobTitle ? (
                              <Field
                                label="Job Title (Manual Entry)"
                                value={formData.contact.jobTitle}
                                onChange={(v) => updateContact("jobTitle", v)}
                                onBlur={() => markTouched("jobTitle")}
                                error={validationErrors.jobTitle}
                                status={fieldStatus.jobTitle}
                                placeholder="e.g. Regional Logistics Head"
                                maxLength={80}
                                required
                              />
                            ) : null}
                          </div>
                          <SearchableSelect
                            label="Department"
                            value={formData.contact.department}
                            onChange={(value) => {
                              markTouched("department");
                              updateContact("department", value);
                            }}
                            options={toOptions(departments)}
                            error={validationErrors.department}
                            status={fieldStatus.department}
                            required
                          />
                          <SearchableSelect
                            label="Shipment Type"
                            value={formData.contact.shipmentTypes[0] ?? ""}
                            onChange={(value) => {
                              markTouched("shipmentTypes");
                              updateContact("shipmentTypes", [
                                value as BusinessAccountFormData["contact"]["shipmentTypes"][number],
                              ]);
                            }}
                            options={shipmentTypeOptions}
                            error={validationErrors.shipmentTypes}
                            status={fieldStatus.shipmentTypes}
                            required
                          />
                        </div>
                      </div>
                    ) : null}

                    {step === 1 ? (
                      <CompanyStep
                        formData={formData}
                        validationErrors={validationErrors}
                        fieldStatus={fieldStatus}
                        fieldWarnings={fieldWarnings}
                        fieldErrors={fieldErrors}
                        validatingFields={validatingFields}
                        onCompanyChange={updateCompany}
                        onValidateUniqueField={validateUniqueField}
                        onFieldBlur={markTouched}
                        hideGstTreatmentSection
                      />
                    ) : null}

                    {/* Step 3: KYC document uploads */}
                    {step === 2 ? (
                      <div className="space-y-4">
                        {/* Document upload overview */}
                        <div className="flex flex-col gap-3 rounded-xl border border-[#D6E5E7] bg-[#F8FBFB] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-900">
                                Required KYC documents
                              </p>
                              <p className="mt-0.5 text-xs leading-5 text-slate-500">
                                Upload Aadhaar and PAN to continue.
                              </p>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2 text-[11px] font-medium text-slate-500">
                            <span className="rounded-md border border-[#D6E5E7] bg-white px-2.5 py-1.5">
                              PDF, JPG, PNG
                            </span>
                            <span className="rounded-md border border-[#D6E5E7] bg-white px-2.5 py-1.5">
                              Max 5 MB
                            </span>
                          </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          {requiredDocumentFields.map((df) => (
                            <PublicBusinessAccountDocumentCard
                              key={df.type}
                              type={df.type as DocumentType}
                              required={df.required}
                              info={df.info}
                              file={files[df.type as DocumentType] ?? null}
                              error={documentErrors[df.type as DocumentType]}
                              onChange={(f) =>
                                handleDocumentChange(df.type as DocumentType, f)
                              }
                            />
                          ))}
                        </div>

                        <div className="border-t border-[#E2EBEC] pt-4">
                          <button
                            type="button"
                            aria-controls="optional-business-documents"
                            aria-expanded={showOptionalDocuments}
                            onClick={() =>
                              setShowOptionalDocuments((current) => !current)
                            }
                            className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-[#0D1282] transition hover:bg-[#F1F8F8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0DE36]/60"
                          >
                            <span>
                              {showOptionalDocuments
                                ? "Hide optional documents"
                                : "View all optional documents"}
                            </span>
                            <FiArrowRight
                              aria-hidden="true"
                              className={`h-4 w-4 transition-transform ${
                                showOptionalDocuments ? "rotate-90" : ""
                              }`}
                            />
                          </button>

                          {showOptionalDocuments ? (
                            <div
                              id="optional-business-documents"
                              className="mt-3 grid gap-3 sm:grid-cols-2"
                            >
                              {optionalDocumentFields.map((df) => (
                                <PublicBusinessAccountDocumentCard
                                  key={df.type}
                                  type={df.type as DocumentType}
                                  required={df.required}
                                  info={df.info}
                                  file={files[df.type as DocumentType] ?? null}
                                  error={
                                    documentErrors[df.type as DocumentType]
                                  }
                                  onChange={(f) =>
                                    handleDocumentChange(
                                      df.type as DocumentType,
                                      f,
                                    )
                                  }
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {/* Step 4: final review */}
                    {step === 3 ? (
                      <div className="space-y-5">
                        {/* Contact summary */}
                        <PublicBusinessAccountReviewCard
                          kind="contact"
                          title="Contact details"
                          description="Primary contact, verification and shipment preferences"
                          onEdit={() => setStep(0)}
                          rows={[
                            ["Title", formData.contact.title],
                            [
                              "Name",
                              `${formData.contact.firstName} ${formData.contact.lastName}`.trim(),
                            ],
                            [
                              "Email",
                              `${formData.contact.email} ${isEmailVerified ? "✓ verified" : "- not verified"}`,
                            ],
                            [
                              "Phone",
                              `${formData.contact.countryCode} ${formData.contact.mobileNumber} (${formData.contact.mobileType})`,
                            ],
                            ["Job", formData.contact.jobTitle],
                            ["Department", formData.contact.department],
                            [
                              "Shipment type",
                              formData.contact.shipmentTypes
                                .map(formatShipmentType)
                                .join(", "),
                            ],
                          ]}
                        />

                        {/* Company summary */}
                        <PublicBusinessAccountReviewCard
                          kind="company"
                          title="Company details"
                          description="Registration, address, billing and account preferences"
                          columns={3}
                          onEdit={() => setStep(1)}
                          rows={[
                            [
                              "Country of registration",
                              formData.company.registrationCountry,
                            ],
                            [
                              "Registration ID",
                              formData.company.registrationId || "-",
                            ],
                            ...(requiresSecondaryRegistration
                              ? [
                                  [
                                    "Additional code",
                                    formData.company.secondaryRegistrationId ||
                                      "-",
                                  ] as [string, string],
                                ]
                              : []),
                            [
                              "GSTIN",
                              formData.company.gstin ||
                                (formData.company.gstExempt
                                  ? `Exempt - ${formData.company.gstExemptReason}`
                                  : "-"),
                            ],
                            [
                              "Company",
                              formData.company.noCompany
                                ? "No company (individual)"
                                : `${formData.company.companyName} (${formData.company.companyType})`,
                            ],
                            [
                              "Address",
                              `${formData.company.registeredAddress} ${formData.company.addressLine2 ?? ""}`.trim() ||
                                "-",
                            ],
                            [
                              "City / State",
                              `${formData.company.city} - ${formData.company.stateOrProvince}`,
                            ],
                            [
                              "Postal / Country",
                              `${formData.company.postalCode} - ${formData.company.addressCountry}`,
                            ],
                            [
                              "Billing",
                              usesCompanyAddressForBilling
                                ? "Same as company address"
                                : `${billingAddress.addressLine1}, ${billingAddress.city}`,
                            ],
                            [
                              "Operating countries",
                              formData.company.operatingCountries.join(", ") ||
                                "-",
                            ],
                            ["Website", formData.company.website || "-"],
                            ["Industry", formData.company.industry || "-"],
                            [
                              "Monthly volume",
                              formData.company.monthlyShipmentVolume || "-",
                            ],
                            [
                              "Credit",
                              `${formData.company.requestedCreditCurrency} ${formData.company.requestedCreditLimit || "-"}`,
                            ],
                          ]}
                        />

                        {/* Uploaded document summary */}
                        <section className="overflow-hidden rounded-xl border border-[#C7DADD] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
                          <div className="flex flex-col gap-3 border-b border-[#DCE8E9] bg-[#F8FBFB] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EAF4F4] text-[#0D1282]">
                                <FiFileText className="h-4.5 w-4.5" />
                              </span>
                              <p className="text-sm font-bold text-slate-950">
                                Uploaded documents
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => setStep(2)}
                              className="inline-flex min-h-9 w-fit items-center justify-center rounded-lg border border-[#C7DADD] bg-white px-3 text-xs font-semibold text-[#0D1282] transition hover:border-[#AFC8CD] hover:bg-[#EAF4F4]"
                            >
                              Edit documents
                            </button>
                          </div>

                          <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
                            {uploadedDocumentFields.length ? (
                              uploadedDocumentFields.map((df) => {
                                const file = files[df.type];
                                if (!file) return null;

                                return (
                                  <div
                                    key={df.type}
                                    className="flex min-w-0 items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3.5 py-3"
                                  >
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                                      <FiCheck className="h-4 w-4" />
                                    </span>
                                    <div className="min-w-0 flex-1 overflow-hidden">
                                      <p className="text-xs font-semibold text-slate-800">
                                        {getDocumentLabel(df.type)}
                                      </p>
                                      <p
                                        className="mt-1 block max-w-full truncate text-[11px] font-medium text-emerald-700"
                                        title={file.name}
                                      >
                                        {file.name}
                                      </p>
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <p className="text-sm text-slate-500">
                                No documents uploaded.
                              </p>
                            )}
                          </div>
                        </section>

                        {/* Final confirmation */}
                        <label
                          className={`group flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-4 transition sm:px-5 ${
                            validationErrors.confirmation
                              ? "border-red-200 bg-red-50/50"
                              : confirmation
                                ? "border-emerald-200 bg-emerald-50/40"
                                : "border-[#C7DADD] bg-[#F8FBFB] hover:border-[#AFC8CD] hover:bg-[#F1F8F8]"
                          }`}
                        >
                          {/* <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[#0D1282] ring-1 ring-[#D3E1E3]">
                          <FiShield className="h-4.5 w-4.5" />
                        </span> */}

                          <span className="min-w-0 flex-1">
                            <span className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                checked={confirmation}
                                onChange={(e) => {
                                  setConfirmation(e.target.checked);
                                  markTouched("confirmation");
                                }}
                                className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 accent-[#0D1282]"
                              />

                              <span className="min-w-0">
                                <span className="mt-1 block text-xs leading-5 text-slate-600">
                                  I confirm the information above is accurate
                                  and the documents are genuine. I understand
                                  the account will be reviewed before
                                  activation.
                                </span>
                              </span>
                            </span>

                            {validationErrors.confirmation ? (
                              <span className="mt-2 block pl-8 text-xs font-semibold text-[#D71313]">
                                {validationErrors.confirmation}
                              </span>
                            ) : confirmation ? (
                              <span className="mt-2 inline-flex items-center gap-1.5 pl-8 text-xs font-semibold text-emerald-700">
                                <FiCheckCircle className="h-3.5 w-3.5" />
                                Confirmation completed
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </div>
                    ) : null}

                    {/* Current-step validation summary */}
                    {outstandingIssues.length ? (
                      step === 3 ? (
                        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                          <p className="text-sm font-semibold text-amber-900">
                            Complete these before submitting
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900">
                            {outstandingIssues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <div className="mt-6 flex items-center gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200">
                          <FiAlertCircle className="h-4 w-4 shrink-0" />
                          <span>
                            {outstandingIssues.length === 1
                              ? "1 required item needs attention before you can continue."
                              : `${outstandingIssues.length} required items need attention before you can continue.`}
                          </span>
                        </div>
                      )
                    ) : null}
                  </div>

                  {/* Step navigation */}
                  <div className="flex flex-wrap rounded-b-xl items-center justify-between gap-3 border-t border-[#C7DADD] bg-[#e22d30] px-5 py-4 sm:px-7">
                    <button
                      type="button"
                      onClick={() => setStep((c) => Math.max(c - 1, 0))}
                      disabled={step === 0 || saving}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-80"
                    >
                      <FiArrowLeft className="h-4 w-4" /> Back
                    </button>
                      <button
                      type="button"
                      onClick={clearDraft}
                      className="relative z-20 inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"
                      title="Clear saved draft"
                    >
                      Clear draft
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                      <Link
                        href="/"
                        className="hidden min-h-11 items-center rounded-lg px-3 py-2.5 bg-white text-sm font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-700 sm:inline-flex"
                      >
                        Cancel
                      </Link>
                      {step < 3 ? (
                        <button
                          type="submit"
                          disabled={saving || isCheckingUnique || !canLeaveStep}
                          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#0D1282] px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0A0F6D] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:opacity-100"
                        >
                          {isCheckingUnique ? "Checking…" : "Continue"}{" "}
                          <FiArrowRight className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={submitForReview}
                          disabled={saving || !canSubmit}
                          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#0D1282] px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0A0F6D] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:opacity-100"
                        >
                          {saving ? (
                            <>
                              <FiLoader className="h-4 w-4 animate-spin" />{" "}
                              Submitting…
                            </>
                          ) : (
                            <>
                              Submit for review{" "}
                              <FiArrowRight className="h-4 w-4" />
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </form>
              </main>
            </div>
          </div>
        </div>
      </div>

      {RECAPTCHA_SITE_KEY ? (
        <Script
          src={`https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`}
          strategy="afterInteractive"
        />
      ) : null}
    </>
  );
}
