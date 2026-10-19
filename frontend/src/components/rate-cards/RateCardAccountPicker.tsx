"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FiChevronDown, FiSearch } from "react-icons/fi";

import {
  listRateCardBusinessAccountOptions,
  type RateCardBusinessAccountOption
} from "@/lib/countryRateCards";

type Selection = {
  id: string;
  name: string;
  accountId: string;
};

type AccountResult = {
  query: string;
  accounts: RateCardBusinessAccountOption[];
};

export default function RateCardAccountPicker({
  selected,
  onSelect
}: {
  selected: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [accountResult, setAccountResult] = useState<AccountResult>({ query: "", accounts: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;

    let current = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");

      void listRateCardBusinessAccountOptions(query)
        .then((result) => {
          if (current) setAccountResult({ query, accounts: result.accounts });
        })
        .catch(() => {
          if (current) setError("Unable to load accounts. Try searching again.");
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 200);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  const options = useMemo<Selection[]>(() => {
    const accounts = accountResult.query === query ? accountResult.accounts : [];
    const showIndividualOption = !query || "individual clients".includes(query.toLowerCase());

    return [
      ...(showIndividualOption ? [{ id: "", name: "Individual Clients", accountId: "" }] : []),
      ...accounts.map((account) => ({
        id: account._id,
        name: account.company.companyName || account.accountId,
        accountId: account.accountId
      }))
    ];
  }, [accountResult, query]);

  const searching = loading || (open && accountResult.query !== query);

  function choose(option: Selection) {
    onSelect(option);
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.max(
        0,
        Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
      ));
      return;
    }

    if (event.key === "Enter" && open && options[active]) {
      event.preventDefault();
      choose(options[active]!);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <label htmlFor={id} className="mb-2 block text-sm font-semibold text-slate-800">
        Business account or Individual Clients
      </label>

      <div className="relative">
        <FiSearch
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        />
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined}
          autoComplete="off"
          value={open ? query : `${selected.name}${selected.accountId ? ` — ${selected.accountId}` : ""}`}
          placeholder="Search business name or account number"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-10 pr-11 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-600 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
        />
        <button
          type="button"
          aria-label="Choose rate card"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          onClick={() => {
            setOpen((current) => !current);
            if (!open) inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
        >
          <FiChevronDown aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-lg border border-slate-300 bg-white shadow-md">
          {searching ? <p role="status" className="px-4 py-2 text-xs text-slate-600">Searching accounts…</p> : null}
          {error ? <p role="alert" className="px-4 py-3 text-sm text-red-700">{error}</p> : null}
          <ul id={`${id}-options`} role="listbox" aria-label="Rate cards" className="max-h-72 overflow-y-auto py-1">
            {options.map((option, index) => (
              <li
                key={option.id || "individual"}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={selected.id === option.id}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                className={`cursor-pointer px-4 py-3 text-sm hover:bg-slate-100 ${index === active ? "bg-slate-100" : ""}`}
              >
                <span className="block font-medium text-slate-900">{option.name}</span>
                <span className="mt-0.5 block text-xs text-slate-600">
                  {option.accountId || "Global individual booking tariff"}
                </span>
              </li>
            ))}
            {!searching && !error && !options.length ? (
              <li className="px-4 py-4 text-sm text-slate-600">No matching business accounts.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
