"use client";

import { useState } from "react";
import { FiPercent } from "react-icons/fi";
import { toast } from "react-toastify";
import { updateBusinessAccountVolumetricDiscount, type BusinessAccount } from "@/lib/businessAccounts";
import { formatDashboardDateTime } from "@/lib/dateFormat";

function positiveNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatKg(value: number) {
  return `${Number(value.toFixed(3))} kg`;
}

export default function BusinessAccountVolumetricDiscountPanel({
  account,
  canEdit,
  onUpdated
}: {
  account: BusinessAccount;
  canEdit: boolean;
  onUpdated: (account: BusinessAccount) => void;
}) {
  const savedPercent = account.volumetricDiscountPercent ?? 0;
  const accountVersion = account.volumetricDiscountVersion ?? 0;
  const [draft, setDraft] = useState(() => ({ accountId: account._id, version: accountVersion, value: String(savedPercent) }));
  const percent = draft.accountId === account._id && draft.version === accountVersion ? draft.value : String(savedPercent);
  const [actualWeight, setActualWeight] = useState("20");
  const [volumetricWeight, setVolumetricWeight] = useState("25");
  const [saving, setSaving] = useState(false);

  const actualKg = positiveNumber(actualWeight);
  const volumetricKg = positiveNumber(volumetricWeight);
  const enteredPercent = Number(percent);
  const previewPercent = Number.isFinite(enteredPercent) ? Math.min(Math.max(enteredPercent, 0), 100) : 0;
  const volumeExcessKg = Math.max(volumetricKg - actualKg, 0);
  const discountedExcessKg = Number((volumeExcessKg * previewPercent / 100).toFixed(3));
  const unroundedWeight = Math.max(actualKg, volumetricKg - discountedExcessKg);
  const previewWeight = previewPercent > 0 ? Number(unroundedWeight.toFixed(3)) : Math.ceil(Number(unroundedWeight.toFixed(3)));
  const validPercent = percent.trim() !== "" && Number.isFinite(enteredPercent) && enteredPercent >= 0 && enteredPercent <= 100;

  function changePercent(value: string) {
    setDraft({ accountId: account._id, version: accountVersion, value });
  }

  async function saveDiscount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validPercent) {
      toast.error("Enter a discount between 0% and 100%.");
      return;
    }

    setSaving(true);
    try {
      const result = await updateBusinessAccountVolumetricDiscount(account.accountId, {
        volumetricDiscountPercent: enteredPercent,
        expectedVersion: account.volumetricDiscountVersion ?? 0
      });
      onUpdated(result.account);
      toast.success("Volumetric discount saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Volumetric discount could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const fieldClass = "min-w-0 rounded-lg border-2 border-slate-700 px-3 pb-1 focus-within:border-blue-900";
  const legendClass = "ml-3 px-2 text-xs font-semibold leading-4 text-slate-700";
  const inputClass = "h-10 w-full min-w-0 bg-transparent px-1 text-base font-semibold tabular-nums text-slate-950 outline-none disabled:text-slate-500";

  return (
    <section id="business-volumetric-discount-panel" role="tabpanel" aria-labelledby="business-volumetric-discount-tab" className="max-w-3xl rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-950">
            <FiPercent aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-900" />
            Volumetric excess discount
          </h2>
          {account.volumetricDiscountUpdatedAt ? (
            <p className="text-sm font-semibold text-green-700">Last updated {formatDashboardDateTime(account.volumetricDiscountUpdatedAt)}</p>
          ) : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This discount applies only to volumetric weight above actual weight. Actual weight stays fully chargeable, and the saved percentage is applied by the server to future shipment prices for this business account.
        </p>

        <form onSubmit={saveDiscount} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:gap-4">
          <fieldset className={`${fieldClass} ${canEdit ? "" : "bg-slate-50"}`}>
            <legend className={legendClass}>Discount %</legend>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              inputMode="decimal"
              value={percent}
              onChange={(event) => changePercent(event.target.value)}
              disabled={!canEdit || saving}
              aria-label="Volumetric excess discount percentage"
              className={inputClass}
            />
          </fieldset>
          {canEdit ? (
            <button type="submit" disabled={saving || !validPercent} className="inline-flex min-h-12 items-center justify-center rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-2">
              {saving ? "Saving…" : "Save discount"}
            </button>
          ) : <p className="self-center text-sm text-slate-500 sm:pt-2">Only admin and operations users can change this discount.</p>}
        </form>

        <div className="mt-8">
          <h3 className="text-sm font-semibold text-slate-950">Try an example</h3>
          <p className="mt-1 text-sm text-slate-600">Change the sample weights to preview the adjusted chargeable weight.</p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <div className="grid min-w-0 gap-3">
            <fieldset className={fieldClass}>
              <legend className={legendClass}>Actual weight</legend>
              <label className="flex items-center gap-2">
                <input type="number" min="0" step="0.01" value={actualWeight} onChange={(event) => setActualWeight(event.target.value)} aria-label="Actual weight" className={inputClass} />
                <span className="text-sm text-slate-500">kg</span>
              </label>
            </fieldset>
            <fieldset className={fieldClass}>
              <legend className={legendClass}>Volumetric weight</legend>
              <label className="flex items-center gap-2">
                <input type="number" min="0" step="0.01" value={volumetricWeight} onChange={(event) => setVolumetricWeight(event.target.value)} aria-label="Volumetric weight" className={inputClass} />
                <span className="text-sm text-slate-500">kg</span>
              </label>
            </fieldset>
          </div>
          <div aria-live="polite" className="flex flex-col justify-center rounded-lg border-2 border-slate-700 p-4 sm:mt-2">
            <p className="break-words text-3xl font-semibold tabular-nums text-slate-950">{formatKg(previewWeight)}</p>
            <p className="mt-3 text-sm font-medium leading-5 text-slate-600">Chargeable weight after discount</p>
          </div>
        </div>
      </div>
    </section>
  );
}