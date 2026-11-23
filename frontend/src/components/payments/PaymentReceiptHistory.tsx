"use client";

import { useEffect, useState } from "react";
import { FiEye } from "react-icons/fi";
import type { ClientShellUser } from "@/components/client/ClientDashboardShell";
import { getClientPrepaidTopUps, type ClientDashboardAccount, type ClientPrepaidTopUp } from "@/lib/clientDashboard";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { formatPaymentMoney } from "@/lib/paymentPresentation";
import { buildPaymentInvoice, type PaymentInvoiceDetails } from "./PaymentReceiptPreview";
import PaymentPagination from "./PaymentPagination";

export default function PaymentReceiptHistory({ account, user, initialTopUps, onView }: { account: ClientDashboardAccount["account"]; user: ClientShellUser; initialTopUps: ClientPrepaidTopUp[]; onView: (receipt: PaymentInvoiceDetails) => void }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState(initialTopUps.slice(0, 5));
  const [totalPages, setTotalPages] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void getClientPrepaidTopUps(account.id, page).then((result) => {
      if (!active) return;
      setRows(result.topUps.slice(0, 5));
      setTotalPages(result.pagination?.totalPages ?? 1);
    }).catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Receipts could not be loaded."); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [account.id, page]);
  function changePage(nextPage: number) {
    setError("");
    setBusy(true);
    setPage(nextPage);
  }
  return (
    <section id="payment-history" aria-label="Payment receipts" className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="border-b border-slate-200 px-5 py-4"><h2 className="text-base font-semibold text-slate-950">Payment receipts</h2></header>
      <div className="flex-1 divide-y divide-slate-100 px-5" aria-busy={busy}>
        {error ? <p role="alert" className="py-4 text-sm text-red-700">{error}</p> : rows.map((row) => (
          <div key={row.id} className="flex min-w-0 items-center justify-between gap-3 py-3">
            <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-900" title={row.internalReference}>{row.internalReference}</p><p className="mt-1 text-xs text-slate-500">{row.purpose === "SECURITY_DEPOSIT" ? "Security deposit" : "Wallet top-up"} on {formatDashboardDateTime(row.createdAt)}</p></div>
            <div className="flex shrink-0 items-center gap-3"><span className="text-right text-xs font-semibold tabular-nums text-slate-900">{formatPaymentMoney(row.amountMinor, row.currency)}{row.status !== "CAPTURED" ? <span className="mt-1 block font-normal text-slate-500">{row.status.toLowerCase().replaceAll("_", " ")}</span> : null}</span>{row.status === "CAPTURED" ? <button type="button" onClick={() => onView(buildPaymentInvoice(row, account, user))} className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><FiEye aria-hidden="true" />View</button> : null}</div>
          </div>
        ))}
        {!rows.length && !error ? <p className="py-10 text-sm text-slate-500">No payment receipts yet.</p> : null}
      </div>
      <PaymentPagination label="Payment receipt pages" page={page} totalPages={totalPages} busy={busy} onPageChange={changePage} />
    </section>
  );
}
