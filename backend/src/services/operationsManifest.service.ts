import crypto from "crypto";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import { AuditLog, type AuditAction } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { OperationsManifest, type IOperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import {
  OperationsManifestConsignment,
  type OperationsParcelDisposition
} from "../models/operationsManifestConsignment.model.js";
import { OperationsManifestCounter } from "../models/operationsManifestCounter.model.js";
import {
  OperationsManifestScan,
  type OperationsScanSource
} from "../models/operationsManifestScan.model.js";
import { OperationsManifestScanSession } from "../models/operationsManifestScanSession.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentManifest, type IShipmentManifest } from "../models/shipmentManifest.model.js";
import {
  buildManifestLine,
  buildShipmentManifestWorkbook,
  fixedPartyAddressRows,
  formatManifestConsignmentNumber,
  formatManifestOrigin
} from "./shipmentManifest.service.js";
import {
  buildManifestDocumentModel,
  parseSealedSnapshot,
  type SealedSnapshot
} from "./manifestDocument.service.js";
import { fullManifestParcelDescription } from "../types/manifestDocument.js";
import { normalizeParcelItems } from "./parcelItems.service.js";
import {
  parcelDeclaredGoodsValueMinor,
  readShipmentBookingSnapshot,
  snapshotDeclaredGoodsValueMinor,
  type ShipmentBookingSnapshot
} from "./shipmentBookingSnapshot.service.js";
import { dateRangeCondition } from "../utils/dateRangeFilter.js";
import {
  findMissingPrerequisites,
  findRecordedLaterMilestones,
  formatShipmentEventLabel
} from "./shipmentStatusSequence.service.js";
import { resolveShipmentEventNote } from "./shipmentEventCopy.service.js";
import { normalizeFlightNumber } from "../utils/flightNumber.js";

export class OperationsManifestServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

const editableStatuses = ["DRAFT", "PACKING", "READY_TO_SEAL"] as const;

/**
 * Operations manifests use one legal origin block regardless of the branch that
 * physically packs the freight. It is frozen into the sealed snapshot so a later
 * branch or company-profile edit cannot rewrite an issued document.
 */
export const OPERATIONS_MANIFEST_ORIGIN_ADDRESS = [
  "M/S SWIFTLINE CARGO AND EXPRESS",
  "LOGISTICS PRIVATE LTD",
  "SECOND FLOOR KRISHAN COMPLEX",
  "SECTOR- 10 NEAR 33 KVS STATION",
  "UTTAM NAGAR REWARI",
  "HARYANA-123401"
].join("\n");

function isEditable(manifest: IOperationsManifest) {
  return editableStatuses.includes(manifest.status as (typeof editableStatuses)[number]);
}

export async function allocateOperationsManifestNumber(session?: mongoose.ClientSession) {
  // Draft/packing manifests may release their number when deleted. The allocator
  // always consumes the lowest released number first; otherwise it advances the
  // high-water mark. Neither path can ever issue a value below SLC017.
  const counter = await OperationsManifestCounter.findOneAndUpdate(
    { _id: "operations-manifest" },
    [
      {
        $set: {
          sequence: { $max: [{ $ifNull: ["$sequence", 0] }, 16] },
          reusableSequences: {
            $filter: {
              input: { $setUnion: [{ $ifNull: ["$reusableSequences", []] }, []] },
              as: "candidate",
              cond: { $gte: ["$$candidate", 17] }
            }
          }
        }
      },
      {
        $set: {
          lastAllocatedSequence: {
            $cond: [
              { $gt: [{ $size: "$reusableSequences" }, 0] },
              { $min: "$reusableSequences" },
              { $add: ["$sequence", 1] }
            ]
          },
          sequence: {
            $cond: [
              { $gt: [{ $size: "$reusableSequences" }, 0] },
              "$sequence",
              { $add: ["$sequence", 1] }
            ]
          },
          reusableSequences: {
            $cond: [
              { $gt: [{ $size: "$reusableSequences" }, 0] },
              {
                $setDifference: [
                  "$reusableSequences",
                  [{ $min: "$reusableSequences" }]
                ]
              },
              "$reusableSequences"
            ]
          }
        }
      }
    ],
    // Mongoose rejects array updates unless they are explicitly identified as
    // aggregation pipelines. Keeping this option beside the pipeline prevents
    // manifest creation from failing before the counter write reaches MongoDB.
    { upsert: true, returnDocument: "after", session, updatePipeline: true }
  ).exec();
  if (!counter) throw new OperationsManifestServiceError("Manifest number could not be generated.", 500);
  return formatOperationsManifestNumber(counter.lastAllocatedSequence ?? counter.sequence);
}

export function formatOperationsManifestNumber(sequence: number) {
  return `SLC${String(sequence).padStart(3, "0")}`;
}

const reusableNumberStatuses = new Set(["DRAFT", "PACKING", "READY_TO_SEAL"]);

export function isOperationsManifestNumberReusable(status: string) {
  return reusableNumberStatuses.has(status);
}

function operationsManifestSequence(manifestNumber: string) {
  const match = /^SLC(\d+)$/.exec(manifestNumber.trim().toUpperCase());
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 17 ? sequence : null;
}

async function audit(
  action: AuditAction,
  manifestId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  metadata: Record<string, unknown>,
  session?: mongoose.ClientSession
) {
  await AuditLog.create([{
    action,
    entityType: "OPERATIONS_MANIFEST",
    entityId: manifestId,
    performedBy: userId,
    performedAt: new Date(),
    metadata
  }], { session });
}

function asObjectId(value: string, label: string) {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new OperationsManifestServiceError(`${label} was not found.`, 404);
  return new mongoose.Types.ObjectId(value);
}

function roundWeight(value: number) {
  return Number(value.toFixed(3));
}

export function calculateScannedParcelWeight(consignment: {
  scannedParcelNumbers: string[];
  parcelWeightSnapshots?: Array<{ parcelNumber: string; weightKg: number }>;
}) {
  const scanned = new Set(consignment.scannedParcelNumbers);
  return roundWeight((consignment.parcelWeightSnapshots ?? []).reduce(
    (total, parcel) => total + (scanned.has(parcel.parcelNumber) ? parcel.weightKg : 0),
    0
  ));
}

type ParcelDispositionRecord = {
  parcelNumber: string;
  disposition: OperationsParcelDisposition;
};

export function unaccountedManifestParcelNumbers(consignment: {
  expectedParcelNumbers: string[];
  scannedParcelNumbers?: string[];
  parcelDispositions?: ParcelDispositionRecord[];
}) {
  const accounted = new Set([
    ...(consignment.scannedParcelNumbers ?? []),
    ...(consignment.parcelDispositions ?? []).map((item) => item.parcelNumber)
  ].map((item) => item.toUpperCase()));
  return consignment.expectedParcelNumbers.filter((item) => !accounted.has(item.toUpperCase()));
}

type PriorParcelManifest = {
  manifestStatus: string;
  manifestNumber?: string;
  expectedParcelNumbers: string[];
  scannedParcelNumbers?: string[];
  parcelDispositions?: ParcelDispositionRecord[];
};

export function deferredParcelEligibility(parcelNumberValue: string, priorManifests: PriorParcelManifest[]) {
  const parcelNumber = parcelNumberValue.trim().toUpperCase();
  const relevant = priorManifests.filter((item) =>
    item.manifestStatus !== "CANCELLED"
      && item.expectedParcelNumbers.some((expected) => expected.toUpperCase() === parcelNumber));
  if (!relevant.length) return { allowed: true as const, reason: "" };

  for (const prior of relevant) {
    if ((prior.scannedParcelNumbers ?? []).some((scanned) => scanned.toUpperCase() === parcelNumber)) {
      return { allowed: false as const, reason: "This parcel has already been scanned." };
    }
    const disposition = [...(prior.parcelDispositions ?? [])]
      .reverse()
      .find((item) => item.parcelNumber.toUpperCase() === parcelNumber)?.disposition;
    if (disposition === "CANCELLED") {
      return { allowed: false as const, reason: "This parcel was cancelled on an earlier manifest and cannot be packed." };
    }
    if (prior.manifestStatus !== "DISPATCHED") {
      return {
        allowed: false as const,
        reason: `This shipment already belongs to ${prior.manifestNumber ?? "another operations manifest"}.`
      };
    }
    if (disposition !== "HELD" && disposition !== "DEFERRED_TO_NEXT_MANIFEST") {
      return {
        allowed: false as const,
        reason: `This parcel was not released from ${prior.manifestNumber ?? "the earlier manifest"}.`
      };
    }
  }
  return { allowed: true as const, reason: "" };
}

type ParcelValueSnapshot = { parcelNumber: string; valueMinor?: number | null };

function snapshotParcelValueMinor(parcel: ShipmentBookingSnapshot["parcels"][number]) {
  const stored = parcel.declaredGoodsValueMinor;
  if (typeof stored === "number" && stored > 0) return stored;
  const derived = parcelDeclaredGoodsValueMinor(parcel);
  return derived > 0 ? derived : null;
}

function fillMissingParcelValues(
  snapshots: Array<{ parcelNumber: string; valueMinor?: number | null }>,
  shipmentSnapshot: ShipmentBookingSnapshot
) {
  const values = new Map(
    shipmentSnapshot.parcels.map((parcel) => [
      parcel.swiftlineParcelNumber.toUpperCase(),
      snapshotParcelValueMinor(parcel)
    ])
  );
  let changed = false;
  for (const parcel of snapshots) {
    if (parcel.valueMinor != null) continue;
    const value = values.get(parcel.parcelNumber.toUpperCase());
    if (value == null) continue;
    parcel.valueMinor = value;
    changed = true;
  }
  return changed;
}

/** The declared value of each scanned parcel, in scan order. */
export function scannedParcelValues(consignment: {
  scannedParcelNumbers: string[];
  parcelWeightSnapshots?: ParcelValueSnapshot[];
}) {
  const valueByParcel = new Map((consignment.parcelWeightSnapshots ?? []).map((parcel) => [parcel.parcelNumber, parcel.valueMinor ?? null]));
  return consignment.scannedParcelNumbers.map((parcelNumber) => ({ parcelNumber, valueMinor: valueByParcel.get(parcelNumber) ?? null }));
}

/** Sum of the scanned parcels' declared values; null until every one has a value. */
export function consignmentDeclaredValueMinor(consignment: {
  scannedParcelNumbers: string[];
  parcelWeightSnapshots?: ParcelValueSnapshot[];
}) {
  const values = scannedParcelValues(consignment);
  if (!values.length || values.some((parcel) => !parcel.valueMinor)) return null;
  return values.reduce((total, parcel) => total + (parcel.valueMinor ?? 0), 0);
}

export function formatOperationsBagNumber(manifestNumber: string, bagSequence: number) {
  // The MHBS is the manifest number with a two-digit bag suffix: SLC012 → SLC01201.
  return `${manifestNumber}${String(bagSequence).padStart(2, "0")}`;
}

export const OPERATIONS_BAG_MAX_WEIGHT_KG = 32;
export const UK_OPERATIONS_BAG_MAX_PIECES = 5;

export function isOperationsBagWeightAllowed(weightKg: number) {
  return roundWeight(weightKg) <= OPERATIONS_BAG_MAX_WEIGHT_KG;
}

export function isUkOperationsManifest(header: { destinationCountryCode?: string }) {
  return String(header.destinationCountryCode ?? "").trim().toUpperCase() === "GB";
}

export type OperationsBagAllocationCandidate = {
  id: string;
  sequence: number;
  status: string;
  totalWeightKg: number;
  totalPhysicalParcels?: number;
  containsConsignment?: boolean;
};

/**
 * Picks the bag server-side. Parcels from the same shipment stay together when
 * possible; otherwise best-fit fills the fullest suitable bag. Sequence is the
 * stable tie-breaker, so equal 20 kg bags choose Bag 01 before Bag 02.
 */
export function chooseOperationsBagForParcel(
  bags: OperationsBagAllocationCandidate[],
  incomingWeightKg: number,
  options: { maxPhysicalParcels?: number } = {}
) {
  return bags
    .filter((bag) => ["OPEN", "REOPENED"].includes(bag.status))
    .filter((bag) => isOperationsBagWeightAllowed(roundWeight(bag.totalWeightKg + incomingWeightKg)))
    .filter((bag) => options.maxPhysicalParcels == null
      || (bag.totalPhysicalParcels ?? 0) < options.maxPhysicalParcels)
    .sort((left, right) =>
      Number(Boolean(right.containsConsignment)) - Number(Boolean(left.containsConsignment))
      || right.totalWeightKg - left.totalWeightKg
      || left.sequence - right.sequence)[0] ?? null;
}

export function shouldReactivateTrailingOperationsBag(status: string | undefined, hasAcceptedScan: boolean) {
  return status === "CANCELLED" && !hasAcceptedScan;
}

export type ManifestDestinationSummary = {
  countryCode: string;
  countryName: string;
  consignments: number;
  parcels: number;
};

/** Final-country visibility is independent from the shared MAWB routing hub. */
export function summarizeManifestDestinations(consignments: Array<{
  consigneeSnapshot?: Record<string, unknown>;
  scannedParcelNumbers?: string[];
}>): ManifestDestinationSummary[] {
  const destinations = new Map<string, ManifestDestinationSummary>();
  for (const consignment of consignments) {
    const party = consignment.consigneeSnapshot?.party as Record<string, unknown> | undefined;
    const countryCode = String(party?.countryCode ?? "").trim().toUpperCase();
    const countryName = String(party?.countryName ?? "").trim();
    const key = countryCode || countryName.toUpperCase() || "UNKNOWN";
    const current = destinations.get(key) ?? {
      countryCode,
      countryName: countryName || countryCode || "Unknown",
      consignments: 0,
      parcels: 0
    };
    current.consignments += 1;
    current.parcels += consignment.scannedParcelNumbers?.length ?? 0;
    destinations.set(key, current);
  }
  return [...destinations.values()].sort((left, right) =>
    left.countryName.localeCompare(right.countryName));
}

type ScannedParcelRef = { bagId?: unknown; parcelNumber: string; consignmentId?: unknown };

/**
 * A consignment's parcels may be packed across several bags, so a bag's contents
 * are derived from its accepted parcel scans rather than from the consignment's
 * primary bag. `consignment.bagId` only records where its first parcel landed.
 */
export function summarizeBagComposition(
  scans: ScannedParcelRef[],
  consignments: Array<{ parcelWeightSnapshots?: Array<{ parcelNumber: string; weightKg: number }> }>
) {
  const weightByParcel = new Map<string, number>();
  for (const consignment of consignments) {
    for (const parcel of consignment.parcelWeightSnapshots ?? []) weightByParcel.set(parcel.parcelNumber, parcel.weightKg);
  }

  const byBag = new Map<string, { parcelCount: number; weightKg: number; consignmentIds: Set<string> }>();
  for (const scan of scans) {
    if (!scan.bagId) continue;
    const key = String(scan.bagId);
    const entry = byBag.get(key) ?? { parcelCount: 0, weightKg: 0, consignmentIds: new Set<string>() };
    entry.parcelCount += 1;
    entry.weightKg = roundWeight(entry.weightKg + (weightByParcel.get(scan.parcelNumber) ?? 0));
    if (scan.consignmentId) entry.consignmentIds.add(String(scan.consignmentId));
    byBag.set(key, entry);
  }
  return byBag;
}

function bagIdsForConsignment(scans: ScannedParcelRef[], consignmentId: unknown) {
  const seen: string[] = [];
  for (const scan of scans) {
    if (String(scan.consignmentId ?? "") !== String(consignmentId) || !scan.bagId) continue;
    const bagId = String(scan.bagId);
    if (!seen.includes(bagId)) seen.push(bagId);
  }
  return seen;
}

async function maybeMarkFlightSheetReviewRequired(manifestId: mongoose.Types.ObjectId) {
  try {
    const { markSheetReviewRequiredIfChanged } = await import("./flightProfitability.service.js");
    await markSheetReviewRequiredIfChanged(manifestId, "Manifest packing changed after cost sheet creation");
  } catch { /* best effort */ }
}

async function recalculateTotals(manifestId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  const [bags, consignments, acceptedScans] = await Promise.all([
    OperationsManifestBag.find({ manifestId, status: { $ne: "CANCELLED" } }).session(session ?? null).exec(),
    OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } }).session(session ?? null).exec(),
    OperationsManifestScan.find({ manifestId, status: "ACCEPTED" })
      .select("bagId parcelNumber consignmentId")
      .session(session ?? null)
      .lean()
      .exec()
  ]);

  const composition = summarizeBagComposition(acceptedScans, consignments);
  for (const bag of bags) {
    const entry = composition.get(String(bag._id));
    bag.totalConsignments = entry?.consignmentIds.size ?? 0;
    bag.totalPhysicalParcels = entry?.parcelCount ?? 0;
    bag.totalWeightKg = roundWeight(entry?.weightKg ?? 0);
    await bag.save({ session });
  }

  const manifest = await OperationsManifest.findById(manifestId).session(session ?? null).exec();
  if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  manifest.totalBags = bags.length;
  manifest.totalConsignments = consignments.length;
  manifest.totalPhysicalParcels = acceptedScans.length;
  manifest.totalWeightKg = roundWeight(consignments.reduce((sum, item) => sum + item.weightKg, 0));

  if (isEditable(manifest)) {
    if (!acceptedScans.length) manifest.status = "DRAFT";
    else {
      // Closed bags mean physical packing is finished. The sealing checks separately
      // require an explicit disposition for every parcel that was not scanned.
      const allBagsClosed = bags.length > 0 && bags.every((bag) => ["CLOSED", "READY"].includes(bag.status));
      manifest.status = allBagsClosed ? "READY_TO_SEAL" : "PACKING";
    }
  }
  await manifest.save({ session });
  // Non-blocking review flag for any existing cost sheet
  if (!session) void maybeMarkFlightSheetReviewRequired(manifestId);
  return manifest;
}

