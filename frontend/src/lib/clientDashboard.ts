import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { toDpdLabelUnavailableError, toPriceChangedError } from "@/lib/shipmentCostEstimate";
import type { TrackingAttention, TrackingSummary } from "@/lib/shipmentTracking";
import {
  AddressPrediction,
  AddressValidationResult,
  PortalAddress,
  ShipmentAmendment,
  ShipmentAmendmentFundingPreview,
  ShipmentAmendmentInput,
  ShipmentAmendmentPreview,
  ShipmentBookingConfirmation,
  ShipmentDraft,
  ShipmentDraftPatch,
  ShipmentKycDocumentType,
  ShipmentKycDocuments,
  formatShipmentValidationIssues,
  type ShipmentImportSummary
} from "@/lib/dpdLabels";

export type ClientDashboardAccount = {
  membership: {
    role: string;
    status: string;
    joinedAt?: string | null;
  };
  account: {
    id: string;
    accountId: string;
    status: string;
    statusLabel: string;
    kycStatus: string;
    kycStatusLabel: string;
    submittedAt?: string | null;
    createdAt?: string | null;
    contact: {
      firstName?: string;
      lastName?: string;
      email?: string;
      countryCode?: string;
      mobileNumber?: string;
      jobTitle?: string;
      department?: string;
    };
    company: {
      companyName?: string;
      companyType?: string;
      industry?: string;
      registrationCountry?: string;
      registrationIdType?: string;
      registrationId?: string;
      registeredAddress?: string;
      city?: string;
      stateOrProvince?: string;
      postalCode?: string;
      addressCountry?: string;
      requestedCreditLimit?: {
        currency?: string;
        amount?: number | null;
      };
    };
    assignedBranch?: {
      _id: string;
      name: string;
      code: string;
      status: string;
    } | null;
    rateCard: {
      title: "Your Swiftline Rate Card";
      assigned: boolean;
    };
  };
  dashboardAccess: {
    state: "READY" | "BLOCKED";
    blockers: string[];
  };
  bookingAccess: {
    state: "READY" | "PAUSED";
    code: "RATE_CARD_REQUIRED" | null;
    message: string | null;
  };
  assignedBranches: Array<{
    _id: string;
    name: string;
    code: string;
    status: string;
  }>;
  shipments: {
    summary: ClientShipmentSummary;
    branchSummaries: ClientShipmentSummary[];
    recentShipments: ClientRecentShipment[];
  };
};

export type ClientShipmentSummary = {
  branchId: string;
  totalShipments: number;
  readyForLabel: number;
  labelsCreated: number;
  validationFailed: number;
  needsReview: number;
  addressValidated: number;
  lastActivityAt?: string | null;
};

