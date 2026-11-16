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
  /**
   * INDIVIDUAL means the shipment was paid at the counter, so any refund leaves
   * the company outside the portal and has to be recorded on approval.
   */
  customerType?: "BUSINESS" | "INDIVIDUAL";
  branch?: { id: string; name: string; code: string } | null;
  businessAccount?: { id: string; accountId: string; companyName: string } | null;
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
    /**
     * How the refund was paid back to a walk-in customer. Required only when the
     * shipment was a counter sale with something to refund- account-backed
     * cancellations settle through the credit ledger instead.
     */
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
