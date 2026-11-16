"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  FiChevronDown,
  FiDownload,
  FiEye,
  FiFileText,
  FiFilter,
  FiFolder,
  FiSearch,
  FiX
} from "react-icons/fi";
import { toast } from "react-toastify";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import {
  accessClientDocument,
  documentTypeOptions,
  listClientDocuments,
  type ClientDocumentCentreItem,
  type ClientDocumentType
} from "@/lib/documentCentre";
import { getClientDashboard, type ClientDashboardAccount } from "@/lib/clientDashboard";
import { useClientUser } from "@/lib/useClientUser";

type Filters = {
  awb: string;
  dateFrom: string;
  dateTo: string;
  documentType: "" | ClientDocumentType;
  destination: string;
};

const emptyFilters: Filters = {
  awb: "",
  dateFrom: "",
  dateTo: "",
  documentType: "",
  destination: ""
};

const emptyPagination = { page: 1, limit: 20, total: 0, totalPages: 1 };
const controlClass = "h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";

function branchesFor(account: ClientDashboardAccount | null) {
  if (!account) return [];
  return account.assignedBranches.length
    ? account.assignedBranches
    : account.account.assignedBranch ? [account.account.assignedBranch] : [];
}

function formatDate(value: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function readableStatus(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function awbLabel(item: ClientDocumentCentreItem) {
  if (!item.awb) return "-";
  return item.awbCount > 1 ? `${item.awb} +${item.awbCount - 1}` : item.awb;
}

export default function ClientDocumentsPage() {
  const { user, loading: authLoading } = useClientUser();
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);
  const [items, setItems] = useState<ClientDocumentCentreItem[]>([]);
  const [availableTypes, setAvailableTypes] = useState<Array<{ value: ClientDocumentType; label: string }>>(
    [...documentTypeOptions]
  );
  const [pagination, setPagination] = useState(emptyPagination);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const account = useMemo(
    () => accounts.find((item) => item.account.id === accountId) ?? null,
    [accountId, accounts]
  );
  const branches = useMemo(() => branchesFor(account), [account]);

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    void getClientDashboard()
      .then((dashboard) => {
        if (!active) return;
        const available = dashboard.accounts.filter((item) => item.dashboardAccess.state === "READY"
          || (item.account.status === "suspended" && item.account.suspensionMode !== "SECURITY_LOCK"));
        setAccounts(available);
        setAccountId(available[0]?.account.id ?? "");
        if (!available.length) setError("Documents are not available until a business account is active.");
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "The document centre could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [authLoading, user]);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void listClientDocuments({
        businessAccountId: accountId,
        branchId,
        ...appliedFilters,
        page,
        limit: 20
      })
        .then((result) => {
          if (!active) return;
          setItems(result.items);
          setAvailableTypes(result.documentTypes);
          setPagination(result.pagination);
        })
        .catch((caught) => {
          if (active) setError(caught instanceof Error ? caught.message : "Documents could not be loaded.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [accountId, appliedFilters, branchId, page]);

  function submitFilters(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  }

  function resetFilters() {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setPage(1);
  }

  async function access(item: ClientDocumentCentreItem, view: boolean) {
    const key = `${item.id}:${view ? "view" : "download"}`;
    if (busyId) return;
    setBusyId(key);
    try {
      await accessClientDocument(item, view);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The document could not be opened.");
    } finally {
      setBusyId("");
    }
  }

  if (authLoading || !user || (loading && !accounts.length && !error)) {
    return <ClientDashboardLoading />;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {/* <p className="text-sm font-semibold text-[#0D1282]">Documents &amp; Compliance</p> */}
          <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">Document Centre</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Find shipment, customs, billing, claim, and delivery documents in one secure place.
          </p>
        </div>
        {pagination.total ? (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
            <span className="font-semibold text-slate-950">{pagination.total}</span> {pagination.total === 1 ? "document" : "documents"}
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      {account ? (
        <>
         <form
  onSubmit={submitFilters}
  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
>
  <div className="flex flex-col gap-4">
    <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {accounts.length > 1 ? (
        <FilterField label="Business account">
          <div className="relative">
            <select
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
                setBranchId("");
                setFilters(emptyFilters);
                setAppliedFilters(emptyFilters);
                setPage(1);
              }}
              className={`${controlClass} appearance-none pr-10`}
            >
              {accounts.map((item) => (
                <option key={item.account.id} value={item.account.id}>
                  {item.account.company.companyName ||
                    item.account.accountId}
                </option>
              ))}
            </select>

            <FiChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          </div>
        </FilterField>
      ) : null}

      {branches.length > 1 ? (
        <FilterField label="Branch">
          <div className="relative">
            <select
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
                setPage(1);
              }}
              className={`${controlClass} appearance-none pr-10`}
            >
              <option value="">All assigned branches</option>

              {branches.map((branch) => (
                <option key={branch._id} value={branch._id}>
                  {branch.name}
                </option>
              ))}
            </select>

            <FiChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          </div>
        </FilterField>
      ) : null}

      <FilterField label="AWB">
        <div className="relative">
          <FiSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />

          <input
            value={filters.awb}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                awb: event.target.value,
              }))
            }
            placeholder="AWB or parcel number"
            className={`${controlClass} pl-10`}
          />
        </div>
      </FilterField>

      <FilterField label="Document type">
        <div className="relative">
          <select
            value={filters.documentType}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                documentType:
                  event.target.value as Filters["documentType"],
              }))
            }
            className={`${controlClass} appearance-none pr-10`}
          >
            <option value="">All document types</option>

            {availableTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>

          <FiChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        </div>
      </FilterField>

      <FilterField label="Destination">
        <input
          value={filters.destination}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              destination: event.target.value,
            }))
          }
          placeholder="City or country"
          className={controlClass}
        />
      </FilterField>

      <FilterField label="From date">
        <input
          type="date"
          value={filters.dateFrom}
          max={filters.dateTo || undefined}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              dateFrom: event.target.value,
            }))
          }
          className={controlClass}
        />
      </FilterField>

      <FilterField label="To date">
        <input
          type="date"
          value={filters.dateTo}
          min={filters.dateFrom || undefined}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              dateTo: event.target.value,
            }))
          }
          className={controlClass}
        />
      </FilterField>
    </div>

    <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-end">
      <button
        type="button"
        onClick={resetFilters}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
      >
        <FiX className="h-4 w-4" />
        Clear
      </button>

      <button
        type="submit"
        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90"
      >
        <FiSearch className="h-4 w-4" />
        Apply filters
      </button>
    </div>
  </div>
