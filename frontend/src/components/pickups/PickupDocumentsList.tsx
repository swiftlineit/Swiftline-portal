"use client";

import { useState } from "react";
import { FiDownload, FiExternalLink, FiFileText } from "react-icons/fi";
import { toast } from "react-toastify";
import { loadClientPickupDocument, loadInternalPickupDocument, type PickupDocument } from "@/lib/pickups";

function sizeLabel(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PickupDocumentsList({
  pickupId,
  documents = [],
  audience,
}: {
  pickupId: string;
  documents?: PickupDocument[];
  audience: "client" | "internal";
}) {
  const [loadingId, setLoadingId] = useState("");

  async function preview(document: PickupDocument) {
    // Open synchronously with the click so browsers do not block the tab while
    // the authenticated file request is still in flight.
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      toast.error("Allow pop-ups to preview this document.");
      return;
    }
    tab.opener = null;
    tab.document.title = "Opening pickup document";
    tab.document.body.textContent = "Loading document preview…";
    setLoadingId(document.id);
    try {
      const url = audience === "client"
        ? await loadClientPickupDocument(pickupId, document.id)
        : await loadInternalPickupDocument(pickupId, document.id);
      const frame = tab.document.createElement("iframe");
      frame.src = url;
      frame.title = document.originalName;
      frame.style.cssText = "display:block;width:100%;height:100vh;border:0";
      tab.document.title = document.originalName;
      tab.document.body.style.margin = "0";
      tab.document.body.replaceChildren(frame);
      window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    } catch (caught) {
      tab.close();
      toast.error(caught instanceof Error ? caught.message : "Pickup document could not be previewed.");
    } finally {
      setLoadingId("");
    }
  }

  async function download(document: PickupDocument) {
    setLoadingId(document.id);
    try {
      const url = audience === "client"
        ? await loadClientPickupDocument(pickupId, document.id)
        : await loadInternalPickupDocument(pickupId, document.id);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = document.originalName;
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Pickup document could not be downloaded.");
    } finally {
      setLoadingId("");
    }
  }

  return <section className="rounded-2xl border border-slate-200 bg-white p-4">
    <div>
      <h3 className="font-semibold text-slate-950">Supporting documents</h3>
      <p className="mt-1 text-xs text-slate-500">Private files attached to this pickup request.</p>
    </div>
    {documents.length ? <ul className="mt-3 divide-y divide-slate-100">
      {documents.map((document) => <li key={document.id} className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-[#0D1282]"><FiFileText /></span>
        <span className="min-w-0 flex-1"><a href="#" target="_blank" rel="noopener noreferrer" aria-disabled={loadingId === document.id} onClick={(event) => { event.preventDefault(); if (loadingId !== document.id) void preview(document); }} className="inline-flex max-w-full items-center gap-1.5 text-sm font-semibold text-[#0D1282] underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-[#0D1282]"><span className="truncate">{document.originalName}</span><FiExternalLink aria-hidden="true" className="shrink-0" /></a><span className="block text-xs text-slate-500">{document.mimeType} · {sizeLabel(document.size)}</span></span>
        <button type="button" onClick={() => void download(document)} disabled={loadingId === document.id} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-[#0D1282] disabled:opacity-50" aria-label={`Download ${document.originalName}`}><FiDownload />{loadingId === document.id ? "Opening" : "Download"}</button>
      </li>)}
    </ul> : <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">No supporting documents uploaded.</p>}
  </section>;
}
