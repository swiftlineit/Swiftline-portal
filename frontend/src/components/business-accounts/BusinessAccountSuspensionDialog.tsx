"use client";

import { useState } from "react";
import { toast } from "react-toastify";
import { useDialog } from "@/lib/useDialog";
import type { BusinessAccountSuspensionDetails } from "@/lib/businessAccounts";

export default function BusinessAccountSuspensionDialog({
  accountName,
  action,
  initialMode = "OPERATIONAL_HOLD",
  busy,
  onCancel,
  onConfirm
}: {
  accountName: string;
  action: "suspend" | "reactivate";
  initialMode?: BusinessAccountSuspensionDetails["suspensionMode"];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (details: BusinessAccountSuspensionDetails) => boolean | void | Promise<boolean | void>;
}) {
  const [mode, setMode] = useState<BusinessAccountSuspensionDetails["suspensionMode"]>(initialMode);
  const [internalReason, setInternalReason] = useState("");
  const [clientMessage, setClientMessage] = useState("");
  const dialogRef = useDialog<HTMLDivElement>(true, () => { if (!busy) onCancel(); });
  const isSuspending = action === "suspend";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const saved = await onConfirm({ suspensionMode: mode, internalReason: internalReason.trim(), clientMessage: clientMessage.trim() });
      // The caller reports API failures with the specific server message.
      if (saved === false) return;
    } catch {
      toast.error("The account could not be updated. Try again.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1282]/30 px-4 backdrop-blur-sm">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="suspension-title" tabIndex={-1}
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl outline-none">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 id="suspension-title" className="text-lg font-bold text-[#0D1282]">
            {isSuspending ? "Suspend business account" : "Reactivate business account"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{accountName}</p>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="space-y-4 px-5 py-4 text-sm">
            {isSuspending ? (
              <fieldset className="space-y-3">
                <legend className="mb-2 font-semibold text-slate-800">Suspension mode</legend>
                <label className={`block cursor-pointer rounded-xl border p-3 transition-colors ${mode === "OPERATIONAL_HOLD" ? "border-amber-400 bg-amber-50" : "border-slate-200 hover:border-slate-300"}`}>
                  <span className="flex items-center gap-2.5 font-semibold text-slate-900">
                    <input type="radio" name="suspension-mode" checked={mode === "OPERATIONAL_HOLD"} onChange={() => setMode("OPERATIONAL_HOLD")} className="h-4 w-4 accent-[#0D1282]" />
                    Operational hold
                  </span>
                  <span className="mt-1 block pl-[26px] leading-5 text-slate-600">Members can review records, pay existing dues and contact support. New account activity is paused.</span>
                </label>
                <label className={`block cursor-pointer rounded-xl border p-3 transition-colors ${mode === "SECURITY_LOCK" ? "border-rose-400 bg-rose-50" : "border-slate-200 hover:border-slate-300"}`}>
                  <span className="flex items-center gap-2.5 font-semibold text-slate-900">
                    <input type="radio" name="suspension-mode" checked={mode === "SECURITY_LOCK"} onChange={() => setMode("SECURITY_LOCK")} className="h-4 w-4 accent-[#0D1282]" />
                    Security lock
                  </span>
                  <span className="mt-1 block pl-[26px] leading-5 text-slate-600">Members lose access to this business account, including records, payments and support.</span>
                </label>
              </fieldset>
            ) : <p className="text-slate-700">Access will be restored after the account checks pass. Existing member and credit restrictions remain in place.</p>}
            <label className="block font-semibold text-slate-800" htmlFor="suspension-reason">Internal reason <span className="text-rose-700">*</span></label>
            <textarea id="suspension-reason" required minLength={5} maxLength={1000} rows={3} value={internalReason}
              onChange={(event) => setInternalReason(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#0D1282] focus:outline-none" />
            <p className="text-xs text-slate-600">Saved in the audit record. Members will not see this reason.</p>
            <label className="block font-semibold text-slate-800" htmlFor="suspension-client-message">Message to account members (optional)</label>
            <textarea id="suspension-client-message" maxLength={500} rows={2} value={clientMessage}
              onChange={(event) => setClientMessage(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#0D1282] focus:outline-none" />
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-200 px-5 py-4">
            <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={busy || internalReason.trim().length < 5}
              className="rounded-lg bg-[#0D1282] px-4 py-2 font-semibold text-white disabled:opacity-50">
              {busy ? "Saving…" : isSuspending ? "Confirm suspension" : "Reactivate account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
