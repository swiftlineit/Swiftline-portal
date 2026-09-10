import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export const countryRateServices = ["COURIER", "CARGO"] as const;
export type CountryRateService = (typeof countryRateServices)[number];
/** Band D is maintained for GST-inclusive public online booking rates. */
export const rateCardBands = ["BAND_A", "BAND_B", "BAND_C", "BAND_D"] as const;
export type RateCardBand = (typeof rateCardBands)[number];
export const internalRateCardBands = ["BAND_A", "BAND_B", "BAND_C"] as const;
export type InternalRateCardBand = (typeof internalRateCardBands)[number];
export const rateCardGstTreatments = ["INCLUDED", "EXCLUDED"] as const;
export type RateCardGstTreatment = (typeof rateCardGstTreatments)[number];

export function formatRateCardBand(band: RateCardBand) {
  return band.replace("BAND_", "Band ");
}

export type CountryRateCard = {
  band: RateCardBand;
  _id: string;
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  fromKg: number;
  toKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
  gstTreatment: RateCardGstTreatment;
  gstRatePercent: number;
  gstApplyToAllRates: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CountryRateCardInput = {
  band: RateCardBand;
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  fromKg: number;
  toKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
  gstTreatment: RateCardGstTreatment;
  gstRatePercent: number;
  gstApplyToAllRates: boolean;
};
export type ClientCountryRateCard = Omit<CountryRateCard, "band">;
export type ClientCountryRouteCharge = Omit<CountryRouteCharge, "band">;

/**
 * Surcharges, insurance and discount for one route (country + service).
 *
 * Stored once per route rather than per weight slab, so a fuel percentage is set
 * in one place and two slabs can never disagree about it. A route with no record
 * charges none of these.
 */
export type CountryRouteCharge = {
  band: RateCardBand;
  _id: string;
  countryCode: string;
  service: CountryRateService;
  fuelSurchargePercent: number;
  remoteAreaCharge: number;
  remoteAreaPostcodes: string[];
  handlingCharge: number;
  insurancePercent: number;
  insuranceMinimum: number;
  discountPercent: number;
  createdAt: string;
  updatedAt: string;
};

export type CountryRouteChargeInput = {
  band: RateCardBand;
  countryCode: string;
  service: CountryRateService;
  fuelSurchargePercent: number;
  remoteAreaCharge: number;
  // Sent as typed, comma or newline separated; the server splits and de-duplicates.
  remoteAreaPostcodes: string;
  handlingCharge: number;
  insurancePercent: number;
  insuranceMinimum: number;
  discountPercent: number;
};

export type RateCardAssignmentAccount = {
  _id: string;
  accountId: string;
  status: string;
  company: { companyName?: string };
  assignedBranch?: { _id: string; name?: string; code?: string; status?: string } | null;
  rateCardBand?: RateCardBand | null;
};

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

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const formattedError = findFirstApiError(data.errors);
    const listError = Array.isArray(data.errors) && typeof data.errors[0] === "string" ? data.errors[0] : "";
    throw new Error(data.message || formattedError || listError || "Country rate card request failed");
  }

  return data as T;
}

