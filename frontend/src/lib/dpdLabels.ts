import { apiUrl } from "@/lib/api";
import { setDateRangeParams, type DateRange } from "@/lib/dateRange";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { CsbType } from "@/lib/csbType";
import { toDpdLabelUnavailableError, toPriceChangedError } from "@/lib/shipmentCostEstimate";
import type { TrackingAttention, TrackingSummary } from "@/lib/shipmentTracking";
import type { TrackingJourney } from "@/lib/shipmentJourney";

/**
 * Destinations a DPD carrier label is produced for.
 *
 * Mirrors `dpdLabelCountryCodes` in backend/src/services/als/alsPayload.service.ts,
 * which is what actually decides whether ALS is called. This copy governs only
 * what the booking panel offers, so a drift between the two shows up as a button
 * that is present or absent when it should not be - never as a wrong booking.
 *
 * The country selector stores the ISO code "GB"; "UK" is accepted alongside it
 * because imported and hand-keyed addresses use the two interchangeably.
 */
const dpdLabelCountryCodes = new Set(["GB", "UK"]);

export function isDpdLabelDestination(countryCode: string | undefined | null) {
  return dpdLabelCountryCodes.has((countryCode ?? "").trim().toUpperCase());
}

export type ShipmentAddress = {
  companyName?: string;
  contactName?: string;
  email?: string;
  mobileCountryCode?: string;
  mobileNumber?: string;
  countryCode: string;
  countryName?: string;
  postcode: string;
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  deliveryInstructions?: string;
};

export type ShipmentConsignorAddress = {
  companyName?: string;
  contactName?: string;
  email?: string;
  mobileCountryCode?: string;
  mobileNumber?: string;
  aadhaarNumber?: string;
  countryCode: string;
  countryName?: string;
  postcode: string;
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  pickupInstructions?: string;
};

export const shipmentKycDocumentTypes = [
  "aadhaar",
  "pan",
  "iec",
  "gst",
  "salePurchaseAdCode",
  "lut",
  "declarationOfGoods",
  "otherCertificates",
  "hsnCode",
  // Legacy upload type, kept readable for existing shipments.
  "other"
] as const;
export type ShipmentKycDocumentType = (typeof shipmentKycDocumentTypes)[number];

export const shipmentKycDocumentLabels: Record<ShipmentKycDocumentType, string> = {
  aadhaar: "Aadhaar Card",
  pan: "PAN Card",
  iec: "IEC",
  gst: "GST",
  salePurchaseAdCode: "Sale / Purchase / AD Code",
  lut: "LUT",
  declarationOfGoods: "Declaration of Goods",
  otherCertificates: "Other Certificates",
  hsnCode: "HSN Code",
  other: "Other Document"
};

export const csbIvKycDocumentTypes = ["pan", "aadhaar"] as const;
export const csbVKycDocumentTypes = [
  "iec",
  "gst",
  "pan",
  "aadhaar",
  "salePurchaseAdCode",
  "lut",
  "declarationOfGoods",
  "otherCertificates",
  "hsnCode"
] as const;

/**
 * The upload slots a route offers.
 *
 * Separate from what it *requires*: CSB-IV still offers PAN and Aadhaar so they
 * can be kept on file, they are simply never mandatory.
 */
export function shipmentKycDocumentSlots(csbType: CsbType): readonly ShipmentKycDocumentType[] {
  return csbType === "CSB_V" ? csbVKycDocumentTypes : csbIvKycDocumentTypes;
}

/** The subset that must be present before booking. CSB-IV mandates none. */
export function requiredShipmentKycDocumentTypes(csbType: CsbType): readonly ShipmentKycDocumentType[] {
  return csbType === "CSB_V" ? csbVKycDocumentTypes : [];
}

export type ShipmentKycDocument = {
  type: ShipmentKycDocumentType;
  documentLabel: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
};

export type ShipmentKycDocuments = Partial<Record<ShipmentKycDocumentType, ShipmentKycDocument | null>>;

export const shipmentContentTypeOptions = [
  { value: "DOCUMENTS", label: "Documents" },
  { value: "PARCEL", label: "Parcel" },
  { value: "MERCHANDISE", label: "Merchandise" },
  { value: "SAMPLES", label: "Samples" },
  { value: "GIFTS", label: "Gifts" },
  { value: "RETURNS", label: "Returns" },
  { value: "OTHER", label: "Other" }
] as const;

export type ShipmentContentType = (typeof shipmentContentTypeOptions)[number]["value"];
export type ShipmentServiceType = "COURIER" | "CARGO";

