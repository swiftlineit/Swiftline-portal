import { apiUrl } from "@/lib/api";
import { setDateRangeParams, type DateRange } from "@/lib/dateRange";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";

export type ManifestStatus =
  | "DRAFT"
  | "PACKING"
  | "READY_TO_SEAL"
  | "SEALED"
  | "DISPATCHED"
  | "CANCELLED";
export type ManifestHeader = {
  destinationAgent: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  flightNumber: string;
  departureDate: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  valueType: string;
};
export type OperationsManifest = {
  id: string;
  manifestNumber: string;
  branchId: string;
  flightLinehaulId?: string | null;
  branch?: { name: string; code: string } | null;
  header: ManifestHeader;
  status: ManifestStatus;
  totalBags: number;
  totalConsignments: number;
  totalPhysicalParcels: number;
  totalWeightKg: number;
  createdAt: string;
  updatedAt: string;
};
export type OperationsBag = {
  id: string;
  bagNumber: string;
  barcode?: string;
  status: "OPEN" | "CLOSED" | "READY" | "REOPENED" | "CANCELLED";
  totalConsignments: number;
  totalPhysicalParcels: number;
  totalWeightKg: number;
};
export type OperationsParcelValue = {
  parcelNumber: string;
  valueMinor: number | null;
};
export type OperationsParcelDisposition =
  | "HELD"
  | "DEFERRED_TO_NEXT_MANIFEST"
  | "CANCELLED";
export type OperationsConsignment = {
  id: string;
  bagId: string;
  bagIds: string[];
  bagNumbers: string[];
  consignmentNumber: string;
  displayConsignmentNumber: string;
  expectedParcelNumbers: string[];
  scannedParcelNumbers: string[];
  parcelDispositions: Array<{
    parcelNumber: string;
    disposition: OperationsParcelDisposition;
    reason: string;
    recordedAt: string;
  }>;
  parcelValues: OperationsParcelValue[];
  weightKg: number;
  status: "PARTIAL" | "COMPLETE";
  consigneeSnapshot: { name?: string; formatted?: string };
  consignorSnapshot: { name?: string; formatted?: string };
  description: string;
  declaredValueMinor?: number | null;
  serviceInfo: string;
  goodsValueRequired: boolean;
  dpdWarning: string;
};
export type OperationsScan = {
  id: string;
  bagId: string | null;
  parcelNumber: string;
  status: "ACCEPTED" | "REJECTED" | "REMOVED";
  message: string;
  scannedAt: string;
};
export type ManifestDetail = {
  manifest: OperationsManifest;
  bags: OperationsBag[];
  consignments: OperationsConsignment[];
  scans: OperationsScan[];
  latestScan: OperationsScan | null;
  sealingIssues: string[];
  destinationSummary: Array<{
    countryCode: string;
    countryName: string;
    consignments: number;
    parcels: number;
  }>;
  dispatchIssues: Array<{
    shipmentDraftId: string;
    reference: string;
    reason: string;
    missingStatuses: string[];
  }>;
};
export type OperationsScanResult = {
  scanId: string;
  parcelNumber: string;
  message: string;
  bag: {
    id: string;
    bagNumber: string;
    status: OperationsBag["status"];
    totalPhysicalParcels: number;
    totalWeightKg: number;
  };
  manifestTotals: {
    totalBags: number;
    totalConsignments: number;
    totalPhysicalParcels: number;
    totalWeightKg: number;
  };
  consignment: {
    displayConsignmentNumber: string;
    scannedParcels: number;
    expectedParcels: number;
    weightKg: number;
    serviceInfo: string;
    description: string;
    consigneeSnapshot: { name?: string; formatted?: string };
  };
};
export type OperationsScanSession = {
  id: string;
  manifestId: string;
  branchId: string;
  status: "PENDING" | "ACTIVE" | "ENDED";
  pairingExpiresAt: string;
  sessionExpiresAt: string;
  connectedAt: string | null;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  endedReason: string;
  manifest: {
    manifestNumber: string;
    status: ManifestStatus;
    destinationCountryCode: string;
    destinationCountryName: string;
    totalPhysicalParcels: number;
    totalWeightKg: number;
  } | null;
  activeBag: {
    id: string;
    bagNumber: string;
    status: OperationsBag["status"];
    totalPhysicalParcels: number;
    totalWeightKg: number;
  } | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token = getAccessToken() ?? (await refreshAccessToken());
  let response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 401) {
    token = await refreshAccessToken();
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }
  const data = (await readJsonSafely(response)) as {
    success?: boolean;
    message?: string;
  };
  if (!response.ok || !data.success) {
    throw new Error(
      data.message ||
        (response.status === 429
          ? "The scanner is sending requests too quickly. Pause briefly and try again."
          : "") ||
        "The operations manifest request could not be completed.",
    );
  }
  return data as T;
}

