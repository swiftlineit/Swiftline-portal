"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FiDownload, FiEye, FiFileText } from "react-icons/fi";
import {
  downloadShipmentInvoicePdf,
  getShipmentInvoice,
  ShipmentInvoice,
  ShipmentInvoiceAudience,
  shipmentInvoicePageUrl
} from "@/lib/shipmentInvoices";
import {
  saveRevisedCopy,
  type ShipmentInvoiceRevisedCopy,
} from "@/lib/shipmentInvoiceRevisedCopies";
import ShipmentInvoiceRevisedCopyEditor from "@/components/shipments/ShipmentInvoiceRevisedCopyEditor";
import ShipmentInvoiceRevisedCopiesSection from "@/components/shipments/ShipmentInvoiceRevisedCopiesSection";

function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(amountMinor / 100);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value)).replaceAll("/", "-");
}

export default function ShipmentInvoiceHistory({
  draftId,
  audience,
  canEdit = false,
}: {
  draftId: string;
  audience: ShipmentInvoiceAudience;
  /**
   * Only staff editors (admin / operations) receive the revise control.
   * Clients and other roles see the real invoice plus any revised documents.
   */
  canEdit?: boolean;
}) {
  const [invoice, setInvoice] = useState<ShipmentInvoice | null>(null);
  const [error, setError] = useState("");
  const [downloadingRevision, setDownloadingRevision] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCopy, setEditingCopy] = useState<ShipmentInvoiceRevisedCopy | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const result = await getShipmentInvoice(draftId, audience);
        if (mounted) setInvoice(result);
      } catch (caughtError) {
        if (mounted) {
          setError(caughtError instanceof Error ? caughtError.message : "Unable to load shipment invoices.");
        }
      }
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [audience, draftId]);

  const versions = useMemo(
    () => [...(invoice?.versions ?? [])].sort((left, right) => right.revision - left.revision),
    [invoice]
  );

  async function download(revision: number) {
    if (!invoice) return;
    setDownloadingRevision(revision);
    setError("");
    try {
      await downloadShipmentInvoicePdf(draftId, audience, invoice.invoiceNumber, revision);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to download shipment invoice.");
    } finally {
      setDownloadingRevision(null);
    }
  }

  function openEditor(copy: ShipmentInvoiceRevisedCopy | null) {
    if (!invoice) return;
    setEditingCopy(copy);
    setEditorOpen(true);
  }

  // Saves the edited document into its own server collection. The real
  // invoice and every money record are never written.
  const [savingCopy, setSavingCopy] = useState(false);

  async function handleEditorSave(edited: ShipmentInvoice, copyId: string | undefined, changeReason: string) {
    if (!invoice) return;
    setSavingCopy(true);
    setError("");
    try {
      await saveRevisedCopy({
        shipmentDraftId: draftId,
        audience,
        invoice: edited,
        basedOnRevision: copyId ? (editingCopy?.basedOnRevision ?? invoice.revision) : invoice.revision,
        changeReason,
        copyId,
      });
      setEditorOpen(false);
      setEditingCopy(null);
    } finally {
      setSavingCopy(false);
    }
  }

  return (
    <section className="border border-slate-200 bg-white rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <div className="flex items-center gap-2 text-slate-500">
            <FiFileText aria-hidden="true" className="h-4 w-4" />
            {/* GST document billing freight and tax, distinct from the shipment
                (customs) invoice that declares the goods. */}
            <h2 className="text-sm font-semibold uppercase tracking-wide">Invoices</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500">GST invoice versions and charge history.</p>
        </div>
        {invoice ? <p className="text-sm font-semibold text-slate-700">{invoice.invoiceNumber}</p> : null}
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">{error}</div>
      ) : null}

      {!invoice && !error ? (
        <p className="px-5 py-5 text-sm font-medium text-slate-500">Loading shipment invoices...</p>
      ) : invoice ? (
        <>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Invoice</th>
                <th className="px-5 py-3">Issued</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {versions.map((version) => (
                <tr key={version.revision}>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-950">Invoice {version.revision}</p>
                  </td>
                  <td className="px-5 py-4 text-slate-700">{date(version.issuedAt)}</td>
                  <td className="px-5 py-4 font-semibold text-slate-950">{money(version.totalAmountMinor, invoice.currency)}</td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex border px-2.5 py-1 rounded-2xl text-xs font-semibold uppercase ${version.isLatest ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                      {version.isLatest ? "Current" : "Previous"}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex justify-end gap-2">
                      <Link
                        href={shipmentInvoicePageUrl(draftId, audience, false, version.revision)}
                        title={`View Invoice ${version.revision}`}
                        className="inline-flex  rounded-4xl h-9 items-center gap-2 border border-slate-300 px-3 font-semibold text-blue-900 hover:border-blue-900"
                      >
                        <FiEye aria-hidden="true" />
                        View
                      </Link>
                      <button
                        type="button"
                        onClick={() => void download(version.revision)}
                        disabled={downloadingRevision !== null}
                        title={`Download Invoice ${version.revision}`}
                        className="inline-flex h-9 w-9 rounded items-center justify-center border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        <FiDownload aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ShipmentInvoiceRevisedCopiesSection
          draftId={draftId}
          audience={audience}
          canEdit={canEdit && Boolean(invoice)}
          onEdit={openEditor}
        />
        {editorOpen && invoice ? (
          <ShipmentInvoiceRevisedCopyEditor
            initial={editingCopy ? editingCopy.invoice : invoice}
            copyId={editingCopy?.id}
            saving={savingCopy}
            onSave={handleEditorSave}
            onCancel={() => {
              setEditorOpen(false);
              setEditingCopy(null);
            }}
          />
        ) : null}
        </>
      ) : null}
    </section>
  );
}
