import { apiUrl } from "@/lib/api";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";
import type { Driver } from "@/lib/drivers";

export type PickupAddress = {
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  postcode: string;
  countryCode: string;
  countryName?: string;
  googlePlaceId?: string;
};
export type PickupParcel = {
  parcelNumber: string;
  weightKg: number;
  status: string;
  exceptionReason?: string;
  collectedAt?: string | null;
  hubReceivedAt?: string | null;
  hubReceiptOutcome?: "RECEIVED" | "NOT_RECEIVED" | null;
};
export type PickupShipment = {
  _id: string;
  shipmentDraftId: string;
  trackingNumber: string;
  status: string;
  hubReceiptRecordedAt?: string | null;
  parcels: PickupParcel[];
};
export type PickupReceivedParcel = {
  shipmentDraftId: string;
  parcelNumber: string;
};
export type PickupAttempt = {
  _id: string;
  id?: string;
  sequence: number;
  status: string;
  scheduledWindow: { startAt: string; endAt: string; timezone: string };
  assignedDriverProfileId?: {
    _id: string;
    engagementType: string;
    status: string;
  } | null;
  assignedDriverUserId?: {
    _id: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    phone?: string;
  } | null;
  vehicle?: { source?: string; type?: string; registrationNumber?: string };
  otpVerifiedAt?: string | null;
  otpExceptionReason?: string;
  otpExceptionRequestedAt?: string | null;
  otpExceptionApprovedBy?: string | null;
  otpExceptionApprovedAt?: string | null;
  otpExceptionRejectedAt?: string | null;
  otpExceptionReviewNote?: string;
  arrivalLocation?: PickupLocation | null;
  completionLocation?: PickupLocation | null;
  proofs?: Array<{
    id: string;
    type: "PHOTO" | "SIGNATURE";
    source?: "DRIVER" | "STAFF";
    originalName: string;
    size: number;
    capturedAt: string;
  }>;
  pickup?: PickupSummary | null;
};
export type PickupLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
};
export type PickupArrivalWindow = "MORNING" | "AFTERNOON" | "EVENING" | "EXACT";
export type PickupBusinessOption = {
  businessAccountId: string;
  accountId: string;
  companyName: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  canRequestStandalone: boolean;
  contact: { name: string; email: string; phone: string };
};
export type PickupCourierAddress = {
  id: string;
  branchId: string;
  companyName: string;
  address: PickupAddress;
  contact: { name: string; phone: string };
  updatedAt?: string;
};
export type PickupCourierBranch = { id: string; name: string; code: string };
export type PickupFormContext = {
  businesses: PickupBusinessOption[];
  requester: { name: string; email: string; phone: string };
  courierAddresses: PickupCourierAddress[];
};
export type PickupDocument = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
};
export type PickupSummary = {
  _id: string;
  id: string;
  requestNumber: string;
  status: string;
  businessAccountId: string;
  businessAccountName?: string;
  branchId: string | { _id: string; name: string; code: string };
  pickupAddress: Record<string, string>;
  pickupContact: { name: string; email?: string; phone: string };
  requestedWindow: { startAt: string; endAt: string; timezone: string };
  dispatchAt?: string | null;
  expectedDelhiArrival?: {
    date: string;
    window: PickupArrivalWindow;
    exactAt?: string | null;
    timezone: string;
  } | null;
  transportCompany?: string;
  handlingRemarks?: string;
  pickupPartnerInfo?: string;
  documents?: PickupDocument[];
  confirmedWindow?: { startAt: string; endAt: string; timezone: string } | null;
  instructions?: string;
  shipmentCount: number;
  totalBoxes?: number;
  parcelCount: number;
  totalWeightKg?: number;
  createdAt: string;
  pickupStartedAt?: string | null;
  receivedAtDelhiHubAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string;
  cancellationSource?: "CLIENT" | "ADMIN" | null;
  cancelledBy?:
    | {
        _id: string;
        firstName?: string;
        lastName?: string;
        name?: string;
        role?: string;
      }
    | string
    | null;
};
export type PickupDetail = PickupSummary & {
  requester?: { name: string; email: string } | null;
  shipments: PickupShipment[];
  attempts: PickupAttempt[];
};
export type EligiblePickupShipment = {
  shipmentDraftId: string;
  businessAccountId: string;
  branchId: string;
  trackingNumber: string;
  parcelNumbers: string[];
  parcelCount: number;
  totalWeightKg: number;
  pickupAddress: Record<string, string>;
  addressFingerprint: string;
  bookedAt: string;
};

