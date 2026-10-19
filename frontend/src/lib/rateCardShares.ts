import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { CountryRateService, RateCardBand } from "@/lib/countryRateCards";

export const rateCardShareChannels = ["PORTAL", "EMAIL", "WHATSAPP"] as const;
export type RateCardShareChannel = (typeof rateCardShareChannels)[number];

export const rateCardAdjustmentModes = ["NONE", "PERCENT", "FLAT"] as const;
export type RateCardAdjustmentMode = (typeof rateCardAdjustmentModes)[number];

export type RateCardShareRow = {
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  fromKg: number;
  toKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
  gstTreatment?: "INCLUDED" | "EXCLUDED";
  gstRatePercent?: number;
  /** Staff-only: the pre-adjustment rate. Never sent to clients or public links. */
  baseChargesPerKg?: number;
};

export type RateCardShareTerms = {
  validFrom: string;
  validUntil: string;
  fuelSurchargePercent: number;
  gstPercent: number;
  minChargeableWeightKg: number;
  volumetricDivisor: number;
  remarks: string;
  customTerms: string[];
};

export type RateCardShare = {
  band?: RateCardBand;
  id: string;
  shareNumber: string;
  title: string;
  currency: string;
  channels: RateCardShareChannel[];
  status: "ACTIVE" | "REVOKED";
  expired: boolean;
  rows: RateCardShareRow[];
  routeCharges: Array<{
    countryCode: string;
    service: CountryRateService;
    fuelSurchargePercent: number;
    remoteAreaCharge: number;
    remoteAreaPostcodes: string[];
    handlingCharge: number;
    insurancePercent: number;
    insuranceMinimum: number;
    discountPercent: number;
  }>;
  documentType: "RATE_CARD" | "EXTERNAL_PROPOSAL";
  historical?: boolean;
  adjustmentMode?: RateCardAdjustmentMode;
  adjustmentValue?: number;
  terms: RateCardShareTerms;
  recipientAccounts: { businessAccountId: string; companyName: string }[];
  recipientEmails: { email: string; name: string }[];
  recipientPhones: { phone: string; name: string }[];
  publicViewCount: number;
  lastViewedAt: string | null;
  expiresAt: string;
  readAt: string | null;
  createdAt: string;
};

export type RateCardShareInput = {
  band?: RateCardBand;
  businessAccountId?: string;
  expectedVersion?: number;
  title: string;
  channels: RateCardShareChannel[];
  selection: {
    countryCodes: string[];
    services: CountryRateService[];
    rateIds: string[];
  };
  adjustmentMode: RateCardAdjustmentMode;
  adjustmentValue: number;
  terms: {
    validFrom: string;
    validUntil: string;
    fuelSurchargePercent: number;
    gstPercent: number;
    minChargeableWeightKg: number;
    volumetricDivisor: number;
    remarks: string;
    customTerms: string[];
  };
  recipientAccountIds: string[];
  recipientEmails: { email: string; name: string }[];
  recipientPhones: { phone: string; name: string }[];
};

export type RateCardShareResult = {
  share: RateCardShare;
  links: { view: string; pdf: string; excel: string };
  emailsQueued: number;
  whatsappLinks: { phone: string; name: string; url: string; message: string }[];
};

function buildAuthHeaders(headers: HeadersInit | undefined, token: string | null) {
  const nextHeaders = new Headers(headers);
  if (token) nextHeaders.set("Authorization", `Bearer ${token}`);
  return nextHeaders;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const response = await fetch(input, { ...init, headers: buildAuthHeaders(init.headers, token) });

  if (response.status !== 401) return response;

  const refreshedToken = await refreshAccessToken();
  if (!refreshedToken) return response;

  return fetch(input, { ...init, headers: buildAuthHeaders(init.headers, refreshedToken) });
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const listError = Array.isArray(data.errors) && typeof data.errors[0] === "string" ? data.errors[0] : "";
    throw new Error(data.message || listError || "Rate card share request failed");
  }

  return data as T;
}