function serializeManifest(manifest: IOperationsManifest) {
  return {
    id: String(manifest._id),
    manifestNumber: manifest.manifestNumber,
    branchId: String(manifest.branchId),
    flightLinehaulId: manifest.flightLinehaulId ? String(manifest.flightLinehaulId) : null,
    header: manifest.header,
    status: manifest.status,
    totalBags: manifest.totalBags,
    totalConsignments: manifest.totalConsignments,
    totalPhysicalParcels: manifest.totalPhysicalParcels,
    totalWeightKg: manifest.totalWeightKg,
    sealedAt: manifest.sealedAt,
    dispatchedAt: manifest.dispatchedAt,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  };
}

export async function listOperationsManifests(input: {
  page: number;
  limit: number;
  status?: string;
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  allowedBranchIds?: string[] | null;
}) {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.branchId && mongoose.Types.ObjectId.isValid(input.branchId)) {
    filter.branchId = input.branchId;
  } else if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined) {
    filter.branchId = { $in: input.allowedBranchIds };
  }
  const createdAt = dateRangeCondition(input.dateFrom, input.dateTo);
  if (createdAt) filter.createdAt = createdAt;
  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    OperationsManifest.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(input.limit).lean().exec(),
    OperationsManifest.countDocuments(filter).exec()
  ]);
  const branchIds = [...new Set(items.map((item) => String(item.branchId)))];
  const branches = await Branch.find({ _id: { $in: branchIds } }).select("name code").lean().exec();
  const branchById = new Map(branches.map((branch) => [String(branch._id), branch]));
  return {
    items: items.map((item) => ({ ...serializeManifest(item as unknown as IOperationsManifest), branch: branchById.get(String(item.branchId)) ?? null })),
    pagination: { page: input.page, limit: input.limit, total, pages: Math.max(1, Math.ceil(total / input.limit)) }
  };
}

export async function createOperationsManifest(input: {
  branchId: string;
  header: IOperationsManifest["header"];
  userId: mongoose.Types.ObjectId;
}) {
  const branchId = asObjectId(input.branchId, "Branch");
  const header = { ...input.header, flightNumber: normalizeFlightNumber(input.header.flightNumber) };
  const branch = await Branch.findOne({ _id: branchId, status: "ACTIVE" }).exec();
  if (!branch) throw new OperationsManifestServiceError("Select an active Swiftline branch.", 409);
  const session = await mongoose.startSession();
  try {
    const createdManifest = await session.withTransaction(async () => {
      // Counter, manifest, audit and first bag commit together. A failed create
      // therefore cannot burn the specifically requested next number.
      const manifestNumber = await allocateOperationsManifestNumber(session);
      const created = await OperationsManifest.create([{
        manifestNumber,
        branchId,
        header,
        status: "DRAFT",
        totalBags: 1,
        createdBy: input.userId
      }], { session });
      const manifest = created[0];
      if (!manifest) throw new OperationsManifestServiceError("Manifest could not be created.", 500);
      await audit("OPERATIONS_MANIFEST_CREATED", manifest._id as mongoose.Types.ObjectId, input.userId, { manifestNumber, branchId }, session);
      // Packing always starts with an open bag, so the operator can scan immediately.
      await openNextBag(manifest, input.userId, session);
      return manifest;
    });
    if (!createdManifest) throw new OperationsManifestServiceError("Manifest could not be created.", 500);
    return createdManifest;
  } finally {
    await session.endSession();
  }
}

export async function updateOperationsManifest(input: {
  manifestId: string;
  header: IOperationsManifest["header"];
  userId: mongoose.Types.ObjectId;
}) {
  const manifest = await OperationsManifest.findById(asObjectId(input.manifestId, "Operations manifest")).exec();
  if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  if (!isEditable(manifest)) throw new OperationsManifestServiceError("A sealed, dispatched or cancelled manifest cannot be edited.", 409);
  manifest.header = { ...input.header, flightNumber: normalizeFlightNumber(input.header.flightNumber) };
  await manifest.save();
  await audit("OPERATIONS_MANIFEST_UPDATED", manifest._id as mongoose.Types.ObjectId, input.userId, { headerUpdated: true });
  return manifest;
}

/** Opens the next sequential bag. Shared by manual creation, manifest setup, and packing overflow. */
async function openNextBag(
  manifest: IOperationsManifest,
  userId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
) {
  const manifestId = manifest._id as mongoose.Types.ObjectId;
  const latest = await OperationsManifestBag.findOne({ manifestId }).sort({ sequence: -1 }).session(session ?? null).exec();
  if (latest?.status === "CANCELLED") {
    const acceptedScan = await OperationsManifestScan.exists({
      manifestId,
      bagId: latest._id,
      status: "ACCEPTED"
    }).session(session ?? null);
    if (shouldReactivateTrailingOperationsBag(latest.status, Boolean(acceptedScan))) {
      latest.status = "OPEN";
      latest.totalConsignments = 0;
      latest.totalPhysicalParcels = 0;
      latest.totalWeightKg = 0;
      latest.closedBy = null;
      latest.closedAt = null;
      latest.reopenedBy = null;
      latest.reopenedAt = null;
      latest.cancelledBy = null;
      latest.cancelledAt = null;
      latest.correctionReason = "";
      await latest.save({ session });
      await audit("OPERATIONS_BAG_UPDATED", manifestId, userId, {
        bagId: latest._id,
        bagNumber: latest.bagNumber,
        status: "OPEN",
        reactivatedTrailingBag: true
      }, session);
      return latest;
    }
  }
  const sequence = (latest?.sequence ?? 0) + 1;
  const bagNumber = formatOperationsBagNumber(manifest.manifestNumber, sequence);
  const created = await OperationsManifestBag.create([{
    manifestId,
    sequence,
    bagNumber,
    barcode: bagNumber,
    status: "OPEN",
    createdBy: userId
  }], { session });
  const bag = created[0];
  if (!bag) throw new OperationsManifestServiceError("Bag could not be created.", 500);
  await audit("OPERATIONS_BAG_CREATED", manifestId, userId, { bagId: bag._id, bagNumber }, session);
  return bag;
}

export async function createOperationsBag(manifestIdValue: string, userId: mongoose.Types.ObjectId) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const session = await mongoose.startSession();
  try {
    let createdBag: InstanceType<typeof OperationsManifestBag> | null = null;
    await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
      if (!isEditable(manifest)) throw new OperationsManifestServiceError("Bags cannot be added to this manifest.", 409);
      createdBag = await openNextBag(manifest, userId, session);
      await recalculateTotals(manifestId, session);
    });
    if (!createdBag) throw new OperationsManifestServiceError("Bag could not be created.", 500);
    return createdBag;
  } finally {
    await session.endSession();
  }
}

async function recordRejectedScan(input: {
  manifestId: mongoose.Types.ObjectId;
  bagId?: mongoose.Types.ObjectId;
  parcelNumber: string;
  scanRequestId: string;
  userId: mongoose.Types.ObjectId;
  message: string;
  scanSource?: OperationsScanSource;
  scanSessionId?: string;
}) {
  const rejected = await OperationsManifestScan.create({
    manifestId: input.manifestId,
    bagId: input.bagId ?? null,
    parcelNumber: input.parcelNumber || "UNKNOWN",
    scanRequestId: input.scanRequestId,
    status: "REJECTED",
    scanSource: input.scanSource ?? "MANUAL",
    scanSessionId: input.scanSessionId || null,
    message: input.message,
    scannedBy: input.userId,
    scannedAt: new Date()
  }).catch(() => undefined);
  // Session activity is advanced only after the rejected scan has actually been
  // recorded. A camera read that never reached the scan service is not a scan.
  if (rejected && input.scanSessionId && mongoose.Types.ObjectId.isValid(input.scanSessionId)) {
    await OperationsManifestScanSession.updateOne(
      { _id: input.scanSessionId, manifestId: input.manifestId, status: "ACTIVE" },
      { $set: { lastSeenAt: new Date(), lastScanAt: rejected.scannedAt } }
    ).exec();
  }
  throw new OperationsManifestServiceError(input.message, 409);
}

