"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FiChevronDown, FiX } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import CancellationReview from "@/components/shipments/CancellationReview";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange } from "@/lib/dateRange";
import Pagination from "@/components/ui/Pagination";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import {
  listShipmentCancellations,
  type ShipmentCancellation
} from "@/lib/shipmentCancellations";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const emptyPagination = { page: 1, limit: 50, total: 0, totalPages: 1 };

export default function CancellationsPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [status, setStatus] = useState("");
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(emptyPagination);
  const [items, setItems] = useState<ShipmentCancellation[]>([]);
  const [selected, setSelected] = useState<ShipmentCancellation | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setDataLoading(true);
    setError("");
    try {
      const result = await listShipmentCancellations({ status, dateRange, page });
      setItems(result.cancellations);
      setPagination(result.pagination);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load cancellations.");
    } finally {
      setDataLoading(false);
    }
  }, [status, dateRange, page]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    async function loadWhenMounted() {
      await Promise.resolve();
      if (active) await load();
    }
    void loadWhenMounted();
    return () => { active = false; };
  }, [load, user]);

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Shipment Cancellations</h1>
          <p className="mt-1 text-sm text-slate-500">Review requests, confirm carrier cancellation, and apply refunds.</p>
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
    className="h-10 appearance-none border rounded border-slate-300 bg-white pl-3 pr-9 text-sm font-semibold text-slate-700 outline-none focus:border-blue-900"
  >
    <option value="">All Status</option>
    <option value="REQUESTED">Requested</option>
    <option value="COMPLETED">Completed</option>
    <option value="REJECTED">Rejected</option>
  </select>
  <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
</div>
          {/* <button type="button" onClick={() => void load()} disabled={dataLoading} aria-label="Refresh cancellations" title="Refresh cancellations" className="flex h-10 w-10 items-center justify-center border border-slate-300 bg-white text-blue-900 disabled:opacity-50">
            <FiRefreshCw className={dataLoading ? "animate-spin" : ""} aria-hidden="true" />
          </button> */}
        </div>
      </div>

      {error ? <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}
      <div className="overflow-x-auto border border-slate-200 bg-white rounded-2xl">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">AWB / Shipment No.</th><th className="px-4 py-3">Consignee</th>
              <th className="px-4 py-3">Account / Branch</th><th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Invoice Amount</th><th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 ">Actions</th>
            </tr>
          </thead>
          <tbody>
            {dataLoading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">Loading cancellation requests...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No cancellation requests found.</td></tr>
            ) : items.map((item) => (
              <tr key={item.id} id={`cancellation-${item.id}`} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-4">
                  <Link href={"/dashboard/shipments/" + item.shipmentDraftId} className="font-semibold text-blue-900 hover:text-blue-700">{item.shipmentReference || "AWB Pending"}</Link>
                  <p className="mt-1 text-xs capitalize text-slate-500">{item.requesterType.toLowerCase()} request</p>
                </td>
                <td className="px-4 py-4 font-medium text-slate-800">{item.consignee || "Not provided"}</td>
                <td className="px-4 py-4">
                  <p className="font-medium text-slate-800">{item.businessAccount?.companyName || "Not provided"}</p>
                  <p className="mt-1 text-xs text-slate-500">{item.branch?.name || "No branch"} {item.branch?.code ? "(" + item.branch.code + ")" : ""}</p>
                </td>
                <td className="px-4 py-4">
                  <p className="text-slate-700">{formatDashboardDateTime(item.requestedAt)}</p>
                  <p className="mt-1 max-w-xs truncate text-xs text-slate-500">{item.reason}</p>
                </td>
                <td className="px-4 py-4  font-semibold text-slate-950">{money.format(item.originalAmountMinor / 100)}</td>
                <td className="px-4 py-4 "><Status value={item.status} /></td>
                <td className="px-4 py-4 "><button type="button" onClick={() => setSelected(item)} className="font-semibold text-blue-900 hover:text-blue-700">{item.status === "REQUESTED" ? "Review" : "View"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        onPageChange={setPage}
      />

      {selected ? <CancellationModal cancellation={selected} onClose={() => setSelected(null)} onChanged={async () => { setSelected(null); await load(); }} /> : null}
    </>
  );
}

function Status({ value }: { value: ShipmentCancellation["status"] }) {
  const classes = value === "COMPLETED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : value === "REJECTED" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800";
  return <span className={"border px-2 py-1 rounded-2xl text-xs font-semibold uppercase " + classes}>{value}</span>;
}

function CancellationModal({ cancellation, onClose, onChanged }: {
  cancellation: ShipmentCancellation;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true">
    <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto bg-white shadow-xl rounded-2xl">
      <div className="flex items-start justify-between border-b border-slate-200 p-5">
        <div><p className="text-xs font-semibold uppercase text-slate-500">Shipment Cancellation</p><h2 className="mt-1 text-xl font-semibold text-slate-950">{cancellation.shipmentReference || "AWB Pending"}</h2><p className="mt-1 text-sm text-slate-500">{cancellation.consignee}</p></div>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600"><FiX /></button>
      </div>
      <CancellationReview key={cancellation.id} cancellation={cancellation} onChanged={onChanged} />
    </div>
  </div>;
}