/**
 * Documents arrive as a binary body rather than JSON, so the browser is handed
 * an object URL instead of being navigated at the API- a plain link would drop
 * the Authorization header and come back a 401.
 */
async function downloadBlob(response: Response, filename: string) {
  if (!response.ok) {
    const message = await response.json().then((data) => data.message).catch(() => "");
    throw new Error(message || "The document could not be downloaded.");
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.URL.revokeObjectURL(url);
}

/* ----------------------------------- Staff ---------------------------------- */

export async function listRateCardShares() {
  const response = await fetchWithAuth(apiUrl("/api/v1/rate-card-shares"));
  return parseApiResponse<{ success: true; shares: RateCardShare[] }>(response);
}

export async function createRateCardShare(input: RateCardShareInput) {
  const response = await fetchWithAuth(apiUrl("/api/v1/rate-card-shares"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseApiResponse<{ success: true } & RateCardShareResult>(response);
}

export async function revokeRateCardShare(shareId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/rate-card-shares/${shareId}/revoke`), { method: "POST" });
  return parseApiResponse<{ success: true; message: string; share: RateCardShare }>(response);
}

export async function downloadRateCardShareDocument(shareId: string, format: "pdf" | "xlsx", shareNumber: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/rate-card-shares/${shareId}/${format}`));
  await downloadBlob(response, `${documentName(shareNumber)}.${format}`);
}

/* ---------------------------------- Client ---------------------------------- */

export async function listClientRateCardShares() {
  const response = await fetchWithAuth(apiUrl("/api/v1/client/rate-card-shares"));
  return parseApiResponse<{ success: true; shares: RateCardShare[]; unreadCount: number }>(response);
}

export async function markClientRateCardShareRead(shareId: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/rate-card-shares/${shareId}/read`), { method: "POST" });
  return parseApiResponse<{ success: true; message: string }>(response);
}

export async function downloadClientRateCardShareDocument(shareId: string, format: "pdf" | "xlsx", shareNumber: string) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/rate-card-shares/${shareId}/${format}`));
  await downloadBlob(response, `${documentName(shareNumber)}.${format}`);
}

/* ---------------------------------- Public ---------------------------------- */

export async function getPublicRateCardShare(shareId: string, token: string) {
  const url = new URL(apiUrl(`/api/v1/public/rate-cards/${shareId}`));
  url.searchParams.set("token", token);

  const response = await fetch(url.toString());
  return parseApiResponse<{ success: true; share: RateCardShare; recipientLabel: string }>(response);
}

export async function downloadPublicRateCardShareDocument(
  shareId: string,
  token: string,
  format: "pdf" | "xlsx",
  shareNumber: string
) {
  const url = new URL(apiUrl(`/api/v1/public/rate-cards/${shareId}/${format}`));
  url.searchParams.set("token", token);

  await downloadBlob(await fetch(url.toString()), `${documentName(shareNumber)}.${format}`);
}

/* --------------------------------- Formatting -------------------------------- */

export function documentName(shareNumber: string) {
  return `Swiftline-Rate-Card-${shareNumber.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function formatRate(value: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatShareDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function daysUntil(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

/** Country + service groups, matching how the PDF and workbook lay the rows out. */
export function groupRateCardRows(rows: RateCardShareRow[]) {
  const groups = new Map<string, { countryCode: string; countryName: string; service: string; rows: RateCardShareRow[] }>();

  for (const row of rows) {
    const key = `${row.countryCode}:${row.service}`;
    const group = groups.get(key)
      ?? { countryCode: row.countryCode, countryName: row.countryName, service: row.service, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((first, second) => first.fromKg - second.fromKg) }))
    .sort((first, second) => first.countryName.localeCompare(second.countryName) || first.service.localeCompare(second.service));
}
