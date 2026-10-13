"use client";

import { useState } from "react";
import { useDialog } from "@/lib/useDialog";
import { useLeavePrompt } from "@/lib/useUnsavedChanges";

/**
 * The prompt shown when leaving a form that holds unsaved edits.
 *
 * Mounted once per shell. It replaces a native `window.confirm`, which could
 * only ever offer leave-or-stay- there was no way to add the third and usually
 * best answer, which is to keep the work as a draft and carry on elsewhere.
 *
 * Tab close is still handled by the browser's own prompt: a page being torn down
 * cannot render this, and no async save would finish in time.
 */
export default function UnsavedChangesDialog() {
  const { open, form, resolve } = useLeavePrompt();
  const [saving, setSaving] = useState(false);

  // Escape means "stay"- the safe answer, and the one that loses nothing.
  const dialogRef = useDialog<HTMLDivElement>(open, () => {
    if (!saving) resolve("stay");
  });

  if (!open) return null;

  const canSaveDraft = Boolean(form?.saveDraft);

  async function handleSaveDraft() {
    setSaving(true);
    try {
      resolve("saveDraft");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-portal-theme-scope className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1282]/30 px-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Unsaved changes"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
      >
        <div className="rounded-t-2xl border-b border-slate-100 bg-[#EEEDED]/50 px-5 py-4">
          <h2 className="text-lg font-bold text-[#0D1282]">Unsaved changes</h2>
        </div>

        <div className="px-5 py-4 text-sm leading-6 text-slate-600">
          {canSaveDraft ? (
            <>
              You have unsaved changes to {form?.label ?? "this form"}. Save them as a draft so you
              can finish later, or leave without keeping them.
            </>
          ) : (
            <>
              You have unsaved changes to {form?.label ?? "this form"}. If you leave now, they will
              be lost.
            </>
          )}
        </div>

        <div className="flex flex-wrap  gap-2 rounded-b-2xl border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={() => resolve("stay")}
            disabled={saving}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282] disabled:opacity-60"
          >
            Stay On Page
          </button>
          <button
            type="button"
            onClick={() => resolve("discard")}
            disabled={saving}
            className="rounded-lg border border-[#D71313]/30 bg-white px-3 py-2.5 text-sm font-semibold text-[#D71313] transition hover:bg-[#D71313]/5 disabled:opacity-60"
          >
            Discard Changes
          </button>
          {canSaveDraft ? (
            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              disabled={saving}
              className="rounded-lg bg-[#0D1282] px-3 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save As Draft"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
