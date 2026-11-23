"use client";

import { FiDownload } from "react-icons/fi";
import type { CashReceiptDraft } from "@/lib/shipmentPayments";
import { formatDashboardDate } from "@/lib/dateFormat";

type Props = {
  receipt: CashReceiptDraft;
  onDownload: () => void;
  downloading?: boolean;
};

function money(minor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(minor / 100);
}

export default function CashReceiptCard({ receipt, onDownload, downloading = false }: Props) {
  if (receipt.status !== "FINALIZED") return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="shipment-cash-receipt-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="shipment-cash-receipt-heading" className="text-base font-semibold text-slate-950">Cash receipt</h2>
          <p className="mt-1 text-sm text-slate-600">{receipt.receiptNumber} · {formatDashboardDate(receipt.receiptDate)}</p>
        </div>
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:border-blue-800 hover:text-blue-900 disabled:cursor-wait disabled:opacity-60"
        >
          <FiDownload aria-hidden="true" className="h-4 w-4" />
          {downloading ? "Preparing…" : "Download receipt"}
        </button>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Received from</dt><dd className="mt-1 font-medium text-slate-900">{receipt.customerName}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{money(receipt.totalReceivedMinor)}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payment reference</dt><dd className="mt-1 break-words font-medium text-slate-900">{receipt.cashCustodyReference}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recorded by</dt><dd className="mt-1 font-medium text-slate-900">{receipt.createdByName}</dd></div>
      </dl>
    </section>
  );
}