async function buildAcceptedScanAcknowledgement(manifestId: mongoose.Types.ObjectId, scanRequestId: string) {
  const scan = await OperationsManifestScan.findOne({ manifestId, scanRequestId, status: "ACCEPTED" }).lean().exec();
  if (!scan?.bagId || !scan.consignmentId) return null;
  const [bag, manifest, consignment] = await Promise.all([
    OperationsManifestBag.findById(scan.bagId).lean().exec(),
    OperationsManifest.findById(manifestId).lean().exec(),
    OperationsManifestConsignment.findById(scan.consignmentId).lean().exec()
  ]);
  if (!bag || !manifest || !consignment) return null;
  return {
    scanId: String(scan._id),
    parcelNumber: scan.parcelNumber,
    message: scan.message,
    bag: {
      id: String(bag._id),
      bagNumber: bag.bagNumber,
      status: bag.status,
      totalPhysicalParcels: bag.totalPhysicalParcels,
      totalWeightKg: bag.totalWeightKg
    },
    manifestTotals: {
      totalBags: manifest.totalBags,
      totalConsignments: manifest.totalConsignments,
      totalPhysicalParcels: manifest.totalPhysicalParcels,
      totalWeightKg: manifest.totalWeightKg
    },
    consignment: {
      displayConsignmentNumber: formatManifestConsignmentNumber(consignment.consignmentNumber),
      scannedParcels: consignment.scannedParcelNumbers.length,
      expectedParcels: consignment.expectedParcelNumbers.length,
      weightKg: consignment.weightKg,
      serviceInfo: consignment.serviceInfo,
      description: consignment.description,
      consigneeSnapshot: consignment.consigneeSnapshot
    }
  };
}

async function previousDeclaredValue(shipmentDraftId: mongoose.Types.ObjectId) {
  const previous = await ShipmentManifest.findOne({ "lineSnapshots.shipmentDraftId": shipmentDraftId })
    .sort({ generatedAt: -1 })
    .select("lineSnapshots")
    .lean()
    .exec();
  const line = previous?.lineSnapshots.find((item) => String(item.shipmentDraftId) === String(shipmentDraftId));
  return line?.declaredValueMinor && line.declaredValueMinor > 0 ? line.declaredValueMinor : null;
}

export async function scanOperationsParcel(input: {
  manifestId: string;
  /** Kept as a backwards-compatible hint while old clients are phased out. */
  bagId?: string;
  parcelNumber: string;
  scanRequestId?: string;
  scanSource?: OperationsScanSource;
  scanSessionId?: string;
  responseMode?: "DETAIL" | "COMPACT";
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const bagId = input.bagId && mongoose.Types.ObjectId.isValid(input.bagId)
    ? new mongoose.Types.ObjectId(input.bagId)
    : undefined;
  const parcelNumber = input.parcelNumber.trim().toUpperCase();
  const scanRequestId = input.scanRequestId?.trim() || crypto.randomUUID();
  const scanMetadata = { scanSource: input.scanSource ?? "MANUAL", scanSessionId: input.scanSessionId };
  if (!parcelNumber) throw new OperationsManifestServiceError("Scan or enter a Swiftline parcel barcode.");

  // These lookups are independent. Running them in one round trip window cuts
  // camera acknowledgement latency without moving any validation into the
  // transaction or weakening the unique scan safeguards.
  const [existingRequest, manifest, label] = await Promise.all([
    OperationsManifestScan.findOne({ scanRequestId }).lean().exec(),
    OperationsManifest.findById(manifestId).exec(),
    LabelDocument.findOne({ parcelNumber, labelType: "SWIFTLINE", voidedAt: null }).exec()
  ]);
  if (existingRequest) {
    if (existingRequest.status === "ACCEPTED") {
      if (input.responseMode === "COMPACT") {
        const scanResult = await buildAcceptedScanAcknowledgement(manifestId, scanRequestId);
        if (!scanResult) throw new OperationsManifestServiceError("The accepted scan could not be confirmed.", 500);
        return { scanResult };
      }
      return getOperationsManifestDetail(input.manifestId, { latestScanId: String(existingRequest._id) });
    }
    throw new OperationsManifestServiceError(existingRequest.message, 409);
  }

  // A manifest can be deleted after branch middleware has admitted the request.
  // Do not create an orphan rejected-scan row when that race occurs.
  if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  if (!isEditable(manifest)) return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: "This manifest is locked and cannot accept parcel scans." });

  if (!label) return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: "No Swiftline parcel was found for this barcode." });
  const shipment = await DpdShipment.findOne({ _id: label.dpdShipmentId, status: { $in: ["DPD_CREATED", "LABEL_RECEIVED"] } }).exec();
  const snapshot = shipment
    ? readShipmentBookingSnapshot(shipment.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(shipment.bookingSnapshot)
    : null;
  if (!shipment || !snapshot) {
    return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: "Shipment information is incomplete. Contact Swiftline support before packing it." });
  }
  const expectedParcelNumbers = snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber.toUpperCase());
  const parcelWeightSnapshots = snapshot.parcels.map((parcel) => ({
    parcelNumber: parcel.swiftlineParcelNumber.toUpperCase(),
    weightKg: roundWeight(parcel.actualWeightKg),
    contentsDescription: typeof parcel.contentsDescription === "string" ? parcel.contentsDescription : "",
    items: normalizeParcelItems(parcel),
    valueMinor: snapshotParcelValueMinor(parcel)
  }));
  const incomingWeightKg = parcelWeightSnapshots.find((parcel) => parcel.parcelNumber === parcelNumber)?.weightKg ?? 0;
  if (!expectedParcelNumbers.includes(parcelNumber)) {
    return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: "This barcode does not match the shipment's current parcel labels." });
  }
  const [
    latestEvent,
    cancelled,
    cancellation,
    priorConsignments,
    duplicate,
    labelCount,
    previousValueMinor
  ] = await Promise.all([
    ShipmentEvent.findOne({ shipmentDraftId: shipment.shipmentDraftId }).sort({ eventAt: -1, createdAt: -1 }).lean().exec(),
    ShipmentEvent.exists({ shipmentDraftId: shipment.shipmentDraftId, status: "SHIPMENT_CANCELLED" }),
    ShipmentCancellation.findOne({
      shipmentDraftId: shipment.shipmentDraftId,
      status: { $in: ["REQUESTED", "COMPLETED"] }
    }).select("status").lean().exec(),
    OperationsManifestConsignment.find({
      shipmentDraftId: shipment.shipmentDraftId,
      manifestId: { $ne: manifestId },
      status: { $ne: "REMOVED" }
    }).sort({ createdAt: 1 }).lean().exec(),
    OperationsManifestScan.findOne({ parcelNumber, status: "ACCEPTED" }).lean().exec(),
    LabelDocument.countDocuments({ dpdShipmentId: shipment._id, labelType: "SWIFTLINE", voidedAt: null }).exec(),
    previousDeclaredValue(shipment.shipmentDraftId)
  ]);
  if (cancelled || cancellation || latestEvent?.status === "ON_HOLD") {
    const message = cancelled || cancellation?.status === "COMPLETED"
      ? "Cancelled shipments cannot be packed."
      : cancellation?.status === "REQUESTED"
        ? "This shipment has a pending cancellation request and cannot be packed."
        : "This shipment is on hold and cannot be packed.";
    return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message });
  }

  if (duplicate) {
    return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: "This parcel has already been scanned." });
  }
  const priorManifestRows = priorConsignments.length
    ? await OperationsManifest.find({ _id: { $in: priorConsignments.map((item) => item.manifestId) } })
      .select("status manifestNumber")
      .lean()
      .exec()
    : [];
  const priorManifestById = new Map(priorManifestRows.map((item) => [String(item._id), item]));
  const priorParcelManifests = priorConsignments.map((item) => ({
    manifestStatus: priorManifestById.get(String(item.manifestId))?.status ?? "UNKNOWN",
    manifestNumber: priorManifestById.get(String(item.manifestId))?.manifestNumber,
    expectedParcelNumbers: item.expectedParcelNumbers,
    scannedParcelNumbers: item.scannedParcelNumbers,
    parcelDispositions: item.parcelDispositions
  }));
  const transferEligibility = deferredParcelEligibility(parcelNumber, priorParcelManifests);
  if (!transferEligibility.allowed) {
    return recordRejectedScan({ manifestId, bagId, parcelNumber, scanRequestId, userId: input.userId, ...scanMetadata, message: transferEligibility.reason });
  }
  const manifestExpectedParcelNumbers = priorConsignments.length
    ? expectedParcelNumbers.filter((candidate) => deferredParcelEligibility(candidate, priorParcelManifests).allowed)
    : expectedParcelNumbers;

  // A parcel heavier than a whole bag cannot be packed anywhere, so that is the only
  // weight a scan still refuses.
  if (!isOperationsBagWeightAllowed(incomingWeightKg)) {
    return recordRejectedScan({
      manifestId,
      bagId,
      parcelNumber,
      scanRequestId,
      userId: input.userId,
      ...scanMetadata,
      message: `This parcel weighs ${incomingWeightKg.toFixed(3)} kg and cannot fit inside a ${OPERATIONS_BAG_MAX_WEIGHT_KG} kg bag.`
    });
  }
  const declaredValueFromSnapshot = snapshotDeclaredGoodsValueMinor(snapshot);
  const declaredValueMinor = declaredValueFromSnapshot > 0 ? declaredValueFromSnapshot : (previousValueMinor ?? 0);
  const businessAccountId = asObjectId(String(snapshot.account.id ?? ""), "Business account");

  const session = await mongoose.startSession();
  let committedScanResult: NonNullable<Awaited<ReturnType<typeof buildAcceptedScanAcknowledgement>>> | null = null;
  try {
    let committed = false;
    for (let attempt = 1; attempt <= 3 && !committed; attempt += 1) {
      try {
        await session.withTransaction(async () => {
          const lockedManifest = await OperationsManifest.findById(manifestId).session(session).exec();
          if (!lockedManifest || !isEditable(lockedManifest)) {
            throw new OperationsManifestServiceError("This manifest is locked and cannot accept parcel scans.", 409);
          }

          let consignment = await OperationsManifestConsignment.findOne({
            manifestId,
            shipmentDraftId: shipment.shipmentDraftId
          }).session(session).exec();
          const currentDisposition = consignment?.parcelDispositions?.find(
            (item) => item.parcelNumber === parcelNumber
          );
          if (currentDisposition?.disposition === "CANCELLED") {
            throw new OperationsManifestServiceError(
              "This parcel is marked Cancelled. Change its disposition before scanning it.",
              409
            );
          }
          const wasActiveConsignment = Boolean(consignment && consignment.status !== "REMOVED");
          const existingConsignmentBagIds = consignment
            ? new Set((await OperationsManifestScan.find({
              manifestId,
              consignmentId: consignment._id,
              status: "ACCEPTED"
            }).select("bagId").lean().session(session).exec()).map((scan) => String(scan.bagId ?? "")))
            : new Set<string>();
          const openBags = await OperationsManifestBag.find({
            manifestId,
            status: { $in: ["OPEN", "REOPENED"] }
          }).sort({ sequence: 1 }).session(session).exec();
          const selected = chooseOperationsBagForParcel(openBags.map((candidate) => ({
            id: String(candidate._id),
            sequence: candidate.sequence,
            status: candidate.status,
            totalWeightKg: candidate.totalWeightKg,
            totalPhysicalParcels: candidate.totalPhysicalParcels,
            containsConsignment: existingConsignmentBagIds.has(String(candidate._id))
          })), incomingWeightKg, {
            maxPhysicalParcels: isUkOperationsManifest(lockedManifest.header)
              ? UK_OPERATIONS_BAG_MAX_PIECES
              : undefined
          });
          const openedBag = !selected;
          const packedBag = selected
            ? openBags.find((candidate) => String(candidate._id) === selected.id) ?? null
            : await openNextBag(lockedManifest, input.userId, session);
          if (!packedBag) throw new OperationsManifestServiceError("A suitable bag could not be allocated.", 500);
          const packedBagId = packedBag._id as mongoose.Types.ObjectId;

          const line = buildManifestLine({
            shipmentDraftId: shipment.shipmentDraftId,
            dpdShipmentId: shipment._id as mongoose.Types.ObjectId,
            snapshot,
            declaredValueMinor: declaredValueMinor ?? 0,
            bagNumber: packedBag.bagNumber
          });
          if (!consignment) {
            const created = await OperationsManifestConsignment.create([{
              manifestId,
              bagId: packedBagId,
              shipmentDraftId: shipment.shipmentDraftId,
              dpdShipmentId: shipment._id,
              businessAccountId,
              consignmentNumber: snapshot.tracking.swiftlineTrackingNumber,
              expectedParcelNumbers: manifestExpectedParcelNumbers,
              scannedParcelNumbers: [],
              parcelDispositions: [],
              parcelWeightSnapshots: parcelWeightSnapshots.filter((parcel) =>
                manifestExpectedParcelNumbers.includes(parcel.parcelNumber)),
              manifestPieces: 1,
              weightKg: 0,
              status: "PARTIAL",
              consignorSnapshot: line.consignor,
              consigneeSnapshot: line.consignee,
              description: line.description,
              declaredValueMinor,
              currency: "INR",
              serviceInfo: line.serviceInfo,
              dpdLabelGenerated: labelCount >= snapshot.parcels.length
            }], { session });
            consignment = created[0] ?? null;
          }
          if (!consignment) throw new OperationsManifestServiceError("Manifest row could not be created.", 500);
          if (consignment.status === "REMOVED") {
            consignment.bagId = packedBagId;
            consignment.scannedParcelNumbers = [];
          }
          if (!consignment.parcelWeightSnapshots.length) {
            consignment.parcelWeightSnapshots = parcelWeightSnapshots;
          } else if (fillMissingParcelValues(consignment.parcelWeightSnapshots, snapshot)) {
            consignment.markModified("parcelWeightSnapshots");
          }
          if (!consignment.scannedParcelNumbers.includes(parcelNumber)) consignment.scannedParcelNumbers.push(parcelNumber);
          if (consignment.parcelDispositions?.some((item) => item.parcelNumber === parcelNumber)) {
            consignment.parcelDispositions = consignment.parcelDispositions.filter(
              (item) => item.parcelNumber !== parcelNumber
            );
          }
          consignment.declaredValueMinor = consignmentDeclaredValueMinor(consignment) ?? declaredValueMinor;
          consignment.weightKg = calculateScannedParcelWeight(consignment);
          consignment.status = consignment.scannedParcelNumbers.length === consignment.expectedParcelNumbers.length ? "COMPLETE" : "PARTIAL";
          await consignment.save({ session });

          const bagAlreadyContainedConsignment = existingConsignmentBagIds.has(String(packedBagId));
          packedBag.totalWeightKg = roundWeight(packedBag.totalWeightKg + incomingWeightKg);
          packedBag.totalPhysicalParcels += 1;
          if (!bagAlreadyContainedConsignment) packedBag.totalConsignments += 1;
          await packedBag.save({ session });

          const message = [
            openedBag
              ? `${packedBag.bagNumber} was opened automatically for this parcel.`
              : `Parcel added to ${packedBag.bagNumber} automatically.`,
            consignment.dpdLabelGenerated ? "" : "Swiftline labels have not been generated for every parcel on this shipment."
          ].filter(Boolean).join(" ");
          const createdScans = await OperationsManifestScan.create([{
            manifestId,
            bagId: packedBagId,
            consignmentId: consignment._id,
            parcelNumber,
            scanRequestId,
            status: "ACCEPTED",
            scanSource: scanMetadata.scanSource,
            scanSessionId: scanMetadata.scanSessionId || null,
            message,
            scannedBy: input.userId,
            scannedAt: new Date()
          }], { session });
          const acceptedScan = createdScans[0];
          if (!acceptedScan) throw new OperationsManifestServiceError("The accepted scan could not be recorded.", 500);

          lockedManifest.totalBags += openedBag ? 1 : 0;
          lockedManifest.totalConsignments += wasActiveConsignment ? 0 : 1;
          lockedManifest.totalPhysicalParcels += 1;
          lockedManifest.totalWeightKg = roundWeight(lockedManifest.totalWeightKg + incomingWeightKg);
          lockedManifest.status = "PACKING";
          await lockedManifest.save({ session });
          await audit("OPERATIONS_PARCEL_SCANNED", manifestId, input.userId, {
            bagId: packedBagId,
            allocation: openedBag ? "OPENED_BAG" : bagAlreadyContainedConsignment ? "SAME_CONSIGNMENT" : "BEST_FIT",
            legacyBagHintId: bagId,
            consignmentId: consignment._id,
            parcelNumber,
            scanSource: scanMetadata.scanSource,
            scanSessionId: scanMetadata.scanSessionId,
            dpdLabelGenerated: consignment.dpdLabelGenerated
          }, session);

          // All documents required by the compact phone acknowledgement are
          // already current in this transaction. Keeping the snapshot avoids a
          // scan lookup followed by three more reads after commit.
          committedScanResult = {
            scanId: String(acceptedScan._id),
            parcelNumber: acceptedScan.parcelNumber,
            message: acceptedScan.message,
            bag: {
              id: String(packedBag._id),
              bagNumber: packedBag.bagNumber,
              status: packedBag.status,
              totalPhysicalParcels: packedBag.totalPhysicalParcels,
              totalWeightKg: packedBag.totalWeightKg
            },
            manifestTotals: {
              totalBags: lockedManifest.totalBags,
              totalConsignments: lockedManifest.totalConsignments,
              totalPhysicalParcels: lockedManifest.totalPhysicalParcels,
              totalWeightKg: lockedManifest.totalWeightKg
            },
            consignment: {
              displayConsignmentNumber: formatManifestConsignmentNumber(consignment.consignmentNumber),
              scannedParcels: consignment.scannedParcelNumbers.length,
              expectedParcels: consignment.expectedParcelNumbers.length,
              weightKg: consignment.weightKg,
              serviceInfo: consignment.serviceInfo,
              description: consignment.description,
              consigneeSnapshot: consignment.consigneeSnapshot
            }
          };
        });
        committed = true;
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
          const keyPattern = error.keyPattern as Record<string, unknown> | undefined;
          const parcelDuplicate = Boolean(keyPattern?.parcelNumber || keyPattern?.scanRequestId);
          // Concurrent stations can race on the next bag or on first creation of
          // the same consignment. Retry those against the winning transaction.
          if (!parcelDuplicate && attempt < 3) continue;
          if (parcelDuplicate) {
            throw new OperationsManifestServiceError("This parcel has already been scanned.", 409);
          }
          throw new OperationsManifestServiceError(
            "Another scanner changed the manifest at the same time. Scan this parcel again.",
            409
          );
        }
        throw error;
      }
    }
    if (!committed) throw new OperationsManifestServiceError("A bag could not be allocated after concurrent scans. Scan the parcel again.", 409);
  } finally {
    await session.endSession();
  }

  // The in-transaction snapshot is the normal fast path. The query fallback is
  // retained for defensive recovery and idempotent requests from older clients.
  const scanResult = committedScanResult
    ?? await buildAcceptedScanAcknowledgement(manifestId, scanRequestId);
  if (!scanResult) throw new OperationsManifestServiceError("The accepted scan could not be confirmed.", 500);
  if (input.scanSessionId && mongoose.Types.ObjectId.isValid(input.scanSessionId)) {
    await OperationsManifestScanSession.updateOne(
      { _id: input.scanSessionId, manifestId, status: "ACTIVE" },
      {
        $set: {
          activeBagId: scanResult.bag.id,
          lastSeenAt: new Date(),
          lastScanAt: new Date()
        }
      }
    ).exec();
  }
  if (input.responseMode === "COMPACT") return { scanResult };
  return getOperationsManifestDetail(input.manifestId, { latestScanId: scanResult.scanId });
}