export type ShipmentDraft = {
  _id: string;
  creationSource: "MANUAL" | "INDIVIDUAL" | "SHIPMENT_IMPORT";
  shipmentImportEntryId?: string;
  rebookedFromDraftId?: string | null;
  rebookIdempotencyKey?: string | null;
  businessAccountId: string;
  /**
   * INDIVIDUAL is a walk-in booked at the counter: paid in full up front, billed
   * to the person rather than a company. Absent on drafts created before the
   * field existed, which are all business shipments.
   */
  customerType?: "BUSINESS" | "INDIVIDUAL";
  branchId: string;
  consignorAddress?: ShipmentConsignorAddress;
  consignorPlaceId?: string;
  kycUseForAllParcels?: boolean;
  kycDocuments?: ShipmentKycDocuments;
  consigneeEnteredAddress: ShipmentAddress;
  consigneeSelectedAddress?: ShipmentAddress | null;
  consigneeValidatedAddress?: ShipmentAddress | null;
  addressValidationResult?: AddressValidationResult;
  addressValidationStatus: string;
  parcelCount?: number;
  parcelList: Array<{
    sequence: number;
    weightKg: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    shipmentContentType: ShipmentContentType;
    // Per-item goods with HS codes and customs-invoice values. Absent on parcels
    // stored before items existed, which fall back to contentsDescription.
    // Numeric over the wire; the forms hold these as strings while editing.
    items?: Array<{
      description: string;
      hsnCode: string;
      unitType?: string;
      quantity?: number;
      unitRate?: number;
    }>;
    declaredGoodsValueMinor?: number | null;
    contentsDescription: string;
    shipmentReference1?: string;
    shipmentReference2?: string;
    aadhaarNumber?: string;
    kycDocuments?: ShipmentKycDocuments;
  }>;
  // Customs route. Absent on drafts created before CSB selection existed.
  csbType?: CsbType;
  // Optional transit cover. Absent on drafts created before insurance existed,
  // which price as uninsured.
  insuranceOptIn?: boolean;
  forceGst?: boolean;
  // Printed as the NOTE block on the customs (shipment) invoice.
  declarationNote?: string;
  serviceType?: ShipmentServiceType;
  serviceCode: string;
  validationIssues: string[];
  status: string;
  bookingState?: "EDITABLE" | "BOOKING" | "BOOKED" | "REVIEW_REQUIRED";
  bookingAttemptId?: string;
  lockedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

/** Workbook provenance and non-blocking warnings for an imported draft. */
export type ShipmentImportSummary = {
  originalFilename: string;
  warnings: string[];
};

export type ShipmentDraftPatch = {
  consignorAddress?: Partial<ShipmentConsignorAddress>;
  consigneeEnteredAddress?: Partial<ShipmentAddress>;
  kycUseForAllParcels?: boolean;
  parcelList?: Array<{
    sequence: number;
    weightKg: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    shipmentContentType: ShipmentContentType;
    items?: Array<{ description: string; hsnCode: string; unitType?: string; quantity?: number; unitRate?: number }>;
    contentsDescription: string;
    shipmentReference1?: string;
    shipmentReference2?: string;
    aadhaarNumber?: string;
  }>;
  csbType?: CsbType;
  insuranceOptIn?: boolean;
  forceGst?: boolean;
  declarationNote?: string;
  serviceType?: ShipmentServiceType;
  serviceCode?: string;
};

export type ShipmentAmendmentInput = {
  reason?: string;
  changes: {
    serviceType?: ShipmentServiceType;
    consigneeEnteredAddress?: Partial<ShipmentAddress>;
    parcelList?: Array<Omit<ShipmentDraft["parcelList"][number], "lengthCm" | "widthCm" | "heightCm"> & {
      lengthCm?: number | null;
      widthCm?: number | null;
      heightCm?: number | null;
    }>;
  };
};

export type ShipmentAmendmentChange = {
  fieldName: string;
  originalValue: unknown;
  newValue: unknown;
};

export type ShipmentAmendmentPricingEstimate = {
  parcels: Array<{
    sequence: number;
    actualWeightKg: number;
    volumetricWeightKg: number;
    chargeableWeightKg: number;
    rateCardId: string | null;
    rateFromKg: number | null;
    rateToKg: number | null;
    chargesPerKg: number | null;
    maxBoxKg: number | null;
    baseAmount: number;
    exceedsMaxBoxKg: boolean;
  }>;
  baseAmount: number;
  gstAmount: number;
  totalAmount: number;
  missingRate: boolean;
  exceedsMaxBoxKg: boolean;
  gstRate: number;
};

export type ShipmentAmendmentBillingAdjustment = {
  previousAmountMinor: number;
  amendedAmountMinor: number;
  deltaAmountMinor: number;
  advanceUsedMinor: number;
  creditUsedMinor: number;
  creditReducedMinor: number;
  advanceRefundedMinor: number;
  // Part of a reduction returned as fresh Customer Advance because the customer
  // had already paid it and there is nothing left on the statement to unwind.
  advanceCreditedMinor: number;
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  settledAmountMinor: number;
};

export type ShipmentAmendmentFundingPreview = {
  billingMode: "BUSINESS_ACCOUNT" | "DIRECT" | "TEST";
  previousAmountMinor: number;
  amendedAmountMinor: number;
  deltaAmountMinor: number;
  availableBookingCapacityMinor: number;
  canFund: boolean;
  message: string;
  adjustment: ShipmentAmendmentBillingAdjustment | null;
};

export type ShipmentAmendmentPreview = {
  pricingImpact: {
    current: ShipmentAmendmentPricingEstimate;
    requested: ShipmentAmendmentPricingEstimate;
    deltaAmount: number;
  };
  fundingPreview: ShipmentAmendmentFundingPreview;
};

export type VerifiedShipmentParcelInput = {
  sequence: number;
  actualWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type ShipmentChargeVerification = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  previousParcelList: Array<Record<string, unknown>>;
  verifiedParcelList: Array<Record<string, unknown>>;
  previousPricingSnapshot: ShipmentAmendmentPricingEstimate;
  verifiedPricingSnapshot: ShipmentAmendmentPricingEstimate;
  previousAmountMinor: number;
  verifiedAmountMinor: number;
  deltaAmountMinor: number;
  billingMode: "BUSINESS_ACCOUNT" | "DIRECT" | "TEST";
  billingAdjustment: ShipmentAmendmentBillingAdjustment;
  invoiceNumber: string;
  invoiceRevision: number;
  note: string;
  verifiedBy: string;
  verifiedAt: string;
};

export type ShipmentChargeVerificationState = {
  status: "PENDING" | "FINALIZED";
  eligible: boolean;
  message: string;
  verification: ShipmentChargeVerification | null;
};

export type ShipmentChargeVerificationPreview = {
  currentPricing: ShipmentAmendmentPricingEstimate;
  verifiedPricing: ShipmentAmendmentPricingEstimate;
  fundingPreview: ShipmentAmendmentFundingPreview;
  expectedTotalAmountMinor: number;
  exceedsMaxBoxKg: boolean;
};

export type ShipmentAmendment = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  shipmentId: string;
  consignee: string;
  branch: {
    id: string;
    name: string;
    code: string;
    city: string;
  } | null;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "APPLIED";
  actorRole: "admin" | "client";
  reason: string;
  reviewNote: string;
  requestedChanges: Record<string, unknown>;
  changePreview: ShipmentAmendmentChange[];
  pricingImpact: {
    current: ShipmentAmendmentPricingEstimate;
    requested: ShipmentAmendmentPricingEstimate;
    deltaAmount: number;
  } | null;
  fundingPreview: ShipmentAmendmentFundingPreview | null;
  billingAdjustment: ShipmentAmendmentBillingAdjustment | null;
  appliedChanges: ShipmentAmendmentChange[];
  requestedAt: string;
  reviewedAt?: string | null;
  appliedAt?: string | null;
};