export type ClientRecentShipment = {
  id: string;
  branchId: string;
  invoiceNumber: string;
  shipmentReference: string;
  swiftlineTrackingNumber: string;
  destination: {
    companyName: string;
    contactName: string;
    countryName: string;
    countryCode: string;
    townOrCity: string;
    postcode: string;
  };
  parcelCount: number;
  status: string;
  statusLabel: string;
  addressValidationStatus: string;
  dpdStatus: string;
  currentStatus: string;
  currentStatusLabel: string;
  holdReason: string;
  dpdShipmentId: string;
  parcelNumbers: string[];
  shipmentInvoice: {
    invoiceNumber: string;
    currency: string;
    totalAmountMinor: number;
    chargeableAmountMinor: number;
    status: "DRAFT" | "ISSUED";
    revision: number;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ClientShipmentListItem = {
  id: string;
  branchId: string;
  invoiceNumber: string;
  shipmentReference: string;
  swiftlineTrackingNumber: string;
  destination: {
    companyName: string;
    contactName: string;
    townOrCity: string;
    postcode: string;
    countryName: string;
    countryCode: string;
  };
  branch: {
    name: string;
    code: string;
    city: string;
  };
  status: string;
  statusLabel: string;
  dpdStatus: string;
  bookingState: "EDITABLE" | "BOOKING" | "BOOKED" | "REVIEW_REQUIRED";
  /**
   * Whether to offer Delete on this row. Decided by the server, which also
   * re-checks on the delete itself- so a true here is an invitation to try,
   * not a guarantee the delete will succeed.
   */
  canDelete: boolean;
  shipmentInvoice: {
    invoiceNumber: string;
    currency: string;
    chargeableAmountMinor: number;
    status: "DRAFT" | "ISSUED";
    revision: number;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ClientShipmentEvent = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId?: string | null;
  status: string;
  statusLabel: string;
  holdReason?: string | null;
  note: string;
  /** Where the scan happened. Empty when Operations did not record one. */
  location: string;
  customerVisible: boolean;
  eventAt: string;
};

export type ClientShipmentDetails = {
  shipmentDraft: {
    id: string;
    status: string;
    statusLabel: string;
    addressValidationStatus: string;
    serviceType: ShipmentDraft["serviceType"];
    serviceCode: string;
    kycUseForAllParcels?: boolean;
    kycDocuments?: ShipmentKycDocuments;
    // Customs route. Absent on shipments booked before CSB selection existed.
    csbType?: ShipmentDraft["csbType"];
    parcelCount: number;
    parcelList: ShipmentDraft["parcelList"];
    consignee: ShipmentDraft["consigneeEnteredAddress"];
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  dpdShipment: {
    id: string;
    shipmentDraftId: string;
    idempotencyKey: string;
    dpdShipmentId: string;
    dpdTransactionId: string;
    swiftlineTrackingNumber: string;
    parcelNumbers: string[];
    serviceCode: string;
    paymentSource: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
  } | null;
  bookingConfirmation: ShipmentBookingConfirmation | null;
  taxInvoiceNumber: string;
  labels: Array<{
    id: string;
    dpdShipmentId: string;
    parcelNumber: string;
    labelType: "SWIFTLINE" | "DPD";
    format: string;
    labelSize: string;
    fileChecksum: string;
    generatedAt: string;
    downloadCount: number;
    lastDownloadedAt?: string | null;
  }>;
  currentEvent: ClientShipmentEvent | null;
  events: ClientShipmentEvent[];
  deliveryEstimate?: {
    estimatedDeliveryAt: string;
    earliestDeliveryAt: string;
    transitDaysMin: number;
    transitDaysMax: number;
    transitBasis: "BUSINESS_DAYS" | "CALENDAR_DAYS";
    state: "ON_SCHEDULE" | "POTENTIAL_DELAY" | "DELAYED" | "DELIVERED" | "ON_HOLD";
    deliveredAt: string | null;
  } | null;
  // Optional because a backend older than the tracking panel does not send
  // them; the page falls back to what it can derive rather than assuming.
  trackingSummary?: TrackingSummary | null;
  trackingAttention?: TrackingAttention | null;
  trackingJourney?: import("@/lib/shipmentJourney").TrackingJourney | null;
  trackingPosition?: import("@/lib/shipmentTracking").TrackingPosition | null;
  parcelActivities?: import("@/lib/shipmentTracking").ParcelActivity[];
  parcelProgress?: import("@/lib/shipmentTracking").ParcelProgress | null;
};

export type ClientPrepaidAccount = {
  businessAccountId: string;
  currency: string;
  cashBalanceMinor: number;
  reservedBalanceMinor: number;
  availableBalanceMinor: number;
  status: string;
  minimumBalanceWarningMinor: number;
  // Optional because a backend older than the top-up limits does not send them.
  // The server is the authority on both, so the UI simply omits its own hint and
  // pre-check when they are absent rather than assuming a shape.
  minTopUpMinor?: number;
  maxTopUpMinor?: number;
  /** Today's allowance for this business account, resetting at IST midnight. */
  dailyTopUp?: {
    usedMinor: number;
    limitMinor: number;
    remainingMinor: number;
    resetsAt: string;
  };
};

export type ClientPrepaidTransaction = {
  _id: string;
  transactionType: string;
  direction: string;
  amountMinor: number;
  currency: string;
  cashBalanceBeforeMinor: number;
  cashBalanceAfterMinor: number;
  reservedBalanceBeforeMinor: number;
  reservedBalanceAfterMinor: number;
  description: string;
  createdAt: string;
};

export type ClientPrepaidTopUp = {
  id: string;
  businessAccountId: string;
  amountMinor: number;
  currency: string;
  purpose: "CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT";
  internalReference: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RazorpayPublicConfig = {
  keyId: string;
  currency: string;
  merchantName: string;
};

function buildAuthHeaders(token: string | null, headers: HeadersInit = {}) {
  const nextHeaders = new Headers(headers);
  if (token) nextHeaders.set("Authorization", `Bearer ${token}`);
  return nextHeaders;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const response = await fetch(input, { ...init, headers: buildAuthHeaders(token, init.headers) });

  if (response.status !== 401) return response;

  const refreshedToken = await refreshAccessToken();
  if (!refreshedToken) return response;

  return fetch(input, { ...init, headers: buildAuthHeaders(refreshedToken, init.headers) });
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const validationError = formatShipmentValidationIssues(data.validationIssues);
    const listError = Array.isArray(data.errors) && typeof data.errors[0] === "string" ? data.errors[0] : "";
    throw new Error(validationError || listError || data.message || "Client dashboard request failed.");
  }

  return data as T;
}

export async function getClientDashboard() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dashboard"));

  return parseApiResponse<{ success: true; serverTime?: string; accounts: ClientDashboardAccount[] }>(response);
}

export async function getClientShipments(input: {
  businessAccountId: string;
  branchId?: string;
  page?: number;
  limit?: number;
}) {
  const url = new URL(apiUrl("/api/v1/client/shipments"));
  url.searchParams.set("businessAccountId", input.businessAccountId);
  if (input.branchId) url.searchParams.set("branchId", input.branchId);
  url.searchParams.set("page", String(input.page ?? 1));
  url.searchParams.set("limit", String(input.limit ?? 10));
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    shipments: ClientShipmentListItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(response);
}

export async function getClientPrepaidAccount(businessAccountId?: string) {
  const url = new URL(apiUrl("/api/v1/client/prepaid-account"));
  if (businessAccountId) url.searchParams.set("businessAccountId", businessAccountId);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; prepaidAccount: ClientPrepaidAccount }>(response);
}

export async function getClientPrepaidTransactions(businessAccountId?: string) {
  const url = new URL(apiUrl("/api/v1/client/prepaid-transactions"));
  if (businessAccountId) url.searchParams.set("businessAccountId", businessAccountId);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; transactions: ClientPrepaidTransaction[] }>(response);
}

export async function getClientPrepaidTopUps(businessAccountId?: string) {
  const url = new URL(apiUrl("/api/v1/client/prepaid-topups"));
  if (businessAccountId) url.searchParams.set("businessAccountId", businessAccountId);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; topUps: ClientPrepaidTopUp[] }>(response);
}

