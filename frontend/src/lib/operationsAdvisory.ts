import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

/**
 * How long a published advisory counts as "new". Drives both the glowing NEW
 * badge in the marquee and the count on the header calendar icon, so the two
 * can never disagree about what a client has not seen yet.
 */
export const ADVISORY_NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

/** True when an advisory was published inside the "new" window. */
export function isNewAdvisory(createdAt: string | undefined, now: number) {
  if (!createdAt) return false;
  const published = new Date(createdAt).getTime();
  return Number.isFinite(published) && now - published < ADVISORY_NEW_WINDOW_MS;
}

// ── Service disruptions ───────────────────────────────────────────────────────

export const serviceDisruptionTypes = [
  "WEATHER_DISRUPTION",
  "AIRPORT_CLOSURE",
  "CUSTOMS_STRIKE",
  "PUBLIC_HOLIDAY",
  "FLIGHT_CANCELLATION",
  "SECURITY_RESTRICTION",
  "PEAK_SEASON_DELAY",
  "INFORMATION"
] as const;
export type ServiceDisruptionType = (typeof serviceDisruptionTypes)[number];

export const serviceDisruptionSeverities = ["INFO", "WARNING", "CRITICAL"] as const;
export type ServiceDisruptionSeverity = (typeof serviceDisruptionSeverities)[number];

export const serviceDisruptionTypeLabels: Record<ServiceDisruptionType, string> = {
  WEATHER_DISRUPTION: "Weather disruption",
  AIRPORT_CLOSURE: "Airport closure",
  CUSTOMS_STRIKE: "Customs strike",
  PUBLIC_HOLIDAY: "Public holiday",
  FLIGHT_CANCELLATION: "Flight cancellation",
  SECURITY_RESTRICTION: "Security restriction",
  PEAK_SEASON_DELAY: "Peak season delay",
  INFORMATION: "Information"
};

