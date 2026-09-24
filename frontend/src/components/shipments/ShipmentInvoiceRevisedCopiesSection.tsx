"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FiDownload, FiEdit2, FiEye, FiPrinter, FiTrash2 } from "react-icons/fi";
import {
  deleteRevisedCopy,
  downloadRevisedCopyPdf,
  listRevisedCopies,
  revisedCopyPageUrl,
  type ShipmentInvoiceRevisedCopy,
} from "@/lib/shipmentInvoiceRevisedCopies";
import type { ShipmentInvoiceAudience } from "@/lib/shipmentInvoices";

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
 * These are stored permanently on the server in their own collection and never
 * change the real invoice or the database records behind it, so staff can
 * revisit them from any device and clients can read them too.
 */
export default function ShipmentInvoiceRevisedCopiesSection({
  draftId,
  audience,
  canEdit,
  onEdit,
}: {
  draftId: string;
  audience: ShipmentInvoiceAudience;
  canEdit: boolean;
  onEdit: (copy: ShipmentInvoiceRevisedCopy | null) => void;
}) {
  const [copies, setCopies] = useState<ShipmentInvoiceRevisedCopy[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError("");
    try {
      setCopies(await listRevisedCopies(draftId, audience));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load revised copies.");
      setCopies([]);
    }
  }, [audience, draftId]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const result = await listRevisedCopies(draftId, audience);
        if (mounted) setCopies(result);
      } catch (caughtError) {
        if (mounted) {
          setError(caughtError instanceof Error ? caughtError.message : "Unable to load revised copies.");
          setCopies([]);
        }
      }
    }

    void load();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { shipmentDraftId?: string } | undefined;
      if (!detail || detail.shipmentDraftId === draftId) void refresh();
    };
    window.addEventListener("swiftline:revised-copies-changed", handler);
    return () => {
      mounted = false;
      window.removeEventListener("swiftline:revised-copies-changed", handler);
    };
  }, [audience, draftId, refresh]);

  async function handleDownload(copy: ShipmentInvoiceRevisedCopy) {
    setBusyId(copy.id);
    setError("");
    try {
      await downloadRevisedCopyPdf(draftId, audience, copy.id, copy.invoiceNumber);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to download the revised copy.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(copy: ShipmentInvoiceRevisedCopy) {
    if (!window.confirm("Delete this revised copy? The real invoice is not affected.")) return;
    setBusyId(copy.id);
    setError("");
    try {
      await deleteRevisedCopy(draftId, audience, copy.id);
      await refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to delete the revised copy.");
    } finally {
      setBusyId(null);
    }
  }

  // Staff without copies yet still need the single entry point; everyone else
  // sees nothing until a copy exists.
  if (copies !== null && !copies.length && !canEdit) return null;

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

      {error ? (
        <p className="mx-5 mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      {copies === null ? (
        <p className="px-5 pb-5 text-sm font-medium text-slate-500">Loading revised copies...</p>
      ) : copies.length ? (
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
                  Based on Invoice {copy.basedOnRevision} · {money(copy.invoice.totalAmountMinor, copy.invoice.currency)} · Updated {date(copy.updatedAt)}
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
                <button
                  type="button"
                  title={`Download Revised copy ${copies.length - index} PDF`}
                  onClick={() => void handleDownload(copy)}
                  disabled={busyId !== null}
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  <FiDownload aria-hidden="true" />
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
                      onClick={() => void handleDelete(copy)}
                      disabled={busyId !== null}
                      className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-slate-700 hover:border-red-500 hover:text-red-700 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                      <FiTrash2 aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : canEdit ? (
        <p className="px-5 pb-5 text-sm font-medium text-slate-500">No revised copies yet. Use “New revised copy” to create an edited document.</p>
      ) : null}
    </div>
  );
}
