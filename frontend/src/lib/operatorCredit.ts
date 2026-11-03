import { fetchWithAuth, requestJson } from "@/lib/shipmentsList";
import type { CreditApprovalInput } from "@/lib/creditAccounts";

export type OperatorCreditPagination = {
  page: number;
  pageSize?: number;
  limit?: number;
  total: number;
  totalPages: number;
};

export type OperatorCreditAccountSummary = {
  id: string;
  businessAccountId: string;
  status: string;
  currency: "INR";
  requestedCreditLimitMinor?: number;
  approvedCreditLimitMinor: number;
  usedCreditMinor: number;
  reservedCreditMinor: number;
  unbilledCreditMinor: number;
  invoicedOutstandingMinor: number;
  totalOwedMinor: number;
  availableCreditMinor: number;
  availableAdvanceMinor: number;
  availableBookingCapacityMinor: number;
  paymentTermsDays: number;
  billingCycle: "WEEKLY" | "MONTHLY";
  requestReason?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  gracePeriodDays?: number;
  maxOverdueDays?: number;
  creditWarningThresholdPercent?: number;
  securityDepositRequiredMinor?: number;
  riskCategory?: "LOW" | "MEDIUM" | "HIGH";
  internalRemarks?: string;
  restriction?: { level: string; message?: string };
  billing?: {
    overdueAmountMinor: number;
    overdueStatementCount: number;
    nextDueAt: string | null;
    nextDueAmountMinor: number | null;
    lastPayment: { amountMinor: number; at: string } | null;
  };
};

export type OperatorCreditBusinessAccount = {
  id: string;
  accountId: string;
  companyName: string;
  status: string;
  branchId?: string | null;
};

export type OperatorCreditAccountRow = {
  businessAccount: OperatorCreditBusinessAccount;
  creditAccount: OperatorCreditAccountSummary;
};

export type OperatorCreditStatement = {
  id: string;
  statementNumber: string;
  businessAccountId: string;
  issuedAt: string;
  dueAt: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  outstandingAmountMinor: number;
  status: string;
};

export type OperatorCreditLedgerEntry = {
  id: string;
  type: string;
  reference: string;
  description: string;
  amountMinor: number;
  currency: string;
  availableCreditAfterMinor: number;
  availableAdvanceAfterMinor: number;
  createdAt: string;
};

export type OperatorCreditPayment = {
  id: string;
  amountMinor: number;
  currency: string;
  method: string;
  status: string;
  internalReference: string;
  externalReference: string;
  verifiedAt: string | null;
  createdAt: string;
};

