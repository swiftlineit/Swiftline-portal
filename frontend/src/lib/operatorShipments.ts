import { fetchWithAuth } from "@/lib/shipmentsList";
import { toPriceChangedError } from "@/lib/shipmentCostEstimate";
import type {
  AddressPrediction,
  AddressValidationResult,
  PortalAddress,
  ShipmentDraft,
  ShipmentDraftPatch,
  ShipmentAddress,
  ShipmentImportSummary,
  ShipmentKycDocumentType,
  ShipmentKycDocuments
} from "@/lib/dpdLabels";
import type { ClientCountryRateCard, ClientCountryRouteCharge } from "@/lib/countryRateCards";
import type { ClientShipmentDetails, ClientShipmentListItem } from "@/lib/clientDashboard";
import type { ShipmentListItem } from "@/lib/shipmentsList";

export type OperatorShipmentListPagination = {
  page: number;
  pageSize?: number;
  limit?: number;
  total: number;
  totalPages: number;
};

export type OperatorStaffShipmentDraft = {
  id: string;
  businessAccountId: string;
  businessAccountName?: string;
  branchId: string;
  destination: ShipmentAddress;
  shipmentReference: string;
  parcelCount: number;
  parcelWeightsKg: Array<number | null>;
  status: string;
  bookingState: string;
  createdAt: string;
  updatedAt: string;
};

export type OperatorStaffShipmentRow = {
  businessAccountName?: string;
  draft: {
    _id: string;
    businessAccountId: string;
    branchId: string;
    consigneeEnteredAddress: ShipmentAddress;
    parcelList?: ShipmentDraft["parcelList"];
    parcelCount?: number;
    bookingState: string;
    createdAt: string;
    updatedAt: string;
  };
  shipment: {
    _id: string;
    swiftlineTrackingNumber: string;
    parcelNumbers: string[];
    status: string;
    createdAt: string;
  } | null;
  taxInvoice: {
    invoiceNumber: string;
    currency: string;
    totalAmountMinor: number;
    status: string;
    paymentStatus: string;
  } | null;
  currentEvent: { status: string; note: string; location: string; eventAt: string } | null;
  manifestEligible: boolean;
  combinedManifestEligible: boolean;
};

export type OperatorShipmentDetails = ClientShipmentDetails & {
  shipmentDraft: ClientShipmentDetails["shipmentDraft"] & {
    consignor?: Record<string, unknown> | null;
  };
  branch?: { name: string; code: string } | null;
  shipmentInvoice?: {
    invoiceNumber: string;
    currency: string;
    totalAmountMinor: number;
    status: string;
    revision: number;
  } | null;
};

function operatorPath(operatorSlug: string, resource: string) {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/${resource}`;
}

async function requestOperatorJson<T>(operatorSlug: string, resource: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(operatorPath(operatorSlug, resource), init);
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    message?: string;
    code?: string;
    [key: string]: unknown;
  };
  if (!response.ok || !payload.success) {
    const priceChanged = toPriceChangedError(payload);
    if (priceChanged) throw priceChanged;
    throw new Error(payload.message || "The operator shipment request could not be completed.");
  }
  return payload as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export function getOperatorShipmentDraft(operatorSlug: string, shipmentDraftId: string) {
  return requestOperatorJson<{
    success: true;
    shipmentDraft: ShipmentDraft;
    shipmentImport?: ShipmentImportSummary | null;
  }>(operatorSlug, `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}`);
}

export function updateOperatorShipmentDraft(operatorSlug: string, shipmentDraftId: string, patch: ShipmentDraftPatch) {
  return requestOperatorJson<{ success: true; shipmentDraft: ShipmentDraft }>(
    operatorSlug,
    `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
  );
}

export function createOperatorManualShipmentDraft(operatorSlug: string, input: { branchId: string; businessAccountId: string }) {
  return requestOperatorJson<{ success: true; shipmentDraft: ShipmentDraft }>(
    operatorSlug,
    "dpd-labels/drafts/manual",
    jsonBody(input)
  );
}

export function createOperatorShipment(operatorSlug: string, shipmentDraftId: string, acceptedPricingHash: string) {
  return requestOperatorJson<{
    success: true;
    reused: boolean;
    shipment: { id: string; shipmentDraftId: string; trackingNumber: string; parcelNumbers: string[]; status: string };
    labels: Array<{ id: string; labelType: string; parcelNumber: string; format: string; labelSize: string }>;
  }>(
    operatorSlug,
    `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/create-shipment`,
    jsonBody({ acceptedPricingHash })
  );
}

