"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import {
  downloadArchivedOperationsManifest,
  getArchivedOperationsManifest,
  listArchivedOperationsManifests,
  type ArchivedOperationsManifest,
} from "@/lib/operationsManifests";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

export default function ArchivedOperationsManifestsPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [items, setItems] = useState<ArchivedOperationsManifest[]>([]);
  const [selected, setSelected] = useState<ArchivedOperationsManifest | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await listArchivedOperationsManifests(page);
      setItems(result.items);
      setPages(result.pagination.pages);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Archived manifests could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [page]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(() => { if (active) return load(); });
    return () => { active = false; };
  }, [load, user]);

  if (loading || !user) return <DashboardLoading />;

  return (
    <main className="mx-auto max-w-8xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[#0D1282]">Archived Operations Manifests</h1>
          <p className="mt-1 text-sm text-slate-600">Deleted issued manifests remain read-only. A reused number identifies a different, active manifest.</p>
        </div>
        <Link href="/dashboard/operations-manifests" className="text-sm font-semibold text-[#0D1282] underline underline-offset-4">Active manifests</Link>
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {busy ? <p className="p-5 text-sm text-slate-600">Loading archives…</p> : items.length === 0 ? (
          <p className="p-5 text-sm text-slate-600">No archived issued manifests found.</p>
        ) : items.map((item) => (
          <button key={item.id} type="button" onClick={async () => {
            try { setSelected((await getArchivedOperationsManifest(item.id)).archive); }
            catch (caught) { toast.error(caught instanceof Error ? caught.message : "This archive could not be opened."); }
          }} className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">
            <span><strong className="text-[#0D1282]">{item.manifestNumber}</strong><span className="ml-2 text-sm text-slate-600">{item.status} · {item.header.flightNumber || "Flight not recorded"}</span></span>
            <span className="text-xs text-slate-600">Archived {new Date(item.archivedAt).toLocaleString("en-IN")}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 text-sm">
        <button type="button" disabled={page === 1} onClick={() => { setSelected(null); setPage((value) => value - 1); }} className="rounded border px-3 py-2 disabled:opacity-40">Previous</button>
        <span>Page {page} of {pages}</span>
        <button type="button" disabled={page >= pages} onClick={() => { setSelected(null); setPage((value) => value + 1); }} className="rounded border px-3 py-2 disabled:opacity-40">Next</button>
      </div>
      {selected && (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5" aria-label={`Archived ${selected.manifestNumber}`}>
          <div>
            <h2 className="text-lg font-semibold text-[#0D1282]">{selected.manifestNumber} · archived copy</h2>
            <p className="text-sm text-slate-600">{selected.header.flightNumber || "Flight not recorded"} · Departure {selected.header.departureDate || "not recorded"} · {selected.document?.totals.totalPhysicalParcels ?? 0} parcels</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selected.documents.map((file) => <button key={file.format} type="button" onClick={async () => {
              try { await downloadArchivedOperationsManifest(selected.id, file.format, file.filename); }
              catch (caught) { toast.error(caught instanceof Error ? caught.message : "Archived export could not be downloaded."); }
            }} className="rounded-lg border border-[#0D1282]/20 px-3 py-2 text-sm font-semibold text-[#0D1282] hover:bg-slate-50">{file.format === "csbVEdi" ? "CSB-V EDI" : file.format === "opsEdi" ? "OPS EDI" : file.format.toUpperCase()}</button>)}
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="bg-slate-100 text-slate-700"><tr><th className="px-3 py-2">HAWB</th><th className="px-3 py-2">Parcel barcode</th><th className="px-3 py-2">Bag</th></tr></thead>
              <tbody>{selected.document?.consignments.flatMap((item) => item.parcels.map((parcel, index) => (
                <tr key={`${item.consignmentNumber}-${index}`} className="border-t border-slate-100"><td className="px-3 py-2">{item.consignmentNumber}</td><td className="px-3 py-2">{parcel.parcelNumber}</td><td className="px-3 py-2">{parcel.bagNumber}</td></tr>
              )))}</tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
