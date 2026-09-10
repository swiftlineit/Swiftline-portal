"use client";

import { useEffect, useRef, useState } from "react";
import { FiSearch } from "react-icons/fi";
import {
  fetchHsCodeSuggestions,
  minHsCodeQueryLength,
  type HsCodeSuggestion,
} from "@/lib/hsCodes";
import { BookingField } from "./BookingField";

const PUBLIC_REFERENCE_ROOT = "/api/v1/public/shipment-bookings/reference";

export default function HsCodeSearchField({
  description,
  value,
  required,
  revealError = false,
  error,
  onChange,
}: {
  description: string;
  value: string;
  required: boolean;
  revealError?: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const [results, setResults] = useState<{
    query: string;
    suggestions: HsCodeSuggestion[];
  }>({ query: "", suggestions: [] });
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const query = value.trim() || description.trim();

  useEffect(() => {
    if (query.length < minHsCodeQueryLength) return;
    let current = true;
    const timer = setTimeout(() => {
      void fetchHsCodeSuggestions(query, PUBLIC_REFERENCE_ROOT).then(
        (suggestions) => {
          if (current) setResults({ query, suggestions });
        },
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const suggestions = results.query === query ? results.suggestions : [];
  return (
    <div ref={containerRef} className="relative">
      <div className="relative [&_input]:pr-10">
        <BookingField
          label="HS code"
          required={required}
          inputMode="numeric"
          value={value}
          error={error}
          revealError={revealError}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value.replace(/\D/g, "").slice(0, 10));
            setOpen(true);
          }}
          placeholder={
            description.trim().length >= minHsCodeQueryLength
              ? "Search or enter code"
              : "Enter description first"
          }
        />
        <FiSearch
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3.5 right-3.5 h-4 w-4 text-slate-400"
        />
      </div>
      {open && suggestions.length ? (
        <div className="absolute z-40 mt-1 max-h-64 w-full min-w-[18rem] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl [scrollbar-width:thin]">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.code}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(suggestion.code);
                setOpen(false);
              }}
              className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-50"
            >
              <span className="shrink-0 font-mono text-sm font-bold text-[#0D1282]">
                {suggestion.code}
              </span>
              <span className="line-clamp-2 text-xs leading-5 text-slate-600">
                {suggestion.description}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