export async function closeOperationsBag(manifestIdValue: string, bagIdValue: string, userId: mongoose.Types.ObjectId) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const bag = await OperationsManifestBag.findOne({ _id: asObjectId(bagIdValue, "Bag"), manifestId }).exec();
  if (!bag) throw new OperationsManifestServiceError("Bag was not found.", 404);
  if (!(["OPEN", "REOPENED"] as string[]).includes(bag.status)) throw new OperationsManifestServiceError("Only an open bag can be closed.", 409);
  // Closing is a physical act the operator decides on. Empty bags and part-packed
  // consignments are both fine here; sealing is where completeness is enforced.
  bag.status = "CLOSED";
  bag.closedBy = userId;
  bag.closedAt = new Date();
  await bag.save();
  await OperationsManifestScanSession.updateMany(
    { manifestId, activeBagId: bag._id, status: "ACTIVE" },
    { $set: { activeBagId: null, lastSeenAt: new Date() } }
  ).exec();
  await recalculateTotals(manifestId);
  await audit("OPERATIONS_BAG_UPDATED", manifestId, userId, { bagId: bag._id, status: "CLOSED" });
  return bag;
}

/** Close every currently open bag with one totals recalculation. */
export async function closeOperationsBags(manifestIdValue: string, userId: mongoose.Types.ObjectId) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const manifest = await OperationsManifest.findById(manifestId).select("status").lean().exec();
  if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  if (!isEditable(manifest)) throw new OperationsManifestServiceError("Only an editable manifest can have bags closed.", 409);
  const bags = await OperationsManifestBag.find({ manifestId, status: { $in: ["OPEN", "REOPENED"] } })
    .select("_id bagNumber")
    .lean()
    .exec();
  if (!bags.length) return { closed: 0, bagNumbers: [] as string[] };

  const closedAt = new Date();
  const bagIds = bags.map((bag) => bag._id);
  await OperationsManifestBag.updateMany(
    { _id: { $in: bagIds }, manifestId, status: { $in: ["OPEN", "REOPENED"] } },
    { $set: { status: "CLOSED", closedBy: userId, closedAt } }
  ).exec();
  await OperationsManifestScanSession.updateMany(
    { manifestId, activeBagId: { $in: bagIds }, status: "ACTIVE" },
    { $set: { activeBagId: null, lastSeenAt: closedAt } }
  ).exec();
  await recalculateTotals(manifestId);
  await audit("OPERATIONS_BAG_UPDATED", manifestId, userId, {
    action: "BULK_CLOSE",
    bagIds: bagIds.map(String),
    bagNumbers: bags.map((bag) => bag.bagNumber),
    status: "CLOSED"
  });
  return { closed: bags.length, bagNumbers: bags.map((bag) => bag.bagNumber) };
}

export async function markOperationsBagReady(input: {
  manifestId: string;
  bagBarcode: string;
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const bagBarcode = input.bagBarcode.trim().toUpperCase();
  if (!bagBarcode) throw new OperationsManifestServiceError("Scan the closed bag barcode.");

  const session = await mongoose.startSession();
  try {
    let result: { bagNumber: string; updatedShipments: number; alreadyReady: boolean } | null = null;
    await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest || !isEditable(manifest)) {
        throw new OperationsManifestServiceError("This manifest cannot accept a bag verification scan.", 409);
      }
      const bag = await OperationsManifestBag.findOne({
        manifestId,
        $or: [{ barcode: bagBarcode }, { bagNumber: bagBarcode }],
        status: { $ne: "CANCELLED" }
      }).session(session).exec();
      if (!bag) throw new OperationsManifestServiceError("This bag barcode does not belong to the manifest.", 404);
      if (bag.status === "READY") {
        result = { bagNumber: bag.bagNumber, updatedShipments: 0, alreadyReady: true };
        return;
      }
      if (bag.status !== "CLOSED") {
        throw new OperationsManifestServiceError("Close the bag before scanning it as Ready for Dispatch.", 409);
      }

      const scans = await OperationsManifestScan.find({ manifestId, bagId: bag._id, status: "ACCEPTED" })
        .select("consignmentId")
        .lean()
        .session(session)
        .exec();
      const consignmentIds = [...new Set(scans.map((scan) => String(scan.consignmentId ?? "")).filter(Boolean))]
        .map((id) => new mongoose.Types.ObjectId(id));
      if (!consignmentIds.length) throw new OperationsManifestServiceError("A bag must contain at least one scanned parcel before it can be verified.", 409);
      const consignments = await OperationsManifestConsignment.find({ _id: { $in: consignmentIds }, manifestId })
        .select("shipmentDraftId dpdShipmentId consignmentNumber")
        .lean()
        .session(session)
        .exec();
      const events = await ShipmentEvent.find({ shipmentDraftId: { $in: consignments.map((item) => item.shipmentDraftId) } })
        .select("shipmentDraftId status")
        .lean()
        .session(session)
        .exec();
      const statusesByDraft = new Map<string, Set<string>>();
      for (const event of events) {
        const key = String(event.shipmentDraftId);
        const current = statusesByDraft.get(key) ?? new Set<string>();
        current.add(event.status);
        statusesByDraft.set(key, current);
      }
      const blocked = consignments.flatMap((consignment) => {
        const missing = findMissingPrerequisites("READY_FOR_EXPORT", statusesByDraft.get(String(consignment.shipmentDraftId)) ?? []);
        return missing.length ? [`${consignment.consignmentNumber}: ${missing.map(formatShipmentEventLabel).join(", ")}`] : [];
      });
      if (blocked.length) {
        throw new OperationsManifestServiceError(
          `Bag cannot be marked Ready for Dispatch. Complete the HAWB scans first: ${blocked.join("; ")}.`,
          409
        );
      }

      const eventAt = new Date();
      let updatedShipments = 0;
      for (const consignment of consignments) {
        const existingStatuses = statusesByDraft.get(String(consignment.shipmentDraftId)) ?? new Set<string>();
        if (existingStatuses.has("READY_FOR_EXPORT") || existingStatuses.has("EXPORT_CUSTOMS_CLEARED") || existingStatuses.has("FLIGHT_ASSIGNED")) continue;
        await ShipmentEvent.create([{
          shipmentDraftId: consignment.shipmentDraftId,
          dpdShipmentId: consignment.dpdShipmentId,
          status: "READY_FOR_EXPORT",
          milestoneKey: "READY_FOR_EXPORT",
          note: resolveShipmentEventNote("", "READY_FOR_EXPORT"),
          location: "",
          source: "MANIFEST",
          sourceReference: `BAG:${String(bag._id)}:READY`,
          customerVisible: true,
          createdBy: input.userId,
          eventAt
        }], { session });
        updatedShipments += 1;
      }
      bag.status = "READY";
      bag.readyBy = input.userId;
      bag.readyAt = eventAt;
      await bag.save({ session });
      await audit("OPERATIONS_BAG_UPDATED", manifestId, input.userId, {
        bagId: bag._id,
        bagNumber: bag.bagNumber,
        status: "READY",
        updatedShipments
      }, session);
      await recalculateTotals(manifestId, session);
      result = { bagNumber: bag.bagNumber, updatedShipments, alreadyReady: false };
    });
    // The Mongo transaction callback assigns this value after the write has
    // committed. TypeScript cannot follow assignments made inside callbacks,
    // so preserve the explicit result contract at this boundary.
    const completedResult = result as { bagNumber: string; updatedShipments: number; alreadyReady: boolean } | null;
    if (!completedResult) throw new OperationsManifestServiceError("Bag readiness could not be recorded.", 500);
    return completedResult;
  } finally {
    await session.endSession();
  }
}