export const listManifestBranches = () =>
  request<{
    success: true;
    branches: Array<{ id: string; name: string; code: string }>;
  }>("/api/v1/operations-manifests/branches/options");
export const listOperationsManifests = (
  page = 1,
  status = "",
  dateRange?: DateRange,
) => {
  const params = new URLSearchParams({ page: String(page), limit: "15" });
  if (status) params.set("status", status);
  setDateRangeParams(params, dateRange);
  return request<{
    success: true;
    items: OperationsManifest[];
    pagination: { page: number; pages: number; total: number };
  }>(`/api/v1/operations-manifests?${params.toString()}`);
};
export const createOperationsManifest = (body: {
  branchId: string;
  header: ManifestHeader;
}) =>
  request<{ success: true; manifestId: string; manifestNumber: string }>(
    "/api/v1/operations-manifests",
    { method: "POST", body: JSON.stringify(body) },
  );
export const updateOperationsManifest = (id: string, body: { header: ManifestHeader }) =>
  request<{ success: true; message: string }>(
    `/api/v1/operations-manifests/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const getOperationsManifest = (id: string) =>
  request<{ success: true } & ManifestDetail>(
    `/api/v1/operations-manifests/${id}`,
  );
export const deleteOperationsManifest = (id: string, confirmationManifestNumber: string) =>
  request<{
    success: true;
    message: string;
    deleted: { manifestNumber: string; status: ManifestStatus; numberWillBeReused: boolean };
  }>(`/api/v1/operations-manifests/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmationManifestNumber })
  });
export const createOperationsBag = (id: string) =>
  request(`/api/v1/operations-manifests/${id}/bags`, {
    method: "POST",
    body: "{}",
  });
export const scanOperationsParcel = (
  id: string,
  parcelNumber: string,
  scanRequestId: string,
  options?: {
    scanSource?: "MANUAL" | "CAMERA" | "HARDWARE";
    sessionId?: string;
  },
) =>
  request<{ success: true; scanResult: OperationsScanResult }>(
    `/api/v1/operations-manifests/${id}/scan`,
    {
      method: "POST",
      body: JSON.stringify({
        parcelNumber,
        scanRequestId,
        responseMode: "COMPACT",
        ...options,
      }),
    },
  );
export const createOperationsScanSession = (manifestId: string) =>
  request<{
    success: true;
    session: OperationsScanSession;
    qrDataUri: string;
  }>(`/api/v1/operations-manifests/${manifestId}/scan-sessions`, {
    method: "POST",
    body: "{}",
  });