</form>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
              <div>
                <h2 className="font-semibold text-slate-950">Available documents</h2>
                <p className="mt-1 text-xs text-slate-500">Only documents you are permitted to access are shown.</p>
              </div>
              {loading ? <span className="text-xs font-medium text-slate-500">Refreshing…</span> : null}
            </div>

            {!loading && !items.length ? (
              <div className="px-6 py-16 text-center">
                <FiFolder className="mx-auto h-10 w-10 text-slate-300" />
                <h2 className="mt-4 text-lg font-semibold text-slate-900">No documents found</h2>
                <p className="mt-2 text-sm text-slate-500">Try clearing a filter or choosing another date range.</p>
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full min-w-240 text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-5 py-3 font-semibold">Document</th>
                        <th className="px-4 py-3 font-semibold">AWB</th>
                        <th className="px-4 py-3 font-semibold">Destination</th>
                        <th className="px-4 py-3 font-semibold">Date</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                        <th className="px-5 py-3 text-right font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/70">
                          <td className="px-5 py-4">
                            <div className="flex min-w-0 items-start gap-3">
                              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[#0D1282]"><FiFileText /></span>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-slate-950">{item.title}</p>
                                <p className="mt-1 truncate text-xs text-slate-500">{item.documentTypeLabel} · {item.reference}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 font-medium text-slate-700">{awbLabel(item)}</td>
                          <td className="px-4 py-4 text-slate-600">{item.destination || "-"}</td>
                          <td className="whitespace-nowrap px-4 py-4 text-slate-600">{formatDate(item.documentDate)}</td>
                          <td className="px-4 py-4"><span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">{readableStatus(item.status)}</span></td>
                          <td className="px-5 py-4">
                            <DocumentActions item={item} busyId={busyId} onAccess={access} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="divide-y divide-slate-100 lg:hidden">
                  {items.map((item) => (
                    <article key={item.id} className="p-4 sm:p-5">
                      <div className="flex items-start gap-3">
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-[#0D1282]"><FiFileText /></span>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate font-semibold text-slate-950">{item.title}</h3>
                          <p className="mt-1 text-xs text-slate-500">{item.documentTypeLabel} · {item.reference}</p>
                        </div>
                        <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">{item.format}</span>
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <MobileDetail label="AWB" value={awbLabel(item)} />
                        <MobileDetail label="Date" value={formatDate(item.documentDate)} />
                        <MobileDetail label="Destination" value={item.destination || "-"} />
                        <MobileDetail label="Status" value={readableStatus(item.status)} />
                      </dl>
                      <div className="mt-4"><DocumentActions item={item} busyId={busyId} onAccess={access} mobile /></div>
                    </article>
                  ))}
                </div>
              </>
            )}

            {pagination.totalPages > 1 ? (
              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-4 sm:px-5">
                <p className="text-sm text-slate-600">Page <span className="font-semibold text-slate-900">{pagination.page}</span> of {pagination.totalPages}</p>
                <div className="flex gap-2">
                  <PageButton disabled={pagination.page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</PageButton>
                  <PageButton disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setPage((value) => value + 1)}>Next</PageButton>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>{children}</label>;
}

function MobileDetail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs font-medium text-slate-500">{label}</dt><dd className="mt-1 truncate font-medium text-slate-800">{value}</dd></div>;
}

function DocumentActions({
  item,
  busyId,
  onAccess,
  mobile = false
}: {
  item: ClientDocumentCentreItem;
  busyId: string;
  onAccess: (item: ClientDocumentCentreItem, view: boolean) => void;
  mobile?: boolean;
}) {
  const viewBusy = busyId === `${item.id}:view`;
  const downloadBusy = busyId === `${item.id}:download`;
  return (
    <div className={`flex gap-2 ${mobile ? "grid grid-cols-2" : "justify-end"}`}>
      <button type="button" disabled={Boolean(busyId)} onClick={() => onAccess(item, true)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <FiEye className="h-4 w-4" /> {viewBusy ? "Opening…" : "View"}
      </button>
      <button type="button" disabled={Boolean(busyId)} onClick={() => onAccess(item, false)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-3 text-xs font-semibold text-white hover:bg-[#0D1282]/90 disabled:opacity-50">
        <FiDownload className="h-4 w-4" /> {downloadBusy ? "Downloading…" : "Download"}
      </button>
    </div>
  );
}

function PageButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">{children}</button>;
}