export async function reopenOperationsBag(manifestIdValue: string, bagIdValue: string, reason: string, userId: mongoose.Types.ObjectId) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const manifest = await OperationsManifest.findById(manifestId).exec();
  if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("This manifest cannot be reopened.", 409);
  const bag = await OperationsManifestBag.findOne({ _id: asObjectId(bagIdValue, "Bag"), manifestId, status: { $ne: "CANCELLED" } }).exec();
  if (!bag) throw new OperationsManifestServiceError("Bag was not found.", 404);
      bag.status = "REOPENED";
      bag.readyBy = null;
      bag.readyAt = null;
  bag.reopenedBy = userId;
  bag.reopenedAt = new Date();
  bag.correctionReason = reason;
  await bag.save();
  await recalculateTotals(manifestId);
  await audit("OPERATIONS_BAG_UPDATED", manifestId, userId, { bagId: bag._id, status: "REOPENED", reason });
  return bag;
}

export async function removeOperationsScan(input: {
  manifestId: string;
  scanId: string;
  reason: string;
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const manifest = await OperationsManifest.findById(manifestId).exec();
  if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("Scans cannot be corrected after sealing.", 409);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const scan = await OperationsManifestScan.findOne({ _id: asObjectId(input.scanId, "Scan"), manifestId, status: "ACCEPTED" }).session(session).exec();
      if (!scan || !scan.consignmentId) throw new OperationsManifestServiceError("Active parcel scan was not found.", 404);
      const bag = scan.bagId ? await OperationsManifestBag.findById(scan.bagId).session(session).exec() : null;
      if (bag?.status === "CLOSED") throw new OperationsManifestServiceError("Reopen the bag before removing a parcel scan.", 409);
      scan.status = "REMOVED";
      scan.removedBy = input.userId;
      scan.removedAt = new Date();
      scan.removalReason = input.reason;
      await scan.save({ session });
      const consignment = await OperationsManifestConsignment.findById(scan.consignmentId).session(session).exec();
      if (consignment) {
        consignment.scannedParcelNumbers = consignment.scannedParcelNumbers.filter((item) => item !== scan.parcelNumber);
        consignment.weightKg = calculateScannedParcelWeight(consignment);
        consignment.status = consignment.scannedParcelNumbers.length
          ? consignment.scannedParcelNumbers.length === consignment.expectedParcelNumbers.length ? "COMPLETE" : "PARTIAL"
          : "REMOVED";
        await consignment.save({ session });
      }
      await recalculateTotals(manifestId, session);
      await audit("OPERATIONS_SCAN_REMOVED", manifestId, input.userId, { scanId: scan._id, parcelNumber: scan.parcelNumber, reason: input.reason }, session);
    });
  } finally {
    await session.endSession();
  }
}

export async function setOperationsParcelDisposition(input: {
  manifestId: string;
  consignmentId: string;
  parcelNumber: string;
  disposition: OperationsParcelDisposition;
  reason: string;
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const consignmentId = asObjectId(input.consignmentId, "Consignment");
  const parcelNumber = input.parcelNumber.trim().toUpperCase();
  const reason = input.reason.trim();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest || (!isEditable(manifest) && manifest.status !== "SEALED")) {
        throw new OperationsManifestServiceError("Parcel dispositions cannot be changed after sealing.", 409);
      }
      const consignment = await OperationsManifestConsignment.findOne({
        _id: consignmentId,
        manifestId,
        status: { $ne: "REMOVED" }
      }).session(session).exec();
      if (!consignment) throw new OperationsManifestServiceError("Consignment was not found.", 404);
      if (!consignment.expectedParcelNumbers.includes(parcelNumber)) {
        throw new OperationsManifestServiceError("This parcel does not belong to the selected consignment.", 409);
      }
      if (consignment.scannedParcelNumbers.includes(parcelNumber)) {
        throw new OperationsManifestServiceError("Remove the parcel scan before recording an omitted-parcel disposition.", 409);
      }

      const recordedAt = new Date();
      consignment.parcelDispositions ??= [];
      const existing = consignment.parcelDispositions?.find((item) => item.parcelNumber === parcelNumber);
      if (manifest.status === "SEALED" && existing) {
        throw new OperationsManifestServiceError("An existing parcel decision on a sealed manifest cannot be changed. Use the controlled correction process.", 409);
      }
      if (existing) {
        existing.disposition = input.disposition;
        existing.reason = reason;
        existing.recordedBy = input.userId;
        existing.recordedAt = recordedAt;
      } else {
        consignment.parcelDispositions.push({
          parcelNumber,
          disposition: input.disposition,
          reason,
          recordedBy: input.userId,
          recordedAt
        });
      }
      consignment.markModified("parcelDispositions");
      await consignment.save({ session });
      await audit("OPERATIONS_PARCEL_DISPOSITION_UPDATED", manifestId, input.userId, {
        consignmentId,
        shipmentDraftId: consignment.shipmentDraftId,
        parcelNumber,
        disposition: input.disposition,
        reason
      }, session);
    });
  } finally {
    await session.endSession();
  }
}

export async function moveOperationsConsignment(input: {
  manifestId: string;
  consignmentId: string;
  targetBagId: string;
  reason: string;
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const manifest = await OperationsManifest.findById(manifestId).exec();
  if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("Consignments cannot be moved after sealing.", 409);
  const consignment = await OperationsManifestConsignment.findOne({ _id: asObjectId(input.consignmentId, "Consignment"), manifestId, status: { $ne: "REMOVED" } }).exec();
  const target = await OperationsManifestBag.findOne({ _id: asObjectId(input.targetBagId, "Bag"), manifestId, status: { $in: ["OPEN", "REOPENED"] } }).exec();
  if (!consignment || !target) throw new OperationsManifestServiceError("Select an active consignment and an open destination bag.", 409);
  // Moving gathers every scanned parcel of the consignment into one bag, so the
  // source can be several bags once a shipment has been split across them.
  const consignmentScans = await OperationsManifestScan.find({ consignmentId: consignment._id, status: "ACCEPTED" }).lean().exec();
  const sourceBagIds = [...new Set(consignmentScans.map((scan) => String(scan.bagId ?? "")).filter(Boolean))];
  const relocatingScans = consignmentScans.filter((scan) => String(scan.bagId ?? "") !== String(target._id));
  if (!relocatingScans.length) throw new OperationsManifestServiceError("This consignment is already packed in the selected bag.", 409);

  const sourceBags = await OperationsManifestBag.find({ _id: { $in: sourceBagIds } }).exec();
  if (sourceBags.some((bag) => bag.status === "CLOSED")) {
    throw new OperationsManifestServiceError("Reopen every bag holding this consignment before moving it.", 409);
  }

  const weightByParcel = new Map(consignment.parcelWeightSnapshots.map((parcel) => [parcel.parcelNumber, parcel.weightKg]));
  const relocatingWeightKg = roundWeight(relocatingScans.reduce((sum, scan) => sum + (weightByParcel.get(scan.parcelNumber) ?? 0), 0));
  if (!isOperationsBagWeightAllowed(roundWeight(target.totalWeightKg + relocatingWeightKg))) {
    throw new OperationsManifestServiceError(`${target.bagNumber} cannot take another ${relocatingWeightKg.toFixed(3)} kg without passing the ${OPERATIONS_BAG_MAX_WEIGHT_KG} kg limit.`, 409);
  }
  if (isUkOperationsManifest(manifest.header)
    && target.totalPhysicalParcels + relocatingScans.length > UK_OPERATIONS_BAG_MAX_PIECES) {
    throw new OperationsManifestServiceError(`${target.bagNumber} cannot contain more than ${UK_OPERATIONS_BAG_MAX_PIECES} parcels for a UK manifest.`, 409);
  }

  consignment.bagId = target._id as mongoose.Types.ObjectId;
  await consignment.save();
  await OperationsManifestScan.updateMany({ consignmentId: consignment._id, status: "ACCEPTED" }, { $set: { bagId: target._id } }).exec();
  await recalculateTotals(manifestId);
  await audit("OPERATIONS_BAG_UPDATED", manifestId, input.userId, { consignmentId: consignment._id, sourceBagIds, targetBagId: target._id, reason: input.reason });
}

export async function cancelOperationsBag(manifestIdValue: string, bagIdValue: string, reason: string, userId: mongoose.Types.ObjectId) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const manifest = await OperationsManifest.findById(manifestId).exec();
  if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("This bag cannot be cancelled.", 409);
  const bag = await OperationsManifestBag.findOne({ _id: asObjectId(bagIdValue, "Bag"), manifestId, status: { $ne: "CANCELLED" } }).exec();
  if (!bag) throw new OperationsManifestServiceError("Bag was not found.", 404);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Cancelling releases whatever was in the bag instead of refusing, so those
      // parcels become scannable again rather than being stranded on a dead bag.
      const packedScans = await OperationsManifestScan.find({ manifestId, bagId: bag._id, status: "ACCEPTED" }).session(session).exec();
      for (const scan of packedScans) {
        scan.status = "REMOVED";
        scan.removedBy = userId;
        scan.removedAt = new Date();
        scan.removalReason = reason || "Bag cancelled.";
        await scan.save({ session });

        if (!scan.consignmentId) continue;
        const consignment = await OperationsManifestConsignment.findById(scan.consignmentId).session(session).exec();
        if (!consignment) continue;
        consignment.scannedParcelNumbers = consignment.scannedParcelNumbers.filter((item) => item !== scan.parcelNumber);
        consignment.weightKg = calculateScannedParcelWeight(consignment);
        consignment.status = consignment.scannedParcelNumbers.length
          ? consignment.scannedParcelNumbers.length === consignment.expectedParcelNumbers.length ? "COMPLETE" : "PARTIAL"
          : "REMOVED";
        await consignment.save({ session });
      }

      bag.status = "CANCELLED";
      bag.cancelledBy = userId;
      bag.cancelledAt = new Date();
      bag.correctionReason = reason;
      await bag.save({ session });
      await OperationsManifestScanSession.updateMany(
        { manifestId, activeBagId: bag._id, status: "ACTIVE" },
        { $set: { activeBagId: null, lastSeenAt: new Date() } },
        { session }
      ).exec();
      await recalculateTotals(manifestId, session);
      await audit("OPERATIONS_BAG_UPDATED", manifestId, userId, { bagId: bag._id, status: "CANCELLED", releasedParcels: packedScans.length, reason }, session);
    });
  } finally {
    await session.endSession();
  }
}

