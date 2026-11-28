"use client";

import { useState } from "react";
import Link from "next/link";
import { FiExternalLink, FiEye, FiFileText } from "react-icons/fi";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { formatPaymentMoney, paymentActivityLabel, paymentSourceLabel } from "@/lib/paymentPresentation";
import { openLedgerDocument, type PaymentsLedgerDocument, type PaymentsLedgerRow } from "@/lib/prepaidLedger";
import { shipmentInvoicePageUrl } from "@/lib/shipmentInvoices";

export type PaymentLedgerRow = PaymentsLedgerRow;

function LedgerDocumentLinks({ documents, audience, businessAccountId }: { documents: PaymentsLedgerDocument[]; audience: "client" | "staff"; businessAccountId: string }) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function openCashReceipt(receiptId: string) {
    setBusyId(receiptId);
    setError("");
    const path = audience === "client"
      ? `/api/v1/client/documents/cash-receipts/${encodeURIComponent(receiptId)}/pdf?businessAccountId=${encodeURIComponent(businessAccountId)}`
      : `/api/v1/business-accounts/${encodeURIComponent(businessAccountId)}/payments-ledger/documents/cash-receipts/${encodeURIComponent(receiptId)}`;
    try {
      await openLedgerDocument(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document could not be opened.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {documents.map((document) => document.kind === "INVOICE" ? (
        <Link
          key={`invoice:${document.draftId}`}
          href={shipmentInvoicePageUrl(document.draftId, audience === "client" ? "client" : "admin")}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={document.invoiceNumber ? `View invoice ${document.invoiceNumber}` : "View invoice"}
          title={document.invoiceNumber ? `Invoice ${document.invoiceNumber}` : "View invoice"}
          className="inline-flex items-center gap-1 text-blue-900 hover:underline"
        >
          <FiFileText aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="text-xs">Invoice</span>
        </Link>
      ) : (
        <button
          key={`receipt:${document.receiptId}`}
          type="button"
          disabled={busyId === document.receiptId}
          onClick={() => void openCashReceipt(document.receiptId)}
          aria-label={document.receiptNumber ? `View cash receipt ${document.receiptNumber}` : "View cash receipt"}
          title={document.receiptNumber ? `Cash receipt ${document.receiptNumber}` : "View cash receipt"}
          className="inline-flex items-center gap-1 text-blue-900 hover:underline disabled:opacity-50"
        >
          <FiEye aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="text-xs">{busyId === document.receiptId ? "Opening…" : "Cash receipt"}</span>
        </button>
      ))}
      {error ? <span role="alert" className="w-full text-xs text-red-700">{error}</span> : null}
    </div>
  );
}

export default function PaymentLedgerTable({ rows, audience, businessAccountId, loading = false }: { rows: PaymentLedgerRow[]; audience: "client" | "staff"; businessAccountId: string; loading?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600"><tr><th className="px-5 py-3 font-semibold">Date</th><th className="px-5 py-3 font-semibold">Activity</th><th className="px-5 py-3 font-semibold">Method / status</th><th className="px-5 py-3 font-semibold">Document</th><th className="px-5 py-3 text-right font-semibold">Amount</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {!loading ? rows.map((row) => (
            <tr key={row._id}>
              <td className="whitespace-nowrap px-5 py-3 text-slate-600">{formatDashboardDateTime(row.createdAt)}</td>
              <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="font-medium capitalize text-slate-900">{paymentActivityLabel(row.transactionType)}</span>{row.shipmentDraftId ? <Link href={`/${audience === "client" ? "client" : "dashboard"}/shipments/${row.shipmentDraftId}`} aria-label={`Open shipment ${row.shipmentNumber || "details"}`} title={row.shipmentNumber || "View shipment"} className="inline-flex shrink-0 items-center gap-1 text-blue-900 hover:underline"><FiExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="text-xs">{row.shipmentNumber}</span></Link> : null}</div>{row.description ? <p className="mt-1 max-w-lg text-xs text-slate-500">{row.description}</p> : null}{row.reference ? <p className="mt-1 max-w-lg break-all text-xs text-slate-500">{row.reference}</p> : null}</td>
              <td className="px-5 py-3"><p className="text-xs font-semibold text-slate-700">{row.paymentSource ? paymentSourceLabel(row.paymentSource) : "-"}</p><p className="mt-1 text-xs capitalize text-slate-500">{paymentActivityLabel(row.status || "Recorded")}</p></td>
              <td className="px-5 py-3">{row.documents?.length ? <LedgerDocumentLinks documents={row.documents} audience={audience} businessAccountId={businessAccountId} /> : null}</td>
              <td className={`whitespace-nowrap px-5 py-3 text-right font-semibold tabular-nums ${row.direction === "CREDIT" ? "text-emerald-700" : "text-slate-900"}`}>{row.direction === "CREDIT" ? "+" : row.direction === "DEBIT" ? "−" : ""}{formatPaymentMoney(row.amountMinor, row.currency)}</td>
            </tr>
          )) : null}
          {loading || !rows.length ? <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-500">{loading ? "Loading activity…" : "No payments found."}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