export type AddressPrediction = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
};

export type PortalAddress = {
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  postcode: string;
  countryCode: string;
  countryName: string;
};

export type AddressValidationResult = {
  outcome: "VALID" | "CORRECTION_SUGGESTED" | "INCOMPLETE" | "UNAVAILABLE";
  enteredAddress: {
    addressLine1: string;
    addressLine2?: string;
    townOrCity: string;
    county?: string;
    postcode: string;
    countryCode: string;
  };
  suggestedAddress?: PortalAddress;
  missingComponents: string[];
  unconfirmedComponents: string[];
  formattedAddress?: string;
};

export type DpdShipmentHistoryItem = {
  dpdShipment: {
    id: string;
    shipmentDraftId: string;
    idempotencyKey: string;
    dpdShipmentId: string;
    dpdTransactionId: string;
    forwardingNumber?: string;
    entryNumber?: string;
    swiftlineTrackingNumber: string;
    parcelNumbers: string[];
    serviceCode: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
  };
  shipmentDraft: {
    id: string;
    branchId: string;
    consigneeName: string;
    consigneeTownOrCity: string;
    deliveryPostcode: string;
    status: string;
    addressValidationStatus: string;
  } | null;
  branch: {
    id: string;
    name: string;
    code: string;
    city: string;
  } | null;
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
  bookingConfirmation: ShipmentBookingConfirmation | null;
  shipmentInvoice: {
    invoiceNumber: string;
    currency: string;
    totalAmountMinor: number;
    chargeableAmountMinor: number;
    status: "DRAFT" | "ISSUED";
    revision: number;
  } | null;
  currentEvent: ShipmentEvent | null;
  events: ShipmentEvent[];
  /** Only populated when the caller asked for it- see `listDpdShipments`. */
  deliveryEstimate?: {
    estimatedDeliveryAt: string;
    earliestDeliveryAt: string;
    transitDaysMin: number;
    transitDaysMax: number;
    transitBasis: "BUSINESS_DAYS" | "CALENDAR_DAYS";
    state: "ON_SCHEDULE" | "POTENTIAL_DELAY" | "DELAYED" | "DELIVERED" | "ON_HOLD";
    deliveredAt: string | null;
  } | null;
  trackingSummary?: TrackingSummary | null;
  trackingAttention?: TrackingAttention | null;
  trackingJourney?: TrackingJourney | null;
  trackingPosition?: import("@/lib/shipmentTracking").TrackingPosition | null;
  parcelActivities?: import("@/lib/shipmentTracking").ParcelActivity[];
  parcelProgress?: import("@/lib/shipmentTracking").ParcelProgress | null;
  carrierTrackingReviews?: Array<{
    id: string;
    carrierAwbNumber: string;
    eventState: string;
    description: string;
    location: string;
    eventAt: string;
    processingNote: string;
    receivedAt: string;
  }>;
};