export async function createClientPrepaidTopUp(input: {
  businessAccountId?: string;
  amountMinor: number;
  purpose?: "CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT";
  idempotencyKey: string;
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/prepaid-topups"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey
    },
    body: JSON.stringify({
      businessAccountId: input.businessAccountId,
      amountMinor: input.amountMinor,
      purpose: input.purpose
    })
  });

  return parseApiResponse<{
    success: true;
    duplicate: boolean;
    razorpay: RazorpayPublicConfig;
    topUp: ClientPrepaidTopUp;
  }>(response);
}

export async function verifyClientPrepaidTopUp(input: {
  topUpId: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/prepaid-topups/${input.topUpId}/verify`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id,
      razorpay_signature: input.razorpay_signature
    })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    topUp: ClientPrepaidTopUp;
  }>(response);
}

export async function createClientManualShipmentDraft(branchId: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dpd-labels/drafts/manual"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branchId })
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function getClientShipmentDraft(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}`));

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
    shipmentImport?: ShipmentImportSummary | null;
  }>(response);
}

export async function getClientShipmentDetails(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/shipments/${shipmentDraftId}`));

  return parseApiResponse<{
    success: true;
    shipment: ClientShipmentDetails;
  }>(response);
}

export async function trackClientShipment(trackingNumber: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/tracking/${encodeURIComponent(trackingNumber.trim())}`));
  return parseApiResponse<{ success: true; shipment: ClientShipmentDetails }>(response);
}

export async function createClientShipmentAmendment(shipmentDraftId: string, input: ShipmentAmendmentInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/shipments/${shipmentDraftId}/amendments`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    amendment: ShipmentAmendment;
  }>(response);
}

export async function previewClientShipmentAmendment(shipmentDraftId: string, input: ShipmentAmendmentInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/shipments/${shipmentDraftId}/amendments/preview`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    pricingImpact: ShipmentAmendmentPreview["pricingImpact"];
    fundingPreview: ShipmentAmendmentFundingPreview;
  }>(response);
}

