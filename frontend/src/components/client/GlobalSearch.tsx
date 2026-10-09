"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiSearch, FiX } from "react-icons/fi";
import {
  MIN_SEARCH_LENGTH,
  searchClientRecords,
  searchKindLabels,
  type ClientSearchResult
} from "@/lib/clientSearch";

/**
 * One search box over AWBs, references, invoices, manifests, pickups, claims
 * and tickets.
 *
 * Customers arrive holding a number off an email or a label without knowing
 * which kind of record it belongs to, so results say what each hit is rather
 * than making them pick a category first.
 */
export default function GlobalSearch({
  businessAccountId,
  audience = "client"
}: {
  /** Required for a client search; ignored for staff, who span accounts. */
  businessAccountId?: string;
  audience?: "client" | "staff";
}) {
  const router = useRouter();
  const listId = useId();
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * The last answer received, tagged with the term it answers.
   *
   * Held as one value so results and their error can never disagree, and
   * compared against what is currently typed instead of being cleared on every
   * keystroke- clearing would mean writing state from inside an effect, and
   * the tag makes a stale answer simply stop being shown.
   */
  const [outcome, setOutcome] = useState<{
    term: string;
    results: ClientSearchResult[];
    error: string;
  }>({ term: "", results: [], error: "" });

  const trimmed = term.trim();
  const longEnough = trimmed.length >= MIN_SEARCH_LENGTH;
  const isCurrent = outcome.term === trimmed;
  const results = longEnough && isCurrent ? outcome.results : [];
  const error = longEnough && isCurrent ? outcome.error : "";

  useEffect(() => {
    if (!longEnough) return;
    if (audience === "client" && !businessAccountId) return;

    // Debounced, and the previous request is abandoned rather than left to
    // land after a newer one and overwrite it with stale results.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchClientRecords({ businessAccountId, audience, term: trimmed, signal: controller.signal })
        .then((found) => setOutcome({ term: trimmed, results: found, error: "" }))
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setOutcome({
            term: trimmed,
            results: [],
            error: caught instanceof Error ? caught.message : "Search failed."
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [audience, businessAccountId, longEnough, trimmed]);

  // A dropdown that outlives a click elsewhere reads as a stuck overlay.
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  function goTo(result: ClientSearchResult) {
    setOpen(false);
    setTerm("");
    router.push(result.href);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    // Enter takes the top hit, which is what someone pasting an exact AWB wants.
    if (event.key === "Enter" && results.length) {
      event.preventDefault();
      goTo(results[0]);
    }
  }

  const showPanel = open && longEnough;

  return (
    <div ref={containerRef} className="relative w-full">
      {/* The offset sits on the label so the absolutely positioned icon, which
          centres against this box, keeps tracking the input on small screens. */}
      <label className="relative block mt-3 md:mt-0">
        <span className="sr-only">Search shipments, invoices, claims and tickets</span>
        <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          maxLength={80}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder="Search AWB, consignor, consignee, invoice, claim..."
          className="h-10 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-9 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
        />
        {term ? (
          <button
            type="button"
            onClick={() => { setTerm(""); setOpen(false); }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <FiX aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </label>

      {showPanel ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-12 z-50 max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl"
        >
          {searching && !results.length ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">Searching...</p>
          ) : error ? (
            <p className="px-4 py-6 text-center text-sm font-medium text-red-600">{error}</p>
          ) : !results.length ? (
            <div className="px-4 py-6 text-center">
              <p className="text-sm font-semibold text-slate-700">Nothing matched “{trimmed}”</p>
              <p className="mt-1 text-sm text-slate-500">
                Try an AWB, consignor or consignee name, your reference, or a document number.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {results.map((result) => (
                <li key={`${result.kind}-${result.href}-${result.title}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => goTo(result)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                  >
                    <span className="mt-0.5 shrink-0 rounded-md bg-[#0D1282]/8 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#0D1282]">
                      {searchKindLabels[result.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{result.title}</span>
                      <span className="block truncate text-xs text-slate-500">{result.subtitle}</span>
                    </span>
                    <span className="mt-0.5 hidden shrink-0 text-[11px] text-slate-400 sm:block">{result.matchedOn}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