export type ShipmentBookingConfirmation = {
  swiftlineTrackingNumber: string;
  carrierShipmentId: string;
  shipmentReference: string;
  customerReference: string;
  serviceType: "COURIER" | "CARGO";
  serviceCode: string;
  parcelCount: number;
  totalActualWeightKg: number;
  baseAmountMinor: number;
  gstAmountMinor: number;
  totalAmountMinor: number;
  advanceAmountMinor: number;
  creditAmountMinor: number;
};

export type ShipmentEvent = {
  id: string;
  shipmentDraftId: string;
  dpdShipmentId?: string | null;
  status: string;
  statusLabel: string;
  holdReason?: string | null;
  note: string;
  /** Where the scan happened, as Operations recorded it. Empty when not known. */
  location: string;
  customerVisible: boolean;
  eventAt: string;
  createdBy?: string;
  source?: "MANUAL" | "PICKUP" | "MANIFEST" | "DELIVERY" | "CARRIER" | "SYSTEM";
  sourceReference?: string;
  gatewayCode?: string;
  gatewayName?: string;
  partnerName?: string;
  partnerCode?: string;
};

export const shipmentHoldReasonOptions = [
  { value: "missing_documents", label: "Missing documents" },
  { value: "customs_query", label: "Customs query" },
  { value: "payment_issue", label: "Payment issue" },
  { value: "customer_request", label: "Customer request" },
  { value: "address_issue", label: "Address issue" },
  { value: "restricted_item_check", label: "Restricted item check" },
  { value: "operational_delay", label: "Operational delay" },
  { value: "missed_connection", label: "Missed connection" },
  { value: "offloaded", label: "Offloaded" },
  { value: "other", label: "Other" }
] as const;

export type ShipmentHoldReason = (typeof shipmentHoldReasonOptions)[number]["value"];

export const shipmentOperationalStatusOptions = [
  { value: "PARCEL_COLLECTED", label: "Shipment Collected" },
  { value: "WAREHOUSE_SCAN_IN", label: "Received at Origin Facility" },
  { value: "ORIGIN_HUB_PROCESSED", label: "Processing for Export" },
  { value: "READY_FOR_EXPORT", label: "Ready for Dispatch" },
  { value: "ORIGIN_HUB_DISPATCHED", label: "Departed from Origin Facility" },
  { value: "IN_TRANSIT", label: "In International Transit" },
  { value: "DESTINATION_ARRIVED", label: "Arrived in Destination Country" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "DELIVERED", label: "Delivered" }
] as const;

export type ShipmentOperationalStatus = (typeof shipmentOperationalStatusOptions)[number]["value"];

/**
 * The ladder steps before `target` that this shipment has not recorded yet.
 *
 * A deliberate mirror of `findMissingPrerequisites` in the backend's
 * shipmentStatusSequence.service.ts. The two packages share no library, and the
 * alternative- a round trip per option- is a poor trade for greying out a
 * dropdown. The backend stays authoritative: this copy exists to stop a doomed
 * submission being made, never to decide whether one is allowed.
 */
export function findMissingStatusPrerequisites(
  target: string,
  recorded: Iterable<string>
): ShipmentOperationalStatus[] {
  const ladder = shipmentOperationalStatusOptions.map((option) => option.value);
  const index = ladder.indexOf(target as ShipmentOperationalStatus);
  if (index < 0) return [];

  const already = new Set(recorded);
  const legacyAliases: Partial<Record<ShipmentOperationalStatus, readonly string[]>> = {
    READY_FOR_EXPORT: ["EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED"],
    IN_TRANSIT: ["FLIGHT_DEPARTED"]
  };
  return ladder.slice(0, index).filter((status) => status !== "PARCEL_COLLECTED").filter((status) => (
    !already.has(status)
    && !(legacyAliases[status] ?? []).some((alias) => already.has(alias))
  ));
}

