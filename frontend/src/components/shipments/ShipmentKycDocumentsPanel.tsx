"use client";

import { useState } from "react";
import { FiDownload, FiEye, FiFileText } from "react-icons/fi";
import {
  shipmentKycDocumentLabels,
  type ShipmentKycDocument,
  type ShipmentKycDocumentType
} from "@/lib/dpdLabels";

export type ShipmentKycDocumentItem = ShipmentKycDocument & {
  key: string;
  scopeLabel?: string;
  sequence?: number;
};

export default function ShipmentKycDocumentsPanel({
  documents,
  onOpen,
  previewOnDocumentName = false,
  canDownload = true,
  showUploadedAt = false,
  title = "Uploaded KYC Documents",
  className = "mt-5 border-t border-slate-100 pt-5"
}: {
  documents: ShipmentKycDocumentItem[];
  onOpen: (document: ShipmentKycDocumentItem) => Promise<Blob>;
  previewOnDocumentName?: boolean;
  canDownload?: boolean;
  showUploadedAt?: boolean;
  title?: string;
  className?: string;
}) {
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");

  async function preview(document: ShipmentKycDocumentItem) {
    const previewWindow = window.open("", "_blank");
    setBusyKey(`${document.key}:preview`);
    setError("");
    try {
      const blob = await onOpen(document);
      const objectUrl = URL.createObjectURL(blob);
      if (previewWindow) {
        previewWindow.location.href = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } else {
        URL.revokeObjectURL(objectUrl);
        setError("Allow pop-ups to preview this document.");
      }
    } catch (caughtError) {
      previewWindow?.close();
      setError(caughtError instanceof Error ? caughtError.message : "Unable to preview this document.");
    } finally {
      setBusyKey("");
    }
  }

  async function download(document: ShipmentKycDocumentItem) {
    setBusyKey(`${document.key}:download`);
    setError("");
    try {
      const blob = await onOpen(document);
      const objectUrl = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = objectUrl;
      link.download = document.originalName || `${document.documentLabel || document.type}.pdf`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to download this document.");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <FiFileText aria-hidden="true" className="h-4 w-4 text-blue-900" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      </div>

      {documents.length ? (
        <div className="mt-3 space-y-2">
          {documents.map((document) => (
            <div key={document.key} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{document.documentLabel || formatDocumentType(document.type)}</p>
                <p className="truncate text-xs mt-1 text-slate-500">
                  {document.scopeLabel ? `${document.scopeLabel} · ` : ""}
                  {previewOnDocumentName ? (
                    <button
                      type="button"
                      onClick={() => void preview(document)}
                      disabled={Boolean(busyKey)}
                      className="max-w-full truncate text-left font-medium text-blue-900 underline decoration-blue-300 underline-offset-2 hover:text-blue-700 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800 disabled:cursor-wait disabled:text-slate-400"
                      aria-label={`Preview ${document.originalName}`}
                    >
                      {busyKey === `${document.key}:preview` ? "Opening preview…" : document.originalName}
                    </button>
                  ) : document.originalName}
                </p>
                {showUploadedAt && document.uploadedAt ? (
                  <p className="mt-1 text-xs text-slate-500">Uploaded {formatUploadedAt(document.uploadedAt)}</p>
                ) : null}
              </div>
              {(!previewOnDocumentName || canDownload) ? (
                <div className="flex shrink-0 gap-2">
                  {!previewOnDocumentName ? (
                    <button
                      type="button"
                      onClick={() => void preview(document)}
                      disabled={Boolean(busyKey)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-blue-900 hover:border-blue-900 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      <FiEye aria-hidden="true" className="h-3.5 w-3.5" />
                      {busyKey === `${document.key}:preview` ? "Opening..." : "Preview"}
                    </button>
                  ) : null}
                  {canDownload ? (
                    <button
                      type="button"
                      onClick={() => void download(document)}
                      disabled={Boolean(busyKey)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-900 px-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      <FiDownload aria-hidden="true" className="h-3.5 w-3.5" />
                      {busyKey === `${document.key}:download` ? "Downloading..." : document.mimeType === "application/pdf" ? "Download PDF" : "Download"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500">No KYC documents uploaded.</p>
      )}

      {error ? <p className="mt-2 text-xs font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}

export function collectShipmentKycDocuments(input: {
  documents?: Partial<Record<ShipmentKycDocumentType, ShipmentKycDocument | null>>;
  parcels?: Array<{ sequence: number; kycDocuments?: Partial<Record<ShipmentKycDocumentType, ShipmentKycDocument | null>> }>;
  kycUseForAllParcels?: boolean;
}) {
  const result: ShipmentKycDocumentItem[] = [];
  for (const document of Object.values(input.documents ?? {})) {
    if (document) result.push({ ...document, key: `shared:${document.type}`, scopeLabel: "All parcels" });
  }

  if (input.kycUseForAllParcels === false) {
    for (const parcel of input.parcels ?? []) {
      for (const document of Object.values(parcel.kycDocuments ?? {})) {
        if (document) result.push({ ...document, key: `parcel:${parcel.sequence}:${document.type}`, sequence: parcel.sequence, scopeLabel: `Parcel ${parcel.sequence}` });
      }
    }
  }

  return result;
}

function formatDocumentType(type: ShipmentKycDocumentType) {
  return shipmentKycDocumentLabels[type];
}

function formatUploadedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