export type ServiceDisruption = {
  id: string;
  type: ServiceDisruptionType;
  severity: ServiceDisruptionSeverity;
  title: string;
  message: string;
  startAt: string;
  endAt: string | null;
  affectedBranches: string[];
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ServiceDisruptionInput = {
  type: ServiceDisruptionType;
  severity: ServiceDisruptionSeverity;
  title: string;
  message: string;
  startAt: string;
  endAt: string | null;
  affectedBranches: string[];
  active: boolean;
};

// ── Holiday & Cut-Off Calendar ────────────────────────────────────────────────

export const calendarCategories = [
  "BRANCH_HOLIDAY",
  "DESTINATION_HOLIDAY",
  "CUSTOMS_HOLIDAY",
  "PICKUP_CUTOFF",
  "SAME_DAY_BOOKING_CUTOFF",
  "FLIGHT_CLOSING_TIME",
  "WEEKEND_DELIVERY",
  "PEAK_SEASON_RESTRICTION"
] as const;
export type CalendarCategory = (typeof calendarCategories)[number];

export const calendarCategoryLabels: Record<CalendarCategory, string> = {
  BRANCH_HOLIDAY: "Branch holidays",
  DESTINATION_HOLIDAY: "Destination holidays",
  CUSTOMS_HOLIDAY: "Customs holidays",
  PICKUP_CUTOFF: "Pickup cut-off time",
  SAME_DAY_BOOKING_CUTOFF: "Same-day booking cut-off",
  FLIGHT_CLOSING_TIME: "Flight closing time",
  WEEKEND_DELIVERY: "Weekend delivery availability",
  PEAK_SEASON_RESTRICTION: "Peak season restrictions"
};

export type CalendarEntryBranch = { _id: string; name: string; code: string };

export type CalendarEntry = {
  id: string;
  category: CalendarCategory;
  title: string;
  description: string;
  branchId: string | null;
  branch: CalendarEntryBranch | null;
  countryCode: string | null;
  locationLabel: string | null;
  date: string | null;
  endDate: string | null;
  time: string | null;
  weekendDeliveryAvailable: boolean | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CalendarEntryInput = {
  category: CalendarCategory;
  title: string;
  description: string;
  branchId: string | null;
  countryCode: string | null;
  locationLabel: string | null;
  date: string | null;
  endDate: string | null;
  time: string | null;
  weekendDeliveryAvailable: boolean | null;
  active: boolean;
};

// ── Customs & regulatory updates ──────────────────────────────────────────────

export const regulatoryUpdateCategories = [
  "CUSTOMS_RULE_CHANGE",
  "DUTY_VAT_CHANGE",
  "DOCUMENTATION_REQUIREMENT",
  "RESTRICTED_PROHIBITED_GOODS",
  "CLEARANCE_REQUIREMENT",
  "SECURITY_ENS_REQUIREMENT",
  "DE_MINIMIS_LOW_VALUE_CHANGE",
  "CUSTOMS_SYSTEM_DISRUPTION",
  "REGULATORY_NOTICE",
  "ECCS_NOT_RESPONDED",
  "HIGH_ALERT_IGI_AIRPORT",
  "OTHER"
] as const;
export type RegulatoryUpdateCategory = (typeof regulatoryUpdateCategories)[number];

export const regulatoryUpdateCategoryLabels: Record<RegulatoryUpdateCategory, string> = {
  CUSTOMS_RULE_CHANGE: "Customs rule change",
  DUTY_VAT_CHANGE: "Duty / VAT change",
  DOCUMENTATION_REQUIREMENT: "Documentation requirement",
  RESTRICTED_PROHIBITED_GOODS: "Restricted / prohibited goods",
  CLEARANCE_REQUIREMENT: "Clearance requirement",
  SECURITY_ENS_REQUIREMENT: "Security / ENS requirement",
  DE_MINIMIS_LOW_VALUE_CHANGE: "De minimis / low-value change",
  CUSTOMS_SYSTEM_DISRUPTION: "Customs system disruption",
  REGULATORY_NOTICE: "Regulatory notice",
  ECCS_NOT_RESPONDED: "ECCS not responded",
  HIGH_ALERT_IGI_AIRPORT: "High alert - IGI Airport",
  OTHER: "Other"
};

export const regulatoryUpdateStatuses = ["UPCOMING", "ACTIVE", "EXPIRED"] as const;
export type RegulatoryUpdateStatus = (typeof regulatoryUpdateStatuses)[number];

export const regulatoryShipmentDirections = ["ALL", "IMPORT", "EXPORT"] as const;
export type RegulatoryShipmentDirection = (typeof regulatoryShipmentDirections)[number];

export const regulatoryShipmentDirectionLabels: Record<RegulatoryShipmentDirection, string> = {
  ALL: "All",
  IMPORT: "Import",
  EXPORT: "Export"
};

export const regulatoryShipmentTypes = ["ALL", "DOCUMENTS", "PARCELS", "CARGO", "COURIER"] as const;
export type RegulatoryShipmentType = (typeof regulatoryShipmentTypes)[number];

export const regulatoryShipmentTypeLabels: Record<RegulatoryShipmentType, string> = {
  ALL: "All",
  DOCUMENTS: "Documents",
  PARCELS: "Parcels",
  CARGO: "Cargo",
  COURIER: "Courier"
};

export type RegulatoryUpdate = {
  id: string;
  regions: string[];
  category: RegulatoryUpdateCategory;
  title: string;
  effectiveFrom: string | null;
  effectiveFromTbc: boolean;
  effectiveUntil: string | null;
  /** A pinned status, or null when the dates decide it. */
  statusOverride: RegulatoryUpdateStatus | null;
  /** What every reader should display: derived server-side from the dates. */
  status: RegulatoryUpdateStatus;
  affectedShipments: RegulatoryShipmentDirection[];
  shipmentTypes: RegulatoryShipmentType[];
  valueThreshold: string | null;
  customerImpact: string;
  actionRequired: string;
  sourceUrl: string | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type RegulatoryUpdateInput = {
  regions: string[];
  category: RegulatoryUpdateCategory;
  title: string;
  effectiveFrom: string | null;
  effectiveFromTbc: boolean;
  effectiveUntil: string | null;
  statusOverride: RegulatoryUpdateStatus | null;
  affectedShipments: RegulatoryShipmentDirection[];
  shipmentTypes: RegulatoryShipmentType[];
  valueThreshold: string | null;
  customerImpact: string;
  actionRequired: string;
  sourceUrl: string | null;
  active: boolean;
};

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

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

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const formattedError = findFirstApiError(data.errors);
    throw new Error(data.message || formattedError || "Request failed");
  }

  return data as T;
}

// ── Staff endpoints ───────────────────────────────────────────────────────────

export type AadhaarOcrFeatureStatus = {
  enabled: boolean;
  providerConfigured: boolean;
  providerEnvironment: "sandbox" | "production";
  updatedAt: string | null;
};

export async function getAadhaarOcrFeatureStatus() {
  const response = await fetchWithAuth(apiUrl("/api/v1/aadhaar-ocr-feature"));
  return parseApiResponse<{ success: true } & AadhaarOcrFeatureStatus>(response);
}

export async function updateAadhaarOcrFeature(enabled: boolean) {
  const response = await fetchWithAuth(apiUrl("/api/v1/aadhaar-ocr-feature"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return parseApiResponse<{ success: true } & AadhaarOcrFeatureStatus>(response);
}

export async function listServiceDisruptions(input: { active?: boolean; scope?: "live" } = {}) {
  const url = new URL(apiUrl("/api/v1/operations-advisory/service-disruptions"));
  if (typeof input.active === "boolean") url.searchParams.set("active", String(input.active));
  if (input.scope === "live") url.searchParams.set("scope", "live");

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; disruptions: ServiceDisruption[] }>(response);
}

export async function createServiceDisruption(input: ServiceDisruptionInput) {
  const response = await fetchWithAuth(apiUrl("/api/v1/operations-advisory/service-disruptions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; disruption: ServiceDisruption }>(response);
}

export async function updateServiceDisruption(id: string, input: ServiceDisruptionInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/service-disruptions/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; disruption: ServiceDisruption }>(response);
}

export async function deleteServiceDisruption(id: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/service-disruptions/${id}`), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; message: string }>(response);
}

export async function listCalendarEntries(input: { category?: CalendarCategory; active?: boolean } = {}) {
  const url = new URL(apiUrl("/api/v1/operations-advisory/calendar-entries"));
  if (input.category) url.searchParams.set("category", input.category);
  if (typeof input.active === "boolean") url.searchParams.set("active", String(input.active));

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; entries: CalendarEntry[] }>(response);
}

export async function createCalendarEntry(input: CalendarEntryInput) {
  const response = await fetchWithAuth(apiUrl("/api/v1/operations-advisory/calendar-entries"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; entry: CalendarEntry }>(response);
}

export async function updateCalendarEntry(id: string, input: CalendarEntryInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/calendar-entries/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; entry: CalendarEntry }>(response);
}

export async function deleteCalendarEntry(id: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/calendar-entries/${id}`), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; message: string }>(response);
}

// ── Client endpoints ──────────────────────────────────────────────────────────

export async function listClientServiceDisruptions() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/service-disruptions"));

  return parseApiResponse<{ success: true; disruptions: ServiceDisruption[] }>(response);
}

