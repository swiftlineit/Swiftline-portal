"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FiArrowRight, FiPlus, FiChevronDown, FiSearch, FiTrash2, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import OperationsManifestDeleteDialog from "@/components/shipments/OperationsManifestDeleteDialog";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange } from "@/lib/dateRange";
import {
  deleteOperationsManifest,
  listOperationsManifests,
  type ManifestStatus,
  type OperationsManifest,
} from "@/lib/operationsManifests";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { normalizeFlightNumber } from "@/lib/flightNumber";

const statuses: ManifestStatus[] = [
  "DRAFT",
  "PACKING",
  "READY_TO_SEAL",
  "SEALED",
  "DISPATCHED",
  "CANCELLED",
];

const dispatchedDeleteReason =
  "Dispatched manifests cannot be deleted because their dispatch and shipment tracking history must remain auditable.";

function ManifestDeleteAction({
  manifest,
  onDelete,
}: {
  manifest: OperationsManifest;
  onDelete: (manifest: OperationsManifest) => void;
}) {
  if (manifest.status !== "DISPATCHED") {
    return (
      <button
        type="button"
        onClick={() => onDelete(manifest)}
        aria-label={`Delete manifest ${manifest.manifestNumber}`}
        title={`Delete ${manifest.manifestNumber}`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-700 outline-none transition hover:border-red-600 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600/30"
      >
        <FiTrash2 aria-hidden="true" />
      </button>
    );
  }

  const tooltipId = `manifest-delete-disabled-${manifest.id}`;

  return (
    <span
      tabIndex={0}
      aria-disabled="true"
      aria-label={`Delete manifest ${manifest.manifestNumber} unavailable`}
      aria-describedby={tooltipId}
      className="group relative inline-flex cursor-not-allowed rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-slate-400/50"
    >
      <button
        type="button"
        disabled
        aria-label={`Delete manifest ${manifest.manifestNumber}`}
        className="inline-flex h-9 w-9 cursor-not-allowed items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-400"
      >
        <FiTrash2 aria-hidden="true" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none invisible absolute right-full top-1/2 z-50 mr-3 w-64 -translate-y-1/2 rounded-lg bg-slate-900 px-3 py-2 text-left text-xs font-medium leading-5 text-white opacity-0 shadow-lg transition duration-150 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100"
      >
        <span
          aria-hidden="true"
          className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-slate-900"
        />
        {dispatchedDeleteReason}
      </span>
    </span>
  );
}

function OperationsManifestListPageContent() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const searchParams = useSearchParams();
  const [items, setItems] = useState<OperationsManifest[]>([]);
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "");
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OperationsManifest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    const requestSequence = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const data = await listOperationsManifests(page, status, dateRange, search);
      if (requestSequence !== loadSequence.current) return;
      setItems(data.items);
      setPages(data.pagination.pages);
    } catch (caught) {
      if (requestSequence !== loadSequence.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load operations manifests.",
      );
    } finally {
      if (requestSequence === loadSequence.current) setBusy(false);
    }
  }, [page, status, dateRange, search]);

  useEffect(() => {
    const nextSearch = searchInput.trim().slice(0, 100);
    if (nextSearch === search) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(nextSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, searchInput]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return load();
    });
    return () => {
      active = false;
    };
  }, [load, user]);

  const confirmDelete = useCallback(async (input: { confirmationManifestNumber: string; mode: "ARCHIVE" | "PERMANENT"; reason: string }) => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await deleteOperationsManifest(pendingDelete.id, input);
      toast.success(result.message);
      setPendingDelete(null);
      if (items.length === 1 && page > 1) setPage((current) => current - 1);
      else await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Unable to delete this operations manifest.");
    } finally {
      setDeleting(false);
    }
  }, [items.length, load, page, pendingDelete]);

  if (loading || !user) return <DashboardLoading />;

  return (
      <div className="mx-auto max-w-8xl">
        <div className="mb-6 rounded-xl border border-[#EEEDED] bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-[#0D1282]">
                Operations Manifests
              </h1>
              <p className="mt-1 text-sm leading-5 text-slate-500">
                Build flight manifests by scanning Swiftline parcel labels into bags.
              </p>
            </div>
            <Link
              href="/dashboard/operations-manifests/new"
              className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0D1282]/90 sm:w-auto"
            >
              <FiPlus />
              New Manifest
            </Link>
          </div>

          <div className="mt-5 grid gap-2 border-t border-slate-200 pt-4 md:grid-cols-2 lg:grid-cols-[minmax(240px,1fr)_auto_auto_auto]">
            <label className="relative min-w-0 md:col-span-2 lg:col-span-1">
              <span className="sr-only">Search operations manifests</span>
              <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                maxLength={100}
                placeholder="Search manifest, flight, or shipment"
                aria-label="Search operations manifests"
                className="h-10 w-full rounded-xl border border-[#0D1282]/20 bg-white pl-9 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  aria-label="Clear operations manifest search"
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  <FiX aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </label>

            <Link
              href="/dashboard/operations-manifests/archived"
              className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-xl border border-[#0D1282]/20 px-3 text-sm font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
            >
              Archived manifests
            </Link>

            <DateRangeFilter
              value={dateRange}
              className="min-w-0 justify-between"
              onChange={(value) => {
                setDateRange(value);
                setPage(1);
              }}
            />

            <div className="relative min-w-0">
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
                className="h-10 w-full appearance-none rounded-xl border border-[#0D1282]/20 bg-white px-3 pr-10 text-sm font-medium text-[#0D1282]"
              >
                <option value="">All Status</option>
                {statuses.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#0D1282]/50" />
            </div>
          </div>
        </div>
        {error ? (
          <div className="mb-4 rounded-md border border-[#D71313]/30 bg-[#D71313]/5 p-4 text-sm font-semibold text-[#D71313]">
            {error}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-225 text-left text-sm">
              <thead className="bg-slate-200 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-5 py-4">Manifest</th>
                  <th className="px-5 py-4">Branch</th>
                  <th className="px-5 py-4">Route / Flight</th>
                  <th className="px-5 py-4 text-center">Bags</th>
                  <th className="px-5 py-4 text-center">Consignments</th>
                  <th className="px-5 py-4 text-center">Weight</th>
                  <th className="px-5 py-4">Status</th>
                  <th className="px-5 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEEDED]">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-[#EEEDED]/40">
                    <td className="px-5 py-4 font-semibold text-[#0D1282]">
                      {item.manifestNumber}
                      <p className="mt-1 text-xs font-normal text-slate-500">
                        {new Date(item.updatedAt).toLocaleString("en-IN")}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      {item.branch?.name ?? "Branch"}
                      <p className="text-xs text-slate-500">
                        {item.branch?.code}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      {item.header.originIataCode &&
                      item.header.destinationIataCode
                        ? `${item.header.originIataCode} - ${item.header.destinationIataCode}`
                        : "Route pending"}
                      <p className="text-xs text-slate-500">
                        {item.header.flightNumber ? normalizeFlightNumber(item.header.flightNumber) : "Flight pending"}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-center">{item.totalBags}</td>
                    <td className="px-5 py-4 text-center">
                      {item.totalConsignments}
                    </td>
                    <td className="px-5 py-4 text-center tabular-nums text-slate-800">
                      {item.totalWeightKg.toFixed(2)}
                    </td>
                    <td className="px-5 py-4">
                      <span className="rounded-4xl border border-[#0D1282]/20 bg-[#EEEDED] px-2 py-1 text-xs font-semibold text-[#0D1282]">
                        {item.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/dashboard/operations-manifests/${item.id}`}
                          className="inline-flex items-center gap-2 font-semibold text-[#0D1282]"
                        >
                          Open <FiArrowRight />
                        </Link>
                        <ManifestDeleteAction
                          manifest={item}
                          onDelete={setPendingDelete}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
                {!busy && !items.length ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-14 text-center text-slate-500"
                    >
                      {search ? "No operations manifests match your search." : "No operations manifests found."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
            className="h-9 rounded-md border border-[#0D1282]/20 bg-white px-4 text-sm text-[#0D1282] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="flex h-9 items-center px-3 text-sm text-slate-600">
            Page {page} of {pages}
          </span>
          <button
            disabled={page >= pages}
            onClick={() => setPage((value) => value + 1)}
            className="h-9 rounded-md border border-[#0D1282]/20 bg-white px-4 text-sm text-[#0D1282] disabled:opacity-40"
          >
            Next
          </button>
        </div>
        {pendingDelete ? (
          <OperationsManifestDeleteDialog
            manifest={pendingDelete}
            busy={deleting}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        ) : null}
      </div>
  );
}

export default function OperationsManifestListPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <OperationsManifestListPageContent />
    </Suspense>
  );
}
