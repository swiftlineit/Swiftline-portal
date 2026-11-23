import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type AdminPrepaidTransaction = {
  paymentSource?: string;
  status?: string;
  reference?: string;
  shipmentDraftId?: string | null;
  shipmentNumber?: string | null;
  _id: string;
  transactionType: string;
  direction: "CREDIT" | "DEBIT" | "NONE";
  amountMinor: number;
  currency: string;
  cashBalanceBeforeMinor?: number;
  cashBalanceAfterMinor?: number;
  reservedBalanceBeforeMinor?: number;
  reservedBalanceAfterMinor?: number;
  description: string;
  idempotencyKey: string;
  createdAt: string;
};

export type AdminPrepaidLedger = {
  success: true;
  account: { id: string; accountId: string; companyName: string; branchId: string };
  wallet: {
    status: string;
    currency: string;
    cashBalanceMinor: number;
    reservedBalanceMinor: number;
    availableBalanceMinor: number;
  };
  transactions: AdminPrepaidTransaction[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

type LedgerRange = { from?: string; to?: string; page?: number; limit?: number; view?: "all" | "wallet" };

function query(input: LedgerRange) {
  const params = new URLSearchParams();
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.page) params.set("page", String(input.page));
  if (input.limit) params.set("limit", String(input.limit));
  if (input.view) params.set("view", input.view);
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

export async function getClientAccountLedger(businessAccountId: string, page = 1) {
  const params = new URLSearchParams({ businessAccountId, page: String(page) });
  const response = await authenticatedFetch(`/api/v1/client/account-ledger?${params}`);
  const result = await response.json() as { success?: boolean; message?: string; transactions: AdminPrepaidTransaction[]; pagination: AdminPrepaidLedger["pagination"] };
  if (!response.ok || !result.success) throw new Error(result.message || "Account ledger could not be loaded.");
  return result;
}

export async function getAdminPrepaidLedger(businessAccountId: string, range: LedgerRange = {}) {
  const response = await authenticatedFetch(`/api/v1/prepaid-accounts/${encodeURIComponent(businessAccountId)}/ledger${query(range)}`);
  const payload = await response.json().catch(() => ({})) as Partial<AdminPrepaidLedger> & { message?: string };
  if (!response.ok || !payload.success) throw new Error(payload.message || "Wallet ledger could not be loaded.");
  return payload as AdminPrepaidLedger;
}

export async function exportAdminPrepaidLedger(businessAccountId: string, range: Omit<LedgerRange, "page" | "limit"> = {}) {
  const response = await authenticatedFetch(`/api/v1/prepaid-accounts/${encodeURIComponent(businessAccountId)}/ledger/export${query(range)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Wallet ledger export could not be downloaded.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `wallet-ledger-${businessAccountId}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
