import mongoose from "mongoose";
import type { IOperationsManifest } from "../models/operationsManifest.model.js";
import type {
  ManifestDocumentConsignment,
  ManifestDocumentItem,
  ManifestDocumentModel,
  ManifestDocumentParcelRow,
  ManifestDocumentParty
} from "../types/manifestDocument.js";
import { formatManifestConsignmentNumber, type ManifestPartySnapshot } from "./shipmentManifest.service.js";

/** The frozen record written at seal time. v2 adds a `party` on each snapshot. */
export type SealedSnapshot = {
  version?: number;
  manifestNumber: string;
  /** Frozen legal FROM block; absent on legacy v1/v2 snapshots. */
  originAddress?: string;
  header: IOperationsManifest["header"];
  branch: Record<string, unknown>;
  totals: { totalBags: number; totalConsignments: number; totalPhysicalParcels: number; totalWeightKg: number };
  bags: Array<Record<string, unknown> & { _id: unknown; bagNumber: string }>;
  consignments: Array<Record<string, unknown> & {
    bagId: unknown;
    shipmentDraftId: mongoose.Types.ObjectId;
    dpdShipmentId: mongoose.Types.ObjectId;
    consignmentNumber: string;
    manifestPieces: number;
    weightKg: number;
    consignorSnapshot: Record<string, unknown>;
    consigneeSnapshot: Record<string, unknown>;
    description: string;
    declaredValueMinor: number;
    currency: "INR";
    serviceInfo: string;
    // Both absent on manifests sealed before parcels became individual rows.
    bagNumbers?: string[];
    // `valueMinor` is the parcel's own declared value; absent on pre-per-parcel seals.
    parcels?: Array<{
      parcelNumber: string;
      weightKg: number;
      description?: string;
      items?: ManifestDocumentItem[];
      bagNumber: string;
      valueMinor?: number | null;
    }>;
  }>;
  sealedAt: string;
};

export type SealedConsignment = SealedSnapshot["consignments"][number];

/** Returns the sealed snapshot when it is complete, otherwise null. */
export function parseSealedSnapshot(value: unknown): SealedSnapshot | null {
  const snapshot = value as Partial<SealedSnapshot> | null | undefined;
  if (!snapshot || !snapshot.header || !snapshot.branch || !snapshot.totals
    || !Array.isArray(snapshot.bags) || !Array.isArray(snapshot.consignments)) {
    return null;
  }
  return snapshot as SealedSnapshot;
}

/**
 * One row per packed parcel, each describing only its own contents. Manifests sealed
 * before this format keep their single summary row so historical exports stay stable.
 */
export function sealedParcelRows(item: SealedConsignment, bagById: Map<string, string>) {
  if (item.parcels?.length) {
    return item.parcels.map((parcel) => ({
      ...parcel,
      description: parcel.description || item.description
    }));
  }
  return [{
    parcelNumber: "",
    weightKg: item.weightKg,
    description: item.description,
    bagNumber: item.bagNumbers?.join(", ") || bagById.get(String(item.bagId)) || "",
    valueMinor: null as number | null
  }];
}

function partyOf(snapshot: Record<string, unknown> | undefined): ManifestDocumentParty {
  const source = snapshot ?? {};
  const party = source.party && typeof source.party === "object"
    ? source.party as ManifestPartySnapshot
    : null;
  return { formatted: typeof source.formatted === "string" ? source.formatted : "", party };
}

/**
 * Normalizes a sealed snapshot into the shared document model consumed by every
 * export. Goods value is stamped only on each consignment's first parcel row.
 */
export function buildManifestDocumentModel(snapshot: SealedSnapshot): ManifestDocumentModel {
  const bagById = new Map(snapshot.bags.map((bag) => [String(bag._id), bag.bagNumber]));
  const parcelRows: ManifestDocumentParcelRow[] = [];
  const consignments: ManifestDocumentConsignment[] = [];
  let serial = 0;

  snapshot.consignments.forEach((item, consignmentIndex) => {
    const consignor = partyOf(item.consignorSnapshot);
    const consignee = partyOf(item.consigneeSnapshot);
    const formattedConsignmentNumber = formatManifestConsignmentNumber(item.consignmentNumber);
    const shipmentDraftId = String(item.shipmentDraftId);
    const dpdShipmentId = String(item.dpdShipmentId);

    const rows = sealedParcelRows(item, bagById).map((parcel, parcelIndexInConsignment): ManifestDocumentParcelRow => {
      serial += 1;
      const isFirst = parcelIndexInConsignment === 0;
      return {
        serial,
        consignmentIndex,
        parcelIndexInConsignment,
        isFirstParcelOfConsignment: isFirst,
        consignmentNumber: item.consignmentNumber,
        formattedConsignmentNumber,
        parcelNumber: parcel.parcelNumber,
        weightKg: parcel.weightKg,
        description: parcel.description,
        items: parcel.items,
        bagNumber: parcel.bagNumber,
        // Each parcel carries its own declared value. Manifests sealed before per-parcel
        // values fall back to the consignment value on its first parcel row.
        declaredValueMinor: parcel.valueMinor != null ? parcel.valueMinor : (isFirst ? item.declaredValueMinor : null),
        currency: item.currency,
        serviceInfo: item.serviceInfo,
        consignor,
        consignee,
        shipmentDraftId,
        dpdShipmentId
      };
    });

    parcelRows.push(...rows);
    consignments.push({
      consignmentIndex,
      consignmentNumber: item.consignmentNumber,
      formattedConsignmentNumber,
      declaredValueMinor: item.declaredValueMinor,
      currency: item.currency,
      serviceInfo: item.serviceInfo,
      consignor,
      consignee,
      shipmentDraftId,
      dpdShipmentId,
      parcels: rows
    });
  });

  return {
    version: snapshot.version ?? 1,
    manifestNumber: snapshot.manifestNumber,
    originAddress: snapshot.originAddress ?? "",
    header: snapshot.header as unknown as Record<string, unknown>,
    branch: snapshot.branch,
    totals: snapshot.totals,
    bags: snapshot.bags.map((bag) => ({ id: String(bag._id), bagNumber: bag.bagNumber })),
    consignments,
    parcelRows,
    generatedAt: new Date(snapshot.sealedAt)
  };
}
