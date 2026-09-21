import { apiUrl } from "@/lib/api";
import { setDateRangeParams, type DateRange } from "@/lib/dateRange";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";
import type { CsbType } from "@/lib/csbType";
import type { ShipmentDestinationRegionCode } from "@/lib/shipmentDestinationRegions";

export type ShipmentAudience = "admin" | "client";
export type DpdLabelStatus = "AVAILABLE" | "NOT_AVAILABLE" | "NOT_APPLICABLE";

export type ShipmentListItem = {
  id: string;
  creationSource: "MANUAL" | "INDIVIDUAL" | "PUBLIC_ONLINE" | "SHIPMENT_IMPORT";
  businessAccountId: string;
  businessAccountName: string;
  businessAccountCode: string;
  branchId: string;
  branch: { name: string; code: string; city: string };
  shipmentReference: string;
  invoiceNumber: string;
  swiftlineTrackingNumber: string;
  awbNumbers: string[];
  forwardingNumbers: string[];
  consignor: string;
  consignee: string;
  destination: string;
  destinationCountry: string;
  product: string;
  serviceInfo: string;
  // Customs route. Absent on shipments booked before CSB selection existed.
  csbType?: CsbType;
  route: string;
  shipmentInvoice: {
    invoiceNumber: string;
    currency: string;
    chargeableAmountMinor: number;
    status: "DRAFT" | "ISSUED";
    revision: number;
  } | null;
  pieces: number;
  weightKg: number;
  status: string;
  statusLabel: string;
  /** The newest scan. Null until Operations records one. */
  lastScan: { statusLabel: string; location: string; at: string } | null;
  /**
   * When it should arrive and whether it is going to. Null when the lane has
   * no route configured, in which case the row shows nothing rather than a
   * guessed date.
   */
  deliveryEstimate: {
    estimatedDeliveryAt: string;
    earliestDeliveryAt: string;
    transitDaysMin: number;
    transitDaysMax: number;
    transitBasis: "BUSINESS_DAYS" | "CALENDAR_DAYS";
    state: "ON_SCHEDULE" | "POTENTIAL_DELAY" | "DELAYED" | "DELIVERED" | "ON_HOLD";
    deliveredAt: string | null;
  } | null;
  /**
   * Carrier-side booking state, distinct from the tracking status above. Staff
   * lists include shipments that reached the carrier but have not completed;
   * client lists only ever contain LABEL_RECEIVED.
   */
  bookingStatus: "LABEL_RECEIVED" | "DPD_CREATED" | "DPD_STATUS_UNKNOWN" | "DPD_CREATING" | "DPD_REJECTED";
  bookingStatusLabel: string;
  manifest: { id: string; manifestNumber: string } | null;
  manifestEligible: boolean;
  /**
   * Per-parcel operational manifest scan state, staff list only. `SCANNED`
   * carries the owning manifest run; `AWAITING_SCAN` means no live scan owns
   * the parcel (never scanned, or removed via parcel/bag/manifest
   * cancellation). Absent on client responses and on shipments with no
   * issued labels. Optional so cached responses still type-check.
   */
  parcelManifests?: Array<{
    parcelNumber: string;
    scanState: "SCANNED" | "AWAITING_SCAN";
    manifestId: string | null;
    manifestNumber: string | null;
    manifestStatus: "DRAFT" | "PACKING" | "READY_TO_SEAL" | "SEALED" | "DISPATCHED" | "CANCELLED" | null;
    bagNumber: string | null;
    /** Booked actual weight. Optional so cached responses still type-check. */
    weightKg?: number | null;
    scannedAt: string | null;
  }>;
  /** Internal staff-only carrier-label state; omitted from client responses. */
  dpdLabelStatus?: DpdLabelStatus;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ShipmentListPagination = { page: number; limit: number; total: number; totalPages: number };

export type ShipmentDashboardSummary = {
  bookedToday: number;
  bookedYesterday: number;
  inTransit: number;
  delivered: number;
  onHold: number;
  exceptions: number;
};

/** Statuses a booked shipment can currently be in, newest stage last. */
export const shipmentStatusOptions = [
  { value: "SHIPMENT_BOOKED", label: "Booking Confirmed" },
  { value: "IN_TRANSIT", label: "In International Transit" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "RELEASED_FROM_HOLD", label: "Released From Hold" },
  { value: "PARCEL_COLLECTED", label: "Shipment Collected" },
  { value: "WAREHOUSE_SCAN_IN", label: "Received at Origin Facility" },
  { value: "ORIGIN_HUB_PROCESSED", label: "Processing for Export" },
  { value: "READY_FOR_EXPORT", label: "Ready for Dispatch" },
  { value: "ORIGIN_HUB_DISPATCHED", label: "Departed from Origin Facility" },
  { value: "DESTINATION_ARRIVED", label: "Arrived in Destination Country" },
  { value: "IMPORT_CUSTOMS_CLEARANCE", label: "Customs Clearance in Progress" },
  { value: "IMPORT_CUSTOMS_CLEARED", label: "Customs Cleared" },
  { value: "DELIVERY_PARTNER_TRANSFERRED", label: "Transferred to Delivery Partner" },
  { value: "DELIVERY_HUB_ARRIVED", label: "Arrived at Delivery Hub" },
  { value: "OUT_FOR_DELIVERY", label: "Out For Delivery" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "RETURNED", label: "Returned" },
  { value: "SHIPMENT_CANCELLED", label: "Cancelled" }
];

export async function fetchWithAuth(path: string, init?: RequestInit) {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body && !(typeof FormData !== "undefined" && init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`
    }
  });

  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  return response;
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(path, init);
  const payload = await readJsonSafely(response) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "The shipment request could not be completed.");
  }
  return payload as T;
}

/**
 * The columns the server can order by, and what each is called on screen.
 *
 * Consignee and destination are deliberately absent: both are displayed as a
 * fallback of two stored fields, and the database can only order by one, so a
 * sort arrow on them would reorder rows in a way that looks broken. See
 * `shipmentSortFields` on the server for the full reasoning.
 */
export const shipmentSortableColumns: Record<string, string> = {
  booked: "Created",
  service: "Service",
  pieces: "Pieces"
};

export function shipmentListPath(audience: ShipmentAudience) {
  return audience === "client" ? "/api/v1/client/booked-shipments" : "/api/v1/shipments";
}

/**
 * Query string for a shipment list request.
 *
 * Shared with the export so a downloaded file carries exactly the filters on
 * screen- building the two separately is how they drift apart.
 */
export function shipmentListParams(input: {
  page?: number;
  limit?: number;
  status?: string;
  attention?: boolean;
  /** Filters by the carrier booking's calendar day, not draft creation day. */
  bookedDate?: string;
  /** Keeps only shipments whose draft was created by the rebooking flow. */
  rebooked?: boolean;
  search?: string;
  dateRange?: DateRange;
  businessAccountId?: string;
  /** Staff-only filter for self-serve public bookings. */
  creationSource?: "PUBLIC_ONLINE";
  branchId?: string;
  sort?: string;
  destinationRegions?: ShipmentDestinationRegionCode[];
} = {}) {
  const params = new URLSearchParams();
  params.set("page", String(input.page ?? 1));
  params.set("limit", String(input.limit ?? 20));
  if (input.status) params.set("status", input.status);
  if (input.attention) params.set("attention", "1");
  if (input.bookedDate) params.set("bookedDate", input.bookedDate);
  if (input.rebooked) params.set("rebooked", "1");
  if (input.search?.trim()) params.set("search", input.search.trim());
  setDateRangeParams(params, input.dateRange);
  if (input.businessAccountId) params.set("businessAccountId", input.businessAccountId);
  if (input.creationSource) params.set("creationSource", input.creationSource);
  if (input.branchId) params.set("branchId", input.branchId);
  if (input.sort) params.set("sort", input.sort);
  if (input.destinationRegions?.length) params.set("destinationRegions", input.destinationRegions.join(","));
  return params;
}

export async function listShipments(audience: ShipmentAudience, input: {
  page?: number;
  limit?: number;
  status?: string;
  attention?: boolean;
  bookedDate?: string;
  rebooked?: boolean;
  /** Free text over AWB, piece number, consignee, consignee address (including destination country/county/postcode), and your own reference. */
  search?: string;
  dateRange?: DateRange;
  businessAccountId?: string;
  /** Staff-only filter for self-serve public bookings. */
  creationSource?: "PUBLIC_ONLINE";
  branchId?: string;
  /** `field:asc|desc`, limited to the columns the server can order by. */
  sort?: string;
  /** Staff-only destination groups. */
  destinationRegions?: ShipmentDestinationRegionCode[];
} = {}) {
  const params = shipmentListParams(input);
  const base = shipmentListPath(audience);

  return requestJson<{
    success: true;
    shipments: ShipmentListItem[];
    pagination: ShipmentListPagination;
  }>(`${base}?${params.toString()}`);
}

export async function getShipmentDashboardSummary() {
  return requestJson<{ success: true } & ShipmentDashboardSummary>("/api/v1/shipments/summary");
}

/**
 * Takes a booked shipment off the shipment lists. Admin only; the server
 * refuses every other role.
 *
 * The delete is soft. The carrier booking, the tax invoice and its number, any
 * manifest, and the audit trail all stay where they are- this hides the
 * shipment rather than destroying anything, and it does not unwind the money.
 * Cancelling a shipment is still a separate action.
 */
export async function deleteBookedShipment(shipmentId: string) {
  return requestJson<{ success: true; message: string }>(
    `/api/v1/shipments/${shipmentId}`,
    { method: "DELETE" }
  );
}

export function shipmentDetailsHref(audience: ShipmentAudience, shipmentId: string) {
  return audience === "client" ? `/client/shipments/${shipmentId}` : `/dashboard/shipments/${shipmentId}`;
}
