import { requestJson } from "@/lib/shipmentsList";

export type FlightStatus =
  | "PLANNED"
  | "BOOKING_CONFIRMED"
  | "CARGO_ALLOCATED"
  | "MANIFEST_READY"
  | "HANDED_TO_AIRLINE"
  | "DEPARTED"
  | "IN_TRANSIT"
  | "CONNECTION"
  | "ARRIVED_DESTINATION"
  | "CUSTOMS"
  | "HANDED_TO_FINAL_MILE"
  | "CLOSED"
  | "CANCELLED";

/** UI wording is intentionally separate from stable backend status values. */
export const flightStatusLabel: Record<FlightStatus, string> = {
  PLANNED: "Legacy planned",
  BOOKING_CONFIRMED: "Booked",
  CARGO_ALLOCATED: "Cargo allocated",
  MANIFEST_READY: "Legacy manifest ready",
  HANDED_TO_AIRLINE: "Legacy airline handover",
  DEPARTED: "Departed",
  IN_TRANSIT: "Legacy in transit",
  CONNECTION: "Legacy connection",
  ARRIVED_DESTINATION: "Arrived at destination",
  CUSTOMS: "Legacy customs",
  HANDED_TO_FINAL_MILE: "Legacy final-mile handover",
  CLOSED: "Closed",
  CANCELLED: "Cancelled"
};

export function formatFlightStatus(status: FlightStatus | string) {
  return flightStatusLabel[status as FlightStatus] ?? status.replaceAll("_", " ");
}

export type FlightCardSummary = {
  tonightDepartures: number;
  awaitingFlight: number;
  departed: number;
  connectionRisk: number;
  offloaded: number;
  delayed: number;
  destinationArrived: number;
  actionRequiredExceptions: number;
};

