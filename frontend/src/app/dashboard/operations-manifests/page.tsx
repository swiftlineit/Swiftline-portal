"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FiArrowRight, FiPlus, FiChevronDown, FiTrash2 } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
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

function OperationsManifestListPageContent() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const searchParams = useSearchParams();
  const [items, setItems] = useState<OperationsManifest[]>([]);
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "");
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OperationsManifest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const data = await listOperationsManifests(page, status, dateRange);
      setItems(data.items);
      setPages(data.pagination.pages);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load operations manifests.",
      );
    } finally {
      setBusy(false);
    }
  }, [page, status, dateRange]);
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

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await deleteOperationsManifest(pendingDelete.id, pendingDelete.manifestNumber);
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

  const deletedNumberWillBeReused = pendingDelete
    ? ["DRAFT", "PACKING", "READY_TO_SEAL"].includes(pendingDelete.status)
    : false;

  return (
      <div className="mx-auto max-w-8xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4 rounded-lg border border-[#EEEDED] bg-white p-5 shadow-sm">
          <div>
            <h1 className="text-2xl font-semibold text-[#0D1282]">
              Operations Manifests
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Build flight manifests by scanning Swiftline parcel labels into
              bags.
            </p>
          </div>
          <div className="flex gap-2">
           <DateRangeFilter
             value={dateRange}
             onChange={(value) => {
               setDateRange(value);
               setPage(1);
             }}
           />
           <div className="relative">
  <select
    value={status}
    onChange={(event) => {
      setStatus(event.target.value);
      setPage(1);
    }}
    className="h-10 w-full appearance-none rounded-4xl border border-[#0D1282]/20 bg-white px-3 pr-10 text-sm font-medium text-[#0D1282]"
  >
    <option value="">All Status</option>
    {statuses.map((item) => (
      <option key={item}>{item}</option>
    ))}
  </select>
  <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#0D1282]/50" />
</div>
           
            <Link
              href="/dashboard/operations-manifests/new"
              className="inline-flex h-10 items-center gap-2 rounded-4xl bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0D1282]/90"
            >
              <FiPlus />
              New Manifest
            </Link>
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
                        <button
                          type="button"
                          onClick={() => setPendingDelete(item)}
                          aria-label={`Delete manifest ${item.manifestNumber}`}
                          title={`Delete ${item.manifestNumber}`}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-700 transition hover:border-red-600 hover:bg-red-50"
                        >
                          <FiTrash2 aria-hidden="true" />
                        </button>
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
                      No operations manifests found.
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
          <ConfirmDialog
            title={`Delete manifest ${pendingDelete.manifestNumber}?`}
            description={deletedNumberWillBeReused ? (
              <>
                This permanently removes the manifest and its packing/scanner records. Its number will be released, so the next new operations manifest will use <span className="font-semibold text-slate-950">{pendingDelete.manifestNumber}</span>. This action cannot be undone.
              </>
            ) : (
              <>
                This permanently removes this <span className="font-semibold text-slate-950">{pendingDelete.status.replaceAll("_", " ")}</span> manifest and its downloadable manifest records. Shipment tracking history remains, and <span className="font-semibold text-slate-950">{pendingDelete.manifestNumber}</span> stays permanently reserved. This action cannot be undone.
              </>
            )}
            confirmLabel="Permanently Delete"
            busyLabel="Deleting..."
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