export function hasRecordedOperationalStatus(
  target: ShipmentOperationalStatus,
  recorded: Iterable<string>
): boolean {
  const already = new Set(recorded);
  if (target === "ORIGIN_HUB_DISPATCHED" && already.has("FLIGHT_DEPARTED")) return true;
  const legacyAliases: Partial<Record<ShipmentOperationalStatus, readonly string[]>> = {
    READY_FOR_EXPORT: ["EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED"],
    IN_TRANSIT: ["FLIGHT_DEPARTED"]
  };
  return [target, ...(legacyAliases[target] ?? [])].some((status) => already.has(status));
}

/** Later milestones that make `target` a controlled correction, not a normal update. */
export function findRecordedLaterStatusMilestones(
  target: string,
  recorded: Iterable<string>
): ShipmentOperationalStatus[] {
  const ladder = shipmentOperationalStatusOptions.map((option) => option.value);
  const index = ladder.indexOf(target as ShipmentOperationalStatus);
  if (index < 0) return [];

  const already = [...recorded];
  return ladder.slice(index + 1).filter((status) => (
    hasRecordedOperationalStatus(status, already)
  ));
}

/**
 * The first status this shipment may record, so the form never opens on an
 * option it would immediately reject. Falls back to the head of the ladder for a
 * shipment whose history has not loaded yet.
 */
export function firstAllowedOperationalStatus(
  recorded: Iterable<string>
): ShipmentOperationalStatus {
  const already = [...recorded];
  return shipmentOperationalStatusOptions
    .map((option) => option.value)
    .find((status) => !hasRecordedOperationalStatus(status, already)
      && findMissingStatusPrerequisites(status, already).length === 0
      && findRecordedLaterStatusMilestones(status, already).length === 0)
    ?? "PARCEL_COLLECTED";
}

export type DpdShipmentAuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  performedBy: string;
  performedAt: string;
  metadata: Record<string, unknown>;
};

function buildAuthHeaders(headers: HeadersInit | undefined, token: string | null) {
  const nextHeaders = new Headers(headers);

  if (token) {
    nextHeaders.set("Authorization", `Bearer ${token}`);
  }

  return nextHeaders;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const response = await fetch(input, {
    ...init,
    headers: buildAuthHeaders(init.headers, token)
  });

  if (response.status !== 401) return response;

  const refreshedToken = await refreshAccessToken();
  if (!refreshedToken) return response;

  return fetch(input, {
    ...init,
    headers: buildAuthHeaders(init.headers, refreshedToken)
  });
}

function findFirstApiError(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const errors = (value as { _errors?: unknown })._errors;
  if (Array.isArray(errors) && typeof errors[0] === "string") return errors[0];

  for (const nested of Object.values(value)) {
    const message = findFirstApiError(nested);
    if (message) return message;
  }

  return "";
}

export function formatShipmentValidationIssues(value: unknown) {
  if (!Array.isArray(value)) return "";
  const issues = [...new Set(value.filter((issue): issue is string => (
    typeof issue === "string" && Boolean(issue.trim())
  )).map((issue) => issue.trim()))];
  const priority = (issue: string) => {
    if (issue.toLowerCase() === "address has not been validated") return 0;
    if (issue.toLowerCase() === "enter a valid uk postcode") return 1;
    return 2;
  };
  return issues.sort((left, right) => priority(left) - priority(right)).join(", ");
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const validationError = formatShipmentValidationIssues(data.validationIssues);
    const formattedError = findFirstApiError(data.errors);
    const listError = Array.isArray(data.errors) && typeof data.errors[0] === "string" ? data.errors[0] : "";
    throw new Error(validationError || formattedError || listError || data.message || "DPD label request failed");
  }

  return data as T;
}