export type FlightListItem = {
  _id: string;
  id: string;
  flightLinehaulNumber: string;
  branchId: string;
  flightNumber: string;
  airlineName: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  transitIataCode: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  actualDepartureAt: string | null;
  actualArrivalAt: string | null;
  capacityKg: number;
  allocatedWeightKg: number;
  utilisationPercent: number;
  totalShipments: number;
  totalBags: number;
  totalPieces: number;
  status: FlightStatus;
  connection: {
    transitAirportCode: string;
    scheduledArrivalAt: string | null;
    scheduledDepartureAt: string | null;
    actualArrivalAt: string | null;
    actualDepartureAt: string | null;
    layoverMinutes: number | null;
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "MISSED";
  } | null;
  customsStatus: "PENDING" | "SUBMITTED" | "CLEARED" | "HELD";
  customsClearedAt: string | null;
  customsSubmittedAt: string | null;
  destinationAgent: string;
  finalMileCarrier: string;
  arrivalAt: string | null;
  handoverAt: string | null;
  handoverReference: string;
  branch?: { name: string; code: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type FlightAllocation = {
  id: string;
  flightLinehaulId: string;
  branchId: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  awb: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  weightKg: number;
  pieces: number;
  activeParcelNumbers: string[];
  offloadedParcelNumbers: string[];
  parcelDetails: Array<{
    parcelNumber: string;
    actualWeightKg: number;
    volumetricWeightKg: number;
    chargeableWeightKg: number;
    status: "ALLOCATED" | "OFFLOADED" | "INACTIVE";
  }>;
  status: "ALLOCATED" | "CARRIED" | "REMOVED" | "OFFLOADED";
  allocatedAt: string;
  snapshot?: Record<string, unknown>;
};

export type FlightManifestRef = {
  id: string;
  manifestNumber: string;
  status: string;
  totalBags: number;
  totalConsignments: number;
  totalWeightKg: number;
  header: {
    flightNumber: string;
    mawbNumber: string;
    originIataCode: string;
    destinationIataCode: string;
    departureDate: string;
  };
};

export type FlightBag = {
  id: string;
  bagNumber: string;
  status: string;
  totalWeightKg: number;
  totalPhysicalParcels: number;
  totalConsignments: number;
};

export type FlightOffload = {
  id: string;
  reason: string;
  detail: string;
  airline: string;
  affectedShipmentIds: string[];
  affectedBagIds: string[];
  affectedParcels?: Array<{
    shipmentDraftId: string;
    parcelNumber: string;
    actualWeightKg: number;
    volumetricWeightKg: number;
    chargeableWeightKg: number;
  }>;
  affectedWeightKg: number;
  affectedPieces: number;
  replacementFlightId: string | null;
  createdAt: string;
};

export type FlightException = {
  id: string;
  flightLinehaulId: string;
  branchId: string;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  title: string;
  description: string;
  dedupeKey: string;
  dueAt: string | null;
  assignedTo: string | null;
  resolutionNotes: string;
  createdAt: string;
  flight?: { flightLinehaulNumber: string; flightNumber: string } | null;
};

export type FlightDocument = {
  id: string;
  flightLinehaulId: string;
  documentType: string;
  originalName: string;
  mimeType: string;
  size: number;
  note: string;
  createdAt: string;
};

export type FlightDetail = {
  flight: FlightListItem;
  stats: {
    allocatedWeightKg: number;
    utilisationPercent: number;
    totalShipments: number;
    totalBags: number;
    totalPieces: number;
    manifestCount: number;
  };
  allocations: FlightAllocation[];
  manifests: FlightManifestRef[];
  bags: FlightBag[];
  consignments: Array<{
    id: string;
    consignmentNumber: string;
    displayConsignmentNumber: string;
    weightKg: number;
    status: string;
    bagNumbers: string[];
    expectedParcelNumbers: string[];
    scannedParcelNumbers: string[];
  }>;
  offloads: FlightOffload[];
  exceptions: FlightException[];
  documents: FlightDocument[];
  auditHistory: Array<{ id: string; action: string; performedAt: string; metadata: Record<string, unknown> }>;
};

function qs(params: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listFlights(input: { page?: number; limit?: number; status?: string; branchId?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
  return requestJson<{ success: true; items: FlightListItem[]; pagination: { page: number; limit: number; total: number; pages: number } }>(
    `/api/v1/flight-linehauls${qs(input as Record<string, string | number | undefined>)}`
  );
}

export function getFlightSummary() {
  return requestJson<{ success: true; cards: FlightCardSummary; byStatus: Array<{ status: string; count: number }> }>(`/api/v1/flight-linehauls/summary`);
}

export function getFlightDetail(flightId: string) {
  return requestJson<{ success: true } & FlightDetail>(`/api/v1/flight-linehauls/${flightId}`);
}

export function createFlight(input: {
  branchId: string;
  flightNumber: string;
  airlineName?: string;
  mawbNumber?: string;
  originIataCode?: string;
  destinationIataCode?: string;
  transitIataCode?: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  capacityKg: number;
  destinationAgent?: string;
  finalMileCarrier?: string;
  manifestId: string;
  connection?: { transitAirportCode?: string; scheduledArrivalAt?: string; scheduledDepartureAt?: string } | null;
}) {
  return requestJson<{ success: true; message: string; flightId: string; flightLinehaulNumber: string }>(`/api/v1/flight-linehauls`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateFlight(flightId: string, input: Partial<{ airlineName: string; mawbNumber: string; originIataCode: string; destinationIataCode: string; transitIataCode: string; scheduledDepartureAt: string; scheduledArrivalAt: string; capacityKg: number; destinationAgent: string; finalMileCarrier: string }>) {
  return requestJson<{ success: true; message: string; flight: FlightListItem }>(`/api/v1/flight-linehauls/${flightId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function transitionFlight(flightId: string, toStatus: FlightStatus, reason = "", metadata: Record<string, unknown> = {}) {
  return requestJson<{ success: true; message: string; flight: FlightListItem }>(`/api/v1/flight-linehauls/${flightId}/status`, {
    method: "POST",
    body: JSON.stringify({ toStatus, reason, metadata })
  });
}

export function cancelFlight(flightId: string, reason: string) {
  return requestJson<{ success: true; message: string; flight: FlightListItem }>(`/api/v1/flight-linehauls/${flightId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

export function searchEligibleShipments(input: { q?: string; branchId?: string; limit?: number } = {}) {
  return requestJson<{ success: true; shipments: Array<{ shipmentDraftId: string; dpdShipmentId: string; awb: string; weightKg: number; pieces: number; destinationCountryCode: string; destinationCountryName: string }> }>(
    `/api/v1/flight-linehauls/eligible-shipments${qs(input as Record<string, string | number | undefined>)}`
  );
}

export function allocateShipments(flightId: string, shipmentDraftIds: string[]) {
  return requestJson<{ success: true; message: string; results: Array<{ shipmentDraftId: string; status: string; reason?: string }>; allocatedCount: number }>(
    `/api/v1/flight-linehauls/${flightId}/shipments/allocate`,
    { method: "POST", body: JSON.stringify({ shipmentDraftIds }) }
  );
}

export function removeAllocation(flightId: string, allocationId: string, reason: string) {
  return requestJson<{ success: true; message: string }>(`/api/v1/flight-linehauls/${flightId}/shipments/${allocationId}`, {
    method: "DELETE",
    body: JSON.stringify({ reason })
  });
}

export function moveAllocation(flightId: string, allocationId: string, targetFlightId: string, reason: string) {
  return requestJson<{ success: true; message: string }>(`/api/v1/flight-linehauls/${flightId}/shipments/${allocationId}/move`, {
    method: "POST",
    body: JSON.stringify({ targetFlightId, reason })
  });
}

export function listAttachableManifests(flightId: string) {
  return requestJson<{ success: true; manifests: FlightManifestRef[] }>(`/api/v1/flight-linehauls/${flightId}/manifests/options`);
}

export function attachManifest(flightId: string, manifestId: string) {
  return requestJson<{ success: true; message: string }>(`/api/v1/flight-linehauls/${flightId}/manifests/attach`, {
    method: "POST",
    body: JSON.stringify({ manifestId })
  });
}

export function detachManifest(flightId: string, manifestId: string, reason = "") {
  return requestJson<{ success: true; message: string }>(`/api/v1/flight-linehauls/${flightId}/manifests/${manifestId}`, {
    method: "DELETE",
    body: JSON.stringify({ reason })
  });
}

export function updateConnection(flightId: string, input: { transitAirportCode: string; scheduledArrivalAt?: string | null; scheduledDepartureAt?: string | null; actualArrivalAt?: string | null; actualDepartureAt?: string | null }) {
  return requestJson<{ success: true; message: string; flight: FlightListItem }>(`/api/v1/flight-linehauls/${flightId}/connection`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function createOffload(flightId: string, input: { reason: string; offloadReason: string; airline?: string; affectedParcels: Array<{ shipmentDraftId: string; parcelNumber: string }>; responsibleEmployeeId?: string | null }) {
  return requestJson<{ success: true; message: string; offload: FlightOffload }>(`/api/v1/flight-linehauls/${flightId}/offloads`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateHandover(flightId: string, input: { arrivalAt?: string | null; customsStatus?: string; customsNote?: string; customsClearedAt?: string | null; destinationAgent?: string; finalMileCarrier?: string; handoverAt?: string | null; handoverReference?: string }) {
  return requestJson<{ success: true; message: string; flight: FlightListItem }>(`/api/v1/flight-linehauls/${flightId}/handover`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function listFlightDocuments(flightId: string) {
  return requestJson<{ success: true; documents: FlightDocument[] }>(`/api/v1/flight-linehauls/${flightId}/documents`);
}

export async function uploadFlightDocument(flightId: string, file: File, documentType: string, note = "") {
  const { getAccessToken, refreshAccessToken } = await import("@/lib/auth");
  const { apiUrl } = await import("@/lib/api");
  let token = getAccessToken() ?? (await refreshAccessToken());
  if (!token) throw new Error("Session expired.");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("documentType", documentType);
  fd.append("note", note);
  let res = await fetch(apiUrl(`/api/v1/flight-linehauls/${flightId}/documents`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  if (res.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Session expired.");
    res = await fetch(apiUrl(`/api/v1/flight-linehauls/${flightId}/documents`), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd
    });
  }
  const data = (await res.json()) as { success?: boolean; message?: string };
  if (!res.ok || !data.success) throw new Error(data.message || "Upload failed.");
  return data as { success: true; message: string; document: FlightDocument };
}

export function deleteFlightDocument(flightId: string, documentId: string) {
  return requestJson<{ success: true; message: string }>(`/api/v1/flight-linehauls/${flightId}/documents/${documentId}`, {
    method: "DELETE"
  });
}

export function downloadFlightDocument(flightId: string, documentId: string, view = false) {
  // handled via direct fetch with auth
  return { flightId, documentId, view };
}

export function listFlightExceptions(input: { flightId?: string; status?: string; severity?: string; type?: string; page?: number; limit?: number } = {}) {
  const base = input.flightId ? `/api/v1/flight-linehauls/${input.flightId}/exceptions` : `/api/v1/flight-linehauls/exceptions`;
  const rest = { ...input };
  delete (rest as Record<string, unknown>).flightId;
  return requestJson<{ success: true; items: FlightException[]; pagination: { page: number; limit: number; total: number; pages: number } }>(`${base}${qs(rest as Record<string, string | number | undefined>)}`);
}

export function acknowledgeException(exceptionId: string) {
  return requestJson<{ success: true; message: string; exception: FlightException }>(`/api/v1/flight-linehauls/exceptions/${exceptionId}/acknowledge`, {
    method: "POST"
  });
}

export function updateException(exceptionId: string, input: { assignedTo?: string | null; status?: string; resolutionNotes?: string }) {
  return requestJson<{ success: true; message: string; exception: FlightException }>(`/api/v1/flight-linehauls/exceptions/${exceptionId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function resolveException(exceptionId: string, resolutionNotes: string) {
  return requestJson<{ success: true; message: string; exception: FlightException }>(`/api/v1/flight-linehauls/exceptions/${exceptionId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolutionNotes })
  });
}
