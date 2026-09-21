"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { FiCheckCircle, FiPackage, FiRefreshCw } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import ParcelScanner from "@/components/driver/ParcelScanner";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import {
  recordOperationsTrackingScan,
  type OperationsTrackingScanAction,
  type OperationsTrackingScanResult
} from "@/lib/operationsTrackingScans";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

type RecentScan = OperationsTrackingScanResult & { barcode: string };

export default function OperationsScansPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [action, setAction] = useState<OperationsTrackingScanAction>("RECEIVE");
  const [barcode, setBarcode] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [action]);
  if (loading || !user) return <DashboardLoading />;

  async function recordScan(rawBarcode: string) {
    const scanned = rawBarcode.trim().toUpperCase();
    if (!scanned) return;
    setBusy(true);
    try {
      const deviceId = window.localStorage.getItem("swiftline-operations-scanner-id") || crypto.randomUUID();
      window.localStorage.setItem("swiftline-operations-scanner-id", deviceId);
      const response = await recordOperationsTrackingScan({
        action,
        barcode: scanned,
        location: location.trim(),
        deviceId,
        scanRequestId: crypto.randomUUID()
      });
      setRecent((current) => [{ ...response.result, barcode: scanned }, ...current].slice(0, 20));
      setBarcode("");
      toast[response.result.alreadyRecorded ? "info" : "success"](response.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The shipment scan could not be recorded.");
    } finally {
      setBusy(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await recordScan(barcode);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Origin tracking scans</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
          Scan every Swiftline parcel barcode when it reaches the origin facility, then scan every parcel again after export processing. The shipment milestone is recorded automatically only after all its parcels are scanned.
        </p>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid border-b border-slate-200 sm:grid-cols-2">
          {(["RECEIVE", "PROCESS"] as const).map((value) => {
            const selected = action === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setAction(value)}
                className={`px-5 py-4 text-left transition ${selected ? "bg-[#0D1282] text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
              >
                <span className="block text-sm font-semibold">{value === "RECEIVE" ? "Receive at origin facility" : "Process for export"}</span>
                <span className={`mt-1 block text-xs ${selected ? "text-blue-100" : "text-slate-500"}`}>
                  {value === "RECEIVE" ? "Creates Received at Origin Facility" : "Requires receipt and creates Processing for Export"}
                </span>
              </button>
            );
          })}
        </div>

        <form onSubmit={submit} className="space-y-4 p-5 sm:p-6">
          <label className="block text-sm font-semibold text-slate-800">
            Swiftline parcel barcode
            <input
              ref={inputRef}
              value={barcode}
              onChange={(event) => setBarcode(event.target.value.toUpperCase())}
              disabled={busy}
              autoComplete="off"
              placeholder="Scan barcode"
              className="mt-2 h-14 w-full rounded-xl border-2 border-[#0D1282] px-4 font-mono text-lg font-semibold uppercase text-slate-950 outline-none focus:ring-2 focus:ring-[#F0DE36] disabled:bg-slate-100"
            />
          </label>
          <ParcelScanner
            disabled={busy}
            showManual={false}
            cameraLabel="Scan parcel barcode with device camera"
            onScan={recordScan}
            scanScope={action}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-sm font-semibold text-slate-700">
              Scan location (optional)
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={120}
                placeholder="Uses the shipment branch when left empty"
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-[#0D1282] focus:ring-1 focus:ring-[#0D1282]"
              />
            </label>
            <button
              disabled={busy || !barcode.trim()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#0D1282] px-6 text-sm font-semibold text-white hover:bg-blue-900 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy ? <FiRefreshCw className="animate-spin" /> : <FiPackage />}
              {busy ? "Recording..." : action === "RECEIVE" ? "Confirm receipt" : "Confirm processing"}
            </button>
          </div>
        </form>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-slate-950">This device session</h2>
          <p className="mt-1 text-xs text-slate-500">Each parcel is counted once. A shipment milestone appears only when all of its parcels are scanned.</p>
        </div>
        {recent.length ? (
          <ol className="divide-y divide-slate-100">
            {recent.map((item, index) => (
              <li key={`${item.barcode}-${item.status}-${item.eventAt}-${index}`} className="flex items-start gap-3 px-5 py-4">
                <FiCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-slate-950">{item.swiftlineTrackingNumber || item.barcode}</p>
                    <span className="text-xs text-slate-500">{formatDashboardDateTime(item.eventAt)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    {item.progress.milestoneRecorded
                      ? `${item.statusLabel}${item.alreadyRecorded ? " · already recorded" : ""}`
                      : `${item.progress.scannedParcels} of ${item.progress.totalParcels} parcels scanned for ${item.statusLabel}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{item.location}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-slate-500">No parcel barcodes scanned in this browser session.</p>
        )}
      </section>
    </div>
  );
}
