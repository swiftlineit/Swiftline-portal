import { readJsonSafely } from "@/lib/auth";
import { fetchWithAuth } from "@/lib/shipmentsList";
import type { OperatorSession } from "@/lib/operatorDirectory";

export type OperatorHomeData = {
  success: true;
  role: OperatorSession["membership"]["role"];
  shipmentCount: number;
  bookedToday: number;
  bookedThisMonth: number;
  inTransit: number;
  trend: Array<{ day: string; count: number; amountMinor?: number }>;
  banners: Array<{ id: string; heading: string; description: string }>;
  recentShipments: Array<{
    id: string;
    awb: string;
    accountName: string;
    consignee: string;
    destinationCountry: string;
    status: string;
    parcelCount: number;
    bookingAmountMinor: number;
    currency: string;
    bookedAt: string | null;
  }>;
  accountStatuses?: Array<{ status: string; count: number }>;
  creditStatuses?: Record<string, number>;
  operations?: {
    pendingAccountReviews: number;
    pendingChanges: number;
    pendingAmendments: number;
    pendingCancellations: number;
    queriesThisWeek: number;
    pendingAccounts: Array<{ id: string; name: string; createdAt: string }>;
    latestQueries: Array<{ id: string; subject: string; accountName: string; kind: string; createdAt: string }>;
  };
  finance?: {
    activeCreditAccounts: number;
    pendingCreditReviews: number;
    outstandingMinor: number;
    overdueMinor: number;
    overdueStatements: number;
  };
  credit?: {
    availableCapacityMinor: number;
    totalOwedMinor: number;
    usedCreditMinor: number;
    creditLimitMinor: number;
  } | null;
};

export async function getOperatorHome(operatorSlug: string, signal?: AbortSignal): Promise<OperatorHomeData> {
  const response = await fetchWithAuth(`/api/v1/operators/${encodeURIComponent(operatorSlug)}/home`, { signal });
  const payload = await readJsonSafely(response) as OperatorHomeData & { message?: string; canonicalSlug?: string };
  if (!response.ok || !payload.success) {
    const error = new Error(payload.message || "The workspace overview could not be loaded.") as Error & { status?: number; canonicalSlug?: string };
    error.status = response.status;
    error.canonicalSlug = payload.canonicalSlug;
    throw error;
  }
  return payload;
}
