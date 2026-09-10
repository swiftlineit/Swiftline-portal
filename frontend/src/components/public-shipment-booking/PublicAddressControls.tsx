"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { CountrySelector, FlagImage, type CountryIso2 } from "react-international-phone";
import { FiChevronDown, FiSearch } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  getPhoneCountryByDialCode,
  getPhoneCountryByIso2,
  preferredPhoneCountries,
} from "@/components/business-accounts/FormFieldControls";
import {
  MIN_LOOKUP_LENGTH,
  autocompleteAddress,
  createSessionToken,
  getLookupAddress,
  getLookupPlaceholder,
  supportsAddressLookup,
  type AddressPrediction,
  type LookupAddress,
} from "@/lib/addressLookup";
import { BookingField } from "./BookingField";

export type PublicAddressOption = {
  value: string;
  label: string;
  iso2?: CountryIso2;
};

const controlClasses =
  "h-11 w-full rounded-lg border bg-white px-3 text-base tracking-[0.015em] text-slate-900 outline-none transition focus:ring-2 sm:text-sm";

function errorClasses(showError: boolean) {
  return showError
    ? "border-red-400 focus:border-red-500 focus:ring-red-100"
    : "border-slate-300 focus:border-[#0D1282] focus:ring-[#0D1282]/10";
}

