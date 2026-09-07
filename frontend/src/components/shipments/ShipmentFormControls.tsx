"use client";

import { ChangeEvent, ReactNode, useEffect, useRef, useState } from "react";
import { CountrySelector, FlagImage, type CountryIso2 } from "react-international-phone";
import { FiChevronDown } from "react-icons/fi";
import InfoTooltip from "@/components/ui/InfoTooltip";
import { toast } from "react-toastify";
import { csbTypeOptions, type CsbType } from "@/lib/csbType";
import {
  getPhoneCountryByDialCode,
  getPhoneCountryByIso2,
  preferredPhoneCountries
} from "@/components/business-accounts/FormFieldControls";

export function ShipmentFieldLabel({
  children,
  required = false,
  tooltip
}: {
  children: ReactNode;
  required?: boolean;
  // Short explanation shown on hover, for fields whose wording is ambiguous.
  tooltip?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
      {children}
      {required ? <span className="text-red-600">*</span> : null}
      {tooltip ? <InfoTooltip text={tooltip} /> : null}
    </span>
  );
}

// Field errors surface in a toast (deduped by message) rather than inline text, and
// only when the field holds wrong content. An empty required field just highlights;
// its "is required" message is raised by the page when Create is pressed.
function toastFieldError(error: string | undefined, value: string) {
  if (error && value.trim()) toast.error(error, { toastId: error });
}

export function ShipmentTextField({
  label,
  value,
  onChange,
  error,
  revealError = false,
  required = false,
  type = "text",
  placeholder,
  inputMode,
  readOnly = false,
  maxLength,
  max,
  hint,
  tooltip,
  onBlur
}: {
  label: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  revealError?: boolean;
  required?: boolean;
  type?: string;
  placeholder?: string;
  inputMode?: "decimal" | "email" | "numeric" | "search" | "tel" | "text" | "url";
  readOnly?: boolean;
  maxLength?: number;
  /**
   * Numeric ceiling. The value is refused outright rather than flagged after the
   * fact- `max` alone only drives the spinner and native validity, and still
   * lets an over-limit number be typed.
   */
  max?: number;
  hint?: string;
  tooltip?: string;
  // Fires after the field's own touched-tracking, e.g. to surface a restricted-goods toast.
  onBlur?: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const showError = touched || revealError;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    // A blank stays editable so the field can be cleared and retyped.
    const next = event.target.value;
    if (max !== undefined && next.trim() !== "") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > max) return;
    }
    onChange(event);
  }

  return (
    <label className="block min-w-0">
      <ShipmentFieldLabel required={required} tooltip={tooltip}>{label}</ShipmentFieldLabel>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={handleChange}
        onBlur={() => { setTouched(true); toastFieldError(error, value); onBlur?.(); }}
        placeholder={placeholder}
        readOnly={readOnly}
        maxLength={maxLength}
        max={max}
        aria-invalid={Boolean(error && showError)}
        className={`mt-2 h-11 w-full min-w-0 rounded-xl border px-3.5 text-sm outline-none transition focus:ring-2 ${
          readOnly
            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500"
            : error && showError
              ? "border-red-400 bg-white focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 bg-white focus:border-blue-900 focus:ring-blue-100"
        }`}
      />
      {hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
    </label>
  );
}

// The consignor country and dialling code are fixed to India, so they render as a
// disabled flag chip rather than an editable field.
export function ShipmentFixedCountryField({ label, mode = "country" }: { label: string; mode?: "country" | "dial" }) {
  return (
    <label className="block min-w-0">
      <ShipmentFieldLabel required>{label}</ShipmentFieldLabel>
      <div className="mt-2 flex h-11 w-full min-w-0 cursor-not-allowed items-center gap-2 rounded-xl border border-slate-200 bg-slate-100 px-3.5 text-sm text-slate-600">
        <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
          <FlagImage iso2="in" size="20px" />
        </span>
        <span className="min-w-0 flex-1 truncate">{mode === "dial" ? "India +91" : "India"}</span>
      </div>
    </label>
  );
}

export function ShipmentSelectField({
  label,
  value,
  onChange,
  children,
  error,
  revealError = false,
  required = false,
  flagCountryCode
}: {
  label: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  error?: string;
  revealError?: boolean;
  required?: boolean;
  flagCountryCode?: string;
}) {
  const [touched, setTouched] = useState(false);
  const showError = touched || revealError;

  return (
    <label className="block min-w-0">
      <ShipmentFieldLabel required={required}>{label}</ShipmentFieldLabel>
      <span className="relative mt-2 block">
        {flagCountryCode ? (
          <span className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-7 -translate-y-1/2 items-center justify-center overflow-hidden [&_img]:rounded-none">
            <FlagImage iso2={flagCountryCode.toLowerCase()} size="20px" />
          </span>
        ) : null}
        <select
          value={value}
          onChange={onChange}
          onBlur={() => { setTouched(true); toastFieldError(error, value); }}
          aria-invalid={Boolean(error && showError)}
          className={`h-11 w-full appearance-none rounded-xl border bg-white pr-12 text-sm outline-none transition focus:ring-2 ${flagCountryCode ? "pl-12" : "pl-3.5"} ${
            error && showError
              ? "border-red-400 focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 focus:border-blue-900 focus:ring-blue-100"
          }`}
        >
          {children}
        </select>
        <FiChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        />
      </span>
    </label>
  );
}

