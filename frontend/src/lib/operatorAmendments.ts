import { fetchWithAuth } from "@/lib/shipmentsList";
import type {
  ShipmentAmendmentChange,
  ShipmentAmendmentInput,
  ShipmentAmendmentPreview
} from "@/lib/dpdLabels";

export type OperatorShipmentAmendment = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  businessAccountId: string;
  branchId: string;
  requestedBy: string;
  actorRole: "admin" | "client";
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "APPLIED";
  reason: string;
  requestedChanges: Record<string, unknown>;
  changePreview: ShipmentAmendmentChange[];
  pricingImpact: ShipmentAmendmentPreview["pricingImpact"] | null;
  fundingPreview: ShipmentAmendmentPreview["fundingPreview"] | null;
  billingAdjustment: Record<string, unknown> | null;
  reviewNote: string;
  requestedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
  currentAmountMinor: number | null;
  requestedAmountMinor: number | null;
};

export type OperatorAmendmentQueueItem = OperatorShipmentAmendment & {
  trackingNumber: string;
  accountName: string;
  accountId: string;
  consignee: string;
  branch: { id: string; name: string; code: string } | null;
};

export class OperatorAmendmentRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly canonicalSlug?: string) {
    super(message);
    this.name = "OperatorAmendmentRequestError";
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
    throw new OperatorAmendmentRequestError(
      payload.message || "The shipment amendment request could not be completed.",
      response.status,
      typeof payload.canonicalSlug === "string" ? payload.canonicalSlug : undefined
    );
  }
  return payload as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function getOperatorShipmentAmendments(operatorSlug: string, draftId: string, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    canRequest: boolean;
    eligibilityMessage: string;
    amendments: OperatorShipmentAmendment[];
  }>(operatorSlug, `shipments/${encodeURIComponent(draftId)}/amendments`, { signal });
}

export function previewOperatorShipmentAmendment(
  operatorSlug: string,
  draftId: string,
  input: ShipmentAmendmentInput
) {
  return requestOperatorJson<{ success: true } & ShipmentAmendmentPreview>(
    operatorSlug,
    `shipments/${encodeURIComponent(draftId)}/amendments/preview`,
    postJson(input)
  );
}

export function requestOperatorShipmentAmendment(
  operatorSlug: string,
  draftId: string,
  input: ShipmentAmendmentInput
) {
  return requestOperatorJson<{ success: true; amendment: OperatorShipmentAmendment }>(
    operatorSlug,
    `shipments/${encodeURIComponent(draftId)}/amendments`,
    postJson(input)
  );
}

export function listOperatorShipmentAmendments(operatorSlug: string, page = 1, signal?: AbortSignal) {
  const query = new URLSearchParams({ status: "REQUESTED", page: String(page), pageSize: "25" });
  return requestOperatorJson<{
    success: true;
    amendments: OperatorAmendmentQueueItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }>(operatorSlug, `shipment-amendments?${query.toString()}`, { signal });
}

export function approveOperatorShipmentAmendment(operatorSlug: string, amendmentId: string, note = "") {
  return requestOperatorJson<{ success: true; amendment: OperatorShipmentAmendment }>(
    operatorSlug,
    `shipment-amendments/${encodeURIComponent(amendmentId)}/approve`,
    postJson({ note })
  );
}

export function rejectOperatorShipmentAmendment(operatorSlug: string, amendmentId: string, note: string) {
  return requestOperatorJson<{ success: true; amendment: OperatorShipmentAmendment }>(
    operatorSlug,
    `shipment-amendments/${encodeURIComponent(amendmentId)}/reject`,
    postJson({ note })
  );
}