function shipmentListQuery(input: {
  page: number;
  pageSize: number;
  businessAccountId?: string;
  branchId?: string;
  search?: string;
  status?: string;
}, clientQuery = false) {
  const query = new URLSearchParams({ page: String(input.page) });
  query.set(clientQuery ? "limit" : "pageSize", String(input.pageSize));
  if (input.businessAccountId) query.set("businessAccountId", input.businessAccountId);
  if (input.branchId) query.set("branchId", input.branchId);
  if (input.search?.trim()) query.set("search", input.search.trim().slice(0, 100));
  if (input.status?.trim()) query.set("status", input.status.trim());
  return query.toString();
}

export function listOperatorClientShipmentDrafts(operatorSlug: string, input: {
  page: number;
  pageSize: number;
  businessAccountId: string;
  branchId?: string;
  search?: string;
  status?: string;
}, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    shipments: ClientShipmentListItem[];
    pagination: OperatorShipmentListPagination;
  }>(operatorSlug, `shipments?${shipmentListQuery(input, true)}`, { signal });
}

export function listOperatorClientBookedShipments(operatorSlug: string, input: {
  page: number;
  pageSize: number;
  businessAccountId?: string;
  branchId?: string;
  search?: string;
  status?: string;
}, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    shipments: ShipmentListItem[];
    pagination: OperatorShipmentListPagination;
  }>(operatorSlug, `booked-shipments?${shipmentListQuery(input, true)}`, { signal });
}

export function listOperatorStaffShipmentDrafts(operatorSlug: string, input: {
  page: number;
  pageSize: number;
  businessAccountId?: string;
  branchId?: string;
  search?: string;
  status?: string;
}, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    drafts: OperatorStaffShipmentDraft[];
    pagination: OperatorShipmentListPagination;
  }>(operatorSlug, `dpd-labels/drafts?${shipmentListQuery(input)}`, { signal });
}

export function listOperatorStaffBookedShipments(operatorSlug: string, input: {
  page: number;
  pageSize: number;
  businessAccountId?: string;
  branchId?: string;
  search?: string;
  status?: string;
}, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    shipments: OperatorStaffShipmentRow[];
    pagination: OperatorShipmentListPagination;
  }>(operatorSlug, `shipments?${shipmentListQuery(input)}`, { signal });
}

export function getOperatorShipmentDetails(operatorSlug: string, shipmentDraftId: string, client: boolean, signal?: AbortSignal) {
  const id = encodeURIComponent(shipmentDraftId);
  const resource = client ? `shipments/${id}` : `shipments/${id}/details`;
  return requestOperatorJson<{ success: true; shipment: OperatorShipmentDetails }>(operatorSlug, resource, { signal });
}

export function updateOperatorShipmentTracking(operatorSlug: string, shipmentDraftId: string, input: {
  status: "PARCEL_COLLECTED" | "IN_TRANSIT" | "DESTINATION_ARRIVED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "RETURNED";
  note?: string;
  location?: string;
  eventAt?: string;
}) {
  return requestOperatorJson<{ success: true; event: { id: string; status: string; eventAt: string } }>(
    operatorSlug,
    `shipments/${encodeURIComponent(shipmentDraftId)}/tracking-events`,
    jsonBody(input)
  );
}

export async function getOperatorShipmentLabelAccessUrl(operatorSlug: string, shipmentDraftId: string, labelId: string) {
  const query = new URLSearchParams({ disposition: "attachment" });
  return requestOperatorJson<{ success: true; url: string; expiresAt: string }>(
    operatorSlug,
    `shipments/${encodeURIComponent(shipmentDraftId)}/labels/${encodeURIComponent(labelId)}/access?${query}`
  );
}

