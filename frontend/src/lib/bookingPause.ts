import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export const bookingPauseCountryOptions = [
  { value: "GB", label: "United Kingdom" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "EUROPE", label: "Europe" },
  { value: "ALL", label: "All destinations" }
] as const;

export type BookingPauseCountry = (typeof bookingPauseCountryOptions)[number]["value"];

export type BookingPauseStatus = "ACTIVE" | "UPCOMING" | "EXPIRED" | "DISABLED";

export type BookingPause = {
  id: string;
  countries: BookingPauseCountry[];
  countryLabels: string[];
  startAt: string;
  endAt: string;
  reason: string;
  active: boolean;
  status: BookingPauseStatus;
  createdAt?: string;
  updatedAt?: string;
};

export type BookingPauseInput = {
  countries: BookingPauseCountry[];
  startAt: string; // YYYY-MM-DD
  endAt: string; // YYYY-MM-DD
  reason: string;
  active: boolean;
};

const EUROPE_COUNTRY_CODES = new Set([
  "AL","AD","AT","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IE","IT","XK","LV","LI","LT","LU","MT","MD","MC","ME","NL","MK","NO","PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","TR","UA","GB","VA"
]);

function normalizeCountryCode(code: string | null | undefined): string {
  const u = (code ?? "").trim().toUpperCase();
  if (u === "UK") return "GB";
  return u;
}

export function isCountryPaused(countryCode: string | null | undefined, pauses: BookingPause[]): boolean {
  const normalized = normalizeCountryCode(countryCode);
  if (!normalized) return false;
  for (const pause of pauses) {
    if (pause.status !== "ACTIVE") continue;
    if (pause.countries.includes("ALL")) return true;
    if (pause.countries.includes(normalized as BookingPauseCountry)) return true;
    if (pause.countries.includes("EUROPE") && EUROPE_COUNTRY_CODES.has(normalized)) return true;
  }
  return false;
}

export function getActivePausesForCountry(countryCode: string | null | undefined, pauses: BookingPause[]): BookingPause[] {
  const normalized = normalizeCountryCode(countryCode);
  if (!normalized) return [];
  return pauses.filter((pause) => {
    if (pause.status !== "ACTIVE") return false;
    if (pause.countries.includes("ALL")) return true;
    if (pause.countries.includes(normalized as BookingPauseCountry)) return true;
    if (pause.countries.includes("EUROPE") && EUROPE_COUNTRY_CODES.has(normalized)) return true;
    return false;
  });
}

export function formatPauseWindow(pause: BookingPause): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(pause.startAt)} – ${fmt(pause.endAt)}`;
}

function buildAuthHeaders(headers: HeadersInit | undefined, token: string | null) {
  const next = new Headers(headers);
  if (token) next.set("Authorization", `Bearer ${token}`);
  return next;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? (await refreshAccessToken());
  const res = await fetch(input, { ...init, headers: buildAuthHeaders(init.headers, token) });
  if (res.status !== 401) return res;
  const refreshed = await refreshAccessToken();
  if (!refreshed) return res;
  return fetch(input, { ...init, headers: buildAuthHeaders(init.headers, refreshed) });
}

function findFirstApiError(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const errors = (value as { _errors?: unknown })._errors;
  if (Array.isArray(errors) && typeof errors[0] === "string") return errors[0];
  for (const nested of Object.values(value)) {
    const m = findFirstApiError(nested);
    if (m) return m;
  }
  return "";
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || !data.success) {
    const formatted = findFirstApiError(data.errors);
    throw new Error(data.message || formatted || "Request failed");
  }
  return data as T;
}

// ── Staff ──
export async function listBookingPauses(input: { active?: boolean; scope?: "live" } = {}) {
  const url = new URL(apiUrl("/api/v1/booking-pauses"));
  if (typeof input.active === "boolean") url.searchParams.set("active", String(input.active));
  if (input.scope === "live") url.searchParams.set("scope", "live");
  const res = await fetchWithAuth(url.toString());
  return parseApiResponse<{ success: true; pauses: BookingPause[]; dpdBookingEnabled: boolean }>(res);
}

export async function listActiveBookingPauses() {
  const url = new URL(apiUrl("/api/v1/booking-pauses/active"));
  const res = await fetchWithAuth(url.toString());
  return parseApiResponse<{ success: true; pauses: BookingPause[]; dpdBookingEnabled: boolean }>(res);
}

export async function updateDpdBookingSetting(enabled: boolean) {
  const res = await fetchWithAuth(apiUrl("/api/v1/booking-pauses/dpd-booking"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  return parseApiResponse<{ success: true; dpdBookingEnabled: boolean }>(res);
}

export async function createBookingPause(input: BookingPauseInput) {
  const res = await fetchWithAuth(apiUrl("/api/v1/booking-pauses"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return parseApiResponse<{ success: true; pause: BookingPause }>(res);
}

export async function updateBookingPause(id: string, input: BookingPauseInput) {
  const res = await fetchWithAuth(apiUrl(`/api/v1/booking-pauses/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return parseApiResponse<{ success: true; pause: BookingPause }>(res);
}

export async function toggleBookingPause(id: string) {
  const res = await fetchWithAuth(apiUrl(`/api/v1/booking-pauses/${id}/toggle`), { method: "PATCH" });
  return parseApiResponse<{ success: true; pause: BookingPause }>(res);
}

export async function deleteBookingPause(id: string) {
  const res = await fetchWithAuth(apiUrl(`/api/v1/booking-pauses/${id}`), { method: "DELETE" });
  return parseApiResponse<{ success: true; message: string }>(res);
}

// ── Client (or any authenticated user needing live view) ──
export async function listClientBookingPauses() {
  const res = await fetchWithAuth(apiUrl("/api/v1/client/booking-pauses"));
  return parseApiResponse<{ success: true; pauses: BookingPause[]; dpdBookingEnabled: boolean }>(res);
}
