import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

/** The control tower: every dashboard figure, plus the exception and action feeds. */

export type AttentionSeverity = "CRITICAL" | "WARNING" | "INFO";

export type ShipmentExceptionType =
  | "CUSTOMS_HOLD" | "ADDRESS_PROBLEM" | "DELIVERY_ATTEMPTED" | "CONSIGNEE_UNAVAILABLE"
  | "DAMAGED_SHIPMENT" | "MISSED_CONNECTION" | "SHIPMENT_DELAYED" | "REMOTE_AREA_ISSUE"
  | "CLEARANCE_DOCUMENTS_REQUIRED" | "RETURN_TO_SENDER" | "WEIGHT_DIFFERENCE" | "CARRIER_EXCEPTION";

export type ShipmentException = {
  id: string;
  shipmentDraftId: string;
  awb: string;
  type: ShipmentExceptionType;
  label: string;
  problem: string;
  requiredAction: string;
  assignedTeam: string;
  severity: AttentionSeverity;
  lastUpdateAt: string;
  href: string;
};

export type ClientAction = {
  id: string;
  type: string;
  label: string;
  detail: string;
  actionLabel: string;
  href: string;
  shipmentDraftId: string | null;
  awb: string | null;
  severity: AttentionSeverity;
  raisedAt: string;
};

export type AttentionItem = {
  id: string;
  kind: "ACTION" | "EXCEPTION";
  label: string;
  detail: string;
  actionLabel: string;
  href: string;
  awb: string | null;
  severity: AttentionSeverity;
  at: string;
};

export type ClientOverviewSummary = {
  totalShipments: number;
  inTransit: number;
  outForDelivery: number;
  deliveredToday: number;
  delayed: number;
  customsHold: number;
  exceptions: number;
  actionRequired: number;
  openClaims: number;
  openTickets: number;
};

export type ClientOverview = {
  summary: ClientOverviewSummary;
  needsAttention: AttentionItem[];
  exceptions: ShipmentException[];
  actions: ClientAction[];
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
  if (!response.ok || !data.success) throw new Error(data.message || "Request failed");
  return data as T;
}

function scopeQuery(input: { businessAccountId: string; branchId?: string }) {
  const query = new URLSearchParams({ businessAccountId: input.businessAccountId });
  if (input.branchId) query.set("branchId", input.branchId);
  return query.toString();
}

export async function getClientOverview(input: { businessAccountId: string; branchId?: string }) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/overview?${scopeQuery(input)}`));
  return parseApiResponse<{ success: true } & ClientOverview>(response);
}

export async function listClientExceptions(input: { businessAccountId: string; branchId?: string }) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/exceptions?${scopeQuery(input)}`));
  return parseApiResponse<{
    success: true;
    exceptions: ShipmentException[];
    exceptionCountsByType: Record<string, number>;
  }>(response);
}

export async function listClientActions(input: { businessAccountId: string; branchId?: string }) {
  const response = await fetchWithAuth(apiUrl(`/api/v1/client/actions?${scopeQuery(input)}`));
  return parseApiResponse<{ success: true; actions: ClientAction[] }>(response);
}

export const severityStyles: Record<AttentionSeverity, { chip: string; bar: string }> = {
  CRITICAL: { chip: "bg-red-50 text-red-700 border-red-200", bar: "bg-red-500" },
  WARNING: { chip: "bg-amber-50 text-amber-800 border-amber-200", bar: "bg-amber-500" },
  INFO: { chip: "bg-slate-100 text-slate-600 border-slate-200", bar: "bg-slate-400" }
};
