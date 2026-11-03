"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { FiChevronDown, FiExternalLink, FiFileText, FiInfo, FiUpload, FiX } from "react-icons/fi";
import { AddressAutocompleteField } from "@/components/business-accounts/AddressAutocompleteField";
import { BranchFileLink, BranchImage } from "@/components/branches/BranchFileView";
import type { LookupAddress } from "@/lib/addressLookup";
import {
  BranchDocument,
  BranchFormData,
  BranchImageRef,
  BranchPhoneNumber,
  BranchService,
  BranchStatus,
  ShipmentCoverage,
  WorkingDay,
  branchDocumentUrl,
  branchImageUrl,
  branchServices,
  countryOptions,
  createBranch,
  currencyOptions,
  deleteBranchDocument,
  deleteBranchImage,
  formatBranchLabel,
  shipmentCoverageTypes,
  updateBranch,
  updateBranchStatus,
  uploadBranchDocument,
  uploadBranchImages,
  validateBranchCode,
  validateBranchCodeForEdit,
  workingDays
} from "@/lib/branches";
import { GSTIN_EXAMPLE, GSTIN_LENGTH, getGstinError, getGstinStateName, normalizeGstin } from "@/lib/gstin";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";

type FormErrors = Partial<Record<string, string>>;
type FieldKey =
  | "name"
  | "code"
  | "labelCode"
  | "country"
  | "city"
  | "postalCode"
  | "address"
  | "email"
  | "phone"
  | "supportedServices"
  | "shipmentCoverage"
  | "operatingCountries"
  | "baseCurrency"
  | "workingDays"
  | "policyAccepted"
  | "phoneNumber0"
  | "phoneNumber1"
  | "phoneNumber2";
type ValidationLevel = "DRAFT" | "ACTIVE";
// draft  → save without activating
// activate → create as active, or save edits and then activate
// save   → persist edits to an existing non-draft branch (status unchanged)
type SubmitMode = "draft" | "activate" | "save";

const initialForm: BranchFormData = {
  name: "",
  code: "",
  labelCode: "",
  openingDate: "",
  description: "",
  address: {
    countryCode: "IN",
    countryName: "India",
    city: "",
    stateOrProvince: "",
    postalCode: "",
    address: ""
  },
  contact: {
    email: "",
    phone: ""
  },
  operations: {
    supportedServices: [],
    shipmentCoverage: [],
    operatingCountries: [],
    workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  },
  baseCurrency: "",
  gstin: "",
  invoiceSacCode: "",
  phoneNumbers: [
    { label: "", number: "" },
    { label: "", number: "" },
    { label: "", number: "" }
  ],
  existingImages: [],
  existingDocuments: []
};

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const branchImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const branchDocumentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

function normalizeBranchCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20);
}

function normalizeLabelCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string) {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

function isDomesticOnlyCoverage(coverage: ShipmentCoverage[]) {
  return coverage.length === 1 && coverage[0] === "DOMESTIC";
}

function validateForm(data: BranchFormData, level: ValidationLevel, codeExists: boolean | null): FormErrors {
  const errors: FormErrors = {};

  if (data.name.trim().length < 3) errors.name = "Branch name must be at least 3 characters.";
  if (!/^[A-Z0-9-]{3,20}$/.test(data.code)) errors.code = "Use 3-20 uppercase letters, numbers, or hyphens.";
  if (level === "ACTIVE" && !/^[A-Z]{3}$/.test(data.labelCode)) errors.labelCode = "Use exactly 3 uppercase letters, for example DEL.";
  if (codeExists) errors.code = "This branch code already exists.";

  // Drafts may omit contact details, but anything entered must still match the
  // API contract so a draft never fails with an avoidable server-side error.
  if (data.contact.email.trim() && !isValidEmail(data.contact.email)) errors.email = "Enter a valid email address.";
  if (data.contact.phone.trim() && !isValidPhone(data.contact.phone)) errors.phone = "Use international format, for example +919876543210.";
  data.phoneNumbers.forEach((phoneNumber, index) => {
    if (phoneNumber.number.trim() && !isValidPhone(phoneNumber.number)) {
      errors[`phoneNumber${index}`] = "Enter a valid phone number with country code.";
    }
  });

  if (level === "DRAFT") return errors;

  // Active branches must be operationally usable, while drafts can stay incomplete.
  if (!data.address.countryCode) errors.country = "Country is required.";
  if (!data.address.city.trim()) errors.city = "City is required.";
  if (!data.address.postalCode.trim()) errors.postalCode = "Postal code is required.";
  if (!data.address.address.trim()) errors.address = "Address is required.";
  if (!isValidEmail(data.contact.email)) errors.email = "Enter a valid email address.";
  if (!isValidPhone(data.contact.phone)) errors.phone = "Use international format, for example +919876543210.";
  if (data.operations.supportedServices.length === 0) errors.supportedServices = "Select at least one service.";
  if (data.operations.shipmentCoverage.length === 0) errors.shipmentCoverage = "Select at least one coverage type.";
  if (!data.baseCurrency) errors.baseCurrency = "Base currency is required.";
  if (data.operations.workingDays.length === 0) errors.workingDays = "Select at least one working day.";
  // Domestic-only branches infer their country from their address; anything
  // crossing borders must state where it operates.
  if (!isDomesticOnlyCoverage(data.operations.shipmentCoverage) && data.operations.operatingCountries.length === 0) {
    errors.operatingCountries = "Select at least one operating country for international coverage.";
  }
  // Indian branches need a GSTIN or invoice generation fails after the fact, and
  // a malformed one fails just as badly, so it gets the full format check.
  if (data.address.countryCode === "IN" && !data.gstin.trim()) {
    errors.gstin = "GSTIN is required for Indian branches.";
  } else {
    const gstinError = getGstinError(data.gstin);
    if (gstinError) errors.gstin = gstinError;
  }

  // Branches being activated must have PAN and GST documents uploaded.
  // Documents are validated during upload flow, not here.

  return errors;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="mt-1.5 text-xs font-semibold text-[#D71313]">{message}</p> : null;
}

function RequiredMark() {
  return <span className="text-[#D71313]">*</span>;
}

const fieldClasses = "mt-2 block h-11 w-full rounded-xl border bg-white px-3.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:ring-2";
const fieldToneClasses = (hasError?: string) => hasError
  ? "border-[#D71313] focus:border-[#D71313] focus:ring-[#D71313]/15"
  : "border-slate-200 focus:border-[#0D1282] focus:ring-[#0D1282]/15";

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <span
        tabIndex={0}
        aria-label={text}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 outline-none transition hover:text-[#0D1282] focus-visible:ring-2 focus-visible:ring-[#0D1282]/20"
      >
        <FiInfo aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 hidden w-64 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-left text-xs font-normal leading-5 text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}

function FieldLabel({ label, required, info }: { label: string; required?: boolean; info?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
      <span>{label} {required ? <RequiredMark /> : null}</span>
      {info ? <InfoTooltip text={info} /> : null}
    </span>
  );
}

function TextField({
  label,
  required,
  error,
  helper,
  info,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; required?: boolean; error?: string; helper?: string; info?: string }) {
  return (
    <label className="block">
      <FieldLabel label={label} required={required} info={info} />
      <input
        {...props}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        className={`${fieldClasses} ${fieldToneClasses(error)} disabled:cursor-not-allowed disabled:bg-[#EEEDED]/60 disabled:text-slate-500`}
      />
      <FieldError message={error} />
      {!error && helper ? <p className="mt-1.5 text-xs font-medium text-slate-500">{helper}</p> : null}
    </label>
  );
}

function TextAreaField({
  label,
  required,
  error,
  value,
  onChange,
  maxLength
}: {
  label: string;
  required?: boolean;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} required={required} />
      <textarea
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 block min-h-24 w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:ring-2 ${fieldToneClasses(error)}`}
      />
      <FieldError message={error} />
    </label>
  );
}

function PhoneField({
  label,
  required,
  value,
  error,
  onBlur,
  onChange
}: {
  label: string;
  required?: boolean;
  value: string;
  error?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} required={required} />
      <input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={value || "+91"}
        onChange={(event) => {
          const next = event.target.value.replace(/[^+0-9]/g, "");
          onChange(next === "+91" ? "" : next);
        }}
        onBlur={onBlur}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        placeholder="+919876543210"
        className={`${fieldClasses} ${fieldToneClasses(error)}`}
      />
      <FieldError message={error} />
    </label>
  );
}

function NativeSelect({
  label,
  required,
  value,
  options,
  placeholder,
  error,
  info,
  onChange
}: {
  label: string;
  required?: boolean;
  value: string;
  options: { value: string; label: string; helper?: string }[];
  placeholder: string;
  error?: string;
  info?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} required={required} info={info} />
      <span className="relative mt-2 block">
        <select
          value={value}
          required={required}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`block h-11 w-full appearance-none rounded-xl border bg-white px-3.5 pr-12 text-sm text-slate-900 shadow-sm outline-none transition focus:ring-2 ${fieldToneClasses(error)}`}
        >
          <option value="" disabled>{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}{option.helper ? ` (${option.helper})` : ""}
            </option>
          ))}
        </select>
        <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      </span>
      <FieldError message={error} />
    </label>
  );
}

function CheckboxGroup<T extends string>({
  label,
  required,
  values,
  options,
  error,
  searchable = false,
  info,
  onChange
}: {
  label: string;
  required?: boolean;
  values: T[];
  options: { value: T; label: string }[];
  error?: string;
  searchable?: boolean;
  info?: string;
  onChange: (values: T[]) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleOptions = options.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <fieldset>
      <legend><FieldLabel label={label} required={required} info={info} /></legend>
      <div className={`mt-2 rounded-xl border bg-white p-3 ${error ? "border-[#D71313]" : "border-slate-200"}`}>
        {searchable ? (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search countries"
            className="mb-3 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
          />
        ) : null}
        <div className={`${searchable ? "max-h-56 overflow-y-auto pr-1" : ""} grid gap-2 sm:grid-cols-2`}>
          {visibleOptions.map((option) => {
            const checked = values.includes(option.value);
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition ${
                  checked
                    ? "border-[#0D1282]/40 bg-[#0D1282]/5 font-semibold text-[#0D1282]"
                    : "border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onChange(event.target.checked
                    ? [...values, option.value]
                    : values.filter((current) => current !== option.value))}
                  className="h-4 w-4 rounded border-slate-300 accent-[#0D1282]"
                />
                <span>{option.label}</span>
              </label>
            );
          })}
          {!visibleOptions.length ? <p className="py-3 text-sm text-slate-500">No countries found.</p> : null}
        </div>
      </div>
      <FieldError message={error} />
    </fieldset>
  );
}

function LocalFileCard({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [previewUrl] = useState(() => URL.createObjectURL(file));
  const isImage = file.type.startsWith("image/");

  useEffect(() => {
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-slate-500">
        {isImage && previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <FiFileText aria-hidden="true" className="h-6 w-6" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-800">{file.name}</p>
        <p className="mt-0.5 text-xs text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <a
          href={previewUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!previewUrl || undefined}
          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-semibold text-[#0D1282] hover:bg-[#0D1282]/5 ${previewUrl ? "" : "pointer-events-none opacity-50"}`}
        >
          <FiExternalLink aria-hidden="true" className="h-3.5 w-3.5" /> Preview
        </a>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#D71313] hover:bg-red-50"
        >
          <FiX className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function FormSection({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="border-b border-slate-100 pb-4">
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default function BranchForm({
  branchId,
  initialData,
  initialStatus = "DRAFT",
  identityLocked = false,
  operatorSlug
}: {
  branchId?: string;
  initialData?: BranchFormData;
  initialStatus?: BranchStatus;
  operatorSlug?: string;
  // True once the branch has been activated: its code and station code are baked
  // into issued tracking numbers and can no longer change.
  identityLocked?: boolean;
}) {
  const router = useRouter();
  const isEditMode = Boolean(branchId);
  const [form, setForm] = useState<BranchFormData>(initialData ?? initialForm);
  const [branchPersisted, setBranchPersisted] = useState(false);
  // Snapshot of the form as opened, so browsing without editing is not treated
  // as unsaved work.
  const branchSnapshot = useMemo(() => JSON.stringify(initialData ?? initialForm), [initialData]);

  useUnsavedChanges(!branchPersisted && JSON.stringify(form) !== branchSnapshot, {
    label: "this branch",
    // An already-activated branch has no draft state to fall back to, so the
    // leave prompt offers only discard-or-stay there.
    saveDraft: !isEditMode || initialStatus === "DRAFT"
      ? async () => {
        const saved = await handleSubmit("draft", { navigateAfterSave: false });
        // Rejecting keeps the user on the form; handleSubmit has already
        // explained what went wrong.
        if (!saved) throw new Error("Branch draft was not saved.");
      }
      : undefined
  });
  const [codeExists, setCodeExists] = useState<boolean | null>(null);
  const [savingMode, setSavingMode] = useState<SubmitMode | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [documentFiles, setDocumentFiles] = useState<{
    pan?: File;
    gst?: File;
    other?: { title: string; file: File };
  }>({});
  const [uploading, setUploading] = useState(false);
  const [existingImages, setExistingImages] = useState<BranchImageRef[]>(initialData?.existingImages ?? []);
  const [existingDocuments, setExistingDocuments] = useState<BranchDocument[]>(initialData?.existingDocuments ?? []);
  const [deletingImages, setDeletingImages] = useState<Set<number>>(new Set());
  const [deletingDocs, setDeletingDocs] = useState<Set<number>>(new Set());

  const countrySelectOptions = useMemo(
    () => countryOptions.map((country) => ({ value: country.code, label: country.name, helper: country.code })),
    []
  );
  const currencySelectOptions = useMemo(
    () => currencyOptions.map((currency) => ({ value: currency, label: currency })),
    []
  );
  const activeErrors = validateForm(form, "ACTIVE", codeExists);
  const visibleErrors = Object.fromEntries(
    Object.entries(activeErrors).filter(([field]) => submitAttempted || touchedFields[field as FieldKey])
  ) as FormErrors;
  const gstinStateName = getGstinStateName(form.gstin);

  useEffect(() => {
    if (!form.code || !/^[A-Z0-9-]{3,20}$/.test(form.code)) {
      return;
    }

    // Cancelled on cleanup so a slow response for an earlier code can never
    // overwrite the result for the code currently in the box.
    let cancelled = false;

    const timeout = window.setTimeout(async () => {
      try {
        const result = branchId
          ? await validateBranchCodeForEdit(form.code, branchId, operatorSlug)
          : await validateBranchCode(form.code, operatorSlug);
        if (!cancelled) setCodeExists(result.exists);
      } catch {
        if (!cancelled) setCodeExists(null);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [branchId, form.code, operatorSlug]);

  function updateForm(update: Partial<BranchFormData>) {
    setForm((current) => ({ ...current, ...update }));
  }

  function markTouched(field: FieldKey) {
    setTouchedFields((current) => ({ ...current, [field]: true }));
  }

  function updateAddress(update: Partial<BranchFormData["address"]>) {
    setForm((current) => ({ ...current, address: { ...current.address, ...update } }));
  }

  // Fills the address fields from a picked suggestion. The lookup does not know
  // the branch's state list, so the provider's spelling is kept as-is and the
  // user can still correct it manually.
  function applyLookupToAddress(address: LookupAddress) {
    const fullAddress = [address.addressLine1, address.addressLine2]
      .filter(Boolean)
      .join(", ");

    updateAddress({
      address: fullAddress || form.address.address,
      city: address.city || form.address.city,
      stateOrProvince: address.state || form.address.stateOrProvince,
      postalCode: address.postalCode || form.address.postalCode,
      countryCode: address.countryCode || form.address.countryCode,
      countryName: address.countryName || form.address.countryName
    });
    markTouched("country");
    markTouched("address");
    markTouched("city");
    markTouched("postalCode");
  }

  function updateContact(update: Partial<BranchFormData["contact"]>) {
    setForm((current) => ({ ...current, contact: { ...current.contact, ...update } }));
  }

  function updateOperations(update: Partial<BranchFormData["operations"]>) {
    setForm((current) => ({ ...current, operations: { ...current.operations, ...update } }));
  }

  function updatePhoneNumber(index: number, update: Partial<BranchPhoneNumber>) {
    setForm((current) => {
      const next = [...current.phoneNumbers];
      next[index] = { ...next[index], ...update };
      return { ...current, phoneNumbers: next };
    });
  }

  function handleImageSelect(files: FileList | null) {
    if (!files) return;
    const selectedFiles = Array.from(files);
    const invalidType = selectedFiles.find((file) => !branchImageTypes.has(file.type));
    const oversized = selectedFiles.find((file) => file.size > MAX_UPLOAD_SIZE);

    if (invalidType) {
      toast.error(`${invalidType.name} is not a supported image. Use JPG, PNG, GIF, or WebP.`);
      return;
    }
    if (oversized) {
      toast.error(`${oversized.name} is larger than 5 MB.`);
      return;
    }

    const availableSlots = Math.max(5 - existingImages.length - imageFiles.length, 0);
    if (!availableSlots) {
      toast.error("A branch can have a maximum of 5 images.");
      return;
    }

    const newFiles = selectedFiles.slice(0, availableSlots);
    const combined = [...imageFiles, ...newFiles];
    setImageFiles(combined);
    setImagePreviews((prev) => {
      prev.forEach((url) => URL.revokeObjectURL(url));
      return combined.map((file) => URL.createObjectURL(file));
    });
    toast.success(`${newFiles.length} branch image${newFiles.length === 1 ? "" : "s"} selected successfully.`);
    if (newFiles.length < selectedFiles.length) toast.error("Only 5 branch images can be uploaded.");
  }

  function removeImage(index: number) {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
    setImagePreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
  }

  function handleDocumentSelect(type: "pan" | "gst" | "other", file: File | null, title?: string) {
    if (!file) {
      setDocumentFiles((prev) => {
        const next = { ...prev };
        delete next[type];
        return next;
      });
      return;
    }

    if (!branchDocumentTypes.has(file.type)) {
      toast.error(`${file.name} is not supported. Use PDF, JPG, or PNG.`);
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      toast.error(`${file.name} is larger than 5 MB.`);
      return;
    }

    const isNewFile = type === "other"
      ? documentFiles.other?.file !== file
      : documentFiles[type] !== file;
    setDocumentFiles((prev) => {
      if (type === "other") {
        return { ...prev, other: { title: title ?? "", file } };
      }
      return { ...prev, [type]: file };
    });
    if (isNewFile) toast.success(`${file.name} selected successfully.`);
  }

  /**
   * Saves the form. Returns whether it was persisted.
   *
   * `navigateAfterSave` is off when the save is driven by the leave prompt: that
   * flow already has a destination in mind, and pushing to the branch page first
   * would bounce the user somewhere they did not ask to go.
   */
  async function handleSubmit(mode: SubmitMode, { navigateAfterSave = true } = {}): Promise<boolean> {
    // The policy is accepted once, at activation. Editing an already-active (or
    // previously-activated) branch must not demand a second acceptance, so only
    // actual activations gate on it.
    const requiresPolicyAcceptance = mode === "activate";

    // A non-draft branch must stay operationally complete after an edit, or it
    // could no longer be reactivated. Drafts can stay incomplete, which is why
    // create-as-draft and save-draft run only the light checks.
    const requiresActiveValidation = mode === "activate" || (mode === "save" && initialStatus !== "DRAFT");

    if (requiresPolicyAcceptance && !policyAccepted) {
      setSubmitAttempted(true);
      toast.error("Please accept the branch operating policy.");
      return false;
    }

    const errors = validateForm(form, requiresActiveValidation ? "ACTIVE" : "DRAFT", codeExists);

    if (Object.keys(errors).length) {
      setSubmitAttempted(true);
      setTouchedFields((current) => ({
        ...current,
        ...Object.fromEntries(Object.keys(errors).map((field) => [field, true]))
      }));
      toast.error("Please fix the highlighted fields before saving.");
      return false;
    }

    setSavingMode(mode);
    setUploading(true);

    try {
      let branch;

      if (!branchId) {
        const result = await createBranch(form, mode === "activate" ? "ACTIVE" : "DRAFT", operatorSlug);
        branch = result.branch;
      } else {
        const result = await updateBranch(branchId, form, operatorSlug);
        branch = result.branch;

        if (mode === "activate") {
          const statusResult = await updateBranchStatus(branchId, "ACTIVE", operatorSlug);
          branch = statusResult.branch;
        }
      }

      // The branch record itself is saved. File uploads are separate requests, so
      // a failure there must not be reported as "the branch could not be saved".
      try {
        if (imageFiles.length) {
          branch = (await uploadBranchImages(branch._id, imageFiles, operatorSlug)).branch;
          toast.success("Branch images uploaded successfully.");
        }

        // Each upload is a read-modify-write of the same documents array on the
        // server, so they run in sequence; in parallel they overwrite each other
        // and only the last one to save would survive.
        if (documentFiles.pan) {
          branch = (await uploadBranchDocument(branch._id, "PAN", "PAN Card", documentFiles.pan, operatorSlug)).branch;
          toast.success("PAN document uploaded successfully.");
        }
        if (documentFiles.gst) {
          branch = (await uploadBranchDocument(branch._id, "GST", "GST Certificate", documentFiles.gst, operatorSlug)).branch;
          toast.success("GST document uploaded successfully.");
        }
        if (documentFiles.other) {
          branch = (await uploadBranchDocument(branch._id, "OTHER", documentFiles.other.title, documentFiles.other.file, operatorSlug)).branch;
          toast.success("Additional document uploaded successfully.");
        }
      } catch (uploadError) {
        // Clear what was already persisted so a retry does not re-upload it, and
        // keep the user on the form to fix the offending file.
        setImageFiles([]);
        setImagePreviews((previews) => {
          previews.forEach((url) => URL.revokeObjectURL(url));
          return [];
        });
        setDocumentFiles({});
        setExistingImages(branch.images ?? []);
        setExistingDocuments(branch.documents ?? []);
        toast.error(
          uploadError instanceof Error
            ? `Branch saved, but a file upload failed: ${uploadError.message}`
            : "Branch saved, but a file upload failed."
        );
        // The branch itself is stored, so the form is no longer unsaved work-
        // but the user must stay to fix the file.
        setBranchPersisted(true);
        return false;
      }

      toast.success(mode === "draft" ? "Branch saved as draft." : "Branch saved successfully.");
      // Saved on the server, so leaving no longer loses anything.
      setBranchPersisted(true);
      if (navigateAfterSave) {
        // A draft goes back to the list, where its row carries the edit action
        // that resumes it. Only a real save opens the branch itself.
        const branchListPath = operatorSlug
          ? `/portal/${encodeURIComponent(operatorSlug)}/branches`
          : "/dashboard/branches";
        router.push(operatorSlug || mode === "draft" ? branchListPath : `/dashboard/branches/${branch._id}`);
      }
      return true;
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Unable to save branch.");
      return false;
    } finally {
      setSavingMode(null);
      setUploading(false);
    }
  }

  const saving = savingMode !== null || uploading;
  const secondaryButtonClasses = "rounded-4xl border border-[#EEEDED] bg-white px-4 py-2.5 text-sm font-semibold text-[#0D1282] shadow-sm transition hover:bg-[#EEEDED]/60 disabled:cursor-not-allowed disabled:opacity-50";
  const primaryButtonClasses = "rounded-4xl bg-[#0D1282] px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-6">
      <FormSection title="Basic Details" description="Branch identity and the station code used to build tracking numbers.">
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            label="Branch Name"
            required
            value={form.name}
            onChange={(event) => {
              markTouched("name");
              updateForm({ name: event.target.value });
            }}
            error={visibleErrors.name}
          />
          <TextField
            label="Branch Code"
            required
            info="Internal unique code used to identify this branch in the portal."
            value={form.code}
            disabled={identityLocked}
            helper={identityLocked ? "Locked: the branch has been activated." : undefined}
            onChange={(event) => {
              markTouched("code");
              setCodeExists(null);
              updateForm({ code: normalizeBranchCode(event.target.value) });
            }}
            error={visibleErrors.code}
            placeholder="DEL-HUB"
          />
          <TextField
            label="Station Code"
            required
            info="Exactly three letters used in shipment and tracking identifiers. It cannot change after activation."
            value={form.labelCode}
            disabled={identityLocked}
            helper={identityLocked ? "Locked: used by already-issued tracking numbers." : undefined}
            onChange={(event) => {
              markTouched("labelCode");
              updateForm({ labelCode: normalizeLabelCode(event.target.value) });
            }}
            error={visibleErrors.labelCode}
            placeholder="DEL"
          />
          <TextField
            label="Opening Date"
            type="date"
            value={form.openingDate}
            onChange={(event) => updateForm({ openingDate: event.target.value })}
          />
          <div className="md:col-span-2">
            <TextAreaField
              label="Description"
              value={form.description}
              maxLength={500}
              onChange={(value) => updateForm({ description: value })}
            />
          </div>
        </div>
      </FormSection>

      <FormSection title="Address and Contact" description="Search for the branch address first, then review the details filled below.">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2 [&_input:focus]:border-[#0D1282]! [&_input:focus]:ring-[#0D1282]/15!">
            <AddressAutocompleteField
              label="Search branch address"
              required
              value={form.address.address}
              countryName={form.address.countryName}
              onChange={(value) => {
                markTouched("address");
                updateAddress({ address: value });
              }}
              onBlur={() => markTouched("address")}
              onAddressSelected={applyLookupToAddress}
              error={visibleErrors.address}
            />
          </div>
          <NativeSelect
            label="Country"
            required
            value={form.address.countryCode}
            options={countrySelectOptions}
            placeholder="Select country"
            error={visibleErrors.country}
            info="India is selected by default so address search works immediately. Change it before searching for a branch in another country."
            onChange={(value) => {
              markTouched("country");
              const country = countryOptions.find((option) => option.code === value);
              updateAddress({ countryCode: value, countryName: country?.name ?? "" });
            }}
          />
          <TextField
            label="City"
            required
            value={form.address.city}
            onChange={(event) => {
              markTouched("city");
              updateAddress({ city: event.target.value });
            }}
            error={visibleErrors.city}
          />
          <TextField
            label="State or Province"
            value={form.address.stateOrProvince}
            onChange={(event) => updateAddress({ stateOrProvince: event.target.value })}
          />
          <TextField
            label="Postal Code"
            required
            value={form.address.postalCode}
            onChange={(event) => {
              markTouched("postalCode");
              updateAddress({ postalCode: event.target.value });
            }}
            error={visibleErrors.postalCode}
          />
          <TextField
            label="Email"
            required
            type="email"
            autoComplete="email"
            value={form.contact.email}
            onChange={(event) => {
              updateContact({ email: event.target.value });
            }}
            onBlur={() => markTouched("email")}
            error={visibleErrors.email}
          />
          <PhoneField
            label="Phone"
            required
            value={form.contact.phone}
            onChange={(value) => {
              updateContact({ phone: value });
            }}
            onBlur={() => markTouched("phone")}
            error={visibleErrors.phone}
          />
        </div>
      </FormSection>

      <FormSection title="Tax and Invoicing" description="Indian branches require a GSTIN before they can go live.">
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            label="Branch GSTIN"
            required={form.address.countryCode === "IN"}
            value={form.gstin}
            onChange={(event) => updateForm({ gstin: normalizeGstin(event.target.value) })}
            error={visibleErrors.gstin}
            helper={gstinStateName ? `State code ${form.gstin.slice(0, 2)}- ${gstinStateName}` : undefined}
            maxLength={GSTIN_LENGTH}
            placeholder={GSTIN_EXAMPLE}
          />
          <TextField
            label="Invoice SAC Code"
            value={form.invoiceSacCode}
            onChange={(event) => updateForm({ invoiceSacCode: event.target.value.replace(/[^0-9]/g, "") })}
            maxLength={12}
            placeholder="Applicable service code"
          />
        </div>
      </FormSection>

      <FormSection title="Operations and Settings" description="Services, coverage, currency, and working days.">
        <div className="grid gap-5 md:grid-cols-2">
          <CheckboxGroup<BranchService>
            label="Supported Services"
            required
            values={form.operations.supportedServices}
            options={branchServices.map((service) => ({ value: service, label: formatBranchLabel(service) }))}
            error={visibleErrors.supportedServices}
            onChange={(values) => {
              markTouched("supportedServices");
              updateOperations({ supportedServices: values });
            }}
          />
          <CheckboxGroup<ShipmentCoverage>
            label="Shipment Coverage"
            required
            values={form.operations.shipmentCoverage}
            options={shipmentCoverageTypes.map((coverage) => ({ value: coverage, label: formatBranchLabel(coverage) }))}
            error={visibleErrors.shipmentCoverage}
            info="Choose whether this branch handles domestic shipments, international shipments, or both."
            onChange={(values) => {
              markTouched("shipmentCoverage");
              updateOperations({ shipmentCoverage: values });
            }}
          />
          <CheckboxGroup<string>
            label="Operating Countries"
            required={!isDomesticOnlyCoverage(form.operations.shipmentCoverage)}
            values={form.operations.operatingCountries}
            options={countryOptions.map((country) => ({ value: country.code, label: `${country.name} (${country.code})` }))}
            searchable
            error={visibleErrors.operatingCountries}
            info="Required when the branch handles international shipments."
            onChange={(values) => {
              markTouched("operatingCountries");
              updateOperations({ operatingCountries: values });
            }}
          />
          <NativeSelect
            label="Base Currency"
            required
            value={form.baseCurrency}
            options={currencySelectOptions}
            placeholder="Select currency"
            error={visibleErrors.baseCurrency}
            onChange={(value) => {
              markTouched("baseCurrency");
              updateForm({ baseCurrency: value });
            }}
          />
          <div className="md:col-span-2">
            <p className="text-sm font-semibold text-slate-700">Working Days <RequiredMark /></p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {workingDays.map((day) => {
                const checked = form.operations.workingDays.includes(day);

                return (
                  <label
                    key={day}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition ${
                      checked
                        ? "border-[#0D1282] bg-[#0D1282]/5 text-[#0D1282]"
                        : "border-[#EEEDED] text-slate-700 hover:border-[#0D1282]/30"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        const nextDays: WorkingDay[] = event.target.checked
                          ? [...form.operations.workingDays, day]
                          : form.operations.workingDays.filter((current) => current !== day);
                        markTouched("workingDays");
                        updateOperations({ workingDays: nextDays });
                      }}
                      className="h-4 w-4 accent-[#0D1282]"
                    />
                    {formatBranchLabel(day)}
                  </label>
                );
              })}
            </div>
            <FieldError message={visibleErrors.workingDays} />
          </div>
        </div>
      </FormSection>

      <FormSection title="Branch Contact Numbers" description="Additional phone numbers for specific departments or staff.">
        <div className="grid gap-5 md:grid-cols-3">
          {form.phoneNumbers.map((phone, index) => (
            <div key={index} className="space-y-3 rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
              <TextField
                label={`Label ${index + 1}`}
                value={phone.label}
                placeholder="e.g. Manager, Operations"
                onChange={(event) => updatePhoneNumber(index, { label: event.target.value })}
              />
              <PhoneField
                label={`Phone ${index + 1}`}
                value={phone.number}
                onChange={(value) => updatePhoneNumber(index, { number: value })}
                error={visibleErrors[`phoneNumber${index}` as FieldKey]}
              />
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection title="Branch Images" description="Upload up to 5 branch office images (JPG, PNG, GIF, WebP, max 5 MB each).">
        <div className="space-y-4">
          {(imagePreviews.length || existingImages.length) ? (
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {existingImages.map((image, index) => (
                <div key={`existing-${index}`} className="group relative overflow-hidden rounded-xl border border-[#EEEDED] bg-[#EEEDED]/40">
                  <BranchImage
                    fileUrl={branchImageUrl(branchId ?? "", index, operatorSlug)}
                    alt={image.fileName || `Existing branch image ${index + 1}`}
                    className="h-32 w-full object-cover"
                  />
                  <BranchFileLink
                    fileUrl={branchImageUrl(branchId ?? "", index, operatorSlug)}
                    className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-lg bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-[#0D1282] shadow-sm hover:bg-white"
                  >
                    <FiExternalLink className="h-3.5 w-3.5" /> Preview
                  </BranchFileLink>
                  <button
                    type="button"
                    disabled={deletingImages.has(index)}
                    onClick={async () => {
                      if (!branchId) return;
                      setDeletingImages((prev) => new Set(prev).add(index));
                      try {
                        await deleteBranchImage(branchId, index, operatorSlug);
                        setExistingImages((prev) => prev.filter((_, i) => i !== index));
                        toast.success("Image deleted.");
                      } catch (caught) {
                        toast.error(caught instanceof Error ? caught.message : "Failed to delete image.");
                      } finally {
                        setDeletingImages((prev) => { const next = new Set(prev); next.delete(index); return next; });
                      }
                    }}
                    aria-label={`Delete branch image ${index + 1}`}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-white/95 text-[#D71313] shadow-sm transition hover:bg-white disabled:opacity-50"
                  >
                    <FiX className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {imagePreviews.map((preview, index) => (
                <div key={index} className="group relative overflow-hidden rounded-xl border border-[#EEEDED] bg-[#EEEDED]/40">
                  {/* Local object URLs cannot be handled by the Next image optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview}
                    alt={`Branch image ${index + 1}`}
                    className="h-32 w-full object-cover"
                  />
                  <a
                    href={preview}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-lg bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-[#0D1282] shadow-sm hover:bg-white"
                  >
                    <FiExternalLink className="h-3.5 w-3.5" /> Preview
                  </a>
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    aria-label={`Remove selected branch image ${index + 1}`}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-white/95 text-[#D71313] shadow-sm transition hover:bg-white"
                  >
                    <FiX className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {imageFiles.length + existingImages.length < 5 ? (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#EEEDED] px-4 py-8 text-sm font-semibold text-slate-500 transition hover:border-[#0D1282]/30 hover:text-[#0D1282]">
              <FiUpload className="h-5 w-5" />
              {imageFiles.length || existingImages.length ? "Add more images" : "Click to select branch images"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(event) => handleImageSelect(event.target.files)}
              />
            </label>
          ) : null}
          <p className="text-xs text-slate-400">{existingImages.length + imageFiles.length} / 5 images</p>
        </div>
      </FormSection>

      <FormSection title="Branch Documents" description="Upload PAN Card (required), GST Certificate (required), and optional documents.">
        <div className="grid gap-5 md:grid-cols-2">
          {existingDocuments.filter((d) => d.type === "PAN").map((doc, idx) => {
            const docIndex = existingDocuments.indexOf(doc);
            return (
              <div key={`existing-pan-${idx}`} className="rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
                <p className="mb-3 text-sm font-semibold text-slate-700">PAN Card <span className="text-[#D71313]">*</span></p>
                <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2 shadow-sm">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FiFileText className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-700">{doc.fileName}</p>
                      <BranchFileLink fileUrl={branchDocumentUrl(branchId ?? "", docIndex, operatorSlug)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-[#0D1282] hover:underline"><FiExternalLink className="h-3.5 w-3.5" /> Preview</BranchFileLink>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={deletingDocs.has(docIndex)}
                    onClick={async () => {
                      if (!branchId) return;
                      setDeletingDocs((prev) => new Set(prev).add(docIndex));
                      try {
                        await deleteBranchDocument(branchId, docIndex, operatorSlug);
                        setExistingDocuments((prev) => prev.filter((_, i) => i !== docIndex));
                        toast.success("PAN document deleted.");
                      } catch (caught) {
                        toast.error(caught instanceof Error ? caught.message : "Failed to delete document.");
                      } finally {
                        setDeletingDocs((prev) => { const next = new Set(prev); next.delete(docIndex); return next; });
                      }
                    }}
                    className="ml-2 text-[#D71313] hover:text-[#D71313]/70 disabled:opacity-50"
                  >
                    <FiX className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {documentFiles.pan || !existingDocuments.some((document) => document.type === "PAN") ? (
          <div className="rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
            <p className="mb-3 text-sm font-semibold text-slate-700">
              PAN Card <span className="text-[#D71313]">*</span>
            </p>
            {documentFiles.pan ? (
              <LocalFileCard key={`${documentFiles.pan.name}-${documentFiles.pan.lastModified}`} file={documentFiles.pan} onRemove={() => handleDocumentSelect("pan", null)} />
            ) : (
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[#EEEDED] px-4 py-6 text-sm text-slate-500 hover:border-[#0D1282]/30 hover:text-[#0D1282]">
                <FiUpload className="h-4 w-4" /> Upload PAN (PDF, JPG, PNG)
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleDocumentSelect("pan", file);
                  }}
                />
              </label>
            )}
          </div>
          ) : null}

          {existingDocuments.filter((d) => d.type === "GST").map((doc, idx) => {
            const docIndex = existingDocuments.indexOf(doc);
            return (
              <div key={`existing-gst-${idx}`} className="rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
                <p className="mb-3 text-sm font-semibold text-slate-700">GST Certificate <span className="text-[#D71313]">*</span></p>
                <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2 shadow-sm">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FiFileText className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-700">{doc.fileName}</p>
                      <BranchFileLink fileUrl={branchDocumentUrl(branchId ?? "", docIndex, operatorSlug)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-[#0D1282] hover:underline"><FiExternalLink className="h-3.5 w-3.5" /> Preview</BranchFileLink>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={deletingDocs.has(docIndex)}
                    onClick={async () => {
                      if (!branchId) return;
                      setDeletingDocs((prev) => new Set(prev).add(docIndex));
                      try {
                        await deleteBranchDocument(branchId, docIndex, operatorSlug);
                        setExistingDocuments((prev) => prev.filter((_, i) => i !== docIndex));
                        toast.success("GST document deleted.");
                      } catch (caught) {
                        toast.error(caught instanceof Error ? caught.message : "Failed to delete document.");
                      } finally {
                        setDeletingDocs((prev) => { const next = new Set(prev); next.delete(docIndex); return next; });
                      }
                    }}
                    className="ml-2 text-[#D71313] hover:text-[#D71313]/70 disabled:opacity-50"
                  >
                    <FiX className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {documentFiles.gst || !existingDocuments.some((document) => document.type === "GST") ? (
          <div className="rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
            <p className="mb-3 text-sm font-semibold text-slate-700">
              GST Certificate <span className="text-[#D71313]">*</span>
            </p>
            {documentFiles.gst ? (
              <LocalFileCard key={`${documentFiles.gst.name}-${documentFiles.gst.lastModified}`} file={documentFiles.gst} onRemove={() => handleDocumentSelect("gst", null)} />
            ) : (
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[#EEEDED] px-4 py-6 text-sm text-slate-500 hover:border-[#0D1282]/30 hover:text-[#0D1282]">
                <FiUpload className="h-4 w-4" /> Upload GST (PDF, JPG, PNG)
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleDocumentSelect("gst", file);
                  }}
                />
              </label>
            )}
          </div>
          ) : null}
          {existingDocuments.filter((d) => d.type === "OTHER").map((doc, idx) => {
            const docIndex = existingDocuments.indexOf(doc);
            return (
              <div key={`existing-other-${idx}`} className="md:col-span-2 rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
                <p className="mb-3 text-sm font-semibold text-slate-700">Other Document (optional)</p>
                <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2 shadow-sm">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FiFileText className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-700">{doc.title || doc.type}</p>
                      <p className="truncate text-xs text-slate-500">{doc.fileName}</p>
                      <BranchFileLink fileUrl={branchDocumentUrl(branchId ?? "", docIndex, operatorSlug)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-[#0D1282] hover:underline"><FiExternalLink className="h-3.5 w-3.5" /> Preview</BranchFileLink>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={deletingDocs.has(docIndex)}
                    onClick={async () => {
                      if (!branchId) return;
                      setDeletingDocs((prev) => new Set(prev).add(docIndex));
                      try {
                        await deleteBranchDocument(branchId, docIndex, operatorSlug);
                        setExistingDocuments((prev) => prev.filter((_, i) => i !== docIndex));
                        toast.success("Document deleted.");
                      } catch (caught) {
                        toast.error(caught instanceof Error ? caught.message : "Failed to delete document.");
                      } finally {
                        setDeletingDocs((prev) => { const next = new Set(prev); next.delete(docIndex); return next; });
                      }
                    }}
                    className="ml-2 text-[#D71313] hover:text-[#D71313]/70 disabled:opacity-50"
                  >
                    <FiX className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
          <div className="md:col-span-2 rounded-xl border border-[#EEEDED] bg-[#EEEDED]/20 p-4">
            <p className="mb-3 text-sm font-semibold text-slate-700">Other Document (optional)</p>
            <div className="grid gap-4 md:grid-cols-2">
              <input
                type="text"
                value={documentFiles.other?.title ?? ""}
                onChange={(event) => {
                  const file = documentFiles.other?.file;
                  handleDocumentSelect("other", file ?? null, event.target.value);
                }}
                placeholder="Document title"
                className="h-11 rounded-xl border border-slate-200 bg-white px-3.5 text-sm outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
              />
              {documentFiles.other?.file ? (
                <LocalFileCard key={`${documentFiles.other.file.name}-${documentFiles.other.file.lastModified}`} file={documentFiles.other.file} onRemove={() => handleDocumentSelect("other", null)} />
              ) : (
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[#EEEDED] px-4 py-3 text-sm text-slate-500 hover:border-[#0D1282]/30 hover:text-[#0D1282]">
                  <FiUpload className="h-4 w-4" /> Upload document (PDF, JPG, PNG)
                  <input
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) handleDocumentSelect("other", file, documentFiles.other?.title ?? "");
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>
      </FormSection>

      {!identityLocked ? (
        <div className={`rounded-xl border p-4 transition ${
          submitAttempted && !policyAccepted
            ? "border-[#D71313]/25 bg-[#D71313]/5"
            : "border-[#EEEDED] bg-white"
        }`}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={policyAccepted}
              onChange={(event) => {
                setPolicyAccepted(event.target.checked);
                if (event.target.checked) setSubmitAttempted(false);
              }}
              className="mt-0.5 h-4 w-4 accent-[#0D1282]"
            />
            <div>
              <p className="text-sm font-semibold text-slate-700">
                I confirm that the information provided is accurate and I accept the branch operating policies.
                <span className="text-[#D71313]"> *</span>
              </p>
              {submitAttempted && !policyAccepted ? (
                <p className="mt-1 text-xs font-semibold text-[#D71313]">
                  You must accept the policy before activating this branch.
                </p>
              ) : null}
            </div>
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3 rounded-2xl px-5 py-4">
        {!isEditMode ? (
          <>
            <button type="button" onClick={() => void handleSubmit("draft")} disabled={saving || uploading} className={secondaryButtonClasses}>
              {uploading ? "Uploading files..." : savingMode === "draft" ? "Saving..." : "Save as Draft"}
            </button>
            <button type="button" onClick={() => void handleSubmit("activate")} disabled={saving || uploading} className={primaryButtonClasses}>
              {uploading ? "Uploading files..." : savingMode === "activate" ? "Creating..." : "Create Branch"}
            </button>
          </>
        ) : initialStatus === "DRAFT" ? (
          <>
            <button type="button" onClick={() => void handleSubmit("draft")} disabled={saving || uploading} className={secondaryButtonClasses}>
              {uploading ? "Uploading files..." : savingMode === "draft" ? "Saving..." : "Save Draft"}
            </button>
            <button type="button" onClick={() => void handleSubmit("activate")} disabled={saving || uploading} className={primaryButtonClasses}>
              {uploading ? "Uploading files..." : savingMode === "activate" ? "Activating..." : "Save & Activate"}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void handleSubmit("save")} disabled={saving || uploading} className={primaryButtonClasses}>
            {uploading ? "Uploading files..." : savingMode === "save" ? "Saving..." : "Save Changes"}
          </button>
        )}
      </div>
    </div>
  );
}
