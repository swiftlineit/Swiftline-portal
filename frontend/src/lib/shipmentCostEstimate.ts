import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { CsbType } from "@/lib/csbType";
import type { ShipmentServiceType } from "@/lib/dpdLabels";

/**
 * The full cost breakdown for a shipment, priced by the server.
 *
 * These types mirror `shipmentPricing.service.ts` and `shipmentCostEstimate.service.ts`.
 * The browser deliberately does no pricing arithmetic of its own: the figure a
 * customer sees has to be the figure the booking charges, and the only way to
 * guarantee that is for one implementation to produce both.
 */

export type ShipmentChargeLineKind = "CHARGE" | "TAX" | "DEDUCTION";

export type ShipmentChargeLineCode =
  | "FREIGHT"
  | "FUEL_SURCHARGE"
  | "REMOTE_AREA"
  | "CUSTOMS_CLEARANCE"
  | "HANDLING"
  | "INSURANCE"
  | "DISCOUNT"
  | "GST";

export type ShipmentChargeLine = {
  code: ShipmentChargeLineCode;
  label: string;
  kind: ShipmentChargeLineKind;
  amount: number;
  amountMinor: number;
  /** How the amount was derived, shown under the line so the customer can check it. */
  basis: string;
};

export type ShipmentEstimateParcel = {
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
  inclusiveBaseAmount?: number;
  exceedsMaxBoxKg: boolean;
};

/**
 * Why a box is over the maximum box weight, in terms the person can act on.
 *
 * The limit is checked against chargeable weight, which for a large light box is
 * its volumetric weight- a 100 x 60 x 70 cm carton is 84 kg chargeable however
 * little it weighs. Saying "box weight" there sends someone to re-weigh a 5 kg
 * parcel that was never the problem, so the message names the weight that
 * actually breached the limit and what to change.
 */
export function maxBoxWeightIssue(parcel: {
  // Structural, not `ShipmentEstimateParcel`: the quote estimate carries the same
  // weights under a slightly different shape and needs the identical wording.
  sequence: number;
  actualWeightKg: number;
  volumetricWeightKg: number;
  maxBoxKg: number | null;
  exceedsMaxBoxKg: boolean;
}) {
  if (!parcel.exceedsMaxBoxKg || parcel.maxBoxKg === null) return null;

  const fromVolumetric = parcel.volumetricWeightKg > parcel.actualWeightKg;

  return {
    sequence: parcel.sequence,
    fromVolumetric,
    maxBoxKg: parcel.maxBoxKg,
    text: fromVolumetric
      ? `Volumetric weight ${parcel.volumetricWeightKg.toFixed(2)} kg is over the ${parcel.maxBoxKg} kg maximum box weight. Reduce the dimensions.`
      : `Actual weight ${parcel.actualWeightKg.toFixed(2)} kg is over the ${parcel.maxBoxKg} kg maximum box weight.`
  };
}

export type ShipmentPricing = {
  parcels: ShipmentEstimateParcel[];
  freightAmount: number;
  fuelSurchargeAmount: number;
  remoteAreaAmount: number;
  remoteAreaApplied: boolean;
  csbType: CsbType;
  csbClearanceAmount: number;
  handlingAmount: number;
  insuranceAmount: number;
  insuranceApplied: boolean;
  declaredGoodsValue: number;
  discountAmount: number;
  baseAmount: number;
  gstAmount: number;
  totalAmount: number;
  missingRate: boolean;
  exceedsMaxBoxKg: boolean;
  /**
   * The heaviest a single box may be on this route, from the rate card. Absent
   * or null until a destination with a rate card is chosen, and the weight field
   * is uncapped until then because there is no ceiling to enforce yet.
   */
  routeMaxBoxKg?: number | null;
  gstRate: number;
  taxTreatment?: "GST_APPLICABLE" | "NO_GST";
  noGstEligible?: boolean;
  gstForced?: boolean;
  gstBillingVersion?: number;
  inclusiveAmounts?: {
    freightAmount: number;
    fuelSurchargeAmount: number;
    remoteAreaAmount: number;
    csbClearanceAmount: number;
    handlingAmount: number;
    insuranceAmount: number;
    discountAmount: number;
    totalAmount: number;
  };
  lines: ShipmentChargeLine[];
};

export type ShipmentFundingPreview = {
  mode: "BUSINESS_ACCOUNT" | "COUNTER";
  totalPayableMinor: number;
  advanceDeductionMinor: number;
  creditUsageMinor: number;
  availableAdvanceMinor: number;
  availableCreditMinor: number;
  canFund: boolean;
  message: string;
};