export function ShipmentPhoneCodeField({
  value,
  onChange,
  error,
  revealError = false,
  defaultDialCode
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  revealError?: boolean;
  // Dial code shown when nothing is stored yet. Defaults to India for backwards
  // compatibility; the consignee passes "+44" so the UK code is pre-selected.
  defaultDialCode?: string;
}) {
  const [touched, setTouched] = useState(false);
  const defaultCountry = getPhoneCountryByDialCode(defaultDialCode || "");
  const initialCountry = getPhoneCountryByDialCode(value.trim() || defaultDialCode || "");
  const [selectedCountryIso2, setSelectedCountryIso2] = useState<CountryIso2>(() => initialCountry.iso2);
  const previousValueRef = useRef(value.trim() || defaultDialCode || "");
  const selectedCountry = getPhoneCountryByIso2(selectedCountryIso2);
  const showError = touched || revealError;

  // A dial code is not a unique country identifier (+1 is shared by the US and
  // Canada). Keep the user's selected ISO code locally so the display does not
  // fall back to whichever country appears first in the phone library.
  useEffect(() => {
    const nextValue = value.trim() || defaultDialCode || "";
    if (previousValueRef.current === nextValue) return;

    previousValueRef.current = nextValue;
    setSelectedCountryIso2(getPhoneCountryByDialCode(nextValue).iso2);
  }, [defaultDialCode, value]);

  // Keep the controlled form value in sync with the visible default so the
  // pre-selected code is also a valid submission value.
  useEffect(() => {
    if (!value.trim()) onChange(`+${defaultCountry.dialCode}`);
  }, [defaultCountry.dialCode, onChange, value]);

  return (
    <div className="min-w-0">
      <ShipmentFieldLabel required>Mobile Country Code</ShipmentFieldLabel>
      <div className="mt-2" onBlur={() => setTouched(true)}>
        <CountrySelector
          selectedCountry={selectedCountry.iso2}
          preferredCountries={preferredPhoneCountries}
          onSelect={(country) => {
            const nextValue = `+${country.dialCode}`;
            previousValueRef.current = nextValue;
            setSelectedCountryIso2(country.iso2);
            onChange(nextValue);
          }}
          renderButtonWrapper={({ rootProps }) => (
            <button
              {...rootProps}
              type="button"
              className={`flex h-11 w-full min-w-0 items-center gap-2 rounded-xl border bg-white px-3.5 text-left text-sm outline-none transition focus:ring-2 ${
                error && showError
                  ? "border-red-400 focus:border-red-500 focus:ring-red-100"
                  : "border-slate-300 focus:border-blue-900 focus:ring-blue-100"
              }`}
            >
              <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
                <FlagImage iso2={selectedCountry.iso2} size="20px" />
              </span>
              <span className="min-w-0 flex-1 truncate">{selectedCountry.name} +{selectedCountry.dialCode}</span>
              <FiChevronDown aria-hidden="true" className="mr-1 h-4 w-4 shrink-0 text-slate-500" />
            </button>
          )}
        />
      </div>
    </div>
  );
}

/**
 * Mandatory CSB-IV / CSB-V choice for a shipment draft, rendered as two
 * selectable cards. Radio inputs give the grouped single-choice semantics.
 *
 * CSB-V adds a flat clearance charge to the whole shipment, so the choice is
 * shown prominently rather than buried in a dropdown.
 */
export function ShipmentCsbTypeField({
  value,
  onChange,
  disabled = false
}: {
  value: CsbType;
  onChange: (value: CsbType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {csbTypeOptions.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition ${
              disabled
                ? "cursor-not-allowed border-slate-200 bg-slate-100"
                : checked
                  ? "cursor-pointer border-blue-900 bg-blue-50"
                  : "cursor-pointer border-slate-300 bg-white hover:border-blue-300"
            }`}
          >
            <input
              type="radio"
              name="shipmentCsbType"
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-blue-900"
            />
            <span className="block min-w-0">
              <span className={`block text-sm font-semibold ${checked ? "text-blue-950" : "text-slate-900"}`}>
                {option.label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