export function formatCountryRateService(service: string) {
  return service.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function rateCardDisplay(rate: {
  chargesPerKg: number;
  gstTreatment?: RateCardGstTreatment;
  gstRatePercent?: number;
}) {
  const treatment = rate.gstTreatment ?? "EXCLUDED";
  const percent = treatment === "INCLUDED" ? rate.gstRatePercent ?? 0 : 0;
  return {
    // `chargesPerKg` is the amount entered on the rate card. GST treatment
    // describes that amount; it must never change it when displayed.
    amount: Math.round(rate.chargesPerKg * 100) / 100,
    label: treatment === "INCLUDED"
      ? `GST included${percent ? ` (${percent}%)` : ""}`
      : "GST excluded"
  };
}

export async function listCountryRateCards(band?: RateCardBand) {
  const path = band ? `/api/v1/country-rate-cards?band=${encodeURIComponent(band)}` : "/api/v1/country-rate-cards";
  const response = await fetchWithAuth(apiUrl(path));

  return parseApiResponse<{
    success: true;
    rates: CountryRateCard[];
  }>(response);
}

export async function listClientCountryRateCards(businessAccountId?: string) {
  const path = businessAccountId
    ? `/api/v1/client/country-rate-cards?businessAccountId=${encodeURIComponent(businessAccountId)}`
    : "/api/v1/client/country-rate-cards";
  const response = await fetchWithAuth(apiUrl(path));

  return parseApiResponse<{
    success: true;
    title: "Your Swiftline Rate Card";
    rateCardAssigned: boolean;
    rates: ClientCountryRateCard[];
    routeCharges: ClientCountryRouteCharge[];
  }>(response);
}

export async function getDraftRateCardContext(draftId: string, audience: "admin" | "client") {
  const path = audience === "client"
    ? `/api/v1/client/dpd-labels/drafts/${draftId}/rate-card-context`
    : `/api/v1/shipment-drafts/${draftId}/rate-card-context`;
  const response = await fetchWithAuth(apiUrl(path));

  return parseApiResponse<{
    success: true;
    title: "Your Swiftline Rate Card";
    rateCardAssigned: boolean;
    band?: RateCardBand;
    rates: ClientCountryRateCard[];
    routeCharges: ClientCountryRouteCharge[];
  }>(response);
}

export async function saveCountryRateCard(input: CountryRateCardInput, rateId?: string) {
  const response = await fetchWithAuth(apiUrl(rateId ? `/api/v1/country-rate-cards/${rateId}` : "/api/v1/country-rate-cards"), {
    method: rateId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    rate: CountryRateCard;
  }>(response);
}

export async function listCountryRouteCharges(band?: RateCardBand) {
  const path = band
    ? `/api/v1/country-rate-cards/route-charges?band=${encodeURIComponent(band)}`
    : "/api/v1/country-rate-cards/route-charges";
  const response = await fetchWithAuth(apiUrl(path));

  return parseApiResponse<{
    success: true;
    routeCharges: CountryRouteCharge[];
  }>(response);
}

export async function listRateCardAssignmentAccounts() {
  const response = await fetchWithAuth(apiUrl("/api/v1/country-rate-cards/assignment-accounts"));
  return parseApiResponse<{ success: true; accounts: RateCardAssignmentAccount[] }>(response);
}

/** Creates or replaces the configuration for one route, keyed by country + service. */
export async function saveCountryRouteCharge(input: CountryRouteChargeInput) {
  const response = await fetchWithAuth(apiUrl("/api/v1/country-rate-cards/route-charges"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{
    success: true;
    routeCharge: CountryRouteCharge;
  }>(response);
}

export async function deleteCountryRateCard(rateId: string, confirmAssignedImpact = false) {
  const query = confirmAssignedImpact ? "?confirmAssignedImpact=true" : "";
  const response = await fetchWithAuth(apiUrl(`/api/v1/country-rate-cards/${rateId}${query}`), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; message: string }>(response);
}

/* -------------------------------------------------------------------------
 * Importing a rate list workbook
 * ---------------------------------------------------------------------- */

export type RateCardImportZone = {
  column: number;
  /** Country names exactly as the workbook spells them, resolved in the browser. */
  rawNames: string[];
  /** Parallel to `weights`; null where the workbook left the cell blank. */
  rates: (number | null)[];
};

export type RateCardImportPreview = {
  fileName: string;
  weights: number[];
  zones: RateCardImportZone[];
};

export type RateCardImportSlab = {
  fromKg: number;
  toKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
};

export type RateCardImportRoute = {
  countryCode: string;
  countryName: string;
  slabs: RateCardImportSlab[];
};

export type RateCardImportPayload = {
  band: RateCardBand;
  services: CountryRateService[];
  routes: RateCardImportRoute[];
  confirmReplace: boolean;
  fileName?: string;
};

export type RateCardImportRouteResult = {
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  added: number;
  removed: number;
};

export type RateCardImportResult = {
  success: true;
  band: RateCardBand;
  services: CountryRateService[];
  routesWritten: number;
  slabsWritten: number;
  slabsRemoved: number;
  summary: RateCardImportRouteResult[];
};

/** Reads the uploaded workbook. The server writes nothing at this stage. */
export async function previewRateCardImport(file: File) {
  const body = new FormData();
  body.append("rateFile", file);

  const response = await fetchWithAuth(apiUrl("/api/v1/country-rate-cards/imports/preview"), {
    method: "POST",
    body
  });

  return parseApiResponse<{ success: true } & RateCardImportPreview>(response);
}

/**
 * Writes the reviewed rate list.
 *
 * Sends the resolved rows rather than the file, so what the operator approved
 * on the review screen is exactly what is stored- a second parse on the server
 * could not drift from what was shown.
 */
export async function commitRateCardImport(payload: RateCardImportPayload) {
  const response = await fetchWithAuth(apiUrl("/api/v1/country-rate-cards/imports"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return parseApiResponse<RateCardImportResult>(response);
}

export function buildCountryRateCardCsv(rates: CountryRateCard[]) {
  const rows = [
    ["Band", "Country", "Service", "From KG", "To KG", "Charges / KG", "GST", "Max Box KG"],
    ...rates.map((rate) => [
      formatRateCardBand(rate.band),
      `${rate.countryName} (${rate.countryCode})`,
      formatCountryRateService(rate.service),
      String(rate.fromKg),
      String(rate.toKg),
      String(rateCardDisplay(rate).amount),
      rateCardDisplay(rate).label,
      String(rate.maxBoxKg)
    ])
  ];

  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
