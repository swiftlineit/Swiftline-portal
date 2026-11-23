"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { FiDownload, FiRefreshCw, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import WalletBalanceSummary from "@/components/payments/WalletBalanceSummary";
import PaymentLedgerTable from "@/components/payments/PaymentLedgerTable";
import {
  exportAdminPrepaidLedger,
  getAdminPrepaidLedger,
  type AdminPrepaidLedger
} from "@/lib/prepaidLedger";
import { PREPAID_LEDGER_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

type ExportPeriod = "3m" | "6m" | "all" | "custom";

function localDateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function rangeFor(period: Exclude<ExportPeriod, "custom">) {
  if (period === "all") return {};
  const today = new Date();
  const from = new Date(today);
  from.setDate(1);
  from.setMonth(from.getMonth() - Number(period.slice(0, -1)));
  return { from: localDateString(from), to: localDateString(today) };
}

export default function AdminPrepaidLedgerPage() {
  const params = useParams<{ businessAccountId: string }>();
  const businessAccountId = params.businessAccountId;
  const { user, loading: userLoading } = useAdminUser(PREPAID_LEDGER_AREA);
  const [data, setData] = useState<AdminPrepaidLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [showExport, setShowExport] = useState(false);
  const [period, setPeriod] = useState<ExportPeriod>("3m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const loadLedger = useCallback(async (quiet = false) => {
    if (!businessAccountId) return;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await getAdminPrepaidLedger(businessAccountId, { page, limit: 50 });
      setData(response);
      if (typeof window !== "undefined" && window.location.hash === "#wallet-ledger") {
        window.requestAnimationFrame(() => document.getElementById("wallet-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Wallet ledger could not be loaded.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [businessAccountId, page]);

  useEffect(() => {
    if (!user || !businessAccountId) return;
    let active = true;
    void getAdminPrepaidLedger(businessAccountId, { page, limit: 50 }).then((response) => {
      if (!active) return;
      setData(response);
      if (typeof window !== "undefined" && window.location.hash === "#wallet-ledger") {
        window.requestAnimationFrame(() => document.getElementById("wallet-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    }).catch((error: unknown) => {
      if (active) toast.error(error instanceof Error ? error.message : "Wallet ledger could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [businessAccountId, page, user]);

  const selectedRange = useMemo(() => {
    if (period !== "custom") return rangeFor(period);
    return { from: customFrom, to: customTo };
  }, [customFrom, customTo, period]);

  const validCustomRange = period !== "custom" || (Boolean(customFrom) && Boolean(customTo) && customFrom <= customTo);

  async function handleExport() {
    if (!validCustomRange) {
      toast.error("Choose a valid start and end date.");
      return;
    }
    setExporting(true);
    try {
      await exportAdminPrepaidLedger(businessAccountId, selectedRange);
      setShowExport(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Wallet ledger export could not be downloaded.");
    } finally {
      setExporting(false);
    }
  }

  if (userLoading || !user) return <DashboardLoading />;
  const wallet = data?.wallet;

  return (
    <div className="mx-auto max-w-8xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">{data?.account.companyName || "Account ledger"}</h1>
          <p className="mt-1 text-sm text-slate-600">Payment history for account {data?.account.accountId || "?"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void loadLedger(true)} disabled={refreshing || loading} className="inline-flex h-10 w-36 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:opacity-60">
            <FiRefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button type="button" onClick={() => setShowExport(true)} className="inline-flex h-10 w-36 items-center justify-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800">
            <FiDownload aria-hidden="true" className="h-4 w-4" /> Export ledger
          </button>
        </div>
      </div>

      {wallet ? <WalletBalanceSummary wallet={wallet} /> : null}

      <section id="wallet-ledger" className="scroll-mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="wallet-ledger-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="wallet-ledger-heading" className="text-base font-semibold text-slate-950">Account ledger</h2>
            <p className="mt-1 text-sm text-slate-600">Wallet movements, Razorpay booking payments, cash receipts and refunds.</p>
          </div>
          {data ? <p className="text-sm text-slate-500">{data.pagination.total} entries</p> : null}
        </div>
        <PaymentLedgerTable rows={data?.transactions ?? []} audience="staff" loading={loading} />
        {data ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
            <span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page <= 1 || loading} className="h-9 rounded-lg border border-slate-300 px-3 font-semibold disabled:opacity-40">Previous</button>
              <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.min(data.pagination.totalPages, value + 1)); }} disabled={page >= data.pagination.totalPages || loading} className="h-9 rounded-lg border border-slate-300 px-3 font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        ) : null}
      </section>

      {showExport ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowExport(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="export-wallet-ledger-title" className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div><h2 id="export-wallet-ledger-title" className="text-lg font-semibold text-slate-950">Export account ledger</h2><p className="mt-1 text-sm text-slate-600">Choose the transaction dates to include in the CSV.</p></div>
              <button type="button" onClick={() => setShowExport(false)} aria-label="Close export options" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><FiX aria-hidden="true" /></button>
            </div>
            <fieldset className="mt-5 space-y-3">
              <legend className="sr-only">Date range</legend>
              {([ ["3m", "Last 3 months"], ["6m", "Last 6 months"], ["all", "All time"], ["custom", "Custom dates"] ] as const).map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-blue-950 has-[:checked]:border-blue-900 has-[:checked]:bg-blue-50">
                  <input type="radio" name="wallet-ledger-range" value={value} checked={period === value} onChange={() => setPeriod(value)} className="h-4 w-4 accent-blue-900" />{label}
                </label>
              ))}
            </fieldset>
            {period === "custom" ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600">From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label>
                <label className="text-xs font-semibold text-slate-600">To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label>
              </div>
            ) : null}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setShowExport(false)} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Cancel</button>
              <button type="button" onClick={() => void handleExport()} disabled={exporting || !validCustomRange} className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
                <FiDownload aria-hidden="true" className="h-4 w-4" /> {exporting ? "Preparing export…" : "Download CSV"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
