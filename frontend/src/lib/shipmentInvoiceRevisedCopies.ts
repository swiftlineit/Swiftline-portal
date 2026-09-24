import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { ShipmentInvoice, ShipmentInvoiceAudience } from "@/lib/shipmentInvoices";

/**
 * Document-only revised copy of a tax invoice, stored permanently on the
 * server in its own collection.
 *
 * Reading or writing one of these never touches the real `ShipmentInvoice`:
 * the legal invoice, its number, its revisions and every money record stay
 * exactly as they were. Because the copy lives server-side, staff can revisit
 * it from any device and clients can see it in their own invoice section.
 */
export type ShipmentInvoiceRevisedCopy = {
  id: string;
  shipmentDraftId: string;
  /** Original statutory invoice number, kept for reference. */
  invoiceNumber: string;
  /** Real backend revision this copy was cloned from. */
  basedOnRevision: number;
  createdAt: string;
  updatedAt: string;
  /** The fully edited invoice document to render / print. */
  invoice: ShipmentInvoice;
};

type StoredCopy = {
  id: string;
  shipmentDraftId: string;
  invoiceNumber: string;
  basedOnRevision: number;
  createdAt: string;
  updatedAt: string;
  document: ShipmentInvoice;
};

function basePath(draftId: string, audience: ShipmentInvoiceAudience) {
  return audience === "client"
    ? `/api/v1/client/shipments/${draftId}/invoice/revised`
    : `/api/v1/dpd-shipments/drafts/${draftId}/invoice/revised`;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return response;
  headers.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers });
}

async function readJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function toCopy(stored: StoredCopy): ShipmentInvoiceRevisedCopy {
  return {
    id: stored.id,
    shipmentDraftId: stored.shipmentDraftId,
    invoiceNumber: stored.invoiceNumber,
    basedOnRevision: stored.basedOnRevision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    invoice: stored.document,
  };
}

export function notifyRevisedCopiesChanged(shipmentDraftId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("swiftline:revised-copies-changed", { detail: { shipmentDraftId } }));
}

export function cloneInvoice(invoice: ShipmentInvoice): ShipmentInvoice {
  return JSON.parse(JSON.stringify(invoice)) as ShipmentInvoice;
}

export async function listRevisedCopies(
  shipmentDraftId: string,
  audience: ShipmentInvoiceAudience,
): Promise<ShipmentInvoiceRevisedCopy[]> {
  const response = await fetchWithAuth(apiUrl(basePath(shipmentDraftId, audience)));
  const data = await readJson(response);
  if (!response.ok || !data.success) throw new Error(typeof data.message === "string" ? data.message : "Unable to load revised copies.");
  const copies = Array.isArray(data.copies) ? (data.copies as StoredCopy[]) : [];
  return copies.map(toCopy);
}

export async function getRevisedCopy(
  shipmentDraftId: string,
  audience: ShipmentInvoiceAudience,
  copyId: string,
): Promise<ShipmentInvoiceRevisedCopy> {
  const response = await fetchWithAuth(apiUrl(`${basePath(shipmentDraftId, audience)}/${encodeURIComponent(copyId)}`));
  const data = await readJson(response);
  if (!response.ok || !data.success || !data.copy) {
    throw new Error(typeof data.message === "string" ? data.message : "Revised copy not found.");
  }
  return toCopy(data.copy as StoredCopy);
}

export async function saveRevisedCopy(input: {
  shipmentDraftId: string;
  audience: ShipmentInvoiceAudience;
  invoice: ShipmentInvoice;
  basedOnRevision: number;
  changeReason: string;
  copyId?: string;
}): Promise<ShipmentInvoiceRevisedCopy> {
  const path = input.copyId
    ? `${basePath(input.shipmentDraftId, input.audience)}/${encodeURIComponent(input.copyId)}`
    : basePath(input.shipmentDraftId, input.audience);
  const response = await fetchWithAuth(apiUrl(path), {
    method: input.copyId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document: input.invoice,
      basedOnRevision: input.basedOnRevision,
      changeReason: input.changeReason,
    }),
  });
  const data = await readJson(response);
  if (!response.ok || !data.success || !data.copy) {
    throw new Error(typeof data.message === "string" ? data.message : "Unable to save the revised copy.");
  }
  notifyRevisedCopiesChanged(input.shipmentDraftId);
  return toCopy(data.copy as StoredCopy);
}

export async function deleteRevisedCopy(
  shipmentDraftId: string,
  audience: ShipmentInvoiceAudience,
  copyId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    apiUrl(`${basePath(shipmentDraftId, audience)}/${encodeURIComponent(copyId)}`),
    { method: "DELETE" },
  );
  const data = await readJson(response);
  if (!response.ok || !data.success) {
    throw new Error(typeof data.message === "string" ? data.message : "Unable to delete the revised copy.");
  }
  notifyRevisedCopiesChanged(shipmentDraftId);
}

export async function downloadRevisedCopyPdf(
  shipmentDraftId: string,
  audience: ShipmentInvoiceAudience,
  copyId: string,
  invoiceNumber: string,
): Promise<void> {
  const response = await fetchWithAuth(
    apiUrl(`${basePath(shipmentDraftId, audience)}/${encodeURIComponent(copyId)}/pdf`),
  );
  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(typeof data.message === "string" ? data.message : "Unable to download the revised copy PDF.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${invoiceNumber.replaceAll("/", "-")}-Revised.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Page URL for viewing a revised copy as a document. */
export function revisedCopyPageUrl(draftId: string, audience: ShipmentInvoiceAudience, copyId: string) {
  const base = audience === "client"
    ? `/client/shipments/${draftId}/invoice`
    : `/dashboard/shipments/${draftId}/invoice`;
  return `${base}?revised=${encodeURIComponent(copyId)}`;
}
