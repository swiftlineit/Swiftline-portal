"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FiSearch, FiX } from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import { findCountries } from "@/lib/countryLookup";

/**
 * Finds a destination on a rate card by name.
 *
 * Searches the whole world rather than only the countries on the card, because
 * a customer typing a destination we do not cover has asked a real question and
 * deserves a real answer. The page answers it; this field only has to recognise
 * the country. Covered destinations are marked, so the list itself shows at a
 * glance what the card includes.
 */
export default function RateCardSearch({
  value,
  onChange,
  onSelect,
  coveredCodes,
  placeholder = "Search a destination, for example Belgium or Germany"
}: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (countryCode: string) => void;
  coveredCodes: Set<string>;
  placeholder?: string;
}) {
  const inputId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  // Covered destinations first: they are what the customer can act on today.
  const suggestions = useMemo(() => {
    if (!value.trim()) return [];

    const matches = findCountries(value).slice(0, 30);
    const covered = matches.filter((country) => coveredCodes.has(country.iso2.toUpperCase()));
    const rest = matches.filter((country) => !coveredCodes.has(country.iso2.toUpperCase()));
    return [...covered, ...rest].slice(0, 8);
  }, [value, coveredCodes]);

  const activeIndex = Math.min(highlighted, Math.max(suggestions.length - 1, 0));

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function choose(iso2: string) {
    onSelect(iso2.toUpperCase());
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

    if (event.key === "Enter" && suggestions[activeIndex]) {
      event.preventDefault();
      choose(suggestions[activeIndex].iso2);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={inputId} className="sr-only">Search destinations</label>

      <div className="relative">
        <FiSearch
          aria-hidden="true"
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="h-12 w-full rounded-lg border border-slate-200 bg-white pl-11 pr-11 text-sm font-medium text-slate-900 shadow-sm outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
        />
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <FiX aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open && suggestions.length ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {suggestions.map((country, index) => {
            const covered = coveredCodes.has(country.iso2.toUpperCase());

            return (
              <li key={country.iso2} id={`${listboxId}-${index}`} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(country.iso2);
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${
                    index === activeIndex ? "bg-slate-100" : ""
                  }`}
                >
                  <CountryFlag code={country.iso2} size={16} />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{country.name}</span>
                  {covered ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                      On your card
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Not covered
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
