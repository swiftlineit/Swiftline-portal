import type { ManifestPartySnapshot } from "../services/shipmentManifest.service.js";

// A normalized, presentation-agnostic view of a sealed operations manifest. It is
// the single source the manifest Excel, the manifest PDF, and the EDI export all
// build from, so the per-parcel row rules (one row per box, goods value stated once
// per consignment) live in exactly one place.

export type ManifestDocumentParty = {
  // The manifest's newline-joined address block, used by the Excel/PDF renderers.
  formatted: string;
  // Discrete address fields for column-based exports (EDI). Null on manifests
  // sealed before structured parties were captured (v1 snapshots).
  party: ManifestPartySnapshot | null;
};

export type ManifestDocumentItem = {
  description: string;
  hsnCode?: string;
  unitType?: string;
  quantity?: number;
  unitRate?: number;
};

export function fullManifestParcelDescription(
  items: ManifestDocumentItem[] | undefined,
  fallback: string
) {
  const descriptions = (items ?? [])
    .map((item) => item.description.trim())
    .filter(Boolean);
  return descriptions.length ? descriptions.join(", ") : fallback;
}

export type ManifestDocumentParcelRow = {
  serial: number; // 1-based across the whole document
  consignmentIndex: number; // 0-based
  parcelIndexInConsignment: number; // 0-based
  isFirstParcelOfConsignment: boolean;
  consignmentNumber: string; // raw Swiftline tracking number
  formattedConsignmentNumber: string; // display form
  parcelNumber: string; // Swiftline parcel barcode (EDI HAWB); "" on legacy summary rows
  weightKg: number;
  description: string;
  items?: ManifestDocumentItem[];
  bagNumber: string;
  // The consignment's declared value, present only on its first parcel row so a
  // multi-box shipment is never counted twice.
  declaredValueMinor: number | null;
  currency: "INR";
  serviceInfo: string;
  consignor: ManifestDocumentParty;
  consignee: ManifestDocumentParty;
  shipmentDraftId: string;
  dpdShipmentId: string;
};

export type ManifestDocumentConsignment = {
  consignmentIndex: number;
  consignmentNumber: string;
  formattedConsignmentNumber: string;
  declaredValueMinor: number | null;
  currency: "INR";
  serviceInfo: string;
  consignor: ManifestDocumentParty;
  consignee: ManifestDocumentParty;
  shipmentDraftId: string;
  dpdShipmentId: string;
  parcels: ManifestDocumentParcelRow[];
};

export type ManifestDocumentModel = {
  version: number;
  manifestNumber: string;
  /** Legal FROM block frozen at seal time; empty for legacy snapshots. */
  originAddress: string;
  header: Record<string, unknown>;
  branch: Record<string, unknown>;
  totals: {
    totalBags: number;
    totalConsignments: number;
    totalPhysicalParcels: number;
    totalWeightKg: number;
  };
  bags: Array<{ id: string; bagNumber: string }>;
  consignments: ManifestDocumentConsignment[];
  // Every parcel across every consignment, flattened, in print order.
  parcelRows: ManifestDocumentParcelRow[];
  generatedAt: Date;
};
