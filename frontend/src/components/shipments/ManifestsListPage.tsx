"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FiDownload, FiEye, FiGrid, FiSearch, FiTrash2, FiPlus, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange } from "@/lib/dateRange";
import Pagination from "@/components/ui/Pagination";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  deleteBulkShipmentManifests,
  deleteShipmentManifest,
  downloadShipmentManifestExcel,
  downloadShipmentManifest,
  listShipmentManifests,
  type ShipmentManifestAudience,
  type ShipmentManifestListItem,
} from "@/lib/shipmentManifests";
import Link from "next/dist/client/link";

export default function ManifestsListPage({
  audience,
}: {
  audience: ShipmentManifestAudience;
}) {
  const canDelete = audience !== "client";
  const [manifests, setManifests] = useState<ShipmentManifestListItem[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 15,
    total: 0,
    totalPages: 1,
  });
  const [page, setPage] = useState(1);
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [busyFormat, setBusyFormat] = useState<"pdf" | "xlsx" | "">("");
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ShipmentManifestListItem | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const requestSequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const data = await listShipmentManifests(audience, { page, dateRange, search });
      if (requestSequence !== loadSequence.current) return;
      setManifests(data.manifests);
      setPagination(data.pagination);
    } catch (caught) {
      if (requestSequence !== loadSequence.current) return;
      setError(
        caught instanceof Error ? caught.message : "Unable to load manifests.",
      );
    } finally {
      if (requestSequence === loadSequence.current) setLoading(false);
    }
  }, [audience, dateRange, page, search]);

  useEffect(() => {
    const nextSearch = searchInput.trim().slice(0, 80);
    if (nextSearch === search) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(nextSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, searchInput]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // `view` opens the PDF in a new tab instead of saving it.
  async function handlePdf(manifest: ShipmentManifestListItem, view: boolean) {
    setBusyId(manifest.id);
    setBusyFormat("pdf");
    try {
      await downloadShipmentManifest(manifest, audience, view);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Manifest could not be opened.",
      );
    } finally {
      setBusyId("");
      setBusyFormat("");
    }
  }

  async function handleExcel(manifest: ShipmentManifestListItem) {
    setBusyId(manifest.id);
    setBusyFormat("xlsx");
    try {
      await downloadShipmentManifestExcel(manifest, audience);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Manifest Excel file could not be downloaded.");
    } finally {
      setBusyId("");
      setBusyFormat("");
    }
  }

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        manifests.forEach((item) => next.add(item.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        manifests.forEach((item) => next.delete(item.id));
        return next;
      });
    }
  }, [manifests]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const confirmSingleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await deleteShipmentManifest(pendingDelete.id, audience);
      toast.success(result.message || `${pendingDelete.manifestNumber} deleted.`);
      setPendingDelete(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(pendingDelete.id);
        return next;
      });
      if (manifests.length === 1 && page > 1) setPage((current) => current - 1);
      else await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Unable to delete this manifest.");
    } finally {
      setDeleting(false);
    }
  }, [audience, load, manifests.length, page, pendingDelete]);

  const confirmBulkDelete = useCallback(async () => {
    if (!selectedIds.size) return;
    setDeleting(true);
    try {
      const ids = [...selectedIds];
      const result = await deleteBulkShipmentManifests(ids, audience);
      toast.success(result.message || `${ids.length} manifest(s) deleted.`);
      setPendingBulkDelete(false);
      clearSelection();
      // If the bulk deleted the whole page, step back so the list is not empty.
      if (manifests.length > 0 && manifests.every((item) => selectedIds.has(item.id)) && page > 1) {
        setPage((current) => current - 1);
      } else {
        await load();
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Unable to delete selected manifests.");
    } finally {
      setDeleting(false);
    }
  }, [audience, clearSelection, load, manifests, page, selectedIds]);

  const allSelected = manifests.length > 0 && manifests.every((item) => selectedIds.has(item.id));
  const someSelected = manifests.some((item) => selectedIds.has(item.id));

  return (
    <div className="mx-auto max-w-375">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold text-[#0D1282]">Manifests</h1>
          <p className="mt-1 text-sm text-slate-500">
            {audience === "client"
              ? "Manifests generated for your business accounts."
              : "Every shipment manifest generated in the portal."}
          </p>
        </div>
        {/* create manifest button */}
      <div className="flex flex-wrap items-center justify-end gap-2">
      <label className="relative w-full sm:w-75">
        <span className="sr-only">Search shipment manifests</span>
        <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          maxLength={80}
          placeholder="Search manifest, account, or shipment"
          aria-label="Search shipment manifests"
          className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
        />
        {searchInput ? (
          <button
            type="button"
            onClick={() => setSearchInput("")}
            aria-label="Clear manifest search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <FiX aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>
      <DateRangeFilter
        value={dateRange}
        onChange={(value) => {
          setDateRange(value);
          setPage(1);
        }}
      />
      <Link
  href={
    audience === "client"
      ? "/client/shipments"
      : "/dashboard/shipments"
  }
  className="inline-flex items-center justify-center rounded-4xl bg-[#0D1282] px-4 py-2 text-sm font-medium text-white hover:bg-[#0D1282]/90"
>
  <FiPlus className="mr-1" />
  Create Manifest
</Link>


        {/* <button
          type="button"
          onClick={() => void load()}
          title="Refresh"
          aria-label="Refresh manifests"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-[#0D1282] hover:border-[#0D1282]"
        >
          <FiRefreshCw
            aria-hidden="true"
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
        </button> */}
      </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {canDelete && selectedIds.size > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#0D1282]/10 bg-[#0D1282]/5 px-4 py-3">
          <p className="text-sm font-semibold text-[#0D1282]">
            {selectedIds.size} manifest{selectedIds.size === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282]"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={() => setPendingBulkDelete(true)}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded-lg bg-[#D71313] px-4 py-2 text-sm font-semibold text-white hover:bg-[#b30f0f] disabled:opacity-50"
            >
              <FiTrash2 aria-hidden="true" className="h-4 w-4" />
              Delete selected
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-250 text-left text-sm">
            <thead className="bg-slate-200 text-xs uppercase text-slate-600 py-4">
              <tr>
                {canDelete ? (
                  <th className="px-4 py-4">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(input) => {
                        if (input) input.indeterminate = !allSelected && someSelected;
                      }}
                      onChange={(event) => toggleSelectAll(event.target.checked)}
                      aria-label="Select all manifests on this page"
                      className="h-4 w-4 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282]"
                    />
                  </th>
                ) : null}
                <th className="px-4 py-4">Manifest No</th>
                <th className="px-4 py-4">Route</th>
                <th className="px-4 py-4">Generated By</th>
                <th className="px-4 py-4 text-center">Shipments</th>
                <th className="px-4 py-4 text-center">Pcs</th>
                <th className="px-4 py-4 text-center">Weight</th>
                <th className="px-4 py-4">Created</th>
                <th className="px-4 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {manifests.map((manifest) => (
                <tr key={manifest.id} id={`manifest-${manifest.id}`} className={`hover:bg-slate-50 ${selectedIds.has(manifest.id) ? "bg-[#0D1282]/5" : ""}`}>
                  {canDelete ? (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(manifest.id)}
                        onChange={() => toggleSelect(manifest.id)}
                        aria-label={`Select manifest ${manifest.manifestNumber}`}
                        className="h-4 w-4 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282]"
                      />
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-semibold text-[#0D1282]">
                    {manifest.manifestNumber}
                  </td>
                  <td className="px-4 py-3 text-slate-800">
                    {manifest.origin || manifest.destination
                      ? `${manifest.origin || "-"} → ${manifest.destination || "-"}`
                      : "Not specified"}
                  </td>
                  <td className="px-4 py-3 text-slate-800">
                    {manifest.generatedBy}
                    <p className="mt-0.5 text-xs capitalize text-slate-500">
                      {manifest.actorRole}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-center tabular-nums text-slate-800">
                    {manifest.shipmentCount}
                  </td>
                  <td className="px-4 py-3 text-center tabular-nums text-slate-800">
                    {manifest.totalPieces}
                  </td>
                  <td className="px-4 py-3 text-center tabular-nums text-slate-800">
                    {manifest.totalWeightKg.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatDashboardDateTime(manifest.generatedAt)}
                  </td>
                  <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => void handlePdf(manifest, true)}
                        disabled={busyId === manifest.id}
                        className="inline-flex items-center gap-1 font-semibold text-[#0D1282] hover:text-blue-700 disabled:opacity-50"
                      >
                        <FiEye aria-hidden="true" className="h-4 w-4" />
                        Preview 
                      </button>
                      <button
                        type="button"
                        onClick={() => void handlePdf(manifest, false)}
                        disabled={busyId === manifest.id}
                        className="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                      >
                        <FiDownload aria-hidden="true" className="h-4 w-4" />
                        {busyId === manifest.id && busyFormat === "pdf"
                          ? "Preparing..."
                          : "Download PDF"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleExcel(manifest)}
                        disabled={busyId === manifest.id}
                        className="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                      >
                        <FiGrid aria-hidden="true" className="h-4 w-4" />
                        {busyId === manifest.id && busyFormat === "xlsx" ? "Preparing..." : "Download Excel"}
                      </button>
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(manifest)}
                          aria-label={`Delete manifest ${manifest.manifestNumber}`}
                          title={`Delete ${manifest.manifestNumber}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-700 transition hover:border-red-600 hover:bg-red-50"
                        >
                          <FiTrash2 aria-hidden="true" className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !manifests.length ? (
                <tr>
                  <td
                    colSpan={canDelete ? 9 : 8}
                    className="px-4 py-14 text-center text-slate-500"
                  >
                      {search ? "No shipment manifests match your search." : "No manifests generated yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        onPageChange={setPage}
      />

      {pendingDelete ? (
        <ConfirmDialog
          title={`Delete manifest ${pendingDelete.manifestNumber}?`}
          description={
            <>
              This permanently removes <span className="font-semibold text-slate-950">{pendingDelete.manifestNumber}</span> and its shipment lines. The included shipments will become available for a new manifest. This action cannot be undone.
            </>
          }
          confirmLabel="Permanently Delete"
          busyLabel="Deleting..."
          busy={deleting}
          onConfirm={confirmSingleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}

      {pendingBulkDelete ? (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} manifest${selectedIds.size === 1 ? "" : "s"}?`}
          description={
            <>
              This permanently removes <span className="font-semibold text-slate-950">{selectedIds.size} manifest{selectedIds.size === 1 ? "" : "s"}</span> and their shipment lines. Included shipments will become available for new manifests. This action cannot be undone.
            </>
          }
          confirmLabel={`Delete ${selectedIds.size} manifest${selectedIds.size === 1 ? "" : "s"}`}
          busyLabel="Deleting..."
          busy={deleting}
          onConfirm={confirmBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      ) : null}
    </div>
  );
}