export type ShipmentCostEstimate = {
  pricing: ShipmentPricing;
  funding: ShipmentFundingPreview;
  /** Sent back with the booking; the server refuses if the price has since moved. */
  pricingHash: string;
  expiresAt: string;
};

/** The in-progress form values to price, as the booking form currently holds them. */
export type ShipmentCostEstimateInput = {
  countryCode?: string;
  destinationPostcode?: string;
  serviceType?: ShipmentServiceType;
  csbType?: CsbType;
  insuranceOptIn?: boolean;
  forceGst?: boolean;
  parcels?: Array<{
    sequence?: number;
    weightKg?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    items?: Array<{ quantity?: number; unitRate?: number }>;
  }>;
};

/** Whether the estimate is for a client's own draft or an admin's. */
export type ShipmentEstimateAudience = "admin" | "client" | "operator";

/**
 * Raised when a booking is refused because its price moved after the customer
 * accepted it. Carries the new breakdown so the panel can show what changed
 * rather than only that something did.
 */
export class ShipmentPriceChangedError extends Error {
  constructor(
    message: string,
    public readonly pricing: ShipmentPricing,
    public readonly pricingHash: string
  ) {
    super(message);
    this.name = "ShipmentPriceChangedError";
  }
}

function buildAuthHeaders(headers: HeadersInit | undefined, token: string | null) {
  const nextHeaders = new Headers(headers);

  if (token) nextHeaders.set("Authorization", `Bearer ${token}`);

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

function costEstimateUrl(shipmentDraftId: string, audience: ShipmentEstimateAudience, operatorSlug?: string) {
  if (audience === "operator") {
    if (!operatorSlug) throw new Error("An operator URL is required to estimate this shipment.");
    return apiUrl(`/api/v1/operators/${encodeURIComponent(operatorSlug)}/dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/cost-estimate`);
  }
  return apiUrl(audience === "client"
    ? `/api/v1/client/dpd-labels/drafts/${encodeURIComponent(shipmentDraftId)}/cost-estimate`
    : `/api/v1/shipment-drafts/${encodeURIComponent(shipmentDraftId)}/cost-estimate`);
}

/**
 * Prices the shipment as it currently stands and previews how it would be paid.
 *
 * Safe to call repeatedly- it reads and reserves nothing- so the booking form
 * can re-price as the customer edits. Pass an `AbortSignal` so a superseded
 * request cannot land after a newer one and show a stale total.
 */
export async function fetchShipmentCostEstimate(
  shipmentDraftId: string,
  audience: ShipmentEstimateAudience,
  input: ShipmentCostEstimateInput,
  signal?: AbortSignal,
  operatorSlug?: string
) {
  const response = await fetchWithAuth(costEstimateUrl(shipmentDraftId, audience, operatorSlug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || "The shipment cost could not be calculated.");
  }

  return data.estimate as ShipmentCostEstimate;
}

/**
 * Turns a booking response that was refused for a changed price into a typed
 * error the booking pages can present as a comparison.
 *
 * Returns null for every other outcome, so callers keep their existing error
 * handling for anything that is not a price change.
 */
/**
 * The DPD label could not be created and the shipment was not booked.
 *
 * Distinct from a generic failure because the booking form responds to it by
 * offering to continue without the carrier label, which is only safe because
 * nothing was created.
 */
export class DpdLabelUnavailableError extends Error {
  constructor(message: string, public readonly carrierErrors: string[] = []) {
    super(message);
    this.name = "DpdLabelUnavailableError";
  }
}

export function toDpdLabelUnavailableError(data: {
  code?: string;
  message?: string;
  carrierErrors?: unknown;
}): DpdLabelUnavailableError | null {
  if (data.code !== "DPD_LABEL_FAILED") return null;

  const carrierErrors = Array.isArray(data.carrierErrors)
    ? data.carrierErrors.filter((entry): entry is string => typeof entry === "string")
    : [];

  return new DpdLabelUnavailableError(
    data.message || "The DPD label could not be created. Nothing has been booked.",
    carrierErrors
  );
}

export function toPriceChangedError(data: {
  code?: string;
  message?: string;
  pricing?: ShipmentPricing;
  pricingHash?: string;
}): ShipmentPriceChangedError | null {
  if (data.code !== "PRICE_CHANGED" || !data.pricing || !data.pricingHash) return null;

  return new ShipmentPriceChangedError(
    data.message || "The price for this shipment changed. Review the updated charges before continuing.",
    data.pricing,
    data.pricingHash
  );
}

export function formatEstimateMoney(amountMinor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}
