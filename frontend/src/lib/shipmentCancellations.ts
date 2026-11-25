import { apiUrl } from "@/lib/api";
import { setDateRangeParams, type DateRange } from "@/lib/dateRange";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type ShipmentCancellation = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  businessAccountId: string;
  branchId: string;
  requesterType: "CLIENT" | "ADMIN";
  requesterRole: string;
  reason: string;
  shipmentStatusAtRequest: string;
  status: "REQUESTED" | "COMPLETED" | "REJECTED";
  originalAmountMinor: number;
  taxTreatment: "GST_APPLICABLE" | "NO_GST";
  requestedFeeBaseMinor: number;
  approvedFeeBaseMinor: number | null;
  feeGstMinor: number | null;
  feeTotalMinor: number | null;
  refundableAmountMinor: number | null;
  feeReason: string;
  carrierConfirmed: boolean;
  settlementConfirmed: boolean;
  paymentRefundStatus: "NOT_REQUIRED" | "CREDITED_TO_WALLET" | "RAZORPAY_REFUNDED" | "CASH_REFUNDED" | "MANUAL_REFUNDED";
  paymentRefundAmountMinor: number;
  paymentRefundReference: string;
  paymentRefundedAt: string | null;
  gatewayRefundStarted?: boolean;
  carrierReference: string;
  reviewNote: string;
  settlement: {
    originalCreditReversedMinor: number;
    cancellationFeeCreditMinor: number;
    netCreditReleasedMinor: number;
    statementCreditAppliedMinor: number;
    customerAdvanceCreditedMinor: number;
  } | null;
  creditNoteId: string | null;
  cancellationFeeInvoiceId: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  shipmentReference?: string;
  consignee?: string;
  customerType?: "BUSINESS" | "INDIVIDUAL";
  paymentSource?: "BUSINESS_ACCOUNT" | "DIRECT_RAZORPAY" | "CASH_RECEIPT" | "CLIENT_PREPAID" | "ADMIN_DIRECT" | "PUBLIC_RAZORPAY" | "TEST" | "";
  branch?: { id: string; name: string; code: string } | null;
  businessAccount?: { id: string; accountId: string; companyName: string } | null;
};

export function cancellationRefundLabel(status: ShipmentCancellation["paymentRefundStatus"]): string | null {
  switch (status) {
    case "CREDITED_TO_WALLET":
      return "Historical wallet credit recorded";
    case "RAZORPAY_REFUNDED":
      return "Refunded to original payment method";
    case "CASH_REFUNDED":
      return "Cash refund recorded";
    case "MANUAL_REFUNDED":
      return "Manual refund recorded";
    case "NOT_REQUIRED":
      return null;
  }
}

export type AdminShipmentCancellationPreview = {
  originalAmountMinor: number;
  taxTreatment: "GST_APPLICABLE" | "NO_GST";
  feeBaseMinor: number;
  feeGstMinor: number;
  feeTotalMinor: number;
  refundableAmountMinor: number;
  feeWasCapped: boolean;
  manualRefundRequired: boolean;
  manualRefundSource: boolean;
};

export const DEFAULT_CANCELLATION_FEE_BASE_MINOR = 70_000;
export const DEFAULT_CANCELLATION_FEE_BASE_RUPEES = "700.00";
export const CANCELLATION_GST_RATE_PERCENT = 18;

export type CancellationFeeAmounts = {
  requestedBaseMinor: number;
  feeBaseMinor: number;
  feeGstMinor: number;
  feeTotalMinor: number;
  refundMinor: number;
  capped: boolean;
};

/** Client-side estimate for the fee review UI; the server recalculates before settlement. */
export function calculateCancellationFeeAmounts(
  originalAmountMinor: number,
  taxTreatment: "GST_APPLICABLE" | "NO_GST",
  feeRupees: string
): CancellationFeeAmounts | null {
  const normalizedFee = feeRupees.trim();
  if (!normalizedFee || !/^\d*(?:\.\d{0,2})?$/.test(normalizedFee)) return null;

  const requestedBaseMinor = Math.round(Number(normalizedFee) * 100);
  if (
    !Number.isSafeInteger(originalAmountMinor)
    || originalAmountMinor < 0
    || !Number.isSafeInteger(requestedBaseMinor)
    || requestedBaseMinor < 0
  ) return null;

  const noGst = taxTreatment === "NO_GST";
  const requestedGstMinor = noGst
    ? 0
    : Math.round(requestedBaseMinor * CANCELLATION_GST_RATE_PERCENT / 100);
  const requestedTotalMinor = requestedBaseMinor + requestedGstMinor;
  if (!Number.isSafeInteger(requestedTotalMinor)) return null;

  if (requestedTotalMinor <= originalAmountMinor) {
    return {
      requestedBaseMinor,
      feeBaseMinor: requestedBaseMinor,
      feeGstMinor: requestedGstMinor,
      feeTotalMinor: requestedTotalMinor,
      refundMinor: originalAmountMinor - requestedTotalMinor,
      capped: false
    };
  }

  const feeBaseMinor = noGst
    ? originalAmountMinor
    : Math.round((originalAmountMinor * 100) / (100 + CANCELLATION_GST_RATE_PERCENT));
  return {
    requestedBaseMinor,
    feeBaseMinor,
    feeGstMinor: originalAmountMinor - feeBaseMinor,
    feeTotalMinor: originalAmountMinor,
    refundMinor: 0,
    capped: true
  };
}

