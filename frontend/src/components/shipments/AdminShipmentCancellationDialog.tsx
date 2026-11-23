"use client";

import { useMemo, useState, type FormEvent } from "react";
import { FiX } from "react-icons/fi";
import { useDialog } from "@/lib/useDialog";
import {
  calculateCancellationFeeAmounts,
  DEFAULT_CANCELLATION_FEE_BASE_MINOR,
  DEFAULT_CANCELLATION_FEE_BASE_RUPEES,
  type AdminShipmentCancellationPreview,
  type CancellationRefundPayout
} from "@/lib/shipmentCancellations";
import type { ShipmentListItem } from "@/lib/shipmentsList";

const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export default function AdminShipmentCancellationDialog({
  shipment,
  preview,
  busy,
  error,
  onClose,
  onSubmit
}: {
  shipment: ShipmentListItem;
  preview: AdminShipmentCancellationPreview;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: {
    reason: string;
    feeBaseMinor: number;
    feeReason: string;
    carrierConfirmed: true;
    settlementConfirmed: true;
    carrierReference: string;
    refundPayout?: CancellationRefundPayout;
  }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [feeRupees, setFeeRupees] = useState(DEFAULT_CANCELLATION_FEE_BASE_RUPEES);
  const [feeReason, setFeeReason] = useState("");
  const [carrierReference, setCarrierReference] = useState("");
  const [carrierConfirmed, setCarrierConfirmed] = useState(false);
  const [settlementConfirmed, setSettlementConfirmed] = useState(false);
  const [refundMethod, setRefundMethod] = useState<CancellationRefundPayout["method"]>("UPI");
  const [refundReference, setRefundReference] = useState("");
  const dialogRef = useDialog<HTMLDivElement>(true, () => {
    if (!busy) onClose();
  });

  const amounts = useMemo(
    () => calculateCancellationFeeAmounts(preview.originalAmountMinor, preview.taxTreatment, feeRupees),
    [preview.originalAmountMinor, preview.taxTreatment, feeRupees]
  );
  const manualRefundRequired = Boolean(amounts?.refundMinor && preview.manualRefundSource);
  const trimmedReason = reason.trim();
  const trimmedFeeReason = feeReason.trim();
  const feeReasonRequired = Boolean(
    amounts && amounts.requestedBaseMinor > DEFAULT_CANCELLATION_FEE_BASE_MINOR
  );
  const refundReferenceRequired = manualRefundRequired && refundMethod !== "CASH";
  const canSubmit = Boolean(amounts)
    && (!feeReasonRequired || trimmedFeeReason.length >= 5)
    && trimmedReason.length >= 5
    && carrierConfirmed
    && settlementConfirmed
    && (!refundReferenceRequired || refundReference.trim().length > 0)
    && !busy;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !amounts) return;
    const refundPayout = manualRefundRequired
      ? {
          method: refundMethod,
          ...(refundReference.trim() ? { reference: refundReference.trim() } : {})
        }
      : undefined;
    await onSubmit({
      reason: trimmedReason,
      feeBaseMinor: amounts.requestedBaseMinor,
      feeReason: feeReasonRequired ? trimmedFeeReason : "",
      carrierConfirmed: true,
      settlementConfirmed: true,
      carrierReference: carrierReference.trim(),
      ...(refundPayout ? { refundPayout } : {})
    });
  }

  const shipmentReference = shipment.swiftlineTrackingNumber || shipment.shipmentReference || "AWB pending";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 px-4 py-6 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="direct-cancellation-title"
        aria-describedby="direct-cancellation-summary"
        tabIndex={-1}
        className="my-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="direct-cancellation-title" className="text-lg font-semibold text-slate-950">Cancel shipment</h2>
            <p className="mt-1 truncate text-sm text-slate-600">{shipmentReference} · {shipment.businessAccountName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close cancellation dialog"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:opacity-50"
          >
            <FiX aria-hidden="true" className="size-4" />
          </button>
        </div>

        <form onSubmit={(event) => void submit(event)}>
          <div className="space-y-4 px-5 py-4">
            <p id="direct-cancellation-summary" className="text-sm leading-6 text-slate-600">
              Direct cancellation is available only before Warehouse Scan In. Confirm the carrier cancellation and review the settlement below. The portal will process a Razorpay refund to its original payment source or return wallet funds as applicable.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-semibold text-slate-700">
                Cancellation fee before GST (INR)
                <input
                  type="text"
                  inputMode="decimal"
                  value={feeRupees}
                  onChange={(event) => {
                    if (/^\d*(?:\.\d{0,2})?$/.test(event.target.value)) {
                      setFeeRupees(event.target.value);
                    }
                  }}
                  required
                  aria-describedby="direct-cancellation-fee-help"
                  className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                />
                <span id="direct-cancellation-fee-help" className="mt-1 block text-xs font-normal leading-5 text-slate-500">
                  Defaults to ₹700. Enter ₹0 or more; fees above ₹700 need a reason.
                </span>
              </label>

              <label className="block text-sm font-semibold text-slate-700">
                Carrier cancellation reference <span className="font-normal text-slate-500">(optional)</span>
                <input
                  value={carrierReference}
                  onChange={(event) => setCarrierReference(event.target.value)}
                  maxLength={120}
                  placeholder="Reference from the carrier, if available"
                  className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                />
              </label>
            </div>

            {feeReasonRequired ? (
              <label className="block text-sm font-semibold text-slate-700">
                Reason for fee above ₹700 <span className="text-red-600">*</span>
                <textarea
                  value={feeReason}
                  onChange={(event) => setFeeReason(event.target.value)}
                  rows={2}
                  minLength={5}
                  maxLength={500}
                  required
                  placeholder="Explain the additional carrier or handling fee"
                  className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                />
              </label>
            ) : null}

            <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-4">
              <Amount
                label={preview.taxTreatment === "NO_GST" ? "Cancellation fee" : "Fee before GST"}
                amountMinor={amounts?.feeBaseMinor ?? null}
              />
              <Amount
                label={preview.taxTreatment === "NO_GST" ? "GST" : "GST (18%)"}
                amountMinor={preview.taxTreatment === "NO_GST" ? null : amounts?.feeGstMinor ?? null}
              />
              <Amount label="Fee total" amountMinor={amounts?.feeTotalMinor ?? null} />
              <Amount label="Refundable" amountMinor={amounts?.refundMinor ?? null} emphasis />
            </div>
            {amounts?.capped ? (
              <p className="text-xs leading-5 text-slate-600">The fee and applicable GST exceed the shipment total, so the fee is capped at the amount paid.</p>
            ) : null}

            <label className="block text-sm font-semibold text-slate-700">
              Cancellation reason <span className="text-red-600">*</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                minLength={5}
                maxLength={500}
                required
                placeholder="Explain why this shipment is being cancelled"
                className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
              />
              <span className="mt-1 block text-right text-xs font-normal text-slate-500">{reason.length}/500</span>
            </label>

            {manualRefundRequired ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-950">Record the offline refund payout</p>
                <p className="mt-1 text-xs leading-5 text-amber-900">This shipment was paid by cash receipt or staff entry. Record how the refundable amount was returned before cancellation can complete.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    Refund method
                    <select
                      value={refundMethod}
                      onChange={(event) => setRefundMethod(event.target.value as CancellationRefundPayout["method"])}
                      className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                    >
                      <option value="UPI">UPI</option>
                      <option value="BANK_TRANSFER">Bank transfer</option>
                      <option value="CASH">Cash</option>
                      <option value="CARD">Card</option>
                      <option value="CHEQUE">Cheque</option>
                    </select>
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Refund reference {refundReferenceRequired ? <span className="text-red-600">*</span> : <span className="font-normal text-slate-500">(optional for cash)</span>}
                    <input
                      value={refundReference}
                      onChange={(event) => setRefundReference(event.target.value)}
                      maxLength={80}
                      required={refundReferenceRequired}
                      placeholder={refundMethod === "CASH" ? "Not required for cash" : "Bank, UPI or payment reference"}
                      className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                    />
                  </label>
                </div>
              </div>
            ) : null}

            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
              <label className="flex items-start gap-2.5 text-sm leading-5 text-slate-700">
                <input
                  type="checkbox"
                  checked={carrierConfirmed}
                  onChange={(event) => setCarrierConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[#0D1282]"
                />
                <span>I have cancelled this shipment with the carrier.</span>
              </label>
              <label className="flex items-start gap-2.5 text-sm leading-5 text-slate-700">
                <input
                  type="checkbox"
                  checked={settlementConfirmed}
                  onChange={(event) => setSettlementConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[#0D1282]"
                />
                <span>I reviewed the fee and refund amount above and confirm the settlement.</span>
              </label>
            </div>

            {error ? (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-800">{error}</p>
            ) : null}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Keep shipment
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#D71313] px-4 text-sm font-semibold text-white transition hover:bg-[#b30f0f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Completing cancellation…" : "Complete cancellation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Amount({ label, amountMinor, emphasis = false }: { label: string; amountMinor: number | null; emphasis?: boolean }) {
  return (
    <div className={`min-w-0 p-3 ${emphasis ? "bg-blue-50" : "bg-white"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 truncate text-sm font-bold tabular-nums ${emphasis ? "text-[#0D1282]" : "text-slate-900"}`}>
        {amountMinor === null ? "—" : currency.format(amountMinor / 100)}
      </p>
    </div>
  );
}
