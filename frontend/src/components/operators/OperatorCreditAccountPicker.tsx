"use client";

import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiSearch } from "react-icons/fi";
import type { OperatorCreditPagination } from "@/lib/operatorCredit";

export type OperatorCreditAccountOption = {
  id: string;
  accountId: string;
  companyName: string;
  creditStatus?: string;
};

function formatStatus(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function OperatorCreditAccountPicker({
  selected,
  accounts,
  pagination,
  loading,
  page,
  onSelect,
  onSearch,
  onPageChange
}: {
  selected: OperatorCreditAccountOption | null;
  accounts: OperatorCreditAccountOption[];
  pagination: OperatorCreditPagination;
  loading: boolean;
  page: number;
  onSelect: (account: OperatorCreditAccountOption) => void;
  onSearch: (query: string) => void;
  onPageChange: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncing, setDebouncing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const onSearchRef = useRef(onSearch);
  const listId = "operator-credit-account-options";

  useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => {
      onSearchRef.current(query.trim());
      setDebouncing(false);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [open, query]);

  useEffect(() => {
    function closeWhenOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setDebouncing(false);
      }
    }
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, []);

  function openOptions() {
    setQuery("");
    setDebouncing(true);
    setActiveIndex(0);
    setOpen(true);
  }

  function choose(account: OperatorCreditAccountOption) {
    onSelect(account);
    setDebouncing(false);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          id="operator-credit-account"
          role="combobox"
          aria-label="Business account"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && accounts[activeIndex] ? `${listId}-${accounts[activeIndex].id}` : undefined}
          autoComplete="off"
          value={open ? query : selected?.companyName ?? ""}
          onFocus={() => { if (!open) openOptions(); }}
          onClick={() => { if (!open) openOptions(); }}
          onChange={(event) => { setDebouncing(true); setQuery(event.target.value.slice(0, 100)); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setDebouncing(false); setOpen(false); return; }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((value) => Math.min(Math.max(accounts.length - 1, 0), value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter" && open && accounts[activeIndex]) {
              event.preventDefault();
              choose(accounts[activeIndex]);
            }
          }}
          placeholder="Search by company name or account ID"
          className="min-h-11 w-full rounded-md border border-slate-300 bg-white py-2 pl-10 pr-12 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
        />
        <FiChevronDown aria-hidden="true" className={`pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </div>
      {selected && !open ? <p className="mt-1.5 text-xs text-slate-500">Account ID: {selected.accountId}</p> : null}
      {open ? (
        <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div id={listId} role="listbox" aria-label="Business accounts" className="max-h-72 overflow-y-auto py-1">
            {loading || debouncing ? <p role="status" className="px-3.5 py-4 text-sm text-slate-500">Searching accounts…</p> : null}
            {!loading && !debouncing && accounts.length === 0 ? <p className="px-3.5 py-4 text-sm text-slate-500">No matching business accounts.</p> : null}
            {!loading && !debouncing ? accounts.map((account, index) => (
              <button
                id={`${listId}-${account.id}`}
                key={account.id}
                type="button"
                role="option"
                aria-selected={selected?.id === account.id}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(account)}
                className={`flex min-h-14 w-full items-center justify-between gap-3 px-3.5 py-2 text-left transition ${index === activeIndex ? "bg-indigo-50" : "hover:bg-slate-50"}`}
              >
                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-900">{account.companyName}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{account.accountId}</span></span>
                {account.creditStatus ? <span className="shrink-0 text-xs text-slate-500">{formatStatus(account.creditStatus)}</span> : null}
              </button>
            )) : null}
          </div>
          {!debouncing && pagination.totalPages > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-600">
              <span>Page {pagination.page} of {pagination.totalPages}</span>
              <span className="flex gap-2">
                <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={loading || page <= 1} className="min-h-8 rounded border border-slate-300 bg-white px-2.5 font-semibold disabled:opacity-40">Previous</button>
                <button type="button" onClick={() => onPageChange(Math.min(pagination.totalPages, page + 1))} disabled={loading || page >= pagination.totalPages} className="min-h-8 rounded border border-slate-300 bg-white px-2.5 font-semibold disabled:opacity-40">Next</button>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