export type CancellationRefundPayout = {
  method: "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
  reference?: string;
  note?: string;
};

export class ShipmentCancellationRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ShipmentCancellationRequestError";
  }
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", "Bearer " + token);
  let response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;
  token = await refreshAccessToken();
  if (!token) return response;
  headers.set("Authorization", "Bearer " + token);
  response = await fetch(input, { ...init, headers });
  return response;
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new ShipmentCancellationRequestError(
      data.message || "The cancellation request could not be completed.",
      response.status
    );
  }
  return data as T;
}

export async function getClientShipmentCancellation(draftId: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/shipments/" + draftId + "/cancellation"));
  return parse<{ success: true; canRequest: boolean; cancellation: ShipmentCancellation | null }>(response);
}

export async function requestClientShipmentCancellation(draftId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/shipments/" + draftId + "/cancellation"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  return parse<{ success: true; cancellation: ShipmentCancellation }>(response);
}

export async function getAdminShipmentCancellation(draftId: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-cancellations/drafts/" + draftId));
  return parse<{ success: true; canRequest: true; cancellation: ShipmentCancellation | null }>(response);
}

export async function requestAdminShipmentCancellation(draftId: string, reason: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-cancellations/drafts/" + draftId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  return parse<{ success: true; cancellation: ShipmentCancellation }>(response);
}

export async function getAdminShipmentCancellationPreview(draftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-cancellations/drafts/${draftId}/direct-preview`));
  return parse<{ success: true; preview: AdminShipmentCancellationPreview }>(response);
}

export async function cancelAdminShipmentDirectly(
  draftId: string,
  input: {
    reason: string;
    feeBaseMinor: number;
    feeReason: string;
    carrierConfirmed: true;
    settlementConfirmed: true;
    carrierReference?: string;
    refundPayout?: CancellationRefundPayout;
  }
) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-cancellations/drafts/${draftId}/direct`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return parse<{
    success: true;
    completed: boolean;
    message: string;
    cancellation: ShipmentCancellation;
  }>(response);
}

export async function listShipmentCancellations(input: { status?: string; dateRange?: DateRange; page?: number } = {}) {
  const url = new URL(apiUrl("/api/v1/shipment-cancellations"));
  if (input.status) url.searchParams.set("status", input.status);
  setDateRangeParams(url.searchParams, input.dateRange);
  url.searchParams.set("page", String(input.page ?? 1));
  const response = await fetchWithAuth(url.toString());
  return parse<{
    success: true;
    cancellations: ShipmentCancellation[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(response);
}

export async function approveShipmentCancellation(
  id: string,
  input: {
    feeBaseMinor: number;
    feeReason: string;
    carrierConfirmed: true;
    settlementConfirmed: true;
    carrierReference: string;
    reviewNote: string;
    /** Staff recorded payout for a legacy admin-direct or offline cash receipt. */
    refundPayout?: {
      method: "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
      reference?: string;
      note?: string;
    };
  }
) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-cancellations/" + id + "/approve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return parse<{ success: true; cancellation: ShipmentCancellation }>(response);
}

export async function rejectShipmentCancellation(id: string, reviewNote: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-cancellations/" + id + "/reject"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewNote })
  });
  return parse<{ success: true; cancellation: ShipmentCancellation }>(response);
}

async function cancellationPdf(id: string, type: "credit-note" | "fee-invoice", audience: "client" | "admin") {
  const base = audience === "client"
    ? "/api/v1/client/shipment-cancellations/" + id + "/" + type + "/pdf"
    : "/api/v1/shipment-cancellations/" + id + "/" + type + "/pdf";
  const response = await fetchWithAuth(apiUrl(base));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || "The financial document could not be opened.");
  }
  return response.blob();
}

export async function openCancellationPdf(
  id: string,
  type: "credit-note" | "fee-invoice",
  audience: "client" | "admin"
) {
  const blob = await cancellationPdf(id, type, audience);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadCancellationPdf(
  id: string,
  type: "credit-note" | "fee-invoice",
  audience: "client" | "admin"
) {
  const blob = await cancellationPdf(id, type, audience);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = type === "credit-note" ? "shipment-credit-note.pdf" : "cancellation-fee-invoice.pdf";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function printCancellationPdf(
  id: string,
  type: "credit-note" | "fee-invoice",
  audience: "client" | "admin"
) {
  const blob = await cancellationPdf(id, type, audience);
  const url = URL.createObjectURL(blob);
  const printWindow = window.open(url, "_blank");
  if (!printWindow) {
    URL.revokeObjectURL(url);
    throw new Error("Allow pop-ups to print this financial document.");
  }
  printWindow.addEventListener("load", () => printWindow.print(), { once: true });
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
