"use client";

import { useState } from "react";
import { useDialog } from "@/lib/useDialog";
import type { OperationsManifest } from "@/lib/operationsManifests";

export type ManifestDeleteMode = "ARCHIVE" | "PERMANENT";

export default function OperationsManifestDeleteDialog({
  manifest,
  busy,
  onConfirm,
  onCancel,
}: {
  manifest: OperationsManifest;
  busy: boolean;
  onConfirm: (input: { mode: ManifestDeleteMode; reason: string; confirmationManifestNumber: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isSealed = manifest.status === "SEALED";
  const [mode, setMode] = useState<ManifestDeleteMode>(isSealed ? "ARCHIVE" : "PERMANENT");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const dialogRef = useDialog<HTMLDivElement>(true, () => {
    if (!busy) onCancel();
  });
  const canConfirm = reason.trim().length >= 5
    && confirmation.trim().toUpperCase() === manifest.manifestNumber.toUpperCase()
    && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/45 p-0 sm:items-center sm:p-4">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manifest-delete-title"
        tabIndex={-1}
        className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:rounded-2xl"
      >
        <header className="border-b border-slate-200 px-5 py-4 sm:px-6">
          <h2 id="manifest-delete-title" className="text-lg font-bold text-[#0D1282]">
            {isSealed ? `Delete sealed manifest ${manifest.manifestNumber}?` : `Delete manifest ${manifest.manifestNumber}?`}
          </h2>
          <p className="mt-1 text-sm leading-5 text-slate-600">
            {isSealed
              ? "The shipment Ready for Dispatch event created by sealing will be removed, the linked pre-departure flight will be removed, and the manifest number will be released."
              : "This removes the active manifest, its packing records and its linked booked flight. The manifest number will be released."}
          </p>
        </header>

        <div className="space-y-4 px-5 py-4 sm:px-6">
          {isSealed ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-800">Choose what to do with the sealed record</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={`block cursor-pointer rounded-xl border p-4 transition ${mode === "ARCHIVE" ? "border-[#0D1282] bg-indigo-50/60 ring-1 ring-[#0D1282]" : "border-slate-200 hover:border-slate-400"}`}>
                  <input className="sr-only" type="radio" name="manifest-delete-mode" value="ARCHIVE" checked={mode === "ARCHIVE"} onChange={() => setMode("ARCHIVE")} />
                  <span className="block text-sm font-bold text-slate-900">Archive &amp; Delete</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-600">Keep a read-only copy of the manifest, linked flight, and issued files. Recommended.</span>
                </label>
                <label className={`block cursor-pointer rounded-xl border p-4 transition ${mode === "PERMANENT" ? "border-red-600 bg-red-50/60 ring-1 ring-red-600" : "border-slate-200 hover:border-slate-400"}`}>
                  <input className="sr-only" type="radio" name="manifest-delete-mode" value="PERMANENT" checked={mode === "PERMANENT"} onChange={() => setMode("PERMANENT")} />
                  <span className="block text-sm font-bold text-slate-900">Permanently Delete</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-600">Remove the operational record and generated documents without an archive copy.</span>
                </label>
              </div>
            </fieldset>
          ) : null}

          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-900">
            Discard old printed manifest and bag labels after deletion. The number can be reused, so an old barcode may look the same as the new manifest’s barcode.
          </div>

          <label className="block text-sm font-semibold text-slate-800">
            Reason for deletion
            <textarea
              required
              minLength={5}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Explain why this manifest is being removed"
              className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            />
          </label>

          <label className="block text-sm font-semibold text-slate-800">
            Type <span className="font-bold text-[#0D1282]">{manifest.manifestNumber}</span> to confirm
            <input
              required
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm font-medium uppercase tracking-wide text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            />
          </label>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button type="button" disabled={busy} onClick={onCancel} className="h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => void onConfirm({ mode, reason: reason.trim(), confirmationManifestNumber: confirmation.trim().toUpperCase() })}
            className={`h-11 rounded-lg px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${mode === "ARCHIVE" ? "bg-[#0D1282] hover:bg-[#0a0d63]" : "bg-red-700 hover:bg-red-800"}`}
          >
            {busy ? "Deleting…" : mode === "ARCHIVE" ? "Archive & Delete" : "Permanently Delete"}
          </button>
        </footer>
      </section>
    </div>
  );
}
