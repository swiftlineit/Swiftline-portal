"use client";

import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import PaymentLedgerTable from "@/components/payments/PaymentLedgerTable";
import { getAdminPrepaidLedger, type AdminPrepaidLedger } from "@/lib/prepaidLedger";
import { formatPaymentMoney } from "@/lib/paymentPresentation";

type LedgerView = "all" | "wallet";
const pageSize = 50;

export default function BusinessAccountLedgerPanel({ businessAccountId }: { businessAccountId: string }) {
  const [view, setView] = useState<LedgerView>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminPrepaidLedger | null>(null);
  const requestKey = `${businessAccountId}:${page}:${view}`;
  const [loadedRequestKey, setLoadedRequestKey] = useState("");
  const loading = loadedRequestKey !== requestKey;

  useEffect(() => {
    let active = true;
    void getAdminPrepaidLedger(businessAccountId, { page, limit: pageSize, view }).then((result) => {
      if (active) {
        setData(result);
        setLoadedRequestKey(requestKey);
      }
    }).catch((error: unknown) => {
      if (active) {
        toast.error(error instanceof Error ? error.message : "Business account ledger could not be loaded.");
        setLoadedRequestKey(requestKey);
      }
    });
    return () => { active = false; };
  }, [businessAccountId, page, requestKey, view]);

  function changeView(nextView: LedgerView) {
    if (nextView === view) return;
    setPage(1);
    setView(nextView);
  }

  const wallet = data?.wallet;
  const totalPages = Math.max(data?.pagination.totalPages ?? 1, 1);

  return (
    <section className="space-y-5" aria-label="Business account ledger">
      {wallet ? (
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div>
            <p className="text-sm font-medium text-slate-600">Available to book</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{formatPaymentMoney(wallet.availableBalanceMinor, wallet.currency)}</p>
          </div>
          <p className="text-sm text-slate-600">Wallet total {formatPaymentMoney(wallet.cashBalanceMinor, wallet.currency)} <span aria-hidden="true">·</span> Held for bookings {formatPaymentMoney(wallet.reservedBalanceMinor, wallet.currency)}</p>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Business account ledger</h2>
            <p className="mt-1 text-sm text-slate-600">All payments and wallet movements for this account.</p>
          </div>
          {data ? <p className="text-sm text-slate-500">{data.pagination.total} entries</p> : null}
        </div>
        <div className="flex gap-1 border-b border-slate-200 px-5 pt-3" role="tablist" aria-label="Ledger type">
          {([ ["all", "All activity"], ["wallet", "Wallet ledger"] ] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => changeView(key)} className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === key ? "border-blue-900 text-blue-900" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
              {label}
            </button>
          ))}
        </div>
        <PaymentLedgerTable rows={data?.transactions ?? []} audience="staff" walletOnly={view === "wallet"} loading={loading} />
        {data ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
            <span>Page {data.pagination.page} of {totalPages}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading} className="h-9 rounded-lg border border-slate-300 px-3 font-semibold disabled:opacity-40">Previous</button>
              <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || loading} className="h-9 rounded-lg border border-slate-300 px-3 font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
