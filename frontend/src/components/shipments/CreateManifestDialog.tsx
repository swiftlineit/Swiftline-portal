"use client";

import { FormEvent, useState } from "react";
import { FiX } from "react-icons/fi";

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
  onCancel,
  onConfirm
}: {
  title?: string;
  shipmentCount: number;
  totalPieces: number;
  totalWeightKg: number;
  defaults: ManifestDialogValues;
  busy: boolean;
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
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#0D1282]">{title}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {shipmentCount} {shipmentCount === 1 ? "shipment" : "shipments"} · {totalPieces} pcs · {totalWeightKg.toFixed(2)} kg
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-slate-400"
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
            <select
              value={values.paymentType}
              onChange={(event) => update("paymentType", event.target.value)}
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-[#0D1282] focus:outline-none"
            >
              <option value="">Not specified</option>
              {paymentTypes.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {busy ? "Creating..." : title}
          </button>
        </div>
      </form>
    </div>
  );
}