export async function createManualShipmentDraft(input: {
  businessAccountId: string;
  branchId: string;
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-drafts/manual"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

/**
 * Identity of a walk-in customer. Only the name is taken at the counter- every
 * other field is filled in on the draft form and enforced before booking.
 */
export type IndividualCustomerDetails = {
  contactName: string;
  mobileCountryCode?: string;
  mobileNumber?: string;
  email?: string;
  aadhaarNumber?: string;
  addressLine1?: string;
  addressLine2?: string;
  townOrCity?: string;
  county?: string;
  postcode?: string;
  pickupInstructions?: string;
};

/**
 * Opens a draft for a customer with no business account. There is no account to
 * select, so the payer's details are sent instead and stored on the draft.
 */
export async function createIndividualShipmentDraft(input: {
  branchId: string;
  customer: IndividualCustomerDetails;
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/shipment-drafts/individual"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function getShipmentDraft(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}`));

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
    shipmentImport?: ShipmentImportSummary | null;
  }>(response);
}

export async function validateShipmentDraft(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/validate`), {
    method: "POST"
  });

  return parseApiResponse<{
    success: true;
    readyForDpd: boolean;
    validationIssues: string[];
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function updateShipmentDraft(shipmentDraftId: string, patch: ShipmentDraftPatch) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function createShipmentAmendment(shipmentDraftId: string, input: ShipmentAmendmentInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/amendments`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    amendment: ShipmentAmendment;
  }>(response);
}

export async function previewShipmentAmendment(shipmentDraftId: string, input: ShipmentAmendmentInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/amendments/preview`), {
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

export async function listShipmentAmendments(input: { status?: string; dateRange?: DateRange; page?: number } = {}) {
  const url = new URL(apiUrl("/api/v1/shipment-amendments"));
  if (input.status) url.searchParams.set("status", input.status);
  setDateRangeParams(url.searchParams, input.dateRange);
  url.searchParams.set("page", String(input.page ?? 1));
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    amendments: ShipmentAmendment[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(response);
}

export async function approveShipmentAmendment(
  amendmentId: string,
  note = "",
  // Required when a walk-in's amendment changes the price: the difference is
  // collected or refunded at the counter, outside the portal.
  counterPayment?: CounterPaymentInput
) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-amendments/${amendmentId}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, ...(counterPayment ? { counterPayment } : {}) })
  });

  return parseApiResponse<{
    success: true;
    amendment: ShipmentAmendment;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function rejectShipmentAmendment(amendmentId: string, note = "") {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-amendments/${amendmentId}/reject`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note })
  });

  return parseApiResponse<{
    success: true;
    amendment: ShipmentAmendment;
  }>(response);
}

/** How a walk-in paid. Required when booking an individual shipment. */
export type CounterPaymentInput = {
  method: "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
  reference?: string;
  note?: string;
};

export async function createShipment(
  shipmentDraftId: string,
  counterPayment?: CounterPaymentInput,
  acceptedPricingHash?: string,
  skipDpdLabel?: boolean
) {
  const body = { ...(counterPayment ?? {}), ...(acceptedPricingHash ? { acceptedPricingHash } : {}), ...(skipDpdLabel ? { skipDpdLabel } : {}) };
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/create-shipment`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
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
      dpdShipmentId: string;
      dpdTransactionId: string;
      forwardingNumber?: string;
      entryNumber?: string;
      swiftlineTrackingNumber: string;
      parcelNumbers: string[];
      serviceCode: string;
      status: string;
      createdAt?: string;
    };
    labels: Array<{
      id: string;
      parcelNumber: string;
      labelType: "SWIFTLINE" | "DPD";
      format: string;
      labelSize: string;
      generatedAt: string;
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

export async function reconcileDpdShipmentDocuments(dpdShipmentId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/reconcile-documents`), {
    method: "POST"
  });

  return parseApiResponse<{
    success: true;
    message: string;
  }>(response);
}

export async function refreshCarrierTracking(dpdShipmentId: string) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/refresh-carrier-tracking`),
    { method: "POST" },
  );
  return parseApiResponse<{
    success: true;
    message: string;
    result: { applied: number; reviewRequired: number; state: string };
  }>(response);
}

/** Load the complete admin detail by the draft id used in the shipments table. */
export async function getAdminShipmentDetails(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/drafts/${shipmentDraftId}/details`));

  return parseApiResponse<{
    success: true;
    shipment: DpdShipmentHistoryItem;
  }>(response);
}

/** Generate the DPD carrier document for an already-booked Swiftline shipment. */
export async function generateExistingDpdLabel(dpdShipmentId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/generate-label`), {
    method: "POST"
  });

  return parseApiResponse<{
    success: true;
    reused: boolean;
    message: string;
    dpdShipment: DpdShipmentHistoryItem["dpdShipment"];
    labels: DpdShipmentHistoryItem["labels"];
  }>(response);
}

export function createRebookIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `rebook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function rebookShipmentDraft(
  shipmentDraftId: string,
  idempotencyKey = createRebookIdempotencyKey()
) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/rebook`), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey }
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}

export async function downloadDpdLabel(dpdShipmentId: string, labelId: string) {
  const access = await getDpdLabelAccessUrl(dpdShipmentId, labelId, "attachment");
  const response = await fetch(access.url);

  if (!response.ok) throw new Error("Unable to download DPD label.");

  return response.blob();
}

export async function getDpdLabelAccessUrl(
  dpdShipmentId: string,
  labelId: string,
  disposition: "inline" | "attachment" = "inline"
) {
  const url = new URL(apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/label-access`));
  url.searchParams.set("labelId", labelId);
  url.searchParams.set("disposition", disposition);
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    url: string;
    expiresAt: string;
    label: {
      id: string;
      parcelNumber: string;
      labelType: "SWIFTLINE" | "DPD";
      format: string;
      labelSize: string;
      generatedAt: string;
    };
  }>(response);
}

