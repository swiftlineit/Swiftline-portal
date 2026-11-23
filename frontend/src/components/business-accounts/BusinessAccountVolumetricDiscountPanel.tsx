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

  return (
    <section id="business-volumetric-discount-panel" role="tabpanel" aria-labelledby="business-volumetric-discount-tab" className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-blue-50 p-2.5 text-blue-900"><FiPercent aria-hidden="true" className="h-5 w-5" /></span>
          <div>
            <h2 className="text-base font-semibold text-slate-950">Volumetric excess discount</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              This discount applies only to volumetric weight above actual weight. Actual weight stays fully chargeable, and the saved percentage is applied by the server to future shipment prices for this business account.
            </p>
          </div>
        </div>

        <form onSubmit={saveDiscount} className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-5">
          <label className="block w-full max-w-xs">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Discount on excess volumetric weight</span>
            <span className="relative mt-1.5 block">
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
                className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-950 outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-900/10 disabled:bg-slate-50 disabled:text-slate-500"
              />
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
            </span>
          </label>
          {canEdit ? (
            <button type="submit" disabled={saving || !validPercent} className="inline-flex h-11 items-center justify-center rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving…" : "Save discount"}
            </button>
          ) : <p className="pb-2 text-sm text-slate-500">Only admin and operations users can change this discount.</p>}
          {account.volumetricDiscountUpdatedAt ? (
            <p className="pb-2 text-xs text-slate-500">Last updated {formatDashboardDateTime(account.volumetricDiscountUpdatedAt)}</p>
          ) : null}
        </form>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Try an example</h3>
          <p className="mt-1 text-sm text-slate-600">Change the sample weights to preview the adjusted chargeable weight.</p>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(15rem,1.2fr)] lg:items-end">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actual weight</span>
            <span className="relative mt-1.5 block"><input type="number" min="0" step="0.01" value={actualWeight} onChange={(event) => setActualWeight(event.target.value)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-950" /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">kg</span></span>
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Volumetric weight</span>
            <span className="relative mt-1.5 block"><input type="number" min="0" step="0.01" value={volumetricWeight} onChange={(event) => setVolumetricWeight(event.target.value)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-950" /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">kg</span></span>
          </label>
          <div className="rounded-lg border border-blue-200 bg-white px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Chargeable weight after discount</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-blue-950">{formatKg(previewWeight)}</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              {volumeExcessKg > 0
                ? `${formatKg(volumeExcessKg)} excess · ${formatKg(discountedExcessKg)} discounted at ${previewPercent}%`
                : "No volumetric excess to discount; actual weight applies."}
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">Example: 20 kg actual, 25 kg volumetric, and 50% off the 5 kg excess gives 22.5 kg chargeable. Accounts with no discount keep the existing whole-kilogram rounding.</p>
      </div>
    </section>
  );
}
