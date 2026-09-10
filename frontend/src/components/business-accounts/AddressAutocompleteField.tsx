"use client";

import { useEffect, useRef, useState } from "react";
import { FiSearch } from "react-icons/fi";
import {
  Field,
  type FieldStatus,
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

/**
 * Address line 1 with search attached.
 *
 * The input is the address line itself, not a separate search box: whatever the
 * user types is the stored value, and picking a suggestion simply fills it in
 * along with the fields around it. That way the form is completable by hand at
 * any time, which it has to be- the lookup can be unconfigured, rate limited or
 * down, and none of those may block an account being created.
 */
export function AddressAutocompleteField({
  label,
  value,
  countryName,
  onChange,
  onBlur,
  onAddressSelected,
  error,
  status = "idle",
  disabled = false,
  required = false,
  endpointRoot,
}: {
  label: string;
  value: string;
  countryName: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  // Fired only when a suggestion is picked, never while typing.
  onAddressSelected: (address: LookupAddress) => void;
  error?: string;
  status?: FieldStatus;
  disabled?: boolean;
  required?: boolean;
  endpointRoot?: string;
}) {
  // Results carry the query they answered, so a slower response for an older
  // query can never be shown against a newer one- and "searching" falls out of
  // the same comparison instead of being toggled in an effect.
  const [results, setResults] = useState<{
    query: string;
    predictions: AddressPrediction[];
  }>({
    query: "",
    predictions: [],
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const containerRef = useRef<HTMLDivElement | null>(null);
  // One token spans the keystrokes leading to a single selection, which is what
  // makes Google bill the sequence once rather than per character.
  const sessionTokenRef = useRef(createSessionToken());
  const enabled = supportsAddressLookup(countryName) && !disabled;

  const trimmedQuery = query.trim();
  const searchable = enabled && trimmedQuery.length >= MIN_LOOKUP_LENGTH;
  const isCurrent = results.query === trimmedQuery;
  const predictions = searchable && isCurrent ? results.predictions : [];
  const searching = searchable && !isCurrent;

  useEffect(() => {
    if (!searchable) return;

    let cancelled = false;
    // Debounced so a lookup runs per pause, not per keystroke.
    const timer = setTimeout(() => {
      void autocompleteAddress(
        trimmedQuery,
        countryName,
        sessionTokenRef.current,
        endpointRoot,
      ).then((predictions) => {
        if (!cancelled) setResults({ query: trimmedQuery, predictions });
      });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery, countryName, searchable, endpointRoot]);

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

    const address = await getLookupAddress(
      prediction.placeId,
      countryName,
      sessionTokenRef.current,
      endpointRoot,
    );

    // The token is spent once details are fetched; the next search starts a new
    // billable session.
    sessionTokenRef.current = createSessionToken();

    if (address) onAddressSelected(address);
  }

  return (
    <div ref={containerRef} className="relative">
      <Field
        label={label}
        value={value}
        onChange={(next) => {
          onChange(next);
          setQuery(next);
          setOpen(true);
        }}
        onBlur={() => {
          // A suggestion uses mousedown, so closing on the next task keeps that
          // selection working while removing stale results after keyboard tab.
          setTimeout(() => setOpen(false), 0);
          onBlur?.();
        }}
        error={error}
        status={searching ? "validating" : status}
        placeholder={enabled ? getLookupPlaceholder(countryName) : undefined}
        info={
          enabled
            ? "Start typing and pick your address to fill the fields below, or type the whole address yourself."
            : "Enter the address manually. Search is not available for the selected country."
        }
        disabled={disabled}
        required={required}
      />

      {open && enabled && predictions.length ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-[#EEEDED] bg-white p-1 shadow-xl">
          <div className="max-h-64 overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:#94a3b8_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400">
            {predictions.map((prediction) => (
              <button
                key={prediction.placeId}
                type="button"
                onMouseDown={(event) => {
                  // Runs before the input's blur, so the click is not lost to
                  // the list unmounting first.
                  event.preventDefault();
                  void handleSelect(prediction);
                }}
                className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-[#EEEDED]/60"
              >
                <FiSearch
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-950">
                    {prediction.mainText || prediction.text}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {prediction.secondaryText || prediction.text}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
