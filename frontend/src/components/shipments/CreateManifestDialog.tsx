"use client";

import { FormEvent, useState } from "react";
import { FiChevronDown, FiX } from "react-icons/fi";

export type ManifestDialogValues = {
  origin: string;
  destination: string;
  coloader: string;
  paymentType: string;
};

const paymentTypes = ["PREPAID", "COLLECT", "CREDIT", "CASH"];

/**
 * Collects the handover details the manifest header carries. Origin and
 * destination are not stored on a shipment, so they are entered here and
 * prefilled from the selected shipments wherever that is possible.
 */
export default function CreateManifestDialog({
  title = "Create Manifest",
  shipmentCount,
  totalPieces,
  totalWeightKg,
  defaults,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  title?: string;
  shipmentCount: number;
  totalPieces: number;
  totalWeightKg: number;
  defaults: ManifestDialogValues;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (values: ManifestDialogValues) => void;
}) {
  const [values, setValues] = useState<ManifestDialogValues>(defaults);
  const canSubmit = Boolean(values.origin.trim() && values.destination.trim()) && !busy;

  function update(field: keyof ManifestDialogValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onConfirm({
      origin: values.origin.trim(),
      destination: values.destination.trim(),
      coloader: values.coloader.trim(),
      paymentType: values.paymentType.trim()
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-manifest-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="create-manifest-title" className="text-base font-semibold text-[#0D1282]">{title}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {shipmentCount} {shipmentCount === 1 ? "shipment" : "shipments"} · {totalPieces} pcs · {totalWeightKg.toFixed(2)} kg
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:border-slate-500 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            <FiX aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Origin <span className="text-red-600">*</span></span>
            <input
              value={values.origin}
              onChange={(event) => update("origin", event.target.value)}
              maxLength={120}
              placeholder="AHMEDABAD"
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-[#0D1282] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Destination <span className="text-red-600">*</span></span>
            <input
              value={values.destination}
              onChange={(event) => update("destination", event.target.value)}
              maxLength={120}
              placeholder="UK SERVICE DEL"
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-[#0D1282] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Coloader</span>
            <input
              value={values.coloader}
              onChange={(event) => update("coloader", event.target.value)}
              maxLength={120}
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-[#0D1282] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payment Type</span>
            <span className="relative mt-2 block">
              <select
                value={values.paymentType}
                onChange={(event) => update("paymentType", event.target.value)}
                className="h-11 w-full appearance-none rounded-md border border-slate-300 bg-white py-2 pl-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
              >
                <option value="">Not specified</option>
                {paymentTypes.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
            </span>
          </label>
        </div>

        {error ? <p role="alert" className="mx-5 mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}

        <div className="flex flex-col-reverse justify-end gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-500 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-11 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {busy ? "Creating..." : title}
          </button>
        </div>
      </form>
    </div>
  );
}
