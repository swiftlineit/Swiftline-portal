import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type CreditAccountStatus = "NOT_REQUESTED" | "PENDING_REVIEW" | "APPROVED" | "ACTIVE" | "ON_HOLD" | "SUSPENDED" | "EXPIRED" | "REJECTED" | "CLOSED";
export type CreditPermission = "requestCredit" | "useCreditPayment" | "viewCreditBalance" | "viewCreditDetails" | "makeCreditPayment";

export type CreditAccount = {
  id: string;
  businessAccountId: string;
  status: CreditAccountStatus;
  currency: "INR";
  requestedCreditLimitMinor?: number;
  requestReason?: string;
  requestedAt?: string | null;
  approvedCreditLimitMinor?: number;
  reservedCreditMinor?: number;
  unbilledCreditMinor?: number;
  invoicedOutstandingMinor?: number;
  customerAdvanceBalanceMinor?: number;
  reservedAdvanceMinor?: number;
  usedCreditMinor?: number;
  availableCreditMinor?: number;
  availableAdvanceMinor?: number;
  availableBookingCapacityMinor?: number;
  /** Unbilled plus invoiced: what is owed whether or not a statement exists yet. */
  totalOwedMinor?: number;
  /** Share of the limit committed, and whether it has crossed the warning threshold. */
  utilizationPercent?: number;
  warningActive?: boolean;
  /** The customer's open ask for a higher limit, if there is one awaiting review. */
  limitIncreaseRequest?: CreditLimitIncreaseRequest | null;
  paymentTermsDays: number;
  /**
   * Amounts owed and dates due, gathered from statements and payments rather
   * than the credit account. Absent for a member without balance visibility.
   */
  billing?: {
    overdueAmountMinor: number;
    overdueStatementCount: number;
    nextDueAt: string | null;
    nextDueAmountMinor: number | null;
    lastPayment: { amountMinor: number; at: string } | null;
  } | null;
  billingCycle: "WEEKLY" | "MONTHLY";
  validFrom?: string | null;
  validUntil?: string | null;
  gracePeriodDays?: number;
  maxOverdueDays?: number;
  creditWarningThresholdPercent?: number;
  securityDepositRequiredMinor?: number;
  riskCategory?: "LOW" | "MEDIUM" | "HIGH";
  internalRemarks?: string;
  holdReason?: string;
  reviewedAt?: string | null;
  activatedAt?: string | null;
  canUseCredit?: boolean;
  restriction?: {
    level: "NONE" | "GRACE_WARNING" | "CREDIT_BLOCKED" | "ALL_BOOKINGS_BLOCKED";
    oldestDueAt: string | null;
    overdueDays: number;
    message: string;
  };
  version?: number;
  updatedAt?: string;
  businessAccount?: {
    id: string;
    accountId: string;
    companyName: string;
    status: string;
    kycStatus: string;
    agreementStatus: string;
    depositStatus: string;
  } | null;
};

export type PaymentTerms = {
  version: string;
  title: string;
  effectiveFrom: string;
  sections: Array<{ heading: string; content: string }>;
};

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;
  token = await refreshAccessToken();
  if (!token) return response;
  headers.set("Authorization", `Bearer ${token}`);
  response = await fetch(input, { ...init, headers });
  return response;
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.message || "The credit account request could not be completed.");
  return data as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}

export async function getClientCreditAccount(businessAccountId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/credit?businessAccountId=${encodeURIComponent(businessAccountId)}`));
  return parse<{ success: true; creditAccount: CreditAccount; permissions: CreditPermission[] }>(response);
}

export async function requestCredit(input: { businessAccountId: string; requestedCreditLimitMinor: number; reason: string }) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/credit/request"), json("POST", input));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

/** A live customer's ask for a higher limit. Their facility keeps working while it waits. */
export type CreditLimitIncreaseRequest = {
  id: string;
  businessAccountId: string;
  currentLimitMinor: number;
  requestedLimitMinor: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  requestedAt: string;
  reviewedAt: string | null;
  decidedLimitMinor: number | null;
  decisionNote: string;
};

export async function getCreditLimitIncrease(businessAccountId: string) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/credit/limit-increase?businessAccountId=${encodeURIComponent(businessAccountId)}`)
  );
  return parse<{ success: true; request: CreditLimitIncreaseRequest | null }>(response);
}

export async function requestCreditLimitIncrease(input: {
  businessAccountId: string;
  requestedLimitMinor: number;
  reason: string;
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/credit/limit-increase"), json("POST", input));
  return parse<{ success: true; message: string; request: CreditLimitIncreaseRequest }>(response);
}

export async function getPaymentTerms() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/payment-terms"));
  return parse<{ success: true; terms: PaymentTerms }>(response);
}

export async function acceptPaymentTerms(input: { businessAccountId: string; termsVersion: string; paymentReference?: string }) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/payment-terms/accept"), json("POST", input));
  return parse<{ success: true; message: string }>(response);
}

export async function listAdminCreditAccounts(status: CreditAccountStatus | "" = "") {
  const url = new URL(apiUrl("/api/v1/credit-accounts"));
  if (status) url.searchParams.set("status", status);
  const response = await fetchWithAuth(url.toString());
  return parse<{ success: true; creditAccounts: CreditAccount[] }>(response);
}

/** Charges that exist but cannot be billed yet, because the parcel is still to be collected. */
export type AwaitingCollection = {
  count: number;
  valueMinor: number;
  oldestIssuedAt: string | null;
};

export async function getAdminCreditAccount(businessAccountId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}`));
  return parse<{ success: true; creditAccount: CreditAccount; awaitingCollection: AwaitingCollection }>(response);
}

export type CreditApprovalInput = {
  approvedCreditLimitMinor: number;
  paymentTermsDays: 0 | 7 | 15 | 30 | 45;
  billingCycle: "WEEKLY" | "MONTHLY";
  validFrom: string;
  validUntil: string;
  gracePeriodDays: number;
  maxOverdueDays: number;
  creditWarningThresholdPercent: number;
  securityDepositRequiredMinor: number;
  riskCategory: "LOW" | "MEDIUM" | "HIGH";
  internalRemarks: string;
  reason: string;
};

export async function approveCreditAccount(businessAccountId: string, input: CreditApprovalInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/approve`), json("POST", input));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export async function activateCreditAccount(businessAccountId: string, input: { agreementId: string; accepted: true }) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/activate`), json("POST", input));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export async function rejectCreditAccount(businessAccountId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/reject`), json("POST", { reason }));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export async function suspendCreditAccount(businessAccountId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/suspend`), json("POST", { reason }));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export async function reactivateCreditAccount(businessAccountId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/reactivate`), json("POST", { reason }));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export async function closeCreditAccount(businessAccountId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/credit-accounts/${businessAccountId}/close`), json("POST", { reason }));
  return parse<{ success: true; message: string; creditAccount: CreditAccount }>(response);
}

export function formatCreditMoney(valueMinor?: number, currency = "INR") {
  if (valueMinor === undefined) return "Restricted";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(valueMinor / 100);
}
export const MAX_CREDIT_LIMIT_RUPEES = 10_00_000;
/** Mirrors `maxCreditLimitLabel` on the API, so both sides quote one number. */
export const MAX_CREDIT_LIMIT_LABEL = `INR ${MAX_CREDIT_LIMIT_RUPEES.toLocaleString("en-IN")}`;
