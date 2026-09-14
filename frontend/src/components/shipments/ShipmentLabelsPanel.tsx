"use client";

import { useState } from "react";
import { FiDownload, FiEye, FiPrinter } from "react-icons/fi";

export type ShipmentLabelItem = {
  id: string;
  parcelNumber: string;
  labelType: "SWIFTLINE" | "DPD";
  format: string;
  labelSize: string;
  fileChecksum?: string;
};

export type ShipmentLabelDocument = ShipmentLabelItem & {
  parcelNumbers: string[];
};

type LabelAction = "view" | "download" | "print";

/**
 * What this label is, in the terms the person printing it uses.
 *
 * A DPD label is the carrier document the parcel travels on and covers the
 * whole shipment; the Swiftline label is one per box. Naming them apart is what
 * stops someone affixing the wrong one.
 */
function labelTitle(label: ShipmentLabelDocument) {
  if (label.labelType === "DPD") return "DPD Carrier Label";
  return label.parcelNumbers.length > 1 ? "Swiftline Labels" : "Swiftline Label";
}

/** Groups only parcel records that point to the same stored Swiftline PDF. */
export function groupShipmentLabelDocuments(labels: ShipmentLabelItem[]) {
  const documents = new Map<string, ShipmentLabelDocument>();

  for (const label of labels) {
    const key = label.labelType === "SWIFTLINE" && label.fileChecksum
      ? `SWIFTLINE:${label.fileChecksum}`
      : `${label.labelType}:${label.id}`;
    const existing = documents.get(key);
    if (existing) {
      existing.parcelNumbers.push(label.parcelNumber);
    } else {
      documents.set(key, { ...label, parcelNumbers: [label.parcelNumber] });
    }
  }

  return [...documents.values()];
}

export function ShipmentLabelsPanel({
  labels,
  swiftlineTrackingNumber,
  compact = false,
  getAccessUrl
}: {
  labels: ShipmentLabelItem[];
  swiftlineTrackingNumber?: string;
  compact?: boolean;
  getAccessUrl: (labelId: string, disposition: "inline" | "attachment") => Promise<{ url: string }>;
}) {
  const [activeAction, setActiveAction] = useState("");
  const [error, setError] = useState("");
  const labelDocuments = groupShipmentLabelDocuments(labels);

  async function runAction(label: ShipmentLabelDocument, action: LabelAction) {
    const actionKey = `${label.id}:${action}`;
    const openedWindow = action === "download" ? null : window.open("about:blank", "_blank");
    setActiveAction(actionKey);
    setError("");

    try {
      const access = await getAccessUrl(label.id, action === "download" ? "attachment" : "inline");

      if (action === "download") {
        const anchor = document.createElement("a");
        anchor.href = access.url;
        const basename = label.labelType === "SWIFTLINE" && label.parcelNumbers.length > 1
          ? `swiftline-labels-${swiftlineTrackingNumber || label.parcelNumber.replace(/-\d+$/, "")}`
          : `${label.labelType.toLowerCase()}-label-${label.parcelNumber}`;
        anchor.download = `${basename}.${label.format.toLowerCase()}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }

      if (!openedWindow) throw new Error("Allow pop-ups to open the shipment label.");
      if (action === "print") {
        const response = await fetch(access.url);
        if (!response.ok) throw new Error("The shipment label could not be loaded for printing.");
        const objectUrl = window.URL.createObjectURL(await response.blob());
        openedWindow.addEventListener("load", () => {
          window.setTimeout(() => openedWindow.print(), 500);
          window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 5_000);
        }, { once: true });
        openedWindow.location.href = objectUrl;
      } else {
        openedWindow.location.href = access.url;
      }
    } catch (caughtError) {
      openedWindow?.close();
      setError(caughtError instanceof Error ? caughtError.message : "The shipment label could not be opened.");
    } finally {
      setActiveAction("");
    }
  }

  if (!labels.length) return null;

  return (
    <section className="border border-slate-200 bg-white rounded-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Shipment Labels</h2>
          <p className="mt-1 text-sm text-slate-600">View, download, or print the labels for this shipment.</p>
        </div>
      </div>

      {error ? <p className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</p> : null}

      {compact ? (
        <div className="divide-y divide-slate-200">
          {labelDocuments.map((label) => (
            <div key={label.id} className="p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-slate-950">{labelTitle(label)}</h3>
                  <span className="text-xs font-medium text-slate-500">{label.format} </span>
                </div>
                <p className="mt-1 break-all text-sm font-medium text-slate-700">
                  {label.parcelNumbers.length > 1 ? `${label.parcelNumbers.length} parcel labels` : label.parcelNumber}
                </p>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <LabelButton icon={<FiEye />} label="View" busy={activeAction === `${label.id}:view`} onClick={() => runAction(label, "view")} compact />
                <LabelButton icon={<FiDownload />} label="Download" busy={activeAction === `${label.id}:download`} onClick={() => runAction(label, "download")} compact />
                <LabelButton icon={<FiPrinter />} label="Print" busy={activeAction === `${label.id}:print`} onClick={() => runAction(label, "print")} compact />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-190 w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">Label</th>
                <th className="px-4 py-3 font-semibold">Parcel Number</th>
                <th className="px-4 py-3 font-semibold">Format</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {labelDocuments.map((label) => (
                <tr key={label.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-950">{labelTitle(label)}</p>
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {label.parcelNumbers.length > 1 ? `${label.parcelNumbers.length} parcel labels` : label.parcelNumber}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{label.format} {label.labelSize}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <LabelButton icon={<FiEye />} label="View" busy={activeAction === `${label.id}:view`} onClick={() => runAction(label, "view")} />
                      <LabelButton icon={<FiDownload />} label="Download" busy={activeAction === `${label.id}:download`} onClick={() => runAction(label, "download")} />
                      <LabelButton icon={<FiPrinter />} label="Print" busy={activeAction === `${label.id}:print`} onClick={() => runAction(label, "print")} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LabelButton({
  icon,
  label,
  busy,
  onClick,
  compact = false
}: {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex h-9 items-center rounded-4xl justify-center border border-slate-300 bg-white font-semibold text-blue-900 hover:border-blue-900 disabled:cursor-wait disabled:opacity-60 ${compact ? "min-w-0 gap-1.5 px-2 text-sm" : "gap-2 px-3"}`}
    >
      <span aria-hidden="true" className="text-base">{icon}</span>
      {busy ? "Opening..." : label}
    </button>
  );
}