export function formatPickupWeightKg(value?: number | null, gross = false) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)} kg${gross ? " gross weight" : ""}`
    : "Weight unavailable";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token = getAccessToken() ?? (await refreshAccessToken());
  if (!token) throw new Error("Your session has expired.");
  const isForm = init?.body instanceof FormData;
  const send = () =>
    fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init?.body && !isForm
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired.");
    response = await send();
  }
  const payload = (await readJsonSafely(response)) as {
    success?: boolean;
    message?: string;
  };
  if (!response.ok || !payload.success)
    throw new Error(
      payload.message || "The pickup request could not be completed.",
    );
  return payload as T;
}

async function requestBlob(path: string) {
  let token = getAccessToken() ?? (await refreshAccessToken());
  if (!token) throw new Error("Your session has expired.");
  const send = () =>
    fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired.");
    response = await send();
  }
  if (!response.ok) {
    const payload = (await readJsonSafely(response)) as { message?: string };
    throw new Error(payload.message || "Pickup document could not be opened.");
  }
  return URL.createObjectURL(await response.blob());
}

export const pickupVehicleTypes = [
  "Bike",
  "Scooter",
  "Car",
  "Mini van",
  "Van",
  "Pickup truck",
  "Light truck",
  "Truck",
] as const;
export const pickupTransportCompanies = [
  "ALL ROUNDER COURIER",
  "AR LOGISTICS",
  "SHREE MARUTI",
  "DTDC",
  "BLUE DART",
  "FIRST FLY",
  "Delhivery",
  "DHL",
  "SPEED GLOBAL",
  "SEKHAWATI",
  "JAI MAA COURIER",
] as const;

export function getClientPickupFormContext() {
  return request<{ success: true } & PickupFormContext>(
    "/api/v1/client/pickups/form-context",
  );
}
export function listPickupCourierAddresses() {
  return request<{ success: true; branches: PickupCourierBranch[]; courierAddresses: PickupCourierAddress[] }>(
    "/api/v1/pickups/courier-addresses",
  );
}
export function savePickupCourierAddress(
  value: Omit<PickupCourierAddress, "id" | "updatedAt">,
  id?: string,
) {
  return request<{ success: true; courierAddress: PickupCourierAddress }>(
    id ? `/api/v1/pickups/courier-addresses/${encodeURIComponent(id)}` : "/api/v1/pickups/courier-addresses",
    { method: id ? "PUT" : "POST", body: JSON.stringify(value) },
  );
}
export function listEligiblePickupShipments() {
  return request<{ success: true; shipments: EligiblePickupShipment[] }>(
    "/api/v1/client/pickups/eligible-shipments",
  );
}
/**
 * The six views item 19 asks for, expressed over the stored statuses.
 *
 * "Today" is a date range rather than a status, because a pickup happening
 * today can be scheduled, assigned or already collected- it is a question
 * about when, not about what state the request is in.
 */
export const pickupViews = [
  { key: "", label: "All" },
  { key: "today", label: "Today's Pickups" },
  { key: "CONFIRMED", label: "Scheduled" },
  { key: "DRIVER_ASSIGNED", label: "Driver Assigned" },
  { key: "IN_PROGRESS", label: "Pickup in progress" },
  { key: "RECEIVED_AT_DELHI_HUB", label: "Received at Delhi hub" },
  {
    key: "COMPLETED_WITH_MISSING_PARCELS",
    label: "Completed - parcels missing",
  },
  { key: "COLLECTED", label: "Collected from sender" },
  { key: "MISSED", label: "Missed Pickup" },
  { key: "CANCELLED", label: "Cancelled" },
] as const;

/** Mirrors `pickupRequestStatusLabels` on the server. */
export const pickupStatusLabels: Record<string, string> = {
  REQUESTED: "Requested",
  CONFIRMED: "Scheduled",
  DRIVER_ASSIGNED: "Driver Assigned",
  IN_PROGRESS: "In Progress",
  ACTION_REQUIRED: "Action Required",
  PARTIALLY_COLLECTED: "Partially Collected",
  COLLECTED: "Collected",
  RECEIVED_AT_DELHI_HUB: "Received at Delhi hub",
  COMPLETED_WITH_MISSING_PARCELS: "Completed - parcels missing",
  MISSED: "Missed Pickup",
  CANCELLED: "Cancelled",
  CLOSED_UNSUCCESSFUL: "Closed Unsuccessful",
};

export const CLIENT_PICKUPS_PATH = "/api/v1/client/pickups";

/** Mirrors `reschedulablePickupStatuses` on the server. */
export const reschedulableClientPickupStatuses = [
  "REQUESTED",
  "CONFIRMED",
  "DRIVER_ASSIGNED",
  "ACTION_REQUIRED",
  "MISSED",
];

/** Today in IST, as the yyyy-mm-dd the date filter speaks. */
function istToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
}

export function pickupListParams(
  input: { view?: string; dateFrom?: string; dateTo?: string } = {},
) {
  const params = new URLSearchParams();
  if (input.view === "today") {
    const today = istToday();
    params.set("dateFrom", today);
    params.set("dateTo", today);
  } else if (input.view) {
    params.set("status", input.view);
  }
  // An explicit range always wins over the shorthand above.
  if (input.dateFrom) params.set("dateFrom", input.dateFrom);
  if (input.dateTo) params.set("dateTo", input.dateTo);
  return params;
}

export function listClientPickups(
  input: { view?: string; dateFrom?: string; dateTo?: string } = {},
) {
  const query = pickupListParams(input).toString();
  return request<{ success: true; pickups: PickupSummary[] }>(
    `${CLIENT_PICKUPS_PATH}${query ? `?${query}` : ""}`,
  );
}

export function rescheduleClientPickup(
  id: string,
  dispatch: { dispatchDate: string; dispatchTime: string },
) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `${CLIENT_PICKUPS_PATH}/${id}/reschedule`,
    { method: "POST", body: JSON.stringify(dispatch) },
  );
}
export function getClientPickup(id: string) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/client/pickups/${id}`,
  );
}
export type CreateClientPickupInput = {
  businessAccountId: string;
  shipmentDraftIds: string[];
  dispatchDate: string;
  dispatchTime: string;
  expectedDelhiArrival: {
    date: string;
    window: PickupArrivalWindow;
    exactTime?: string;
  };
  transportCompany: string;
  contact: { name: string; phone: string };
  pickupAddress: PickupAddress;
  totalBoxes?: number;
  totalWeightKg?: number;
  handlingRemarks?: string;
  documents?: File[];
};
export function createClientPickup(input: CreateClientPickupInput) {
  const form = new FormData();
  const { documents = [], ...requestBody } = input;
  form.append("request", JSON.stringify(requestBody));
  documents.forEach((file) => form.append("documents", file, file.name));
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    "/api/v1/client/pickups",
    { method: "POST", body: form },
  );
}
export function cancelClientPickup(id: string, reason: string) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/client/pickups/${id}/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
export function listInternalPickups() {
  return request<{ success: true; pickups: PickupSummary[] }>(
    "/api/v1/pickups",
  );
}
export function listAvailablePickupDrivers() {
  return request<{ success: true; drivers: Driver[] }>(
    "/api/v1/pickups/available-drivers",
  );
}
export function getInternalPickup(id: string) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}`,
  );
}
export function confirmInternalPickup(id: string) {
  return request<{ success: true; pickup: PickupDetail; attemptId: string }>(
    `/api/v1/pickups/${id}/confirm`,
    { method: "POST" },
  );
}
export function updateInternalPickupStatus(
  id: string,
  status: "IN_PROGRESS" | "RECEIVED_AT_DELHI_HUB",
  receivedParcels?: PickupReceivedParcel[],
) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}/status`,
    {
      method: "POST",
      body: JSON.stringify({
        status,
        ...(receivedParcels ? { receivedParcels } : {}),
      }),
    },
  );
}
export function updateInternalPickupPartnerInfo(
  id: string,
  information: string,
) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}/partner-info`,
    { method: "PUT", body: JSON.stringify({ information }) },
  );
}
export function assignInternalPickup(
  id: string,
  input: {
    attemptId: string;
    driverProfileId: string;
    vehicle: { source: string; type: string; registrationNumber: string };
  },
) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}/assign`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
export function cancelInternalPickup(id: string, reason: string) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
export function reviewInternalPickupOtpException(
  id: string,
  input: { attemptId: string; approved: boolean; reviewNote?: string },
) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/pickups/${id}/otp-exception/review`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
export function listMyPickupAttempts() {
  return request<{ success: true; attempts: PickupAttempt[] }>(
    "/api/v1/driver/pickups/attempts",
  );
}
export function getMyPickupAttempt(id: string) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}`,
  );
}
export function updateMyPickupStatus(
  id: string,
  status: string,
  location?: PickupLocation,
) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}/status`,
    { method: "POST", body: JSON.stringify({ status, location }) },
  );
}
export function requestMyPickupOtp(id: string) {
  return request<{
    success: true;
    sent: boolean;
    skipped: boolean;
    expiresAt: string;
  }>(`/api/v1/driver/pickups/attempts/${id}/otp/request`, { method: "POST" });
}
export function verifyMyPickupOtp(id: string, code: string) {
  return request<{ success: true; verifiedAt: string }>(
    `/api/v1/driver/pickups/attempts/${id}/otp/verify`,
    { method: "POST", body: JSON.stringify({ code }) },
  );
}
export function requestMyPickupOtpException(id: string, reason: string) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}/otp/exception`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
export function scanMyPickupParcel(
  id: string,
  parcelNumber: string,
  scanRequestId: string,
) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}/scan`,
    { method: "POST", body: JSON.stringify({ parcelNumber, scanRequestId }) },
  );
}
export function addMyPickupException(
  id: string,
  input: { parcelNumber: string; status: string; reason: string },
) {
  return request<{ success: true; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}/exceptions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
export function uploadMyPickupProof(
  id: string,
  type: "PHOTO" | "SIGNATURE",
  file: Blob,
  filename: string,
) {
  const form = new FormData();
  form.append("proof", file, filename);
  return request<{ success: true; message: string }>(
    `/api/v1/driver/pickups/attempts/${id}/proofs/${type}`,
    { method: "POST", body: form },
  );
}
export function completeMyPickup(id: string, location?: PickupLocation) {
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/driver/pickups/attempts/${id}/complete`,
    { method: "POST", body: JSON.stringify({ location }) },
  );
}
export function loadClientPickupProof(pickupId: string, proofId: string) {
  return requestBlob(`/api/v1/client/pickups/${pickupId}/proofs/${proofId}`);
}
export function loadInternalPickupProof(pickupId: string, proofId: string) {
  return requestBlob(`/api/v1/pickups/${pickupId}/proofs/${proofId}`);
}
export function uploadInternalPickupProof(pickupId: string, file: File) {
  const form = new FormData();
  form.append("proof", file, file.name);
  return request<{ success: true; message: string; pickup: PickupDetail }>(
    `/api/v1/pickups/${pickupId}/proofs`,
    { method: "POST", body: form },
  );
}
export function loadClientPickupDocument(pickupId: string, documentId: string) {
  return requestBlob(
    `/api/v1/client/pickups/${pickupId}/documents/${documentId}`,
  );
}
export function loadInternalPickupDocument(
  pickupId: string,
  documentId: string,
) {
  return requestBlob(`/api/v1/pickups/${pickupId}/documents/${documentId}`);
}
export function loadDriverPickupProof(attemptId: string, proofId: string) {
  return requestBlob(
    `/api/v1/driver/pickups/attempts/${attemptId}/proofs/${proofId}`,
  );
}
