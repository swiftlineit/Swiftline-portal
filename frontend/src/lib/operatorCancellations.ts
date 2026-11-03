import { fetchWithAuth } from "@/lib/shipmentsList";

export type OperatorCancellationStatus = "REQUESTED" | "COMPLETED" | "REJECTED";

export type OperatorShipmentCancellation = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  businessAccountId: string;
  branchId: string;
  requesterType: "CLIENT" | "ADMIN";
  requesterRole: string;
  reason: string;
  shipmentStatusAtRequest: string;
  status: OperatorCancellationStatus;
  originalAmountMinor: number;
  taxTreatment: "GST_APPLICABLE" | "NO_GST";
  requestedFeeBaseMinor: number;
  approvedFeeBaseMinor: number | null;
  feeGstMinor: number | null;
  feeTotalMinor: number | null;
  refundableAmountMinor: number | null;
  feeReason: string;
  carrierConfirmed: boolean;
  carrierConfirmationRequired: boolean;
  settlementConfirmed: boolean;
  reviewNote: string;
  creditNoteId: string | null;
  cancellationFeeInvoiceId: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
};

export type OperatorCancellationQueueItem = OperatorShipmentCancellation & {
  trackingNumber: string;
  accountName: string;
  accountId: string;
  branch: { id: string; name: string; code: string } | null;
  destination: string;
  currentStatus: string;
};

export class OperatorCancellationRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly canonicalSlug?: string) {
    super(message);
    this.name = "OperatorCancellationRequestError";
  }
}

function operatorPath(operatorSlug: string, resource: string) {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/${resource}`;
}

async function requestOperatorJson<T>(operatorSlug: string, resource: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(operatorPath(operatorSlug, resource), init);
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    message?: string;
    canonicalSlug?: unknown;
    [key: string]: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new OperatorCancellationRequestError(
      payload.message || "The cancellation request could not be completed.",
      response.status,
      typeof payload.canonicalSlug === "string" ? payload.canonicalSlug : undefined
    );
  }
  return payload as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function getOperatorShipmentCancellation(operatorSlug: string, draftId: string, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    canRequest: boolean;
    eligibilityMessage: string;
    cancellation: OperatorShipmentCancellation | null;
  }>(operatorSlug, `shipments/${encodeURIComponent(draftId)}/cancellation`, { signal });
}

export function requestOperatorShipmentCancellation(operatorSlug: string, draftId: string, reason: string) {
  return requestOperatorJson<{ success: true; cancellation: OperatorShipmentCancellation }>(
    operatorSlug,
    `shipments/${encodeURIComponent(draftId)}/cancellation`,
    postJson({ reason })
  );
}

export function listOperatorShipmentCancellations(operatorSlug: string, page = 1, signal?: AbortSignal) {
  const query = new URLSearchParams({ status: "REQUESTED", page: String(page), pageSize: "50" });
  return requestOperatorJson<{
    success: true;
    cancellations: OperatorCancellationQueueItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }>(operatorSlug, `cancellations?${query.toString()}`, { signal });
}

export function approveOperatorShipmentCancellation(operatorSlug: string, cancellationId: string, input: {
  feeBaseMinor: number;
  feeReason: string;
  reviewNote: string;
}) {
  return requestOperatorJson<{ success: true; cancellation: OperatorShipmentCancellation }>(
    operatorSlug,
    `cancellations/${encodeURIComponent(cancellationId)}/approve`,
    postJson({ ...input, settlementConfirmed: true })
  );
}

export function rejectOperatorShipmentCancellation(operatorSlug: string, cancellationId: string, reviewNote: string) {
  return requestOperatorJson<{ success: true; cancellation: OperatorShipmentCancellation }>(
    operatorSlug,
    `cancellations/${encodeURIComponent(cancellationId)}/reject`,
    postJson({ reviewNote })
  );
}

export async function downloadOperatorCancellationDocument(
  operatorSlug: string,
  cancellationId: string,
  documentType: "credit-note" | "fee-invoice"
) {
  const response = await fetchWithAuth(operatorPath(
    operatorSlug,
    `shipment-cancellations/${encodeURIComponent(cancellationId)}/${documentType}/pdf?download=1`
  ));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string; canonicalSlug?: unknown };
    throw new OperatorCancellationRequestError(
      payload.message || "The cancellation document could not be downloaded.",
      response.status,
      typeof payload.canonicalSlug === "string" ? payload.canonicalSlug : undefined
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = documentType === "credit-note" ? `cancellation-credit-note-${cancellationId}.pdf` : `cancellation-fee-invoice-${cancellationId}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
