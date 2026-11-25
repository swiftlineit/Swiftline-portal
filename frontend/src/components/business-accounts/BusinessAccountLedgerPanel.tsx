"use client";

import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import PaymentLedgerTable from "@/components/payments/PaymentLedgerTable";
import { getAdminPaymentsLedger, type PaymentsLedger } from "@/lib/prepaidLedger";

const pageSize = 50;

export default function BusinessAccountLedgerPanel({ businessAccountId }: { businessAccountId: string }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PaymentsLedger | null>(null);
  const requestKey = `${businessAccountId}:${page}`;
  const [loadedRequestKey, setLoadedRequestKey] = useState("");
  const loading = loadedRequestKey !== requestKey;

  useEffect(() => {
    let active = true;
    void getAdminPaymentsLedger(businessAccountId, { page, limit: pageSize }).then((result) => {
      if (active) {
        setData(result);
        setLoadedRequestKey(requestKey);
      }
    }).catch((error: unknown) => {
      if (active) {
        toast.error(error instanceof Error ? error.message : "Payments ledger could not be loaded.");
        setLoadedRequestKey(requestKey);
      }
    });
    return () => { active = false; };
  }, [businessAccountId, page, requestKey]);

  const totalPages = Math.max(data?.pagination.totalPages ?? 1, 1);

  return (
    <section id="payments-ledger" className="scroll-mt-6 space-y-5" aria-label="Business account payments ledger">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Payments ledger</h2>
            <p className="mt-1 text-sm text-slate-600">Online payments, cash receipts and refunds recorded for this account.</p>
          </div>
          {data ? <p className="text-sm text-slate-500">{data.pagination.total} entries</p> : null}
        </div>
        <PaymentLedgerTable rows={data?.transactions ?? []} audience="staff" loading={loading} />
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
