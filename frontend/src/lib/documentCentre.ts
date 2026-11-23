"use client";

import { apiUrl } from "@/lib/api";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";

export const documentTypeOptions = [
  { value: "SHIPPING_LABEL", label: "Shipping Labels" },
  { value: "COMMERCIAL_INVOICE", label: "Commercial Invoices" },
  { value: "MANIFEST", label: "Manifests" },
  { value: "POD", label: "POD" },
  { value: "BILLING_INVOICE", label: "Billing Invoices" },
  { value: "CASH_RECEIPT", label: "Cash Receipts" },
  { value: "CREDIT_NOTE", label: "Credit Notes" },
  { value: "CLAIM_DOCUMENT", label: "Claim Documents" },
  { value: "CUSTOMS_DOCUMENT", label: "Customs Documents" }
] as const;

export type ClientDocumentType = (typeof documentTypeOptions)[number]["value"];

export type ClientDocumentCentreItem = {
  id: string;
  documentType: ClientDocumentType;
  documentTypeLabel: string;
  title: string;
  reference: string;
  awb: string;
  awbCount: number;
  destination: string;
  documentDate: string;
  format: string;
  fileName: string;
  status: string;
  isNew: boolean;
  downloadPath: string;
  downloadMode: "BLOB" | "LABEL_ACCESS";
};

type DocumentListResponse = {
  success: true;
  items: ClientDocumentCentreItem[];
  documentTypes: Array<{ value: ClientDocumentType; label: string }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export const cashReceiptReadEvent = "cash-receipt-read";

export async function getCashReceiptUnreadCount() {
  const response = await authenticatedFetch("/api/v1/client/documents/cash-receipts/unread-count");
  const payload = await readJsonSafely(response) as { success?: boolean; message?: string; unreadCount?: number };
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "Cash receipt notifications could not be loaded.");
  }
  return Math.max(0, Math.trunc(payload.unreadCount ?? 0));
}

async function authenticatedFetch(path: string, init: RequestInit = {}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");

  const send = () => fetch(apiUrl(path), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      Authorization: `Bearer ${token}`
    }
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  return response;
}

export async function listClientDocuments(input: {
  businessAccountId: string;
  branchId?: string;
  documentType?: "" | ClientDocumentType;
  awb?: string;
  destination?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  const query = new URLSearchParams({
    businessAccountId: input.businessAccountId,
    page: String(input.page ?? 1),
    limit: String(input.limit ?? 20)
  });
  if (input.branchId) query.set("branchId", input.branchId);
  if (input.documentType) query.set("documentType", input.documentType);
  if (input.awb) query.set("awb", input.awb);
  if (input.destination) query.set("destination", input.destination);
  if (input.dateFrom) query.set("dateFrom", input.dateFrom);
  if (input.dateTo) query.set("dateTo", input.dateTo);

  const response = await authenticatedFetch(`/api/v1/client/documents?${query.toString()}`);
  const payload = await readJsonSafely(response) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "Documents could not be loaded.");
  }
  return payload as unknown as DocumentListResponse;
}

function saveBlob(blob: Blob, fileName: string, view: boolean, openedWindow: Window | null) {
  const url = URL.createObjectURL(blob);
  if (view) {
    if (!openedWindow) throw new Error("Allow pop-ups to open this document.");
    openedWindow.location.href = url;
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function accessClientDocument(item: ClientDocumentCentreItem, view: boolean) {
  const openedWindow = view ? window.open("about:blank", "_blank") : null;
  try {
    const separator = item.downloadPath.includes("?") ? "&" : "?";
    if (item.downloadMode === "LABEL_ACCESS") {
      const response = await authenticatedFetch(
        `${item.downloadPath}${separator}disposition=${view ? "inline" : "attachment"}`
      );
      const payload = await readJsonSafely(response) as { success?: boolean; message?: string; url?: string };
      if (!response.ok || !payload.success || !payload.url) {
        throw new Error(payload.message || "The label could not be opened.");
      }
      if (view) {
        if (!openedWindow) throw new Error("Allow pop-ups to open this document.");
        openedWindow.location.href = payload.url;
      } else {
        const anchor = document.createElement("a");
        anchor.href = payload.url;
        anchor.download = item.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
      return;
    }

    const response = await authenticatedFetch(`${item.downloadPath}${separator}${view ? "view=1" : "download=1"}`);
    if (!response.ok) {
      const payload = await readJsonSafely(response) as { message?: string };
      throw new Error(payload.message || "The document could not be opened.");
    }
    saveBlob(await response.blob(), item.fileName, view, openedWindow);
    if (item.documentType === "CASH_RECEIPT") {
      window.dispatchEvent(new CustomEvent(cashReceiptReadEvent));
    }
  } catch (error) {
    openedWindow?.close();
    throw error;
  }
}
