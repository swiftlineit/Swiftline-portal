"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FiEdit2, FiEye, FiPrinter, FiTrash2 } from "react-icons/fi";
import {
  deleteRevisedCopy,
  listRevisedCopies,
  revisedCopyPageUrl,
  type ShipmentInvoiceRevisedCopy,
} from "@/lib/shipmentInvoiceRevisedCopies";

function date(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(value))
    .replaceAll("/", "-");
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
}

/**
 * Document-only revised copies of the tax invoice.
 *
 * These live in the browser only and never change the real invoice or the
 * database. Each row opens the edited document with a "Revised copy" banner.
 */
export default function ShipmentInvoiceRevisedCopiesSection({
  draftId,
  audience,
  canEdit,
  onEdit,
}: {
  draftId: string;
  audience: "admin" | "client";
  canEdit: boolean;
  onEdit: (copy: ShipmentInvoiceRevisedCopy | null) => void;
}) {
  const [tick, setTick] = useState(0);
  // Re-read on every render; `tick` re-renders after any save/delete event.
  void tick;
  const copies = listRevisedCopies(draftId);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { shipmentDraftId?: string } | undefined;
      if (!detail || detail.shipmentDraftId === draftId) refresh();
    };
    window.addEventListener("swiftline:revised-copies-changed", handler);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("swiftline:revised-copies-changed", handler);
      window.removeEventListener("storage", refresh);
    };
  }, [draftId, refresh]);

  if (!copies.length && !canEdit) return null;

  return (
    <div className="border-t border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h3 className="text-sm font-bold text-slate-950">Revised copies <span className="font-semibold text-slate-500">(document only)</span></h3>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Edited documents for reference. The real tax invoice above is unchanged.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => onEdit(null)}
            className="inline-flex h-9 items-center gap-2 rounded-4xl border border-blue-900 px-3 text-sm font-semibold text-blue-900 hover:bg-blue-50"
          >
            <FiEdit2 aria-hidden="true" />
            New revised copy
          </button>
        ) : null}
      </div>

      {copies.length ? (
        <ul className="divide-y divide-slate-100">
          {copies.map((copy, index) => (
            <li key={copy.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div>
                <p className="text-sm font-bold text-slate-950">
                  Revised copy {copies.length - index}
                  <span className="ml-2 inline-flex rounded-2xl border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
                    Revision · document only
                  </span>
                </p>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  Based on Invoice {copy.invoice.revision} · {money(copy.invoice.totalAmountMinor, copy.invoice.currency)} · Updated {date(copy.updatedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={revisedCopyPageUrl(draftId, audience, copy.id)}
                  className="inline-flex h-9 items-center gap-2 rounded-4xl border border-slate-300 px-3 text-sm font-semibold text-blue-900 hover:border-blue-900"
                >
                  <FiEye aria-hidden="true" />
                  View
                </Link>
                <button
                  type="button"
                  title="Print / save as PDF"
                  onClick={() => window.open(revisedCopyPageUrl(draftId, audience, copy.id), "_blank")}
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900"
                >
                  <FiPrinter aria-hidden="true" />
                </button>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      title="Edit this revised copy"
                      onClick={() => onEdit(copy)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900"
                    >
                      <FiEdit2 aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title="Delete this revised copy"
                      onClick={() => {
                        if (!window.confirm("Delete this revised copy? The real invoice is not affected.")) return;
                        deleteRevisedCopy(draftId, copy.id);
                        refresh();
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-slate-700 hover:border-red-500 hover:text-red-700"
                    >
                      <FiTrash2 aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-5 text-sm font-medium text-slate-500">No revised copies yet. Use “New revised copy” to create an edited document.</p>
      )}
    </div>
  );
}