/**
 * `withEstimate` costs a route and holiday lookup per shipment, so it is opt-in:
 * tracking searches one number and wants it, the dashboard feeds pull many rows
 * and never read it.
 */
export async function listDpdShipments(
  limit = 25,
  trackingNumber = "",
  withEstimate = false,
  withJourney = false,
  summaryOnly = false
) {
  const url = new URL(apiUrl("/api/v1/dpd-shipments"));
  url.searchParams.set("limit", String(limit));
  if (withEstimate) url.searchParams.set("withEstimate", "1");
  if (withJourney) url.searchParams.set("withJourney", "1");
  if (summaryOnly) url.searchParams.set("summary", "1");
  if (trackingNumber.trim()) url.searchParams.set("trackingNumber", trackingNumber.trim());
  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    shipments: DpdShipmentHistoryItem[];
  }>(response);
}

export async function holdDpdShipment(input: {
  dpdShipmentId: string;
  reason: ShipmentHoldReason;
  note: string;
  location?: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${input.dpdShipmentId}/hold`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: input.reason, note: input.note, location: input.location ?? "" })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    event: ShipmentEvent;
  }>(response);
}

export async function releaseDpdShipment(input: {
  dpdShipmentId: string;
  note: string;
  location?: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${input.dpdShipmentId}/release`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: input.note, location: input.location ?? "" })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    event: ShipmentEvent;
  }>(response);
}

export async function updateDpdShipmentOperationalStatus(input: {
  dpdShipmentId: string;
  status: ShipmentOperationalStatus;
  note?: string;
  location?: string;
  /** Actual destination gateway. Supplied only for DESTINATION_ARRIVED. */
  gatewayCode?: string;
  /**
   * When the scan actually happened, as an ISO string. Omitted, the server
   * stamps the event with the moment it is recorded- which is what a status
   * keyed in late or early would otherwise put on the customer's timeline.
   */
  eventAt?: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${input.dpdShipmentId}/status-events`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: input.status,
      note: input.note,
      location: input.location ?? "",
      ...(input.gatewayCode ? { gatewayCode: input.gatewayCode } : {}),
      ...(input.eventAt ? { eventAt: input.eventAt } : {})
    })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    event: ShipmentEvent;
  }>(response);
}

export async function correctDpdShipmentGateway(input: {
  dpdShipmentId: string;
  gatewayCode: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${input.dpdShipmentId}/gateway`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gatewayCode: input.gatewayCode })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    event: ShipmentEvent;
  }>(response);
}

export type BulkShipmentStatusSkip = {
  shipmentDraftId: string;
  swiftlineTrackingNumber?: string;
  reason: string;
  missingStatuses?: ShipmentOperationalStatus[];
};

export type BulkShipmentStatusResult = {
  success: true;
  message: string;
  updatedCount: number;
  skipped: BulkShipmentStatusSkip[];
  /**
   * Compact server-confirmed row changes. Optional during a rolling deploy so
   * a new frontend can still fall back to refreshing against an older API.
   */
  updated?: Array<{
    shipmentDraftId: string;
    status: ShipmentOperationalStatus;
    statusLabel: string;
    lastScan: {
      statusLabel: string;
      location: string;
      at: string;
    };
  }>;
};

/**
 * Records one operational status across many shipments at once. The server holds
 * every shipment to the same sequential rule as the single update, so shipments
 * that cannot take the status yet are skipped and reported rather than blocking
 * the eligible ones- the same-day, same-flight batch moves together.
 */
export async function bulkUpdateDpdShipmentOperationalStatus(input: {
  shipmentDraftIds: string[];
  /** Statuses shown when the rows were selected, for stale-selection detection. */
  expectedStatuses?: Array<{ shipmentDraftId: string; status: string }>;
  status: ShipmentOperationalStatus;
  note?: string;
  location?: string;
  /** One actual gateway shared by this destination-arrival batch. */
  gatewayCode?: string;
  /** One scan time across the batch, as an ISO string. See the single update above. */
  eventAt?: string;
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/dpd-shipments/bulk-status"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shipmentDraftIds: input.shipmentDraftIds,
      expectedStatuses: input.expectedStatuses ?? [],
      status: input.status,
      note: input.note ?? "",
      location: input.location ?? "",
      ...(input.gatewayCode ? { gatewayCode: input.gatewayCode } : {}),
      ...(input.eventAt ? { eventAt: input.eventAt } : {})
    })
  });

  return parseApiResponse<BulkShipmentStatusResult>(response);
}