export function sealingIssues(manifest: IOperationsManifest, bags: Array<{ status: string; totalWeightKg?: number; totalPhysicalParcels?: number }>, consignments: Array<{ status: string; expectedParcelNumbers: string[]; scannedParcelNumbers?: string[]; parcelDispositions?: ParcelDispositionRecord[]; parcelWeightSnapshots?: ParcelValueSnapshot[] }>) {
  const issues: string[] = [];
  const header = manifest.header;
  if (!header.destinationAgent) issues.push("Destination agent details are required.");
  if (!header.destinationCountryCode || !header.destinationCountryName) issues.push("Destination country is required.");
  if (!header.flightNumber) issues.push("Flight number is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.departureDate)) issues.push("Departure date is required.");
  if (!header.mawbNumber) issues.push("MAWB number is required.");
  if (!/^[A-Z]{3}$/.test(header.originIataCode)) issues.push("A valid origin IATA code is required.");
  if (!/^[A-Z]{3}$/.test(header.destinationIataCode)) issues.push("A valid destination IATA code is required.");
  if (!header.valueType) issues.push("Value type is required.");
  if (!bags.length) issues.push("Create and close at least one bag.");
  if (bags.some((bag) => !["CLOSED", "READY"].includes(bag.status))) {
    issues.push("Close every active bag before sealing the manifest.");
  }
  if (bags.some((bag) => !isOperationsBagWeightAllowed(bag.totalWeightKg ?? 0))) {
    issues.push(`Every bag must remain within the ${OPERATIONS_BAG_MAX_WEIGHT_KG} kg maximum weight.`);
  }
  if (isUkOperationsManifest(header)
    && bags.some((bag) => (bag.totalPhysicalParcels ?? 0) > UK_OPERATIONS_BAG_MAX_PIECES)) {
    issues.push(`Every UK bag must contain no more than ${UK_OPERATIONS_BAG_MAX_PIECES} parcels.`);
  }
  if (!consignments.length) issues.push("Scan at least one consignment.");
  const unaccountedParcels = consignments.flatMap(unaccountedManifestParcelNumbers);
  if (unaccountedParcels.length) {
    issues.push(
      `Choose Held, Deferred to next manifest, or Cancelled for ${unaccountedParcels.length} unscanned parcel${unaccountedParcels.length === 1 ? "" : "s"}.`
    );
  }
  // Every packed parcel needs its own declared value, since each box is a customs line.
  const parcelMissingValue = consignments.some((item) =>
    scannedParcelValues({ scannedParcelNumbers: item.scannedParcelNumbers ?? [], parcelWeightSnapshots: item.parcelWeightSnapshots })
      .some((parcel) => !parcel.valueMinor));
  if (parcelMissingValue) issues.push("Enter the goods value for every parcel.");
  return issues;
}

export type ManifestDispatchIssue = {
  shipmentDraftId: string;
  reference: string;
  reason: string;
  missingStatuses: string[];
};

export function buildManifestSealReadinessIssues(input: {
  consignments: Array<{ shipmentDraftId: unknown; consignmentNumber: string }>;
  events: Array<{ shipmentDraftId: unknown; status: string; eventAt: Date }>;
  cancellations?: Array<{ shipmentDraftId: unknown; status: string }>;
}) {
  const statusesByDraft = new Map<string, Set<string>>();
  const latestByDraft = new Map<string, { status: string; eventAt: Date }>();
  for (const event of input.events) {
    const draftId = String(event.shipmentDraftId);
    const statuses = statusesByDraft.get(draftId) ?? new Set<string>();
    statuses.add(event.status);
    statusesByDraft.set(draftId, statuses);
    const latest = latestByDraft.get(draftId);
    if (!latest || event.eventAt.getTime() > latest.eventAt.getTime()) {
      latestByDraft.set(draftId, event);
    }
  }
  const cancellationByDraft = new Map(
    (input.cancellations ?? []).map((item) => [String(item.shipmentDraftId), item.status])
  );
  return input.consignments.flatMap((consignment) => {
    const draftId = String(consignment.shipmentDraftId);
    const statuses = statusesByDraft.get(draftId) ?? new Set<string>();
    const cancellation = cancellationByDraft.get(draftId);
    if (cancellation || statuses.has("SHIPMENT_CANCELLED")) {
      return [{
        shipmentDraftId: draftId,
        reference: consignment.consignmentNumber || draftId,
        reason: "Shipment is cancelled.",
        missingStatuses: []
      }];
    }
    if (latestByDraft.get(draftId)?.status === "ON_HOLD") {
      return [{
        shipmentDraftId: draftId,
        reference: consignment.consignmentNumber || draftId,
        reason: "Shipment is on hold.",
        missingStatuses: []
      }];
    }
    const missing = findMissingPrerequisites("READY_FOR_EXPORT", statuses);
    return missing.length ? [{
      shipmentDraftId: draftId,
      reference: consignment.consignmentNumber || draftId,
      reason: `Missing ${missing.map(formatShipmentEventLabel).join(", ")}.`,
      missingStatuses: missing
    }] : [];
  });
}

export function buildManifestDispatchIssues(input: {
  consignments: Array<{ shipmentDraftId: unknown; consignmentNumber: string }>;
  events: Array<{ shipmentDraftId: unknown; status: string; eventAt: Date }>;
  cancellations?: Array<{ shipmentDraftId: unknown; status: string }>;
}): ManifestDispatchIssue[] {
  const statusesByDraft = new Map<string, Set<string>>();
  const latestByDraft = new Map<string, { status: string; eventAt: Date }>();
  for (const event of input.events) {
    const draftId = String(event.shipmentDraftId);
    const statuses = statusesByDraft.get(draftId) ?? new Set<string>();
    statuses.add(event.status);
    statusesByDraft.set(draftId, statuses);
    const latest = latestByDraft.get(draftId);
    if (!latest || event.eventAt.getTime() > latest.eventAt.getTime()) latestByDraft.set(draftId, event);
  }
  const cancellationByDraft = new Map(
    (input.cancellations ?? []).map((item) => [String(item.shipmentDraftId), item.status])
  );

  return input.consignments.flatMap((consignment) => {
    const draftId = String(consignment.shipmentDraftId);
    const reference = consignment.consignmentNumber || draftId;
    const cancellation = cancellationByDraft.get(draftId);
    const eventCancelled = statusesByDraft.get(draftId)?.has("SHIPMENT_CANCELLED");
    if (cancellation || eventCancelled) {
      return [{
        shipmentDraftId: draftId,
        reference,
        reason: cancellation === "COMPLETED" || eventCancelled
          ? "Shipment is cancelled."
          : "Shipment has a pending cancellation request.",
        missingStatuses: []
      }];
    }
    if (latestByDraft.get(draftId)?.status === "ON_HOLD") {
      return [{ shipmentDraftId: draftId, reference, reason: "Shipment is on hold.", missingStatuses: [] }];
    }
    const missing = findMissingPrerequisites("ORIGIN_HUB_DISPATCHED", statusesByDraft.get(draftId) ?? []);
    if (missing.length) return [{
      shipmentDraftId: draftId,
      reference,
      reason: `Missing ${missing.map(formatShipmentEventLabel).join(", ")}.`,
      missingStatuses: missing
    }];
    const later = findRecordedLaterMilestones("ORIGIN_HUB_DISPATCHED", statusesByDraft.get(draftId) ?? []);
    return later.length ? [{
      shipmentDraftId: draftId,
      reference,
      reason: `A later milestone is already recorded: ${later.map(formatShipmentEventLabel).join(", ")}.`,
      missingStatuses: []
    }] : [];
  });
}

async function loadManifestDispatchIssues(
  consignments: Array<{ shipmentDraftId: mongoose.Types.ObjectId; consignmentNumber: string }>,
  session?: mongoose.ClientSession
) {
  if (!consignments.length) return [];
  const shipmentDraftIds = consignments.map((item) => item.shipmentDraftId);
  const [events, cancellations] = await Promise.all([
    ShipmentEvent.find({ shipmentDraftId: { $in: shipmentDraftIds } })
      .select("shipmentDraftId status eventAt")
      .lean()
      .session(session ?? null)
      .exec(),
    ShipmentCancellation.find({
      shipmentDraftId: { $in: shipmentDraftIds },
      status: { $in: ["REQUESTED", "COMPLETED"] }
    }).select("shipmentDraftId status").lean().session(session ?? null).exec()
  ]);
  return buildManifestDispatchIssues({ consignments, events, cancellations });
}

export function buildManifestDispatchTrackingEvent(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  manifestId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  dispatchedAt: Date;
}) {
  return {
    shipmentDraftId: input.shipmentDraftId,
    dpdShipmentId: input.dpdShipmentId,
    status: "ORIGIN_HUB_DISPATCHED" as const,
    milestoneKey: "ORIGIN_HUB_DISPATCHED",
    note: resolveShipmentEventNote("", "ORIGIN_HUB_DISPATCHED"),
    location: "",
    customerVisible: true,
    source: "MANIFEST" as const,
    sourceReference: String(input.manifestId),
    createdBy: input.userId,
    eventAt: input.dispatchedAt
  };
}

export function buildManifestReadyTrackingEvent(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  manifestId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  sealedAt: Date;
}) {
  return {
    shipmentDraftId: input.shipmentDraftId,
    dpdShipmentId: input.dpdShipmentId,
    status: "READY_FOR_EXPORT" as const,
    milestoneKey: "READY_FOR_EXPORT",
    note: resolveShipmentEventNote("", "READY_FOR_EXPORT"),
    location: "",
    source: "MANIFEST" as const,
    sourceReference: `MANIFEST:${String(input.manifestId)}:SEALED`,
    customerVisible: true,
    createdBy: input.userId,
    eventAt: input.sealedAt
  };
}

export async function sealOperationsManifest(
  manifestIdValue: string,
  userId: mongoose.Types.ObjectId,
  options: { confirmMixedDestinations?: boolean } = {}
) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const session = await mongoose.startSession();
  try {
    let sealed: IOperationsManifest | null = null;
    await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("This manifest cannot be sealed.", 409);
      const [branch, bags, consignments] = await Promise.all([
        Branch.findById(manifest.branchId).lean().session(session).exec(),
        OperationsManifestBag.find({ manifestId, status: { $ne: "CANCELLED" } }).sort({ sequence: 1 }).lean().session(session).exec(),
        OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } }).sort({ createdAt: 1 }).lean().session(session).exec()
      ]);
      const issues = sealingIssues(manifest, bags, consignments);
      const shipmentDraftIds = consignments.map((item) => item.shipmentDraftId);
      const [sealEvents, sealCancellations] = shipmentDraftIds.length
        ? await Promise.all([
            ShipmentEvent.find({ shipmentDraftId: { $in: shipmentDraftIds } })
              .select("shipmentDraftId status eventAt")
              .lean()
              .session(session)
              .exec(),
            ShipmentCancellation.find({
              shipmentDraftId: { $in: shipmentDraftIds },
              status: { $in: ["REQUESTED", "COMPLETED"] }
            }).select("shipmentDraftId status").lean().session(session).exec()
          ])
        : [[], []];
      const readinessIssues = buildManifestSealReadinessIssues({
        consignments,
        events: sealEvents,
        cancellations: sealCancellations
      });
      if (readinessIssues.length) {
        issues.push(...readinessIssues.map((issue) => `${issue.reference}: ${issue.reason}`));
      }
      if (issues.length) throw new OperationsManifestServiceError(issues.join(" "), 409);
      const destinations = summarizeManifestDestinations(consignments);
      if (destinations.length > 1 && !options.confirmMixedDestinations) {
        throw new OperationsManifestServiceError(
          `This manifest contains ${destinations.length} final destination countries. Confirm the mixed destinations before sealing.`,
          409
        );
      }
      // A consignment can span several bags, so the printed manifest records every
      // bag its parcels were packed into rather than just the first one.
      const acceptedScans = await OperationsManifestScan.find({ manifestId, status: "ACCEPTED" })
        .select("bagId parcelNumber consignmentId")
        .sort({ scannedAt: 1 })
        .lean()
        .session(session)
        .exec();
      const sealedBagNumberById = new Map(bags.map((bag) => [String(bag._id), bag.bagNumber]));
      const sealedConsignments = consignments.map((item) => {
        const snapshotByParcel = new Map((item.parcelWeightSnapshots ?? []).map((parcel) => [parcel.parcelNumber, parcel]));
        // Each packed parcel becomes its own manifest row, carrying the weight,
        // contents, and bag it was actually scanned into.
        const parcels = acceptedScans
          .filter((scan) => String(scan.consignmentId ?? "") === String(item._id))
          .map((scan) => ({
            parcelNumber: scan.parcelNumber,
            weightKg: roundWeight(snapshotByParcel.get(scan.parcelNumber)?.weightKg ?? 0),
            description: snapshotByParcel.get(scan.parcelNumber)?.contentsDescription ?? "",
            items: snapshotByParcel.get(scan.parcelNumber)?.items,
            bagNumber: sealedBagNumberById.get(String(scan.bagId ?? "")) ?? "",
            valueMinor: snapshotByParcel.get(scan.parcelNumber)?.valueMinor ?? null
          }));
        return {
          ...item,
          parcels,
          bagNumbers: [...new Set(parcels.map((parcel) => parcel.bagNumber))].filter(Boolean)
        };
      });
      const eventAt = new Date();
      const statusesByDraft = new Map<string, Set<string>>();
      for (const event of sealEvents) {
        const statuses = statusesByDraft.get(String(event.shipmentDraftId)) ?? new Set<string>();
        statuses.add(event.status);
        statusesByDraft.set(String(event.shipmentDraftId), statuses);
      }
      let readyEventsCreated = 0;
      for (const consignment of consignments) {
        const statuses = statusesByDraft.get(String(consignment.shipmentDraftId)) ?? new Set<string>();
        if (["READY_FOR_EXPORT", "EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED"].some((status) => statuses.has(status))) continue;
        await ShipmentEvent.create([buildManifestReadyTrackingEvent({
          shipmentDraftId: consignment.shipmentDraftId,
          dpdShipmentId: consignment.dpdShipmentId,
          manifestId: manifest._id as mongoose.Types.ObjectId,
          userId,
          sealedAt: eventAt
        })], { session });
        readyEventsCreated += 1;
      }
      // v3 freezes the legal FROM block. Older snapshots remain readable and keep
      // their historical branch-derived origin instead of being rewritten.
      manifest.sealedSnapshot = JSON.parse(JSON.stringify({
        version: 3,
        manifestNumber: manifest.manifestNumber,
        originAddress: OPERATIONS_MANIFEST_ORIGIN_ADDRESS,
        header: manifest.header,
        branch,
        totals: {
          totalBags: manifest.totalBags,
          totalConsignments: manifest.totalConsignments,
          totalPhysicalParcels: manifest.totalPhysicalParcels,
          totalWeightKg: manifest.totalWeightKg
        },
        bags,
        consignments: sealedConsignments,
        sealedAt: eventAt.toISOString(),
        sealedBy: userId
      }));
      manifest.status = "SEALED";
      manifest.sealedAt = new Date();
      manifest.sealedBy = userId;
      await manifest.save({ session });
      await OperationsManifestScanSession.updateMany(
        { manifestId, status: { $ne: "ENDED" } },
        { $set: { status: "ENDED", activeBagId: null, endedAt: new Date(), endedReason: "Manifest sealed." } },
        { session }
      ).exec();
      await audit("OPERATIONS_MANIFEST_SEALED", manifestId, userId, {
        totals: manifest.sealedSnapshot.totals,
        destinations,
        mixedDestinationsConfirmed: destinations.length > 1,
        readyEventsCreated
      }, session);
      sealed = manifest;
    });
    if (!sealed) throw new OperationsManifestServiceError("Manifest could not be sealed.", 500);
    void maybeMarkFlightSheetReviewRequired(new mongoose.Types.ObjectId(manifestIdValue));
    return sealed;
  } finally {
    await session.endSession();
  }
}

