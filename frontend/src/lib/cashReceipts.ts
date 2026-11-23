import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type StandaloneCashReceipt = {
  id: string;
  receiptNumber: string;
  receiptType: "STANDALONE";
  status: "FINALIZED";
  businessAccountId: string;
  branchId: string;
  shipmentDraftId: null;
  totalReceivedMinor: number;
  customerName: string;
  receiptDate: string;
  accountId: string;
  destination: string;
  service?: "COURIER" | "CARGO";
  pieces?: number;
  weightKg?: number;
  customerReference: string;
  cashCustodyReference: string;
  createdByName: string;
  issuedAt: string | null;
};

type ReceiptListResponse = {
  success: true;
  receipts: StandaloneCashReceipt[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

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

async function json<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) throw new Error(payload.message || fallback);
  return payload as T;
}

function query(input: { from?: string; to?: string; page?: number; limit?: number }) {
  const params = new URLSearchParams();
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.page) params.set("page", String(input.page));
  if (input.limit) params.set("limit", String(input.limit));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export async function listStandaloneCashReceipts(input: { from?: string; to?: string; page?: number; limit?: number } = {}) {
  const response = await authenticatedFetch(`/api/v1/cash-receipts${query(input)}`);
  return json<ReceiptListResponse>(response, "Cash receipts could not be loaded.");
}

export async function createStandaloneCashReceipt(input: {
  idempotencyKey: string;
  businessAccountId: string;
  branchId: string;
  customerName: string;
  receiptDate: string;
  amountMinor: number;
  paymentReference: string;
  customerReference?: string;
  destination?: string;
  service?: "COURIER" | "CARGO";
  pieces?: number;
  weightKg?: number;
}) {
  const { idempotencyKey, ...body } = input;
  const response = await authenticatedFetch("/api/v1/cash-receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body)
  });
  return json<{ success: true; duplicate?: boolean; receipt: StandaloneCashReceipt }>(response, "Cash receipt could not be created.");
}

async function download(path: string, filename: string) {
  const response = await authenticatedFetch(path);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Cash receipt file could not be downloaded.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadStandaloneCashReceipt(receipt: StandaloneCashReceipt) {
  return download(`/api/v1/cash-receipts/${encodeURIComponent(receipt.id)}/pdf`, `CASH-RECEIPT-${receipt.receiptNumber}.pdf`);
}

export function exportStandaloneCashReceipts(input: { from?: string; to?: string }) {
  return download(`/api/v1/cash-receipts/export${query(input)}`, "swiftline-cash-receipts.csv");
}
