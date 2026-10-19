"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import CountryFlag from "@/components/CountryFlag";
import { findCountries, resolveCountry } from "@/lib/countryLookup";

/**
 * The destination field on the rate card, searchable across every country.
 *
 * Modelled on `components/ui/CountryAutocomplete`, which solves the same
 * problem for address fields, with two deliberate differences.
 *
 * It starts empty. The old picker defaulted to the United Kingdom, so the
 * quickest way to use it was also the quickest way to save a UK rate by
 * mistake. A placeholder asks rather than assumes.
 *
 * It does not pass free text through. An address field can submit whatever was
 * typed and let the server answer, but a rate is keyed by ISO-3166 alpha-2 and
 * the form has nothing to submit until the text resolves to one, so an
 * unresolved value is reported here rather than sent.
 */
export default function RateCardCountryPicker({
  label = "Country",
  value,
  onChange,
  placeholder = "Search a country",
  disabled = false,
  invalid = false,
  inputClassName = "h-10 rounded-lg"
}: {
  label?: string;
  /** The visible text. The ISO code is derived from it by the parent. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  inputClassName?: string;
}) {
  const inputId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const suggestions = useMemo(() => findCountries(value).slice(0, 8), [value]);
  const selected = useMemo(() => resolveCountry(value), [value]);

  // Clamped while rendering rather than reset from an effect: the list shrinks
  // as the query narrows, and an index left pointing past the end would make
  // Enter select nothing or the wrong row.
  const activeIndex = Math.min(highlighted, Math.max(suggestions.length - 1, 0));

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function select(name: string) {
    onChange(name);
    setOpen(false);
    setHighlighted(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlighted(Math.min(activeIndex + 1, suggestions.length - 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted(Math.max(activeIndex - 1, 0));
      return;
    }

    // Enter picks the highlighted row only while the list is open, so it cannot
    // overwrite a code somebody deliberately typed.
    if (event.key === "Enter" && open && suggestions[activeIndex]) {
      event.preventDefault();
      select(suggestions[activeIndex].name);
    }
  }

  return (
    <div ref={containerRef} className="relative block min-w-0">
      {/* Used both as a labelled form field and, inside the import review
          table, as a bare correction control where the column heading is the
          label. An empty label element would still take up its line box. */}
      <label htmlFor={inputId} className={label ? "block" : "sr-only"}>
        <span className="text-xs font-semibold uppercase text-slate-500">{label || "Country"}</span>
      </label>

      <div className={`relative ${label ? "mt-2" : ""}`}>
        {/* The flag sits inside the box so the confirmation of what was
            understood is on the field itself, not somewhere alongside it. */}
        {selected ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
            <CountryFlag code={selected.iso2} size={16} />
          </span>
        ) : null}

        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-activedescendant={open && suggestions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
          autoComplete="off"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          className={`w-full border bg-white text-sm font-semibold text-slate-900 outline-none disabled:bg-slate-50 ${inputClassName} ${
            invalid ? "border-red-400 focus:border-red-500" : "border-slate-300 focus:border-blue-900"
          } ${selected ? "pl-10" : "pl-3"} ${selected ? "pr-14" : "pr-3"}`}
        />

        {selected ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-slate-600">
            {selected.iso2.toUpperCase()}
          </span>
        ) : null}
      </div>

      {open && suggestions.length ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {suggestions.map((country, index) => (
            <li key={country.iso2} id={`${listboxId}-${index}`} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                // Pointer-down rather than click: the input's blur would
                // otherwise close the list before the click landed.
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(country.name);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${index === activeIndex ? "bg-blue-50" : ""}`}
              >
                <CountryFlag code={country.iso2} size={16} />
                <span className="min-w-0 flex-1 truncate text-slate-800">{country.name}</span>
                <span className="shrink-0 text-xs font-bold tracking-wide text-slate-500">
                  {country.iso2.toUpperCase()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
