import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type PaymentsLedgerRow = {
  paymentSource?: string;
  status?: string;
  reference?: string;
  description?: string;
  shipmentDraftId?: string | null;
  shipmentNumber?: string | null;
  _id: string;
  transactionType: string;
  direction: "CREDIT" | "DEBIT" | "NONE";
  amountMinor: number;
  currency: string;
  idempotencyKey?: string;
  createdAt: string;
};

export type PaymentsLedgerPagination = { page: number; limit: number; total: number; totalPages: number };

export type PaymentsLedger = {
  success: true;
  account: { id: string; accountId: string; companyName: string; branchId: string };
  transactions: PaymentsLedgerRow[];
  pagination: PaymentsLedgerPagination;
};

export type ClientAccountLedger = {
  success: true;
  transactions: PaymentsLedgerRow[];
  pagination: PaymentsLedgerPagination;
};

export type LedgerRange = { from?: string; to?: string; page?: number; limit?: number };

function query(input: LedgerRange) {
  const params = new URLSearchParams();
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.page) params.set("page", String(input.page));
  if (input.limit) params.set("limit", String(input.limit));
  const value = params.toString();
  return value ? `?${value}` : "";
}

async function authenticatedFetch(path: string) {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  return response;
}

export async function getClientAccountLedger(businessAccountId: string, range: LedgerRange = {}) {
  const params = new URLSearchParams({ businessAccountId, ...Object.fromEntries(new URLSearchParams(query(range)).entries()) });
  const response = await authenticatedFetch(`/api/v1/client/account-ledger?${params}`);
  const result = await response.json().catch(() => ({})) as Partial<ClientAccountLedger> & { message?: string };
  if (!response.ok || !result.success) throw new Error(result.message || "Payments ledger could not be loaded.");
  return result as ClientAccountLedger;
}

export async function getAdminPaymentsLedger(businessAccountId: string, range: LedgerRange = {}) {
  const response = await authenticatedFetch(`/api/v1/business-accounts/${encodeURIComponent(businessAccountId)}/payments-ledger${query(range)}`);
  const payload = await response.json().catch(() => ({})) as Partial<PaymentsLedger> & { message?: string };
  if (!response.ok || !payload.success) throw new Error(payload.message || "Payments ledger could not be loaded.");
  return payload as PaymentsLedger;
}

export async function exportAdminPaymentsLedger(businessAccountId: string, range: Omit<LedgerRange, "page" | "limit"> = {}) {
  const response = await authenticatedFetch(`/api/v1/business-accounts/${encodeURIComponent(businessAccountId)}/payments-ledger/export${query(range)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Payments ledger export could not be downloaded.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `payments-ledger-${businessAccountId}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
