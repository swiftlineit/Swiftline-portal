"use client";

import { useEffect, useState } from "react";
import { getClientAccountLedger, type PaymentsLedgerRow, type PaymentsLedgerPagination } from "@/lib/prepaidLedger";
import PaymentLedgerTable from "./PaymentLedgerTable";
import PaymentPagination from "./PaymentPagination";

export default function ClientPaymentLedger({ businessAccountId, initialTransactions = [] }: { businessAccountId: string; initialTransactions?: PaymentsLedgerRow[] }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PaymentsLedgerRow[]>(initialTransactions);
  const [pagination, setPagination] = useState<PaymentsLedgerPagination>({ page: 1, limit: 50, total: initialTransactions.length, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getClientAccountLedger(businessAccountId, { page, limit: 50 })
      .then((result) => {
        if (!active) return;
        setRows(result.transactions);
        setPagination(result.pagination ?? { page, limit: 50, total: result.transactions.length, totalPages: 1 });
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Payments ledger could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [businessAccountId, page]);

  function changePage(nextPage: number) {
    setLoading(true);
    setError("");
    setPage(nextPage);
  }

  return (
    <section id="payments-ledger" aria-label="Payments ledger" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-950">Payments ledger</h2>
        <p className="mt-1 text-xs text-slate-500">Online payments, cash receipts and refunds recorded for this business account.</p>
      </div>
      {error ? <p role="alert" className="p-5 text-sm text-red-700">{error}</p> : <PaymentLedgerTable rows={rows} audience="client" businessAccountId={businessAccountId} loading={loading} />}
      <PaymentPagination label="Payments ledger pages" page={page} totalPages={pagination.totalPages} busy={loading} onPageChange={changePage} />
    </section>
  );
}
