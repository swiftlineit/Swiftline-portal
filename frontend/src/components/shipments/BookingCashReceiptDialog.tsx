"use client";

import Image from "next/image";
import { useDialog } from "@/lib/useDialog";
import { formatPaymentMoney } from "@/lib/paymentPresentation";

export type BookingCashReceiptForm = { customerName: string; date: string; amount: string; reference: string };
type Props = {
  value: BookingCashReceiptForm; onChange: (value: BookingCashReceiptForm) => void;
  receiptNumber?: string; recordedBy: string; service: string; pieces: number; weightKg: number;
  totalMinor: number; busy: boolean; loading: boolean; error?: string; onClose: () => void; onSave: () => void;
};

export default function BookingCashReceiptDialog(props: Props) {
  const dialogRef = useDialog<HTMLElement>(true, () => { if (!props.busy) props.onClose(); });
  const update = (key: keyof BookingCashReceiptForm, value: string) => props.onChange({ ...props.value, [key]: value });
  const inputClass = "mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950 focus:border-blue-800 focus:outline-none";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="cash-receipt-heading" tabIndex={-1} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-3"><Image src="/swiftline-invoice-logo.png" alt="Swiftline" width={96} height={36} className="h-9 w-24 object-contain" /><div><h2 id="cash-receipt-heading" className="text-lg font-semibold text-slate-950">Cash receipt</h2><p className="text-xs text-slate-600">Save the details, then choose how to book the shipment.</p></div></div>
          <span className="text-xs font-semibold text-slate-600">{props.receiptNumber || "Draft receipt"}</span>
        </header>
        <div className="space-y-4 px-5 py-4">
          {props.loading ? <p role="status" className="text-sm text-slate-600">Loading receipt details…</p> : null}
          {props.error ? <p role="alert" className="text-sm text-red-700">{props.error}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700">Received from<input value={props.value.customerName} onChange={(e) => update("customerName", e.target.value)} maxLength={200} className={inputClass} /></label>
            <label className="text-xs font-semibold text-slate-700">Receipt date<input type="date" value={props.value.date} onChange={(e) => update("date", e.target.value)} className={inputClass} /></label>
            <label className="text-xs font-semibold text-slate-700">Amount received (INR)<input type="number" min="0.01" step="0.01" value={props.value.amount} onChange={(e) => update("amount", e.target.value)} className={inputClass} /><span className="mt-1 block font-normal text-slate-500">Shipment total {formatPaymentMoney(props.totalMinor)}</span></label>
            <label className="text-xs font-semibold text-slate-700">Payment reference<input value={props.value.reference} onChange={(e) => update("reference", e.target.value)} maxLength={160} className={inputClass} /></label>
          </div>
          <dl className="grid gap-3 rounded-lg bg-slate-50 p-4 text-sm">
            <div><dt className="text-xs text-slate-500">Service · pieces · weight</dt><dd className="mt-1 text-slate-900">{props.service} · {props.pieces} pcs · {props.weightKg.toFixed(2)} kg</dd></div>
            <div><dt className="text-xs text-slate-500">Recorded by</dt><dd className="mt-1 font-medium text-slate-900">{props.recordedBy}</dd></div>
          </dl>
          <p className="text-center text-xs text-slate-500">System generated receipt · issued when booking completes</p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button type="button" onClick={props.onClose} disabled={props.busy} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={props.onSave} disabled={props.busy || props.loading || !props.value.customerName.trim() || !props.value.date || !props.value.reference.trim() || !props.value.amount} className="h-10 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white disabled:bg-slate-400">{props.busy ? "Saving…" : "Save receipt details"}</button>
        </footer>
      </section>
    </div>
  );
}
