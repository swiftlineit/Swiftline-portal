"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BusinessAccount,
  BusinessAccountFiles,
  BusinessAccountFormData,
  DocumentType,
  createBusinessAccount,
  createIdempotencyKey,
  emptyBusinessAddress,
  submitBusinessAccount,
  updateBusinessAccount,
  validateBusinessAccountUnique
} from "@/lib/businessAccounts";
import {
  businessAccountSteps,
  CompanyStep,
  ContactStep,
  DocumentsStep,
  ReviewStep,
  type UniqueField
} from "@/components/business-accounts/BusinessAccountFormSteps";
import type { FieldStatus } from "@/components/business-accounts/FormFieldControls";
import {
  emailValidationMessage,
  getPhoneValidationError,
  isValidBusinessContactEmail
} from "@/lib/businessAccountContactRules";
import {
  draftRequiredFieldKeys,
  fieldLabels,
  getStepIssues,
  isDraftSavable,
  isStepValid,
  stepFieldKeys,
  validateBusinessAccountForm
} from "@/lib/businessAccountValidation";
import { requestLeave, useUnsavedChanges } from "@/lib/useUnsavedChanges";
import { documentTooltips, reviewTooltips } from "@/lib/businessAccountTooltips";
import InfoTooltip from "@/components/ui/InfoTooltip";
import { isSensitiveUsTaxIdType, isUsTaxIdType, type UsTaxIdType } from "@/lib/usTaxId";

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
    shipmentTypes: ["international_courier"]
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
    requestedCreditLimit: ""
  },
  gstBilling: { requestedTreatment: "GST_APPLICABLE", requestReason: "" }
};

const duplicateMessages: Record<UniqueField, string> = {
  email: "Email address already exists.",
  mobileNumber: "Mobile number already exists.",
  registrationId: "Company registration ID already exists."
};

const maxDocumentSizeBytes = 5 * 1024 * 1024;
const allowedDocumentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const allowedDocumentExtensions = new Set(["pdf", "jpg", "jpeg", "png"]);

function normalizeShipmentTypes(values: string[]) {
  const firstValue = values[0];

  if (firstValue === "international_courier") {
    return ["international_courier"] as BusinessAccountFormData["contact"]["shipmentTypes"];
  }

  return ["international_cargo"] as BusinessAccountFormData["contact"]["shipmentTypes"];
}

function fromAccount(account?: BusinessAccount): BusinessAccountFormData {
  if (!account) return defaultFormData;

  return {
    contact: {
      ...defaultFormData.contact,
      ...account.contact,
      shipmentTypes: normalizeShipmentTypes(account.contact.shipmentTypes)
    },
    company: {
      ...account.company,
      registrationIdType: account.company.registrationIdType ?? defaultFormData.company.registrationIdType,
      gstExempt: account.company.gstExempt ?? false,
      gstExemptReason: account.company.gstExemptReason ?? "",
      secondaryRegistrationId: account.company.secondaryRegistrationId ?? "",
      noCompanyRegistration: account.company.noCompanyRegistration ?? false,
      noCompany: account.company.noCompany ?? false,
      companyType: account.company.companyType ?? "",
      website: account.company.website ?? "",
      addressCountry: account.company.addressCountry ?? account.company.registrationCountry ?? defaultFormData.company.addressCountry,
      useCompanyAddressAsBillingAddress: account.company.useCompanyAddressAsBillingAddress ?? true,
      addressLine2: account.company.addressLine2 ?? "",
      billingAddress: account.company.billingAddress ?? emptyBusinessAddress,
      operatingCountries: account.company.operatingCountries ?? (account.company.operatingCountry ? [account.company.operatingCountry] : []),
      requestedCreditCurrency: account.company.requestedCreditLimit.currency,
      requestedCreditLimit: account.company.requestedCreditLimit.amount?.toString() ?? ""
    },
    gstBilling: {
      requestedTreatment: account.gstBilling?.requestedTreatment ?? "GST_APPLICABLE",
      requestReason: account.gstBilling?.requestReason ?? ""
    }
  };
}