export async function dispatchOperationsManifest(
  manifestIdValue: string,
  userId: mongoose.Types.ObjectId,
  options: { method?: "BUTTON" | "BARCODE_SCAN"; scannedBarcode?: string } = {}
) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const session = await mongoose.startSession();
  let dispatched: IOperationsManifest | null = null;

  try {
    await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
      if (manifest.status === "DISPATCHED") {
        dispatched = manifest;
        return;
      }
      if (manifest.status !== "SEALED") {
        throw new OperationsManifestServiceError("Only a sealed manifest can be dispatched.", 409);
      }
      const dispatchMethod = options.method ?? "BUTTON";
      if (dispatchMethod === "BARCODE_SCAN") {
        const scannedBarcode = options.scannedBarcode?.trim().toUpperCase() ?? "";
        const validBarcodes = new Set([manifest.manifestNumber, `OM:${manifest.manifestNumber}`]);
        if (!validBarcodes.has(scannedBarcode)) {
          throw new OperationsManifestServiceError(
            `Scan the dispatch barcode for ${manifest.manifestNumber}.`,
            409
          );
        }
      }

      const dispatchedAt = new Date();
      const consignments = await OperationsManifestConsignment.find({
        manifestId: manifest._id,
        status: { $ne: "REMOVED" }
      }).select("shipmentDraftId dpdShipmentId consignmentNumber").session(session).lean().exec();

      const dispatchIssues = await loadManifestDispatchIssues(consignments, session);
      if (dispatchIssues.length) {
        const visible = dispatchIssues.slice(0, 8).map((issue) => `${issue.reference}: ${issue.reason}`);
        const remainder = dispatchIssues.length - visible.length;
        throw new OperationsManifestServiceError(
          `Manifest cannot be dispatched. ${visible.join(" ")}`
            + (remainder > 0 ? ` ${remainder} more shipment(s) need attention.` : ""),
          409
        );
      }

      manifest.status = "DISPATCHED";
      manifest.dispatchedAt = dispatchedAt;
      manifest.dispatchedBy = userId;
      await manifest.save({ session });

      if (consignments.length) {
        // Run these sequentially on the transaction session. Mongoose 9 can
        // silently omit a bulk update whose only mutation is `$setOnInsert`,
        // reporting zero matches and zero upserts while allowing the manifest
        // transaction to commit. A direct updateOne reliably performs the
        // idempotent upsert and keeps manifest dispatch and tracking atomic.
        for (const consignment of consignments) {
          const result = await ShipmentEvent.updateOne(
            {
              shipmentDraftId: consignment.shipmentDraftId,
              $or: [
                { milestoneKey: "ORIGIN_HUB_DISPATCHED" },
                { status: { $in: ["ORIGIN_HUB_DISPATCHED", "FLIGHT_DEPARTED"] } }
              ]
            },
            {
              $setOnInsert: buildManifestDispatchTrackingEvent({
                shipmentDraftId: consignment.shipmentDraftId,
                dpdShipmentId: consignment.dpdShipmentId,
                manifestId: manifest._id as mongoose.Types.ObjectId,
                userId,
                dispatchedAt
              })
            },
            { session, upsert: true }
          ).exec();

          if (!result.acknowledged || (result.matchedCount === 0 && result.upsertedCount === 0)) {
            throw new OperationsManifestServiceError(
              `Dispatch tracking could not be recorded for ${consignment.consignmentNumber}. The manifest was not dispatched.`,
              500
            );
          }
        }
      }

      await OperationsManifestScanSession.updateMany(
        { manifestId: manifest._id, status: { $ne: "ENDED" } },
        { $set: { status: "ENDED", activeBagId: null, endedAt: dispatchedAt, endedReason: "Manifest dispatched." } },
        { session }
      ).exec();
      await audit(
        "OPERATIONS_MANIFEST_DISPATCHED",
        manifest._id as mongoose.Types.ObjectId,
        userId,
        {
          dispatchedAt,
          consignmentsChecked: consignments.length,
          dispatchMethod,
          ...(dispatchMethod === "BARCODE_SCAN" ? { scannedBarcode: options.scannedBarcode?.trim().toUpperCase() } : {})
        },
        session
      );
      dispatched = manifest;
    });
  } finally {
    await session.endSession();
  }

  if (!dispatched) throw new OperationsManifestServiceError("Manifest could not be dispatched.", 500);
  return dispatched;
}

export async function cancelOperationsManifest(manifestIdValue: string, reason: string, userId: mongoose.Types.ObjectId) {
  const manifest = await OperationsManifest.findById(asObjectId(manifestIdValue, "Operations manifest")).exec();
  if (!manifest || !isEditable(manifest)) throw new OperationsManifestServiceError("A sealed, dispatched or cancelled manifest cannot be cancelled.", 409);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      manifest.status = "CANCELLED";
      manifest.cancelledAt = new Date();
      manifest.cancelledBy = userId;
      manifest.cancellationReason = reason;
      await manifest.save({ session });
      await OperationsManifestScanSession.updateMany(
        { manifestId: manifest._id, status: { $ne: "ENDED" } },
        { $set: { status: "ENDED", activeBagId: null, endedAt: new Date(), endedReason: "Manifest cancelled." } },
        { session }
      ).exec();
      await OperationsManifestScan.updateMany({ manifestId: manifest._id, status: "ACCEPTED" }, {
        $set: { status: "REMOVED", removedBy: userId, removedAt: new Date(), removalReason: `Manifest cancelled: ${reason}` }
      }, { session }).exec();
      await audit("OPERATIONS_MANIFEST_CANCELLED", manifest._id as mongoose.Types.ObjectId, userId, { reason }, session);
    });
  } finally {
    await session.endSession();
  }
  return manifest;
}

export async function deleteOperationsManifest(input: {
  manifestId: string;
  confirmationManifestNumber: string;
  userId: mongoose.Types.ObjectId;
}) {
  const manifestId = asObjectId(input.manifestId, "Operations manifest");
  const session = await mongoose.startSession();

  try {
    const deleted = await session.withTransaction(async () => {
      const manifest = await OperationsManifest.findById(manifestId).session(session).exec();
      if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
      if (input.confirmationManifestNumber.trim().toUpperCase() !== manifest.manifestNumber) {
        throw new OperationsManifestServiceError("Manifest deletion confirmation did not match.", 409);
      }

      const sequence = operationsManifestSequence(manifest.manifestNumber);
      const numberWillBeReused = isOperationsManifestNumberReusable(manifest.status) && sequence !== null;

      // Existing tracking milestones remain as shipment history, but the
      // manifest workspace and all of its packing/scanner children are removed.
      // The audit row is intentionally retained after the parent is gone.
      await audit("OPERATIONS_MANIFEST_DELETED", manifestId, input.userId, {
        manifestNumber: manifest.manifestNumber,
        status: manifest.status,
        branchId: manifest.branchId,
        totalBags: manifest.totalBags,
        totalConsignments: manifest.totalConsignments,
        totalPhysicalParcels: manifest.totalPhysicalParcels,
        totalWeightKg: manifest.totalWeightKg,
        numberWillBeReused
      }, session);

      await OperationsManifestScanSession.deleteMany({ manifestId }, { session }).exec();
      await OperationsManifestScan.deleteMany({ manifestId }, { session }).exec();
      await OperationsManifestConsignment.deleteMany({ manifestId }, { session }).exec();
      await OperationsManifestBag.deleteMany({ manifestId }, { session }).exec();
      await OperationsManifest.deleteOne({ _id: manifestId }, { session }).exec();

      if (numberWillBeReused && sequence !== null) {
        await OperationsManifestCounter.updateOne(
          { _id: "operations-manifest" },
          [{
            $set: {
              sequence: { $max: [{ $ifNull: ["$sequence", 0] }, 16] },
              reusableSequences: {
                $setUnion: [{ $ifNull: ["$reusableSequences", []] }, [sequence]]
              }
            }
          }],
          { upsert: true, session, updatePipeline: true }
        ).exec();
      }

      return {
        manifestNumber: manifest.manifestNumber,
        status: manifest.status,
        numberWillBeReused
      };
    });
    if (!deleted) throw new OperationsManifestServiceError("Operations manifest could not be deleted.", 500);
    return deleted;
  } finally {
    await session.endSession();
  }
}

async function normalizeEditableManifestData(manifest: IOperationsManifest) {
  if (!isEditable(manifest)) return;
  const [bags, consignments] = await Promise.all([
    OperationsManifestBag.find({ manifestId: manifest._id, status: { $ne: "CANCELLED" } }).sort({ sequence: 1 }).exec(),
    OperationsManifestConsignment.find({
      manifestId: manifest._id,
      status: { $ne: "REMOVED" },
      $or: [
        { parcelWeightSnapshots: { $exists: false } },
        { parcelWeightSnapshots: { $size: 0 } },
        { "parcelWeightSnapshots.valueMinor": null },
        { "parcelWeightSnapshots.items": { $exists: false } },
        { "parcelWeightSnapshots.items": { $size: 0 } }
      ]
    }).exec()
  ]);
  let changed = false;

  for (const bag of bags) {
    const expectedNumber = formatOperationsBagNumber(manifest.manifestNumber, bag.sequence);
    if (bag.bagNumber === expectedNumber && bag.barcode === expectedNumber) continue;
    bag.bagNumber = expectedNumber;
    bag.barcode = expectedNumber;
    await bag.save();
    changed = true;
  }

  if (consignments.length) {
    const shipments = await DpdShipment.find({ _id: { $in: consignments.map((item) => item.dpdShipmentId) } }).exec();
    const shipmentById = new Map(shipments.map((shipment) => [String(shipment._id), shipment]));
    for (const consignment of consignments) {
      const shipment = shipmentById.get(String(consignment.dpdShipmentId));
      const snapshot = shipment
        ? readShipmentBookingSnapshot(shipment.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(shipment.bookingSnapshot)
        : null;
      if (!snapshot) continue;
      let valueChanged = false;
      if (!consignment.parcelWeightSnapshots.length) {
        consignment.parcelWeightSnapshots = snapshot.parcels.map((parcel) => ({
          parcelNumber: parcel.swiftlineParcelNumber.toUpperCase(),
          weightKg: roundWeight(parcel.actualWeightKg),
          contentsDescription: typeof parcel.contentsDescription === "string" ? parcel.contentsDescription : "",
          items: normalizeParcelItems(parcel),
          valueMinor: snapshotParcelValueMinor(parcel)
        }));
        valueChanged = true;
      } else {
        valueChanged = fillMissingParcelValues(consignment.parcelWeightSnapshots, snapshot);
        const snapshotItemsByParcel = new Map(
          snapshot.parcels.map((parcel) => [parcel.swiftlineParcelNumber.toUpperCase(), normalizeParcelItems(parcel)])
        );
        for (const parcel of consignment.parcelWeightSnapshots) {
          if (parcel.items?.length) continue;
          const items = snapshotItemsByParcel.get(parcel.parcelNumber.toUpperCase());
          if (!items?.length) continue;
          parcel.items = items;
          valueChanged = true;
        }
      }
      const declaredValueMinor = snapshotDeclaredGoodsValueMinor(snapshot);
      if (consignment.declaredValueMinor !== declaredValueMinor) {
        consignment.declaredValueMinor = declaredValueMinor;
        valueChanged = true;
      }
      if (valueChanged) {
        consignment.markModified("parcelWeightSnapshots");
        consignment.weightKg = calculateScannedParcelWeight(consignment);
        await consignment.save();
        changed = true;
      }
    }
  }

  if (changed) await recalculateTotals(manifest._id as mongoose.Types.ObjectId);
}

export async function getOperationsManifestDetail(manifestIdValue: string, options?: { latestScanId?: string }) {
  const manifestId = asObjectId(manifestIdValue, "Operations manifest");
  const manifestDocument = await OperationsManifest.findById(manifestId).exec();
  if (!manifestDocument) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  await normalizeEditableManifestData(manifestDocument);
  const [manifest, bags, consignments, scans, acceptedScans] = await Promise.all([
    OperationsManifest.findById(manifestId).lean().exec(),
    OperationsManifestBag.find({ manifestId }).sort({ sequence: 1 }).lean().exec(),
    OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } }).sort({ createdAt: 1 }).lean().exec(),
    OperationsManifestScan.find({ manifestId }).sort({ scannedAt: -1 }).limit(50).lean().exec(),
    OperationsManifestScan.find({ manifestId, status: "ACCEPTED" })
      .select("bagId parcelNumber consignmentId")
      .sort({ scannedAt: 1 })
      .lean()
      .exec()
  ]);
  if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
  const sealShipmentIds = consignments.map((item) => item.shipmentDraftId);
  const [sealEvents, sealCancellations] = sealShipmentIds.length
    ? await Promise.all([
        ShipmentEvent.find({ shipmentDraftId: { $in: sealShipmentIds } })
          .select("shipmentDraftId status eventAt")
          .lean()
          .exec(),
        ShipmentCancellation.find({
          shipmentDraftId: { $in: sealShipmentIds },
          status: { $in: ["REQUESTED", "COMPLETED"] }
        }).select("shipmentDraftId status").lean().exec()
      ])
    : [[], []];
  const dispatchIssues = manifest.status === "SEALED"
    ? await loadManifestDispatchIssues(consignments)
    : [];
  const destinationSummary = summarizeManifestDestinations(consignments);
  const branch = await Branch.findById(manifest.branchId).select("name code address contact").lean().exec();
  const bagNumberById = new Map(bags.map((bag) => [String(bag._id), bag.bagNumber]));
  const latestScan = options?.latestScanId
    ? scans.find((scan) => String(scan._id) === options.latestScanId)
    : scans[0];
  return {
    manifest: { ...serializeManifest(manifest as unknown as IOperationsManifest), branch },
    bags: bags.map((bag) => ({ ...bag, id: String(bag._id), manifestId: String(bag.manifestId) })),
    consignments: consignments.map((item) => {
      const packedIn = bagIdsForConsignment(acceptedScans, item._id);
      return {
        ...item,
        id: String(item._id),
        manifestId: String(item.manifestId),
        bagId: String(item.bagId),
        // Every bag holding a parcel of this consignment, in packing order.
        bagIds: packedIn,
        bagNumbers: packedIn.map((id) => bagNumberById.get(id) ?? "").filter(Boolean),
        shipmentDraftId: String(item.shipmentDraftId),
        dpdShipmentId: String(item.dpdShipmentId),
        businessAccountId: String(item.businessAccountId),
        displayConsignmentNumber: formatManifestConsignmentNumber(item.consignmentNumber),
        // Goods value is entered per parcel; the consignment value is their sum.
        parcelValues: scannedParcelValues(item),
        goodsValueRequired: scannedParcelValues(item).some((parcel) => !parcel.valueMinor),
        dpdWarning: item.dpdLabelGenerated ? "" : "Swiftline labels have not been generated for every parcel on this shipment."
      };
    }),
    scans: scans.map((scan) => ({ ...scan, id: String(scan._id), manifestId: String(scan.manifestId), bagId: scan.bagId ? String(scan.bagId) : null })),
    latestScan: latestScan
      ? { ...latestScan, id: String(latestScan._id), bagId: latestScan.bagId ? String(latestScan.bagId) : null }
      : null,
    sealingIssues: [
      ...sealingIssues(
        manifest as unknown as IOperationsManifest,
        bags.filter((bag) => bag.status !== "CANCELLED"),
        consignments
      ),
      ...(isEditable(manifest)
        ? buildManifestSealReadinessIssues({ consignments, events: sealEvents, cancellations: sealCancellations })
            .map((issue) => `${issue.reference}: ${issue.reason}`)
        : [])
    ],
    destinationSummary,
    dispatchIssues
  };
}