export async function listClientCalendarEntries() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/calendar-entries"));

  return parseApiResponse<{ success: true; entries: CalendarEntry[] }>(response);
}

// ── Regulatory updates: staff endpoints ───────────────────────────────────────

export async function listRegulatoryUpdates(
  input: { category?: RegulatoryUpdateCategory; region?: string; status?: RegulatoryUpdateStatus; active?: boolean } = {}
) {
  const url = new URL(apiUrl("/api/v1/operations-advisory/regulatory-updates"));
  if (input.category) url.searchParams.set("category", input.category);
  if (input.region) url.searchParams.set("region", input.region);
  if (input.status) url.searchParams.set("status", input.status);
  if (typeof input.active === "boolean") url.searchParams.set("active", String(input.active));

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; updates: RegulatoryUpdate[] }>(response);
}

export async function createRegulatoryUpdate(input: RegulatoryUpdateInput) {
  const response = await fetchWithAuth(apiUrl("/api/v1/operations-advisory/regulatory-updates"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; update: RegulatoryUpdate }>(response);
}

export async function updateRegulatoryUpdate(id: string, input: RegulatoryUpdateInput) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/regulatory-updates/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true; update: RegulatoryUpdate }>(response);
}

export async function deleteRegulatoryUpdate(id: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/operations-advisory/regulatory-updates/${id}`), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; message: string }>(response);
}

// ── Regulatory updates: client endpoint ───────────────────────────────────────

export async function listClientRegulatoryUpdates() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/regulatory-updates"));

  return parseApiResponse<{ success: true; updates: RegulatoryUpdate[] }>(response);
}
