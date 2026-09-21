import { apiUrl } from "@/lib/api";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";

export type OperationsTrackingScanAction = "RECEIVE" | "PROCESS";
export type OperationsTrackingScanResult = {
  alreadyRecorded: boolean;
  status: string;
  statusLabel: string;
  eventAt: string;
  location: string;
  swiftlineTrackingNumber: string;
  parcelNumbers: string[];
  progress: {
    parcelNumber: string;
    scannedParcels: number;
    totalParcels: number;
    remainingParcels: number;
    milestoneRecorded: boolean;
  };
};

export async function recordOperationsTrackingScan(input: {
  action: OperationsTrackingScanAction;
  barcode: string;
  location?: string;
  deviceId?: string;
  scanRequestId: string;
}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  let response = await fetch(apiUrl("/api/v1/dpd-shipments/operations-scan"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input)
  });
  if (response.status === 401) {
    token = await refreshAccessToken();
    response = await fetch(apiUrl("/api/v1/dpd-shipments/operations-scan"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input)
    });
  }
  const payload = await readJsonSafely(response) as {
    success?: boolean;
    message?: string;
    result?: OperationsTrackingScanResult;
  };
  if (!response.ok || !payload.success || !payload.result) {
    throw new Error(payload.message || "The shipment scan could not be recorded.");
  }
  return { message: payload.message || "Scan recorded.", result: payload.result };
}