export async function getShipmentChargeVerification(dpdShipmentId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/charge-verification`));

  return parseApiResponse<{ success: true } & ShipmentChargeVerificationState>(response);
}

export async function previewFinalShipmentCharge(
  dpdShipmentId: string,
  parcels: VerifiedShipmentParcelInput[]
) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${dpdShipmentId}/charge-verification/preview`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parcels })
  });

  return parseApiResponse<{
    success: true;
    preview: ShipmentChargeVerificationPreview;
  }>(response);
}

export async function finalizeFinalShipmentCharge(input: {
  dpdShipmentId: string;
  parcels: VerifiedShipmentParcelInput[];
  expectedTotalAmountMinor: number;
  note?: string;
}) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/${input.dpdShipmentId}/charge-verification/finalize`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parcels: input.parcels,
      expectedTotalAmountMinor: input.expectedTotalAmountMinor,
      note: input.note ?? ""
    })
  });

  return parseApiResponse<{
    success: true;
    message: string;
    verification: ShipmentChargeVerification;
  }>(response);
}

export async function listDpdShipmentAudit(shipmentDraftId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/dpd-shipments/drafts/${shipmentDraftId}/audit`));

  return parseApiResponse<{
    success: true;
    auditLogs: DpdShipmentAuditLog[];
  }>(response);
}

export async function autocompleteAddress(input: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/addresses/autocomplete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  });

  return parseApiResponse<{
    success: true;
    predictions: AddressPrediction[];
  }>(response);
}

export async function getPlaceAddress(placeId: string, shipmentDraftId: string) {
  const url = new URL(apiUrl(`/api/v1/addresses/places/${encodeURIComponent(placeId)}`));
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

// Consignor pickup addresses are Indian, so they search Google Places while the
// consignee delivery address stays on the Ideal Postcodes UK lookup above.
export async function autocompleteConsignorAddress(input: string) {
  const response = await fetchWithAuth(apiUrl("/api/v1/addresses/consignor/autocomplete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  });

  return parseApiResponse<{
    success: true;
    predictions: AddressPrediction[];
  }>(response);
}

export async function getConsignorPlaceAddress(placeId: string, shipmentDraftId: string) {
  const url = new URL(apiUrl(`/api/v1/addresses/consignor/places/${encodeURIComponent(placeId)}`));
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

export async function uploadShipmentKycDocument(input: {
  shipmentDraftId: string;
  type: ShipmentKycDocumentType;
  file: File;
  documentLabel?: string;
}) {
  const formData = new FormData();
  formData.append("document", input.file);
  if (input.documentLabel) formData.append("documentLabel", input.documentLabel);

  const response = await fetchWithAuth(
    apiUrl(`/api/v1/shipment-drafts/${input.shipmentDraftId}/kyc-documents/${input.type}`),
    { method: "POST", body: formData }
  );

  return parseApiResponse<{
    success: true;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function deleteShipmentKycDocument(shipmentDraftId: string, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/kyc-documents/${type}`),
    { method: "DELETE" }
  );

  return parseApiResponse<{
    success: true;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function openShipmentKycDocument(shipmentDraftId: string, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/kyc-documents/${type}`)
  );

  if (!response.ok) throw new Error("Unable to open this KYC document.");

  return response.blob();
}

export async function uploadShipmentParcelKycDocument(input: {
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
    apiUrl(`/api/v1/shipment-drafts/${input.shipmentDraftId}/parcels/${input.sequence}/kyc-documents/${input.type}`),
    { method: "POST", body: formData }
  );

  return parseApiResponse<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function deleteShipmentParcelKycDocument(shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/parcels/${sequence}/kyc-documents/${type}`),
    { method: "DELETE" }
  );

  return parseApiResponse<{
    success: true;
    parcelSequence: number;
    kycDocuments: ShipmentKycDocuments;
    validationIssues: string[];
  }>(response);
}

export async function openShipmentParcelKycDocument(shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) {
  const response = await fetchWithAuth(
    apiUrl(`/api/v1/shipment-drafts/${shipmentDraftId}/parcels/${sequence}/kyc-documents/${type}`)
  );

  if (!response.ok) throw new Error("Unable to open this KYC document.");

  return response.blob();
}

export async function validateAddress(input: {
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
  const response = await fetchWithAuth(apiUrl("/api/v1/addresses/validate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    validation: AddressValidationResult;
  }>(response);
}

export async function confirmAddress(input: {
  shipmentDraftId: string;
  decision: "USE_SUGGESTED" | "KEEP_ENTERED";
}) {
  const response = await fetchWithAuth(apiUrl("/api/v1/addresses/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    shipmentDraft: ShipmentDraft;
  }>(response);
}