function getDocumentFileError(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isAllowedType = allowedDocumentTypes.has(file.type) || allowedDocumentExtensions.has(extension);

  if (!isAllowedType) return "Only PDF, JPG, JPEG, and PNG files are supported.";
  if (file.size <= 0) return "The selected file is empty or corrupted.";
  if (file.size > maxDocumentSizeBytes) return "File size must not exceed 5 MB.";

  return "";
}

export default function BusinessAccountForm({
  account,
  operatorSlug,
  operatorName
}: {
  account?: BusinessAccount;
  operatorSlug?: string;
  operatorName?: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<BusinessAccountFormData>(() => fromAccount(account));
  const [files, setFiles] = useState<BusinessAccountFiles>({});
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [documentErrors, setDocumentErrors] = useState<Partial<Record<DocumentType, string>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<UniqueField, string>>>({});
  const [validatingFields, setValidatingFields] = useState<Partial<Record<UniqueField, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const idempotencyKeyRef = useRef("");

  // Snapshot of the form as it was opened. Comparing against it means simply
  // clicking through the steps is not treated as an edit.
  const initialSnapshot = useMemo(() => JSON.stringify(fromAccount(account)), [account]);
  const hasUnsavedChanges = !persisted
    && (JSON.stringify(formData) !== initialSnapshot || Object.values(files).some(Boolean));

  const existingDocuments = account?.documents ?? {};
  const accountsHref = operatorSlug
    ? `/portal/${encodeURIComponent(operatorSlug)}/business-accounts`
    : "/dashboard/business-accounts";
  const steps = businessAccountSteps;
  const isEdit = Boolean(account);
  const isDraftEdit = account?.status === "draft";

  useUnsavedChanges(hasUnsavedChanges, {
    label: "this business account",
    // An account already under review has left draft for good, so there is
    // nothing to save it back to.
    saveDraft: !isEdit || isDraftEdit
      ? async () => {
        const saved = await saveAsDraft({ navigateAfterSave: false });
        // Rejecting keeps the user on the form; saveAsDraft has already set the
        // error message explaining why.
        if (!saved) throw new Error("Business account draft was not saved.");
      }
      : undefined
  });
  const isCheckingUnique = Object.values(validatingFields).some(Boolean);

  // The whole form's field state, recomputed on every keystroke. One call feeds
  // the live tick/warning on each control, the per-step gate, and the submit
  // gate, so the three cannot drift apart.
  const validation = useMemo(() => validateBusinessAccountForm(formData, {
    requireBillingAddressForNoCompany: Boolean(operatorSlug)
  }), [formData, operatorSlug]);

  // A field only turns red once the user has left it (or a button revealed the
  // whole step). Green needs no such gate- a tick the moment the value becomes
  // valid is helpful, whereas a red field mid-word is not.
  const validationErrors = useMemo(() => {
    const errors: Record<string, string> = {};

    for (const [key, field] of Object.entries(validation)) {
      if (touched[key] && field.error) errors[key] = field.error;
    }

    // The review checkbox lives outside the form data the rules cover.
    if (touched.confirmation && !confirmation) {
      errors.confirmation = "Please confirm the information has been reviewed.";
    }

    return errors;
  }, [validation, touched, confirmation]);

  const fieldStatus = useMemo(() => {
    const statuses: Record<string, FieldStatus> = {};

    for (const [key, field] of Object.entries(validation)) {
      if (validatingFields[key as UniqueField]) statuses[key] = "validating";
      else if (validationErrors[key] || fieldErrors[key as UniqueField]) statuses[key] = "invalid";
      else if (field.filled && !field.error) statuses[key] = "valid";
      else statuses[key] = "idle";
    }

    return statuses;
  }, [validation, validationErrors, fieldErrors, validatingFields]);

  // Warnings are advisory, so unlike errors they show as soon as they apply and
  // never wait for the field to be visited or gate the submit button.
  const fieldWarnings = useMemo(() => {
    const warnings: Record<string, string> = {};

    for (const [key, field] of Object.entries(validation)) {
      if (field.warning) warnings[key] = field.warning;
    }

    return warnings;
  }, [validation]);

  const hasUniqueConflict = Object.values(fieldErrors).some(Boolean);
  const documentsComplete = Boolean(files.aadhaarCard || existingDocuments.aadhaarCard)
    && Boolean(files.panCard || existingDocuments.panCard)
    && !Object.values(documentErrors).some(Boolean);
  const canLeaveStep = step === 2
    ? documentsComplete
    : step === 3
      ? true
      : isStepValid(validation, step) && !isCheckingUnique && !hasUniqueConflict;
  const canSubmit = isStepValid(validation, 0)
    && isStepValid(validation, 1)
    && documentsComplete
    && confirmation
    && !hasUniqueConflict
    && !isCheckingUnique;

  // Shown beside a disabled button so it never reads as broken. On a step the
  // user has not started, the empty form is its own explanation- listing every
  // field before they have typed anything reads as a wall of failures, so the
  // checklist waits until they have engaged with the step.
  const outstandingIssues = useMemo(() => {
    if (step === 2) return documentsComplete ? [] : ["Aadhaar Card and PAN Card Copy are required."];

    if (step === 3) {
      const issues = [0, 1].flatMap((stepIndex) =>
        getStepIssues(validation, stepIndex).map((key) => `${fieldLabels[key] ?? key}: ${validation[key].error}`)
      );

      if (!documentsComplete) issues.push("Aadhaar Card and PAN Card Copy are required.");
      if (!confirmation) issues.push("Confirm the information has been reviewed.");

      return issues;
    }

    const stepStarted = (stepFieldKeys[step] ?? []).some((key) => touched[key]);
    if (!stepStarted) return [];

    return getStepIssues(validation, step).map((key) => `${fieldLabels[key] ?? key}: ${validation[key].error}`);
  }, [step, validation, touched, documentsComplete, confirmation]);

  const documentFields = useMemo(() => [
    { type: "aadhaarCard" as DocumentType, required: true, helper: "Mandatory identity document for KYC verification.", info: documentTooltips.aadhaarCard },
    { type: "panCard" as DocumentType, required: true, helper: "Mandatory PAN document for KYC verification.", info: documentTooltips.panCard },
    { type: "adCertificate" as DocumentType, required: false, helper: "Optional supporting AD certificate for KYC review.", info: documentTooltips.adCertificate },
    { type: "msmeCertificate" as DocumentType, required: false, helper: "Optional MSME certificate, if applicable.", info: documentTooltips.msmeCertificate },
    { type: "tanCertificate" as DocumentType, required: false, helper: "Optional TAN certificate, if applicable.", info: documentTooltips.tanCertificate },
    { type: "gstCertificate" as DocumentType, required: false, helper: "Optional GST certificate, if applicable.", info: documentTooltips.gstCertificate },
    { type: "iecCertificate" as DocumentType, required: false, helper: "Optional IEC certificate, if applicable.", info: documentTooltips.iecCertificate },
    { type: "otherCertificate" as DocumentType, required: false, helper: "Optional supporting certificate or document.", info: documentTooltips.otherCertificate }
  ], []);

  // Marks fields as visited so their errors may be shown. Blur marks one field;
  // pressing a button marks a whole step.
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
    value: BusinessAccountFormData["contact"][Key]
  ) {
    if (key === "email" || key === "mobileNumber") {
      setFieldErrors((current) => ({ ...current, [key]: undefined }));
    }

    // A different dialling code makes the previous number check meaningless.
    if (key === "countryCode") {
      setFieldErrors((current) => ({ ...current, mobileNumber: undefined }));
    }

    setFormData((current) => ({
      ...current,
      contact: { ...current.contact, [key]: value }
    }));
  }

  function updateCompany<Key extends keyof BusinessAccountFormData["company"]>(
    key: Key,
    value: BusinessAccountFormData["company"][Key]
  ) {
    if (key === "registrationId") {
      setFieldErrors((current) => ({ ...current, registrationId: undefined }));
    }

    // Switching country replaces the registration format, so a conflict raised
    // against the old country's ID no longer applies.
    if (key === "registrationCountry") {
      setFieldErrors((current) => ({ ...current, registrationId: undefined }));
      setTouched((current) => ({ ...current, registrationId: false, secondaryRegistrationId: false }));
    }

    setFormData((current) => ({
      ...current,
      company: { ...current.company, [key]: value }
    }));
  }

  function updateGstBilling<Key extends keyof BusinessAccountFormData["gstBilling"]>(
    key: Key,
    value: BusinessAccountFormData["gstBilling"][Key]
  ) {
    setFormData((current) => ({
      ...current,
      gstBilling: { ...current.gstBilling, [key]: value }
    }));
  }

  function getUniqueFieldValue(field: UniqueField) {
    if (field === "email") return formData.contact.email.trim();
    if (field === "mobileNumber") return formData.contact.mobileNumber.trim();
    return formData.company.registrationId.trim();
  }

  async function validateUniqueField(field: UniqueField): Promise<boolean> {
    const value = getUniqueFieldValue(field);

    if (!value) {
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
      return true;
    }

    if (field === "email" && !isValidBusinessContactEmail(value)) {
      setFieldErrors((current) => ({ ...current, email: emailValidationMessage }));
      return false;
    }

    if (field === "mobileNumber") {
      const phoneError = getPhoneValidationError(formData.contact.countryCode, value);

      if (phoneError) {
        setFieldErrors((current) => ({ ...current, mobileNumber: phoneError }));
        return false;
      }
    }

    // A value that fails its format rule can never match an existing record, so
    // there is nothing to ask the server. The format message is already shown.
    if (field === "registrationId" && validation.registrationId?.error) return false;

    // A US SSN or ITIN is stored encrypted and never compared. Asking would also
    // turn this endpoint into a way to confirm whether a guessed SSN is on file.
    if (
      field === "registrationId"
      && formData.company.registrationCountry === "United States"
      && isUsTaxIdType(formData.company.registrationIdType ?? "")
      && isSensitiveUsTaxIdType(formData.company.registrationIdType as UsTaxIdType)
    ) {
      setFieldErrors((current) => ({ ...current, registrationId: undefined }));
      return true;
    }

    setValidatingFields((current) => ({ ...current, [field]: true }));

    try {
      const result = await validateBusinessAccountUnique({
        [field]: value,
        // The mobile-number check is scoped by country code, matching the server.
        ...(field === "mobileNumber" ? { countryCode: formData.contact.countryCode.trim() } : {}),
        ...(field === "registrationId" ? { registrationIdType: formData.company.registrationIdType ?? "" } : {}),
        excludeAccountId: account?.accountId
      }, operatorSlug);

      if (getUniqueFieldValue(field) !== value) return true;

      const hasConflict = result.conflicts[field];
      setFieldErrors((current) => ({
        ...current,
        [field]: hasConflict ? duplicateMessages[field] : undefined
      }));

      return !hasConflict;
    } catch {
      setFieldErrors((current) => ({
        ...current,
        [field]: "Unable to validate this value right now."
      }));
      return false;
    } finally {
      setValidatingFields((current) => ({ ...current, [field]: false }));
    }
  }

  async function validateStepUniqueFields(stepToValidate: number): Promise<boolean> {
    const fields: UniqueField[] = stepToValidate === 0
      ? ["email", "mobileNumber"]
      : stepToValidate === 1
        ? formData.company.registrationId.trim() ? ["registrationId"] : []
        : [];

    if (!fields.length) return true;

    const results = await Promise.all(fields.map((field) => validateUniqueField(field)));
    const isValid = results.every(Boolean);

    if (!isValid) {
      setError("Please fix the highlighted duplicate fields before continuing.");
    }

    return isValid;
  }

  function updateShipmentType(value: string) {
    updateContact("shipmentTypes", [value] as BusinessAccountFormData["contact"]["shipmentTypes"]);
  }

  function handleDocumentChange(type: DocumentType, file: File | null) {
    if (!file) {
      setFiles((current) => ({ ...current, [type]: null }));
      setDocumentErrors((current) => ({ ...current, [type]: undefined }));
      return;
    }

    const fileError = getDocumentFileError(file);

    if (fileError) {
      setFiles((current) => ({ ...current, [type]: null }));
      setDocumentErrors((current) => ({ ...current, [type]: fileError }));
      return;
    }

    setFiles((current) => ({ ...current, [type]: file }));
    setDocumentErrors((current) => ({ ...current, [type]: undefined }));
  }

  function getDocumentValidationErrors() {
    const nextErrors: Partial<Record<DocumentType, string>> = { ...documentErrors };

    if (!files.aadhaarCard && !existingDocuments.aadhaarCard) {
      nextErrors.aadhaarCard = "Aadhaar Card is required.";
    }

    if (!files.panCard && !existingDocuments.panCard) {
      nextErrors.panCard = "PAN Card Copy is required.";
    }

    return nextErrors;
  }

  async function validateStep(stepToValidate: number, { fieldsRequiredForDraft = false } = {}) {
    setError("");

    // A draft only has to carry the identity fields, so the usual step gates are
    // bypassed in favour of that smaller set.
    if (fieldsRequiredForDraft) {
      for (const key of draftRequiredFieldKeys) markTouched(key);

      if (!isDraftSavable(validation)) {
        setError("Enter the contact name, email, and mobile number before saving a draft.");
        return false;
      }

      return validateStepUniqueFields(0);
    }

    if (stepToValidate === 2) {
      const nextDocumentErrors = getDocumentValidationErrors();
      setDocumentErrors(nextDocumentErrors);

      if (Object.values(nextDocumentErrors).some(Boolean)) {
        setError("Please fix the highlighted document issues before continuing.");
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

      return true;
    }

    // Reveals the step's messages, then reads the shared rules rather than
    // re-deriving them here.
    markStepTouched(stepToValidate);

    if (!isStepValid(validation, stepToValidate)) {
      setError("Please fill the highlighted fields before continuing.");
      return false;
    }

    return validateStepUniqueFields(stepToValidate);
  }

  async function submitForReview() {
    for (const stepToValidate of [0, 1, 2, 3]) {
      if (!(await validateStep(stepToValidate))) {
        setStep(stepToValidate);
        return;
      }
    }

    setSaving(true);

    try {
      // Held in a ref so a retry after a network failure reuses the same key and
      // the server recognises it as the same submission, not a new one.
      idempotencyKeyRef.current ||= createIdempotencyKey();

      const result = isEdit && account
        ? await updateBusinessAccount(account.accountId, formData, files)
        : await createBusinessAccount(formData, files, idempotencyKeyRef.current, {
          ...(operatorSlug ? { saveAsDraft: true, operatorSlug } : {})
        });

      // Saved on the server from here on, so leaving no longer loses anything-
      // including on the submit-failure path below, which navigates away.
      setPersisted(true);

      if (!operatorSlug && (!isEdit || isDraftEdit)) {
        try {
          await submitBusinessAccount(result.account.accountId);
        } catch (submitError) {
          // The account (or draft) was already saved. Navigate to it so the record
          // is not stranded- a retry from the form would hit a duplicate conflict
          // and the user could never move past it.
          router.push(`/dashboard/business-accounts/${result.account.accountId}`);
          throw submitError;
        }
      }

      router.push(accountsHref);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to save business account.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Stores the form without submitting it for review.
   *
   * Only the contact identity fields are required, matching the relaxed schema
   * the server applies to drafts- the account keeps its `draft` status and the
   * accounts table offers "Submit for Review" when it is complete.
   *
   * Returns whether it was saved, so the leave prompt can keep the user on the
   * form when it was not.
   */
  async function saveAsDraft({ navigateAfterSave = true } = {}): Promise<boolean> {
    // The identity fields are what the server needs to de-duplicate the account,
    // so they are the one thing a draft cannot skip.
    // Lock operator draft saves while their required identity checks are running
    // so a second click cannot submit the same form concurrently.
    const isOperatorDraft = Boolean(operatorSlug);
    if (isOperatorDraft) {
      setSavingDraft(true);
      setError("");
    }

    if (!(await validateStep(0, { fieldsRequiredForDraft: true }))) {
      setStep(0);
      if (isOperatorDraft) setSavingDraft(false);
      return false;
    }

    if (!isOperatorDraft) {
      setSavingDraft(true);
      setError("");
    }

    try {
      idempotencyKeyRef.current ||= createIdempotencyKey();

      if (isEdit && account) {
        await updateBusinessAccount(account.accountId, formData, files, { saveAsDraft: true });
      } else {
        await createBusinessAccount(formData, files, idempotencyKeyRef.current, {
          saveAsDraft: true,
          ...(operatorSlug ? { operatorSlug } : {})
        });
      }

      setPersisted(true);
      // Back to the list, not the account page. A draft is an unfinished form,
      // not an onboarded customer, and landing on its detail page reads as though
      // a real account had just been created.
      if (navigateAfterSave) router.push(accountsHref);
      return true;
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to save this draft.");
      return false;
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await validateStep(step))) return;
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  async function handleStepNavigation(nextStep: number) {
    if (nextStep <= step) {
      setStep(nextStep);
      return;
    }

    for (let stepToValidate = step; stepToValidate < nextStep; stepToValidate += 1) {
      if (!(await validateStep(stepToValidate))) {
        setStep(stepToValidate);
        return;
      }
    }

    setStep(nextStep);
  }

  return (
    <div className="mx-auto w-full max-w-8xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="border-l-4 border-[#F0DE36] pl-4">
          <h2 className="mb-2 text-3xl font-bold tracking-tight text-[#0D1282] sm:text-4xl">Let&apos;s Get Started</h2>
          <p className="text-sm leading-6 text-slate-500">
            Enter your {steps[step]}. Fields marked with asterisk (<span className="text-[#D71313]">*</span>) are mandatory.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            // Goes through the shared prompt so Cancel offers to keep the work
            // as a draft, exactly as leaving via the sidebar does.
            void requestLeave().then((canLeave) => {
              if (canLeave) router.push(accountsHref);
            });
          }}
          className="rounded-xl border border-[#EEEDED] bg-white px-4 py-2.5 text-sm font-semibold text-[#0D1282] shadow-sm transition hover:border-[#0D1282]/30 hover:bg-[#EEEDED]/60 focus:outline-none focus:ring-2 focus:ring-[#F0DE36]/40"
        >
          Cancel
        </button>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-1 rounded-2xl bg-[#EEEDED]/70 p-1 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((label, index) => {
          const isCurrent = step === index;
          const isCompleted = index < step;

          return (
            <button
              key={label}
              type="button"
              onClick={() => void handleStepNavigation(index)}
              className={`rounded-xl px-4 py-3 text-left text-sm font-semibold transition-all ${
                isCurrent
                  ? "bg-[#0D1282] text-white shadow-sm"
                  : isCompleted
                    ? "bg-[#F0DE36] text-[#0D1282]"
                    : "text-slate-600 hover:bg-white hover:text-[#0D1282]"
              }`}
            >
              {index + 1}. {label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="mb-5 rounded-2xl border border-[#D71313]/20 bg-[#D71313]/5 px-4 py-3 text-sm font-semibold text-[#D71313]">
          {error}
        </div>
      ) : null}

      <form noValidate onSubmit={handleContinue} className="rounded-3xl bg-white p-5 shadow-[0_16px_45px_rgba(13,18,130,0.08)] ring-1 ring-[#EEEDED] sm:p-7">
        {step === 0 ? (
          <ContactStep
            formData={formData}
            validationErrors={validationErrors}
            fieldStatus={fieldStatus}
            fieldErrors={fieldErrors}
            validatingFields={validatingFields}
            onContactChange={updateContact}
            onShipmentTypeChange={updateShipmentType}
            onValidateUniqueField={validateUniqueField}
            onFieldBlur={markTouched}
            operatorDraftMode={Boolean(operatorSlug)}
          />
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
            onGstBillingChange={updateGstBilling}
            onValidateUniqueField={validateUniqueField}
            onFieldBlur={markTouched}
            operatorBillingAddressForNoCompany={Boolean(operatorSlug)}
          />
        ) : null}

        {step === 2 ? (
          <DocumentsStep
            documentFields={documentFields}
            existingDocuments={existingDocuments}
            files={files}
            documentErrors={documentErrors}
            onDocumentChange={handleDocumentChange}
          />
        ) : null}

        {step === 3 ? (
          <ReviewStep
            formData={formData}
            documentFields={documentFields}
            existingDocuments={existingDocuments}
            files={files}
            confirmation={confirmation}
            validationErrors={validationErrors}
            onConfirmationChange={setConfirmation}
            onEditStep={setStep}
            operatorName={operatorName}
          />
        ) : null}

        {/* The forward button is disabled until the step is valid, so the reason
            has to be on screen- otherwise it just looks broken. */}
        {outstandingIssues.length ? (
          <div className="mt-8 rounded-2xl border border-[#F0DE36] bg-[#F0DE36]/10 px-4 py-3">
            <p className="text-sm font-bold text-[#0D1282]">
              {step === 3 ? operatorSlug ? "Complete these before saving the account" : "Complete these before submitting" : "Complete these to continue"}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {outstandingIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-8 flex flex-wrap justify-between gap-3 border-t border-[#EEEDED] pt-5">
          <button
            type="button"
            onClick={() => setStep((current) => Math.max(current - 1, 0))}
            disabled={step === 0 || saving}
            className="rounded-xl border border-[#EEEDED] bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282]/25 hover:text-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#F0DE36]/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          <div className="flex gap-3">
            {/* Available on every step, unlike Continue: the point of a draft is
                to leave from wherever you happen to be. Hidden once the account
                is past review, where there is no draft state to return to. */}
            {!isEdit || isDraftEdit ? (
              <button
                type="button"
                onClick={() => void saveAsDraft()}
                disabled={saving || savingDraft || isCheckingUnique || !isDraftSavable(validation)}
                title={isDraftSavable(validation)
                  ? undefined
                  : "Enter the contact name, email, and mobile number first."}
                className="rounded-xl border border-[#EEEDED] bg-white px-4 py-2.5 text-sm font-semibold text-[#0D1282] shadow-sm transition hover:border-[#0D1282]/30 hover:bg-[#EEEDED]/60 focus:outline-none focus:ring-2 focus:ring-[#F0DE36]/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingDraft ? "Saving..." : "Save as Draft"}
              </button>
            ) : null}
            {step < steps.length - 1 ? (
              <button
                type="submit"
                disabled={saving || savingDraft || isCheckingUnique || !canLeaveStep}
                className="rounded-xl bg-[#0D1282] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0D1282]/90 focus:outline-none focus:ring-2 focus:ring-[#F0DE36]/50 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#0D1282]/55"
              >
                {isCheckingUnique ? "Checking..." : "Continue"}
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
              <InfoTooltip text={operatorSlug ? "Saves this business account as a draft in your operator workspace." : reviewTooltips.submit} />
              <button
                type="button"
                onClick={submitForReview}
                disabled={saving || isCheckingUnique || !canSubmit}
                className="rounded-xl bg-[#0D1282] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0D1282]/90 focus:outline-none focus:ring-2 focus:ring-[#F0DE36]/50 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#0D1282]/55"
              >
                {saving
                  ? operatorSlug || isEdit && !isDraftEdit ? "Saving..." : "Submitting..."
                  : isCheckingUnique ? "Checking..."
                    : operatorSlug ? "Create Draft" : isEdit && !isDraftEdit ? "Save Changes" : "Submit for Review"}
              </button>
              </span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