export const pairOperationsScanSession = (token: string) =>
  request<{
    success: true;
    session: OperationsScanSession;
  }>("/api/v1/operations-manifests/scan-sessions/pair", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
export const getOperationsScanSession = (sessionId: string) =>
  request<{
    success: true;
    session: OperationsScanSession;
  }>(`/api/v1/operations-manifests/scan-sessions/${sessionId}/status`);
export const getActiveOperationsScanSession = (manifestId: string) =>
  request<{
    success: true;
    session: OperationsScanSession | null;
  }>(`/api/v1/operations-manifests/${manifestId}/scan-sessions/active`);
export const changeOperationsScanSessionBag = (
  manifestId: string,
  sessionId: string,
  activeBagId: string,
) =>
  request<{
    success: true;
    session: OperationsScanSession;
  }>(
    `/api/v1/operations-manifests/${manifestId}/scan-sessions/${sessionId}/bag`,
    {
      method: "PATCH",
      body: JSON.stringify({ activeBagId }),
    },
  );
export const disconnectOperationsScanSession = (
  manifestId: string,
  sessionId: string,
) =>
  request<{
    success: true;
    session: OperationsScanSession;
  }>(`/api/v1/operations-manifests/${manifestId}/scan-sessions/${sessionId}`, {
    method: "DELETE",
  });
export const runManifestAction = (
  id: string,
  action: "seal" | "dispatch" | "cancel",
  reason = "",
  options?: {
    confirmMixedDestinations?: boolean;
    method?: "BUTTON" | "BARCODE_SCAN";
    scannedBarcode?: string;
  },
) =>
  request<{ success: true; message: string }>(
    `/api/v1/operations-manifests/${id}/${action}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(reason ? { reason } : {}),
        ...(options ?? {}),
      }),
    },
  );
export const runBagAction = (
  id: string,
  bagId: string,
  action: "close" | "reopen" | "cancel",
  reason = "",
) =>
  request<{ success: true; message: string }>(
    `/api/v1/operations-manifests/${id}/bags/${bagId}/${action}`,
    { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
  );
export const closeAllOperationsBags = (id: string) =>
  request<{ success: true; message: string; result: { closed: number; bagNumbers: string[] } }>(
    `/api/v1/operations-manifests/${id}/bags/close-all`,
    { method: "POST", body: "{}" },
  );
export const markOperationsBagReady = (manifestId: string, bagBarcode: string) =>
  request<{
    success: true;
    message: string;
    result: { bagNumber: string; updatedShipments: number; alreadyReady: boolean };
  }>(`/api/v1/operations-manifests/${manifestId}/bags/ready`, {
    method: "POST",
    body: JSON.stringify({ bagBarcode }),
  });
export const removeOperationsScan = (
  id: string,
  scanId: string,
  reason: string,
) =>
  request(`/api/v1/operations-manifests/${id}/scans/${scanId}/remove`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
export const setOperationsParcelDisposition = (
  manifestId: string,
  consignmentId: string,
  parcelNumber: string,
  disposition: OperationsParcelDisposition,
  reason: string,
) =>
  request<{ success: true; message: string }>(
    `/api/v1/operations-manifests/${manifestId}/consignments/${consignmentId}/parcel-disposition`,
    {
      method: "PUT",
      body: JSON.stringify({ parcelNumber, disposition, reason }),
    },
  );

// EDI and OPS EDI exports live at their own paths; xlsx and pdf share the export.<format> route.
// `fileName` builds the download name from the manifest number.
const manifestExportPaths: Record<
  "xlsx" | "pdf" | "edi" | "opsEdi" | "uk",
  { path: string; fileName: (manifestNumber: string) => string }
> = {
  xlsx: {
    path: "export.xlsx",
    fileName: (number) => `ops-manifest-${number}.xlsx`,
  },
  pdf: {
    path: "export.pdf",
    fileName: (number) => `ops-manifest-${number}.pdf`,
  },
  edi: { path: "export-edi.xlsx", fileName: (number) => `edi-${number}.xlsx` },
  opsEdi: { path: "export-ops-edi.xls", fileName: (number) => `ops-edi-${number}.xls` },
  uk: {
    path: "export-uk.xlsx",
    fileName: (number) => `${number.toUpperCase()}UKmanifest.xlsx`,
  },
};

export async function downloadOperationsManifest(
  id: string,
  format: "xlsx" | "pdf" | "edi" | "opsEdi" | "uk",
  view = false,
  manifestNumber = "",
) {
  const token = getAccessToken() ?? (await refreshAccessToken());
  const target = manifestExportPaths[format];
  const response = await fetch(
    apiUrl(
      `/api/v1/operations-manifests/${id}/${target.path}${view ? "?view=1" : ""}`,
    ),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || "Manifest export could not be opened.");
  }
  if (format === "opsEdi") {
    const encodedWarnings = response.headers.get("X-OPS-EDI-Warnings");
    if (encodedWarnings) {
      try {
        const warnings = JSON.parse(atob(encodedWarnings)) as Array<{ message?: string }>;
        if (warnings.length) {
          const visible = warnings.slice(0, 3).map((warning) => warning.message).filter(Boolean).join(" ");
          const remaining = warnings.length > 3 ? ` ${warnings.length - 3} more warning${warnings.length - 3 === 1 ? "" : "s"}.` : "";
          window.dispatchEvent(new CustomEvent("swiftline:ops-edi-warnings", { detail: `${visible}${remaining}` }));
        }
      } catch {
        // A malformed optional warning header must never block the workbook download.
      }
    }
  }
  const url = URL.createObjectURL(await response.blob());
  if (view) window.open(url, "_blank", "noopener,noreferrer");
  else {
    const link = document.createElement("a");
    link.href = url;
    link.download = target.fileName(manifestNumber || id);
    link.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
