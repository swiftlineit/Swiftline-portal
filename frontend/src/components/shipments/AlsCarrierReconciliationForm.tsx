"use client";

import { useState } from "react";
import { toast } from "react-toastify";
import { reconcileAlsCarrierBooking } from "@/lib/dpdLabels";

export default function AlsCarrierReconciliationForm({
  shipmentDraftId,
  swiftlineTrackingNumber,
  manifestId,
  onComplete
}: {
  shipmentDraftId: string;
  swiftlineTrackingNumber: string;
  manifestId?: string;
  onComplete?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [awb, setAwb] = useState("");
  const [forwarding, setForwarding] = useState("");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState<File | null>(null);
  const [originalAlsAttemptVoided, setOriginalAlsAttemptVoided] = useState(false);
  const [replacementBookingVerified, setReplacementBookingVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!label || !originalAlsAttemptVoided || !replacementBookingVerified) return;
    setBusy(true);
    setError("");
    try {
      const result = await reconcileAlsCarrierBooking({
        shipmentDraftId,
        manifestId,
        carrierAwbNumber: awb,
        carrierForwardingNumber: forwarding,
        swiftlineTrackingNumber,
        originalAlsAttemptVoided: true,
        replacementBookingVerified: true,
        confirmationNote: note,
        dpdLabel: label
      });
      toast.success(result.message);
      setOpen(false);
      await onComplete?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The ALS booking could not be reconciled.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-[11px] font-semibold text-amber-800 underline decoration-amber-400 underline-offset-2 hover:text-amber-950"
      >
        Reconcile ALS booking
      </button>
    );
  }

  return (
    <div className="mt-3 w-72 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-left shadow-sm">
      <p className="text-xs font-semibold text-amber-950">Replacement ALS booking</p>
      <input
        aria-label="Replacement ALS AWB"
        placeholder="ALS AWB"
        value={awb}
        onChange={(event) => setAwb(event.target.value.replace(/\D/g, ""))}
        inputMode="numeric"
        maxLength={20}
        className="h-9 w-full rounded-lg border border-amber-200 bg-white px-3 text-xs text-slate-950 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100"
      />
      <input
        aria-label="Forwarding number"
        placeholder="Forwarding number"
        value={forwarding}
        onChange={(event) => setForwarding(event.target.value.toUpperCase())}
        maxLength={120}
        className="h-9 w-full rounded-lg border border-amber-200 bg-white px-3 text-xs text-slate-950 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100"
      />
      <input
        aria-label="ALS DPD label HTML"
        type="file"
        accept=".html,.htm,text/html,application/xhtml+xml"
        onChange={(event) => setLabel(event.target.files?.[0] ?? null)}
        className="block w-full text-[11px] text-amber-950 file:mr-2 file:rounded-md file:border-0 file:bg-amber-100 file:px-2 file:py-1 file:font-semibold file:text-amber-950"
      />
      <textarea
        aria-label="Confirmation note"
        placeholder="Who confirmed the replacement and original void?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={500}
        rows={3}
        className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-950 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100"
      />
      <label className="flex items-start gap-2 text-[11px] text-amber-950">
        <input type="checkbox" checked={originalAlsAttemptVoided} onChange={(event) => setOriginalAlsAttemptVoided(event.target.checked)} />
        I confirm the original uncertain ALS attempt was voided.
      </label>
      <label className="flex items-start gap-2 text-[11px] text-amber-950">
        <input type="checkbox" checked={replacementBookingVerified} onChange={(event) => setReplacementBookingVerified(event.target.checked)} />
        I verified the replacement booking and label against this shipment in ALS.
      </label>
      {error ? <p role="alert" className="text-[11px] font-semibold text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || awb.length < 6 || !forwarding.trim() || note.trim().length < 10 || !label || !originalAlsAttemptVoided || !replacementBookingVerified}
          className="h-8 rounded-lg bg-amber-800 px-3 text-[11px] font-semibold text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:bg-amber-300"
        >
          {busy ? "Saving..." : "Save and attach label"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-8 px-2 text-[11px] font-semibold text-slate-600 hover:text-slate-950">
          Cancel
        </button>
      </div>
    </div>
  );
}
