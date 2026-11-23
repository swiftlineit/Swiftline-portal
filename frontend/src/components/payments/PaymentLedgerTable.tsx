import Link from "next/link";
import { FiExternalLink } from "react-icons/fi";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { formatPaymentMoney, paymentActivityLabel } from "@/lib/paymentPresentation";

export type PaymentLedgerRow = {
  _id: string; createdAt: string; transactionType: string; direction: string; amountMinor: number; currency: string;
  description?: string; paymentSource?: string; status?: string; reference?: string;
  shipmentDraftId?: string | null; shipmentNumber?: string | null;
  cashBalanceAfterMinor?: number; reservedBalanceAfterMinor?: number;
};

export default function PaymentLedgerTable({ rows, audience, walletOnly = false, loading = false }: { rows: PaymentLedgerRow[]; audience: "client" | "staff"; walletOnly?: boolean; loading?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600"><tr><th className="px-5 py-3 font-semibold">Date</th><th className="px-5 py-3 font-semibold">Activity</th>{!walletOnly ? <th className="px-5 py-3 font-semibold">Method / status</th> : null}<th className="px-5 py-3 text-right font-semibold">Amount</th><th className="px-5 py-3 text-right font-semibold">{walletOnly ? "Available after" : "Wallet after"}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {!loading ? rows.map((row) => (
            <tr key={row._id}>
              <td className="whitespace-nowrap px-5 py-3 text-slate-600">{formatDashboardDateTime(row.createdAt)}</td>
              <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="font-medium capitalize text-slate-900">{paymentActivityLabel(row.transactionType)}</span>{row.shipmentDraftId ? <Link href={`/${audience === "client" ? "client" : "dashboard"}/shipments/${row.shipmentDraftId}`} aria-label={`Open shipment ${row.shipmentNumber || "details"}`} title={row.shipmentNumber || "View shipment"} className="inline-flex shrink-0 items-center gap-1 text-blue-900 hover:underline"><FiExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="text-xs">{row.shipmentNumber}</span></Link> : null}</div>{row.description ? <p className="mt-1 max-w-lg text-xs text-slate-500">{row.description}</p> : null}{row.reference ? <p className="mt-1 max-w-lg break-all text-xs text-slate-500">{row.reference}</p> : null}</td>
              {!walletOnly ? <td className="px-5 py-3"><p className="text-xs font-semibold text-slate-700">{row.paymentSource || "Wallet"}</p><p className="mt-1 text-xs capitalize text-slate-500">{paymentActivityLabel(row.status || "Recorded")}</p></td> : null}
              <td className={`whitespace-nowrap px-5 py-3 text-right font-semibold tabular-nums ${row.direction === "CREDIT" ? "text-emerald-700" : "text-slate-900"}`}>{row.direction === "CREDIT" ? "+" : row.direction === "DEBIT" ? "−" : ""}{formatPaymentMoney(row.amountMinor, row.currency)}</td>
              <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-700">{typeof row.cashBalanceAfterMinor === "number" ? formatPaymentMoney(row.cashBalanceAfterMinor - (row.reservedBalanceAfterMinor ?? 0), row.currency) : "—"}</td>
            </tr>
          )) : null}
          {loading || !rows.length ? <tr><td colSpan={walletOnly ? 4 : 5} className="px-5 py-10 text-center text-slate-500">{loading ? "Loading activity…" : "No transactions found."}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