function readSealedSnapshot(manifest: IOperationsManifest): SealedSnapshot {
  const snapshot = parseSealedSnapshot(manifest.sealedSnapshot);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  return snapshot;
}

function normalizedManifestAddress(value: unknown) {
  const seen = new Set<string>();
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    const key = line.replace(/\s+/g, " ").toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((line) => ["UNITED KINGDOM", "UK", "GREAT BRITAIN"].includes(line.toUpperCase()) ? "GB" : line).join("\n");
}

function spacedPdfAddress(value: unknown) {
  const lines = normalizedManifestAddress(value).split("\n").filter(Boolean);
  const phone = lines.find((line) => line.toUpperCase().startsWith("TEL-"));
  const address = lines.filter((line) => line !== phone);
  const spread = [...address.slice(0, 3), "", ...address.slice(3)];
  if (phone) spread.push("", phone);
  // Legacy fallback keeps the trailing blank row the fixed party block also carries.
  spread.push("");
  return spread;
}

export async function buildOperationsManifestExcel(manifest: IOperationsManifest) {
  const snapshot = readSealedSnapshot(manifest);
  const model = buildManifestDocumentModel(snapshot);
  const bagSequenceByNumber = new Map(snapshot.bags.map((bag, index) => {
    const storedSequence = Number(bag.sequence);
    const sequence = Number.isInteger(storedSequence) && storedSequence > 0
      ? storedSequence
      : index + 1;
    return [String(bag.bagNumber ?? "").trim().toUpperCase(), sequence] as const;
  }));
  // The sealed snapshot remains in packing/consignment order. Sort only a copy
  // used by the standard Excel renderer so every parcel row stays intact while
  // the Bag No column reads 01, 01, 02... EDI, PDF and UK exports keep their
  // existing contracts and ordering.
  const excelParcelRows = model.parcelRows
    .map((row, sourceIndex) => ({
      row,
      sourceIndex,
      bagSequence: bagSequenceByNumber.get(row.bagNumber.trim().toUpperCase()) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => left.bagSequence - right.bagSequence || left.sourceIndex - right.sourceIndex)
    .map(({ row }) => row);
  const virtualManifest = {
    manifestNumber: model.manifestNumber,
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: manifest.branchId,
    shipmentDraftIds: model.consignments.map((item) => new mongoose.Types.ObjectId(item.shipmentDraftId)),
    headerSnapshot: {
      originBranch: [String(model.branch.name ?? ""), String(model.branch.code ?? "")].filter(Boolean).join(" - "),
      originAddress: model.originAddress || formatManifestOrigin(model.branch),
      destinationAgent: snapshot.header.destinationAgent,
      flightNumber: snapshot.header.flightNumber,
      departureDate: snapshot.header.departureDate,
      mawbNumber: snapshot.header.mawbNumber,
      originIataCode: snapshot.header.originIataCode,
      destinationIataCode: snapshot.header.destinationIataCode,
      valueType: snapshot.header.valueType
    },
    // One line per parcel, straight from the shared document model. The goods value
    // already lives only on each consignment's first parcel row.
    lineSnapshots: excelParcelRows.map((row) => ({
      shipmentDraftId: new mongoose.Types.ObjectId(row.shipmentDraftId),
      dpdShipmentId: new mongoose.Types.ObjectId(row.dpdShipmentId),
      consignmentNumber: row.consignmentNumber,
      pieces: 1,
      weightKg: row.weightKg,
      consignor: { formatted: normalizedManifestAddress(row.consignor.formatted), party: row.consignor.party },
      consignee: { formatted: normalizedManifestAddress(row.consignee.formatted), party: row.consignee.party },
      description: fullManifestParcelDescription(row.items, row.description),
      declaredValueMinor: row.declaredValueMinor,
      currency: row.currency,
      bagNumber: row.bagNumber,
      serviceInfo: row.serviceInfo
    })),
    totalPieces: model.totals.totalPhysicalParcels,
    totalWeightKg: model.totals.totalWeightKg,
    totalBags: model.totals.totalBags,
    actorRole: "admin",
    generatedAt: model.generatedAt
  };
  return buildShipmentManifestWorkbook(virtualManifest as unknown as IShipmentManifest, {
    includeChargeableWeight: false
  });
}

export async function buildOperationsManifestPdf(manifest: IOperationsManifest) {
  const snapshot = readSealedSnapshot(manifest);
  const model = buildManifestDocumentModel(snapshot);
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 20 });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    const widths = [30, 78, 42, 50, 132, 145, 120, 55, 45, 45, 58];
    const headers = ["S.No *", "Consignment\nNo. *", "Pieces *", "Weight\n(kg)", "Consignor *", "Consignee *", "Description *", "Value *", "Currency *", "Bag No *", "Service\nInfo"];
    const left = document.page.margins.left;
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const drawCell = (column: number, y: number, height: number, value: unknown, options?: { bold?: boolean; align?: "left" | "center"; size?: number }) => {
      const x = left + widths.slice(0, column).reduce((sum, width) => sum + width, 0);
      document.rect(x, y, widths[column] ?? 0, height).stroke("#222222");
      document.font(options?.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options?.size ?? 7)
        .fillColor("#111111").text(String(value ?? ""), x + 3, y + 4, { width: (widths[column] ?? 0) - 6, height: height - 6, align: options?.align ?? "center", lineGap: 1 });
    };
    let y = 30;
    document.rect(left, y, totalWidth, 34).stroke("#222222");
    document.font("Helvetica-Bold").fontSize(10).text("Courier Manifest", left + 10, y + 11, { width: totalWidth - 20, align: "center" });
    y += 34;
    const branchLines = (model.originAddress || formatManifestOrigin(snapshot.branch)).split("\n");
    const destinationLines = String(snapshot.header.destinationAgent ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const details: Array<[string, string | number]> = [
      ["Manifest Number", snapshot.manifestNumber], ["FLIGHT NUMBER", snapshot.header.flightNumber],
      ["FLIGHT DEPARTURE DATE", snapshot.header.departureDate.split("-").reverse().join("/")], ["MAWB NO. *", snapshot.header.mawbNumber],
      ["MAWB ORIGIN (IATA Code) *", snapshot.header.originIataCode], ["MAWB DESTINATION (IATA Code) *", snapshot.header.destinationIataCode],
      ["TOTAL BAGS *", snapshot.totals.totalBags], ["TOTAL WEIGHT (kg) *", snapshot.totals.totalWeightKg.toFixed(3)],
      ["VALUE TYPE (HV, LV, TS, Docs)", snapshot.header.valueType], ["", ""]
    ];
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < widths.length; column += 1) drawCell(column, y, 16, "");
      if (row === 0) { drawCell(4, y, 16, "FROM *", { bold: true, align: "left" }); drawCell(5, y, 16, "TO *", { bold: true, align: "left" }); }
      else { drawCell(4, y, 16, branchLines[row - 1] ?? "", { bold: row === 1, align: "left" }); drawCell(5, y, 16, destinationLines[row - 1] ?? "", { bold: row === 1, align: "left" }); }
      drawCell(6, y, 16, details[row]?.[0] ?? "", { bold: true, align: "left" });
      drawCell(7, y, 16, details[row]?.[1] ?? "", { bold: true, align: "left" });
      y += 16;
    }
    y += 10;
    headers.forEach((header, index) => drawCell(index, y, 30, header, { bold: true }));
    y += 30;
    const rowHeight = 11.2;
    model.consignments.forEach((consignment) => {
      // Same fixed ten-row block as the Excel: contact name first (no company), the
      // phone on the consignee only, and a blank tenth row.
      const consignorLines = consignment.consignor.party
        ? fixedPartyAddressRows(consignment.consignor.party, false)
        : spacedPdfAddress(consignment.consignor.formatted);
      const consigneeLines = consignment.consignee.party
        ? fixedPartyAddressRows(consignment.consignee.party, true)
        : spacedPdfAddress(consignment.consignee.formatted);
      const blockSize = Math.max(consignorLines.length, consigneeLines.length);

      consignment.parcels.forEach((parcel) => {
        const description = fullManifestParcelDescription(parcel.items, parcel.description);
        document.font("Helvetica").fontSize(6.5);
        const descriptionHeight = document.heightOfString(description, {
          width: (widths[6] ?? 0) - 6,
          align: "center",
          lineGap: 1
        });
        const firstRowHeight = Math.max(rowHeight, descriptionHeight + 8);
        const blockHeight = firstRowHeight + Math.max(0, blockSize - 1) * rowHeight;
        if (y + blockHeight > document.page.height - 28) {
          document.addPage();
          y = document.page.margins.top;
          headers.forEach((header, column) => drawCell(column, y, 30, header, { bold: true }));
          y += 30;
        }

        for (let row = 0; row < blockSize; row += 1) {
          const values = row === 0
            ? [
              parcel.serial,
              consignment.formattedConsignmentNumber,
              1,
              parcel.weightKg.toFixed(3),
              consignorLines[0] ?? "",
              consigneeLines[0] ?? "",
              description,
              parcel.declaredValueMinor != null ? (parcel.declaredValueMinor / 100).toFixed(2) : "",
              consignment.currency,
              parcel.bagNumber,
              consignment.serviceInfo
            ]
            : ["", "", "", "", consignorLines[row] ?? "", consigneeLines[row] ?? "", "", "", "", "", ""];
          const currentRowHeight = row === 0 ? firstRowHeight : rowHeight;
          values.forEach((value, column) => drawCell(column, y, currentRowHeight, value, { align: "center", size: 6.5 }));
          y += currentRowHeight;
        }
      });
    });
    document.font("Helvetica").fontSize(7).text("Swiftline Portal | Computer Generated Operations Manifest", left, document.page.height - 18, { width: totalWidth, align: "center" });
    document.end();
  });
}
