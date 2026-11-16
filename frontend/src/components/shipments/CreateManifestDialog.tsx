"use client";

import { FormEvent, useId, useState } from "react";
import { FiChevronDown, FiX } from "react-icons/fi";

export type ManifestDialogValues = {
  origin: string;
  destination: string;
  coloader: string;
  paymentType: string;
  manifestName?: string;
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
  canSetManifestName = false,
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
  canSetManifestName?: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (values: ManifestDialogValues) => void;
}) {
  const [values, setValues] = useState<ManifestDialogValues>(defaults);
  const fieldIds = useId();
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
      paymentType: values.paymentType.trim(),
      ...(canSetManifestName && values.manifestName?.trim()
        ? { manifestName: values.manifestName.trim() }
        : {})
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

        <div className="grid gap-x-4 gap-y-6 px-5 py-6 sm:grid-cols-2">
          {canSetManifestName ? (
            <div className="relative sm:col-span-2">
              <label
                htmlFor={`${fieldIds}-manifest-name`}
                className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-semibold text-slate-600"
              >
                Manifest display name <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={`${fieldIds}-manifest-name`}
                value={values.manifestName ?? ""}
                onChange={(event) => update("manifestName", event.target.value)}
                maxLength={120}
                autoComplete="off"
                aria-describedby={`${fieldIds}-manifest-name-hint`}
                placeholder="For example, UK Air Dispatch"
                className="h-11 w-full rounded-md border-2 border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
              />
              <p id={`${fieldIds}-manifest-name-hint`} className="mt-1.5 text-xs text-slate-500">
                Leave blank for the automatic name; the generated manifest number stays as its reference.
              </p>
            </div>
          ) : null}
          <div className="relative">
            <label
              htmlFor={`${fieldIds}-origin`}
              className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-semibold text-slate-600"
            >
              Origin <span className="text-red-600">*</span>
            </label>
            <input
              id={`${fieldIds}-origin`}
              value={values.origin}
              onChange={(event) => update("origin", event.target.value)}
              maxLength={120}
              placeholder="AHMEDABAD"
              className="h-11 w-full rounded-md border-2 border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            />
          </div>
          <div className="relative">
            <label
              htmlFor={`${fieldIds}-destination`}
              className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-semibold text-slate-600"
            >
              Destination <span className="text-red-600">*</span>
            </label>
            <input
              id={`${fieldIds}-destination`}
              value={values.destination}
              onChange={(event) => update("destination", event.target.value)}
              maxLength={120}
              placeholder="UK SERVICE DEL"
              className="h-11 w-full rounded-md border-2 border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            />
          </div>
          <div className="relative">
            <label
              htmlFor={`${fieldIds}-coloader`}
              className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-semibold text-slate-600"
            >Coloader</label>
            <input
              id={`${fieldIds}-coloader`}
              value={values.coloader}
              onChange={(event) => update("coloader", event.target.value)}
              maxLength={120}
              className="h-11 w-full rounded-md border-2 border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            />
          </div>
          <div className="relative">
            <label
              htmlFor={`${fieldIds}-payment-type`}
              className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-semibold text-slate-600"
            >Payment Type</label>
            <select
              id={`${fieldIds}-payment-type`}
              value={values.paymentType}
              onChange={(event) => update("paymentType", event.target.value)}
              className="h-11 w-full appearance-none rounded-md border-2 border-slate-300 bg-white py-2 pl-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            >
              <option value="">Not specified</option>
              {paymentTypes.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
          </div>
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