export async function downloadOperatorShipmentDocument(
  operatorSlug: string,
  shipmentDraftId: string,
  documentKind: "tax-invoice" | "shipment-invoice-pdf" | "shipment-invoice-xlsx"
) {
  const suffix = {
    "tax-invoice": "invoice/pdf",
    "shipment-invoice-pdf": "shipment-invoice/pdf",
    "shipment-invoice-xlsx": "shipment-invoice/xlsx"
  }[documentKind];
  const response = await fetchWithAuth(operatorPath(
    operatorSlug,
    `shipments/${encodeURIComponent(shipmentDraftId)}/${suffix}`
  ));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Unable to download this shipment document.");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  anchor.href = url;
  anchor.download = filename || (documentKind === "shipment-invoice-xlsx" ? "shipment-invoice.xlsx" : "invoice.pdf");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function getOperatorDraftRateCardContext(operatorSlug: string, shipmentDraftId: string) {
  return requestOperatorJson<{
    success: true;
    title: string;
    rateCardAssigned: boolean;
    rates: ClientCountryRateCard[];
    routeCharges: ClientCountryRouteCharge[];
  }>(operatorSlug, `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/rate-card-context`);
}

export function autocompleteOperatorAddress(operatorSlug: string, input: string) {
  return requestOperatorJson<{ success: true; predictions: AddressPrediction[] }>(
    operatorSlug,
    "dpd-labels/addresses/autocomplete",
    jsonBody({ input })
  );
}

export function autocompleteOperatorConsignorAddress(operatorSlug: string, input: string) {
  return requestOperatorJson<{ success: true; predictions: AddressPrediction[] }>(
    operatorSlug,
    "dpd-labels/addresses/consignor/autocomplete",
    jsonBody({ input })
  );
}

export function getOperatorPlaceAddress(operatorSlug: string, placeId: string, shipmentDraftId?: string) {
  const query = shipmentDraftId ? `?shipmentDraftId=${encodeURIComponent(shipmentDraftId)}` : "";
  return requestOperatorJson<{
    success: true;
    place: { placeId: string; formattedAddress: string; address: PortalAddress };
  }>(operatorSlug, `dpd-labels/addresses/places/${encodeURIComponent(placeId)}${query}`);
}

export function getOperatorConsignorPlaceAddress(operatorSlug: string, placeId: string, shipmentDraftId: string) {
  return requestOperatorJson<{
    success: true;
    place: { placeId: string; formattedAddress: string; address: PortalAddress };
  }>(
    operatorSlug,
    `dpd-labels/addresses/consignor/places/${encodeURIComponent(placeId)}?shipmentDraftId=${encodeURIComponent(shipmentDraftId)}`
  );
}

export function validateOperatorAddress(operatorSlug: string, input: {
  shipmentDraftId: string;
  address: {
    addressLine1: string;
    addressLine2?: string;
    townOrCity: string;
    county?: string;
    postcode: string;
    countryCode: string;
    countryName?: string;
  };
}) {
  return requestOperatorJson<{ success: true; validation: AddressValidationResult }>(
    operatorSlug,
    "dpd-labels/addresses/validate",
    jsonBody(input)
  );
}

export function confirmOperatorAddress(operatorSlug: string, input: {
  shipmentDraftId: string;
  decision: "USE_SUGGESTED" | "KEEP_ENTERED";
}) {
  return requestOperatorJson<{ success: true; shipmentDraft: ShipmentDraft }>(
    operatorSlug,
    "dpd-labels/addresses/confirm",
    jsonBody(input)
  );
}

async function requestOperatorKycJson<T>(operatorSlug: string, shipmentDraftId: string, suffix: string, init?: RequestInit) {
  return requestOperatorJson<T>(operatorSlug, `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/${suffix}`, init);
}

export async function uploadOperatorShipmentKycDocument(input: {
  operatorSlug: string;
  shipmentDraftId: string;
  type: ShipmentKycDocumentType;
  file: File;
  documentLabel?: string;
}) {
  const formData = new FormData();
  formData.append("document", input.file);
  if (input.documentLabel) formData.append("documentLabel", input.documentLabel);
  return requestOperatorKycJson<{
    success: true;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(input.operatorSlug, input.shipmentDraftId, `kyc-documents/${input.type}`, { method: "POST", body: formData });
}

export function deleteOperatorShipmentKycDocument(operatorSlug: string, shipmentDraftId: string, type: ShipmentKycDocumentType) {
  return requestOperatorKycJson<{ success: true; kycDocuments: ShipmentKycDocuments; validationIssues: string[] }>(
    operatorSlug,
    shipmentDraftId,
    `kyc-documents/${type}`,
    { method: "DELETE" }
  );
}

async function openOperatorKycDocument(operatorSlug: string, shipmentDraftId: string, suffix: string) {
  const response = await fetchWithAuth(operatorPath(operatorSlug, `dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/${suffix}`));
  if (!response.ok) throw new Error("Unable to open this KYC document.");
  return response.blob();
}

export function openOperatorShipmentKycDocument(operatorSlug: string, shipmentDraftId: string, type: ShipmentKycDocumentType) {
  return openOperatorKycDocument(operatorSlug, shipmentDraftId, `kyc-documents/${type}`);
}

export async function uploadOperatorShipmentParcelKycDocument(input: {
  operatorSlug: string;
  shipmentDraftId: string;
  sequence: number;
  type: ShipmentKycDocumentType;
  file: File;
  documentLabel?: string;
}) {
  const formData = new FormData();
  formData.append("document", input.file);
  if (input.documentLabel) formData.append("documentLabel", input.documentLabel);
  return requestOperatorKycJson<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(
    input.operatorSlug,
    input.shipmentDraftId,
    `parcels/${input.sequence}/kyc-documents/${input.type}`,
    { method: "POST", body: formData }
  );
}

export function deleteOperatorShipmentParcelKycDocument(operatorSlug: string, shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  return requestOperatorKycJson<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(
    operatorSlug,
    shipmentDraftId,
    `parcels/${sequence}/kyc-documents/${type}`,
    { method: "DELETE" }
  );
}

export function openOperatorShipmentParcelKycDocument(operatorSlug: string, shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  return openOperatorKycDocument(operatorSlug, shipmentDraftId, `parcels/${sequence}/kyc-documents/${type}`);
}
