"use client";

import { useEffect, useState } from "react";
import { getClientPrepaidTransactions, type ClientPrepaidTransaction, type PaymentPagination as Pagination } from "@/lib/clientDashboard";
import { getClientAccountLedger } from "@/lib/prepaidLedger";
import PaymentLedgerTable, { type PaymentLedgerRow } from "./PaymentLedgerTable";
import PaymentPagination from "./PaymentPagination";

export default function ClientPaymentLedger({ businessAccountId, initialTransactions }: { businessAccountId: string; initialTransactions: ClientPrepaidTransaction[] }) {
  const [mode, setMode] = useState<"wallet" | "account">("wallet");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PaymentLedgerRow[]>(initialTransactions);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: initialTransactions.length, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const promise = mode === "wallet" ? getClientPrepaidTransactions(businessAccountId, page) : getClientAccountLedger(businessAccountId, page);
    void promise.then((result) => {
      if (!active) return;
      setRows(result.transactions);
      setPagination(result.pagination ?? { page, limit: 50, total: result.transactions.length, totalPages: 1 });
    }).catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Activity could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [businessAccountId, mode, page]);
  function changeMode(nextMode: "wallet" | "account") {
    if (nextMode === mode) return;
    setError("");
    setLoading(true);
    setPage(1);
    setMode(nextMode);
  }
  function changePage(nextPage: number) {
    setError("");
    setLoading(true);
    setPage(nextPage);
  }
  return (
    <section id="wallet-ledger" aria-label="Payment activity" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div><h2 className="text-base font-semibold text-slate-950">{mode === "wallet" ? "Wallet activity" : "Account ledger"}</h2><p className="mt-1 text-xs text-slate-500">{mode === "wallet" ? "Top-ups, shipment charges, holds and refunds." : "Wallet movements, Razorpay booking payments, cash receipts and refunds. External payments do not change the wallet."}</p></div>
        <div className="flex rounded-lg border border-slate-200 p-1" aria-label="Activity type">{([ ["wallet", "Wallet activity"], ["account", "All transactions"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => changeMode(value)} className={`rounded-md px-3 py-2 text-xs font-semibold ${mode === value ? "bg-blue-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{label}</button>)}</div>
      </div>
      {error ? <p role="alert" className="p-5 text-sm text-red-700">{error}</p> : <PaymentLedgerTable rows={rows} audience="client" walletOnly={mode === "wallet"} loading={loading} />}
      <PaymentPagination label="Payment activity pages" page={page} totalPages={pagination.totalPages} busy={loading} onPageChange={changePage} />
    </section>
  );
}
