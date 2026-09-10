"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiChevronDown, FiSave } from "react-icons/fi";
import {
  assignBusinessAccountRateCard,
  getBusinessAccountRateCardHistory,
  type BusinessAccount,
  type RateCardAssignmentHistoryEntry,
} from "@/lib/businessAccounts";
import {
  formatRateCardBand,
  internalRateCardBands,
  type RateCardBand,
} from "@/lib/countryRateCards";

type AssignableAccount = Pick<BusinessAccount, "accountId" | "rateCardBand">;

export default function RateCardAssignmentPanel({
  account,
  onAssigned,
}: {
  account: AssignableAccount;
  onAssigned: (account: BusinessAccount) => void;
}) {
  const [selection, setSelection] = useState<RateCardBand | "">(account.rateCardBand ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState("");
  const [history, setHistory] = useState<RateCardAssignmentHistoryEntry[]>([]);

  async function loadHistory() {
    try {
      const result = await getBusinessAccountRateCardHistory(account.accountId);
      setHistory(result.history);
    } catch {
      // Assignment remains available if history cannot be loaded.
    }
  }

  useEffect(() => {
    let active = true;
    void getBusinessAccountRateCardHistory(account.accountId)
      .then((result) => {
        if (active) setHistory(result.history);
      })
      .catch(() => {
        // Assignment remains available if history cannot be loaded.
      });
    return () => {
      active = false;
    };
  }, [account.accountId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    setWarning("");
    try {
      const result = await assignBusinessAccountRateCard(
        account.accountId,
        selection || null,
        account.rateCardBand ?? null,
        reason,
      );
      onAssigned(result.account);
      setReason("");
      setMessage(result.message);
      setWarning(result.coverageWarning ?? "");
      await loadHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rate card could not be assigned.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-bold text-[#0D1282]">Rate Card</h2>
      <p className="mt-1 text-sm text-slate-600">
        Controls every new estimate, quote, booking, amendment and verified charge for this account.
      </p>

      {!account.rateCardBand ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
          Assign a rate card to this account to enable shipment booking.
        </p>
      ) : null}

      {error ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      {message ? <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{message}</p> : null}
      {warning ? <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{warning}</p> : null}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,220px)_1fr_auto] md:items-end">
        <label>
  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
    Assigned card
  </span>

  <div className="relative mt-2">
    <select
      value={selection}
      onChange={(event) =>
        setSelection(event.target.value as RateCardBand | "")
      }
      className="h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-11 text-sm font-semibold text-slate-900 outline-none focus:border-[#0D1282]"
    >
      <option value="">Unassigned - pause pricing</option>

      {internalRateCardBands.map((band) => (
        <option key={band} value={band}>
          {formatRateCardBand(band)}
        </option>
      ))}
    </select>

    <FiChevronDown
      aria-hidden="true"
      className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
    />
  </div>
</label>
        <label>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason for change</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={3}
            maxLength={500}
            placeholder="New commercial agreement, annual review, correction..."
            className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-[#0D1282]"
          />
        </label>
        <button
          type="submit"
          disabled={busy || selection === (account.rateCardBand ?? "")}
          title={
            selection === (account.rateCardBand ?? "")
              ? "Select a different rate card to save an assignment change."
              : undefined
          }
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#0D1282] px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          <FiSave className="h-4 w-4" />{busy ? "Saving..." : "Save Assignment"}
        </button>
      </div>

      {account.rateCardBand && selection === account.rateCardBand ? (
        <p className="mt-3 text-xs font-medium text-slate-600">
          This account is already assigned to {formatRateCardBand(account.rateCardBand)}. Select another band or Unassigned to save a change.
        </p>
      ) : null}

      <div className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="text-sm font-bold text-slate-800">Assignment history</h3>
        {!history.length ? (
          <p className="mt-2 text-sm text-slate-500">No rate-card changes have been recorded yet.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {history.slice(0, 5).map((entry) => (
              <li key={entry.id} className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <p className="font-semibold text-slate-800">
                  {entry.previousRateCardBand ? formatRateCardBand(entry.previousRateCardBand) : "Unassigned"}
                  {" -> "}
                  {entry.rateCardBand ? formatRateCardBand(entry.rateCardBand) : "Unassigned"}
                </p>
                <p className="mt-1">{entry.reason}</p>
                <p className="mt-1 text-slate-500">
                  {new Date(entry.performedAt).toLocaleString()} by {entry.performedBy.name || entry.performedBy.email || "Swiftline user"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </form>
  );
}
