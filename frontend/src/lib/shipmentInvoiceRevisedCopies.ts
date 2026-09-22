import type { ShipmentInvoice } from "@/lib/shipmentInvoices";

/**
 * Document-only revised copy of a tax invoice.
 *
 * This never touches the backend or the database. It is a local edited
 * document cloned from the real invoice, kept in the browser so Operations /
 * Admin can re-issue a corrected-looking paper without mutating the legal
 * invoice stored on the server.
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

function storageKey(shipmentDraftId: string) {
  return `swiftline:invoice-revised-copies:${shipmentDraftId}`;
}

function readAll(shipmentDraftId: string): ShipmentInvoiceRevisedCopy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(shipmentDraftId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ShipmentInvoiceRevisedCopy[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(shipmentDraftId: string, copies: ShipmentInvoiceRevisedCopy[]) {
  window.localStorage.setItem(storageKey(shipmentDraftId), JSON.stringify(copies));
  // Notify other mounted components on the same page (history + invoice page).
  window.dispatchEvent(new CustomEvent("swiftline:revised-copies-changed", { detail: { shipmentDraftId } }));
}

export function cloneInvoice(invoice: ShipmentInvoice): ShipmentInvoice {
  return JSON.parse(JSON.stringify(invoice)) as ShipmentInvoice;
}

function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `rev-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function listRevisedCopies(shipmentDraftId: string): ShipmentInvoiceRevisedCopy[] {
  return [...readAll(shipmentDraftId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getRevisedCopy(shipmentDraftId: string, copyId: string) {
  return readAll(shipmentDraftId).find((copy) => copy.id === copyId) ?? null;
}

export function saveRevisedCopy(input: {
  shipmentDraftId: string;
  invoice: ShipmentInvoice;
  basedOnRevision: number;
  copyId?: string;
}): ShipmentInvoiceRevisedCopy {
  const copies = readAll(input.shipmentDraftId);
  const now = new Date().toISOString();
  if (input.copyId) {
    const existing = copies.find((copy) => copy.id === input.copyId);
    if (existing) {
      existing.invoice = cloneInvoice(input.invoice);
      existing.updatedAt = now;
      existing.basedOnRevision = input.basedOnRevision;
      writeAll(input.shipmentDraftId, copies);
      return existing;
    }
  }
  const created: ShipmentInvoiceRevisedCopy = {
    id: newId(),
    shipmentDraftId: input.shipmentDraftId,
    invoiceNumber: input.invoice.invoiceNumber,
    basedOnRevision: input.basedOnRevision,
    createdAt: now,
    updatedAt: now,
    invoice: cloneInvoice(input.invoice),
  };
  writeAll(input.shipmentDraftId, [...copies, created]);
  return created;
}

export function deleteRevisedCopy(shipmentDraftId: string, copyId: string) {
  writeAll(
    shipmentDraftId,
    readAll(shipmentDraftId).filter((copy) => copy.id !== copyId),
  );
}

/** Page URL for viewing a revised copy as a document. */
export function revisedCopyPageUrl(draftId: string, audience: "admin" | "client", copyId: string) {
  const base = audience === "client"
    ? `/client/shipments/${draftId}/invoice`
    : `/dashboard/shipments/${draftId}/invoice`;
  return `${base}?revised=${encodeURIComponent(copyId)}`;
}