export function PublicSearchableSelect({
  label,
  value,
  onChange,
  options,
  error,
  required = false,
  placeholder,
  revealError = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PublicAddressOption[];
  error?: string;
  required?: boolean;
  placeholder?: string;
  revealError?: boolean;
}) {
  const buttonId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [openUp, setOpenUp] = useState(false);
  const [touched, setTouched] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = search.trim()
    ? options.filter((option) =>
        option.label.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : options;
  const showError = Boolean(error && (touched || revealError));

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setOpenUp(window.innerHeight - rect.bottom < 320 && rect.top > 320);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  function reportError() {
    setTouched(true);
    if (error) toast.error(error, { toastId: error });
  }

  function selectOption(option: PublicAddressOption) {
    onChange(option.value);
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setOpen(true);
      setSearch((current) => `${current}${event.key}`);
      setHighlightedIndex(0);
      return;
    }
    if (event.key === "Backspace" && search) {
      event.preventDefault();
      setSearch((current) => current.slice(0, -1));
      setHighlightedIndex(0);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setSearch("");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)),
      );
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
    }
    if (event.key === "Enter" && filteredOptions[highlightedIndex]) {
      event.preventDefault();
      selectOption(filteredOptions[highlightedIndex]);
    }
  }

  return (
    <div ref={containerRef} className="relative min-w-0" onKeyDown={handleKeyDown}>
      <label htmlFor={buttonId} className="block text-sm font-semibold text-slate-600">
        <span>
          {label}
          {required ? <span className="ml-1 text-red-600" aria-hidden="true">*</span> : null}
        </span>
      </label>
      <button
        id={buttonId}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onBlur={reportError}
        onClick={() => {
          setOpen((current) => !current);
          setHighlightedIndex(0);
        }}
        className={`${controlClasses} relative mt-1.5 flex items-center gap-2 text-left ${errorClasses(showError)} pr-11`}
      >
        {selectedOption?.iso2 ? (
          <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
            <FlagImage iso2={selectedOption.iso2} size="20px" />
          </span>
        ) : null}
        <span className={`min-w-0 flex-1 truncate ${selectedOption ? "text-slate-900" : "text-slate-400"}`}>
          {search || selectedOption?.label || placeholder || label}
        </span>
        <FiChevronDown
          aria-hidden="true"
          className={`pointer-events-none absolute right-3.5 h-4 w-4 text-slate-500 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className={`absolute z-50 w-full overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-xl ${openUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          <div ref={listRef} className="max-h-64 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            {filteredOptions.length ? (
              filteredOptions.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  data-index={index}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectOption(option);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-100"
                >
                  {option.iso2 ? (
                    <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
                      <FlagImage iso2={option.iso2} size="20px" />
                    </span>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-slate-500">No matches found.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PublicFixedCountryField({
  label,
  mode = "country",
}: {
  label: string;
  mode?: "country" | "dial";
}) {
  return (
    <div className="min-w-0">
      <span className="block text-sm font-semibold text-slate-600">
        {label}<span className="ml-1 text-red-600" aria-hidden="true">*</span>
      </span>
      <div className="mt-1.5 flex h-11 w-full cursor-not-allowed items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-3 text-sm tracking-[0.015em] text-slate-600">
        <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
          <FlagImage iso2="in" size="20px" />
        </span>
        <span className="min-w-0 flex-1 truncate">{mode === "dial" ? "India +91" : "India"}</span>
      </div>
    </div>
  );
}

export function PublicPhoneCodeField({
  value,
  onChange,
  error,
  revealError = false,
  defaultDialCode,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  revealError?: boolean;
  defaultDialCode?: string;
}) {
  const [touched, setTouched] = useState(false);
  const defaultCountry = getPhoneCountryByDialCode(defaultDialCode || "");
  const initialCountry = getPhoneCountryByDialCode(value.trim() || defaultDialCode || "");
  const [selectedCountryIso2, setSelectedCountryIso2] = useState<CountryIso2>(() => initialCountry.iso2);
  const previousValueRef = useRef(value.trim() || defaultDialCode || "");
  const selectedCountry = getPhoneCountryByIso2(selectedCountryIso2);
  const showError = Boolean(error && (touched || revealError));

  useEffect(() => {
    const nextValue = value.trim() || defaultDialCode || "";
    if (previousValueRef.current === nextValue) return;
    previousValueRef.current = nextValue;
    setSelectedCountryIso2(getPhoneCountryByDialCode(nextValue).iso2);
  }, [defaultDialCode, value]);

  useEffect(() => {
    if (!value.trim()) onChange(`+${defaultCountry.dialCode}`);
  }, [defaultCountry.dialCode, onChange, value]);

  function handleBlur() {
    setTouched(true);
    if (error) toast.error(error, { toastId: error });
  }

  return (
    <div className="min-w-0">
      <span className="block text-sm font-semibold text-slate-600">
        Mobile country code<span className="ml-1 text-red-600" aria-hidden="true">*</span>
      </span>
      <div className="mt-1.5" onBlur={handleBlur}>
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
              aria-label="Mobile country code"
              className={`${controlClasses} relative flex items-center gap-2 text-left ${errorClasses(showError)} pr-11`}
            >
              <span className="flex h-5 w-7 shrink-0 items-center justify-center overflow-hidden [&_img]:rounded-none">
                <FlagImage iso2={selectedCountry.iso2} size="20px" />
              </span>
              <span className="min-w-0 flex-1 truncate">{selectedCountry.name} +{selectedCountry.dialCode}</span>
              <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 h-4 w-4 text-slate-500" />
            </button>
          )}
        />
      </div>
    </div>
  );
}

export function PublicAddressAutocompleteField({
  label,
  value,
  countryName,
  onChange,
  onBlur,
  onAddressSelected,
  error,
  disabled = false,
  required = false,
  endpointRoot,
  revealError = false,
}: {
  label: string;
  value: string;
  countryName: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onAddressSelected: (address: LookupAddress) => void;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  endpointRoot?: string;
  revealError?: boolean;
}) {
  const [results, setResults] = useState<{ query: string; predictions: AddressPrediction[] }>({ query: "", predictions: [] });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionTokenRef = useRef(createSessionToken());
  const enabled = supportsAddressLookup(countryName) && !disabled;
  const trimmedQuery = query.trim();
  const searchable = enabled && trimmedQuery.length >= MIN_LOOKUP_LENGTH;
  const isCurrent = results.query === trimmedQuery;
  const predictions = searchable && isCurrent ? results.predictions : [];

  useEffect(() => {
    if (!searchable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void autocompleteAddress(trimmedQuery, countryName, sessionTokenRef.current, endpointRoot).then((next) => {
        if (!cancelled) setResults({ query: trimmedQuery, predictions: next });
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [countryName, endpointRoot, searchable, trimmedQuery]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  async function handleSelect(prediction: AddressPrediction) {
    setOpen(false);
    const address = await getLookupAddress(prediction.placeId, countryName, sessionTokenRef.current, endpointRoot);
    sessionTokenRef.current = createSessionToken();
    if (address) onAddressSelected(address);
  }

  return (
    <div ref={containerRef} className="relative">
      <BookingField
        label={label}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setQuery(next);
          setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 0);
          onBlur?.();
        }}
        error={error}
        revealError={revealError}
        placeholder={enabled ? getLookupPlaceholder(countryName) : undefined}
        disabled={disabled}
        required={required}
        autoComplete="street-address"
        aria-busy={searchable && !isCurrent}
      />
      {open && enabled && predictions.length ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
          <div className="max-h-64 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            {predictions.map((prediction) => (
              <button
                key={prediction.placeId}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  void handleSelect(prediction);
                }}
                className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-slate-100"
              >
                <FiSearch aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-950">{prediction.mainText || prediction.text}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">{prediction.secondaryText || prediction.text}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