export async function updateClientShipmentDraft(shipmentDraftId: string, patch: ShipmentDraftPatch) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function createClientShipment(
  shipmentDraftId: string,
  acceptedPricingHash?: string,
  skipDpdLabel?: boolean
) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}/create-shipment`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(acceptedPricingHash ? { acceptedPricingHash } : {}), ...(skipDpdLabel ? { skipDpdLabel } : {}) })
  });

  // A refusal because the price moved carries the new breakdown, so it is raised
  // as a typed error the booking page can render as a comparison rather than as
  // an opaque message.
  // Read on any refusal, not just 409: a DPD failure carries 503 when the
  // integration is misconfigured or its credentials are rejected, 400 when the
  // shipment cannot be expressed, and 409 when the carrier declines it. All
  // three mean the same thing here- nothing was booked.
  if (!response.ok) {
    const data = await response.clone().json().catch(() => ({}));
    const priceChanged = toPriceChangedError(data);
    if (priceChanged) throw priceChanged;
    const dpdUnavailable = toDpdLabelUnavailableError(data);
    if (dpdUnavailable) throw dpdUnavailable;
  }

  return parseApiResponse<{
    success: true;
    reused: boolean;
    dpdShipment: {
      id: string;
      status: string;
      paymentSource: string;
      swiftlineTrackingNumber: string;
      parcelNumbers: string[];
    };
    labels: Array<{
      id: string;
      parcelNumber: string;
      labelType: "SWIFTLINE" | "DPD";
      format: string;
      labelSize: string;
    }>;
    bookingConfirmation: ShipmentBookingConfirmation | null;
    shipmentInvoice: {
      id: string;
      invoiceNumber: string;
      currency: string;
      totalAmountMinor: number;
      revision: number;
      status: "DRAFT" | "ISSUED";
    } | null;
  }>(response);
}

export async function getClientShipmentLabelAccessUrl(
  shipmentDraftId: string,
  labelId: string,
  disposition: "inline" | "attachment" = "inline"
) {
  const url = new URL(apiUrl(`/api/v1/client/shipments/${shipmentDraftId}/labels/${labelId}/access`));
  url.searchParams.set("disposition", disposition);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    url: string;
    expiresAt: string;
  }>(response);
}

export async function autocompleteClientAddress(input: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dpd-labels/addresses/autocomplete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  });

  return parseApiResponse<{
    success: true;
    predictions: AddressPrediction[];
  }>(response);
}

export async function getClientPlaceAddress(placeId: string, shipmentDraftId?: string) {
  const url = new URL(apiUrl(`/api/v1/client/dpd-labels/addresses/places/${encodeURIComponent(placeId)}`));
  if (shipmentDraftId) url.searchParams.set("shipmentDraftId", shipmentDraftId);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    place: {
      placeId: string;
      formattedAddress: string;
      address: PortalAddress;
    };
  }>(response);
}

export async function autocompleteClientConsignorAddress(input: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dpd-labels/addresses/consignor/autocomplete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  });

  return parseApiResponse<{
    success: true;
    predictions: AddressPrediction[];
  }>(response);
}

export async function getClientConsignorPlaceAddress(placeId: string, shipmentDraftId: string) {
  const url = new URL(apiUrl(`/api/v1/client/dpd-labels/addresses/consignor/places/${encodeURIComponent(placeId)}`));
  url.searchParams.set("shipmentDraftId", shipmentDraftId);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    place: {
      placeId: string;
      formattedAddress: string;
      address: PortalAddress;
    };
  }>(response);
}

export async function uploadClientShipmentKycDocument(input: {
  shipmentDraftId: string;
  type: ShipmentKycDocumentType;
  file: File;
  documentLabel?: string;
}) {
  const formData = new FormData();
  formData.append("document", input.file);
  if (input.documentLabel) formData.append("documentLabel", input.documentLabel);

  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${input.shipmentDraftId}/kyc-documents/${input.type}`),
    { method: "POST", body: formData }
  );

  return parseApiResponse<{
    success: true;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function deleteClientShipmentKycDocument(shipmentDraftId: string, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}/kyc-documents/${type}`),
    { method: "DELETE" }
  );

  return parseApiResponse<{
    success: true;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function openClientShipmentKycDocument(shipmentDraftId: string, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}/kyc-documents/${type}`)
  );

  if (!response.ok) throw new Error("Unable to open this KYC document.");

  return response.blob();
}

export async function uploadClientShipmentParcelKycDocument(input: {
  shipmentDraftId: string;
  sequence: number;
  type: ShipmentKycDocumentType;
  file: File;
  documentLabel?: string;
}) {
  const formData = new FormData();
  formData.append("document", input.file);
  if (input.documentLabel) formData.append("documentLabel", input.documentLabel);

  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${input.shipmentDraftId}/parcels/${input.sequence}/kyc-documents/${input.type}`),
    { method: "POST", body: formData }
  );

  return parseApiResponse<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function deleteClientShipmentParcelKycDocument(shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}/parcels/${sequence}/kyc-documents/${type}`),
    { method: "DELETE" }
  );

  return parseApiResponse<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function openClientShipmentParcelKycDocument(shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/client/dpd-labels/drafts/${shipmentDraftId}/parcels/${sequence}/kyc-documents/${type}`)
  );

  if (!response.ok) throw new Error("Unable to open this KYC document.");

  return response.blob();
}

export async function validateClientAddress(input: {
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
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dpd-labels/addresses/validate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    validation: AddressValidationResult;
  }>(response);
}

export async function confirmClientAddress(input: {
  shipmentDraftId: string;
  decision: "USE_SUGGESTED" | "KEEP_ENTERED";
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/dpd-labels/addresses/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}