function creditPath(operatorSlug: string, path: string) {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/credit/${path}`;
}

function accountQuery(businessAccountId: string) {
  return new URLSearchParams({ businessAccountId }).toString();
}

export function listOperatorCreditAccounts(operatorSlug: string, page = 1, pageSize = 25, search = "") {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search.trim()) params.set("search", search.trim());
  return requestJson<{
    success: true;
    creditAccounts: OperatorCreditAccountRow[];
    pagination: OperatorCreditPagination;
  }>(`${creditPath(operatorSlug, "accounts")}?${params.toString()}`);
}

export function getOperatorCreditAccount(operatorSlug: string, businessAccountId: string) {
  return requestJson<{
    success: true;
    creditAccount: OperatorCreditAccountSummary & { businessAccount?: OperatorCreditBusinessAccount };
    businessAccount: OperatorCreditBusinessAccount;
  }>(creditPath(operatorSlug, `accounts/${encodeURIComponent(businessAccountId)}`));
}

export function getOperatorClientCreditSummary(operatorSlug: string, businessAccountId: string) {
  return requestJson<{
    success: true;
    permissions: string[];
    financialAccess: boolean;
    creditAccount: OperatorCreditAccountSummary & { businessAccount?: OperatorCreditBusinessAccount };
  }>(`${creditPath(operatorSlug, "client/summary")}?${accountQuery(businessAccountId)}`);
}

export function listOperatorCreditStatements(operatorSlug: string, businessAccountId: string, role: "staff" | "client") {
  const path = role === "client" ? "client/statements" : `accounts/${encodeURIComponent(businessAccountId)}/statements`;
  const query = role === "client" ? `?${accountQuery(businessAccountId)}` : "";
  return requestJson<{ success: true; statements: OperatorCreditStatement[]; pagination: OperatorCreditPagination }>(
    `${creditPath(operatorSlug, path)}${query}`
  );
}

export function listOperatorCreditLedger(operatorSlug: string, businessAccountId: string, role: "staff" | "client") {
  const path = role === "client" ? "client/ledger" : `accounts/${encodeURIComponent(businessAccountId)}/ledger`;
  const query = role === "client" ? `?${accountQuery(businessAccountId)}` : "";
  return requestJson<{ success: true; entries: OperatorCreditLedgerEntry[]; pagination: OperatorCreditPagination }>(
    `${creditPath(operatorSlug, path)}${query}`
  );
}

export function listOperatorCreditPayments(operatorSlug: string, businessAccountId: string, role: "staff" | "client") {
  const path = role === "client" ? "client/payments" : `accounts/${encodeURIComponent(businessAccountId)}/payments`;
  const query = role === "client" ? `?${accountQuery(businessAccountId)}` : "";
  return requestJson<{ success: true; payments: OperatorCreditPayment[]; pagination: OperatorCreditPagination }>(
    `${creditPath(operatorSlug, path)}${query}`
  );
}

export function requestOperatorCredit(operatorSlug: string, input: {
  businessAccountId: string;
  requestedCreditLimitMinor: number;
  reason: string;
}) {
  return requestJson<{ success: true; message: string }>(creditPath(operatorSlug, "client/requests"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function approveOperatorCredit(operatorSlug: string, businessAccountId: string, input: CreditApprovalInput) {
  return requestJson<{ success: true; message: string }>(creditPath(operatorSlug, `accounts/${encodeURIComponent(businessAccountId)}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function rejectOperatorCredit(operatorSlug: string, businessAccountId: string, reason: string) {
  return requestJson<{ success: true; message: string }>(creditPath(operatorSlug, `accounts/${encodeURIComponent(businessAccountId)}/reject`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
}

export function recordOperatorOfflinePayment(operatorSlug: string, businessAccountId: string, input: {
  amountMinor: number;
  method: "BANK_TRANSFER" | "UPI" | "CASH" | "CHEQUE";
  externalReference: string;
  notes: string;
  requestedStatementId?: string;
}) {
  return requestJson<{ success: true; message: string; payment: OperatorCreditPayment }>(
    creditPath(operatorSlug, `accounts/${encodeURIComponent(businessAccountId)}/payments/offline`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `OPERATOR-OFFLINE:${crypto.randomUUID()}`
          : `OPERATOR-OFFLINE:${Date.now()}`
      },
      body: JSON.stringify(input)
    }
  );
}

export function verifyOperatorOfflinePayment(operatorSlug: string, businessAccountId: string, paymentId: string) {
  return requestJson<{ success: true; message: string; payment: OperatorCreditPayment }>(
    creditPath(operatorSlug, `accounts/${encodeURIComponent(businessAccountId)}/payments/${encodeURIComponent(paymentId)}/verify`),
    { method: "POST" }
  );
}

export async function downloadOperatorCreditStatement(operatorSlug: string, businessAccountId: string, statementId: string, role: "staff" | "client") {
  const path = role === "client"
    ? `client/statements/${encodeURIComponent(statementId)}/pdf?${accountQuery(businessAccountId)}`
    : `accounts/${encodeURIComponent(businessAccountId)}/statements/${encodeURIComponent(statementId)}/pdf`;
  const response = await fetchWithAuth(creditPath(operatorSlug, path));
  if (!response.ok) throw new Error("Unable to download this credit statement.");
  return response.blob();
}
