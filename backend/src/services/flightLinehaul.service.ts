import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { FlightLinehaul, type IFlightLinehaul, type FlightLinehaulStatus, type ConnectionRisk } from "../models/flightLinehaul.model.js";
import { FlightLinehaulCounter } from "../models/flightLinehaulCounter.model.js";
import { FlightShipmentAllocation } from "../models/flightShipmentAllocation.model.js";
import { FlightOffload } from "../models/flightOffload.model.js";
import { FlightException } from "../models/flightException.model.js";
import { FlightDocument } from "../models/flightDocument.model.js";
import { OperationsManifest, type IOperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { OperationsManifestScan } from "../models/operationsManifestScan.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import type { PortalNotificationType } from "../models/portalNotification.model.js";
import { User } from "../models/user.model.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";
import { resolveShipmentEventNote } from "./shipmentEventCopy.service.js";
import { notifyFlightOperationsStaff } from "./portalNotification.service.js";
import { comparableFlightNumber, normalizeFlightNumber } from "../utils/flightNumber.js";
import { describeMissingPrerequisites, findMissingPrerequisites } from "./shipmentStatusSequence.service.js";

export class FlightLinehaulServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

function asObjectId(value: string, label: string) {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new FlightLinehaulServiceError(`${label} was not found.`, 404);
  return new mongoose.Types.ObjectId(value);
}

function roundWeight(value: number) {
  return Number(Number(value).toFixed(3));
}

// SLA thresholds - industry standard air-cargo values, operating in IST
export const FLIGHT_SLA = {
  delayThresholdMinutes: 120, // 2h after scheduled departure without actual departure
  connectionMinMinutes: 90,
  connectionRiskBufferMinutes: 120,
  customsSlaHours: 12,
  customsCriticalHours: 24,
  finalMileSlaHours: 24,
  finalMileCriticalHours: 48
} as const;

export const flightStatusOrder: FlightLinehaulStatus[] = [
  "BOOKING_CONFIRMED",
  "CARGO_ALLOCATED",
  "DEPARTED",
  "ARRIVED_DESTINATION",
  "CLOSED",
  "CANCELLED"
];

// New flights follow the short operational lifecycle below. Legacy values are
// retained only to let historical records move safely to the next meaningful
// milestone; no new flight can be moved into a legacy state.
export const allowedTransitions: Record<FlightLinehaulStatus, FlightLinehaulStatus[]> = {
  PLANNED: ["BOOKING_CONFIRMED", "CARGO_ALLOCATED", "CANCELLED"],
  BOOKING_CONFIRMED: ["CARGO_ALLOCATED", "CANCELLED"],
  CARGO_ALLOCATED: ["DEPARTED", "CANCELLED"],
  MANIFEST_READY: ["DEPARTED", "CANCELLED"],
  HANDED_TO_AIRLINE: ["DEPARTED", "CANCELLED"],
  DEPARTED: ["ARRIVED_DESTINATION"],
  IN_TRANSIT: ["ARRIVED_DESTINATION"],
  CONNECTION: ["ARRIVED_DESTINATION"],
  ARRIVED_DESTINATION: ["CLOSED"],
  CUSTOMS: ["CLOSED"],
  HANDED_TO_FINAL_MILE: ["CLOSED"],
  CLOSED: [],
  CANCELLED: []
};

const allocationOpenStatuses: FlightLinehaulStatus[] = [
  "PLANNED",
  "BOOKING_CONFIRMED",
  "CARGO_ALLOCATED",
  "MANIFEST_READY",
  "HANDED_TO_AIRLINE"
];

const departureLockedStatuses: FlightLinehaulStatus[] = [
  "DEPARTED",
  "IN_TRANSIT",
  "CONNECTION",
  "ARRIVED_DESTINATION",
  "CUSTOMS",
  "HANDED_TO_FINAL_MILE",
  "CLOSED",
  "CANCELLED"
];

function isDepartureLocked(status: FlightLinehaulStatus) {
  return departureLockedStatuses.includes(status);
}

function canTransition(from: FlightLinehaulStatus, to: FlightLinehaulStatus) {
  return allowedTransitions[from]?.includes(to) ?? false;
}

export function calculateConnectionRisk(layoverMinutes: number | null): ConnectionRisk {
  if (layoverMinutes == null) return "LOW";
  if (layoverMinutes < 0) return "MISSED";
  if (layoverMinutes < FLIGHT_SLA.connectionMinMinutes) return "CRITICAL";
  if (layoverMinutes < FLIGHT_SLA.connectionRiskBufferMinutes) return "HIGH";
  if (layoverMinutes < 180) return "MEDIUM";
  return "LOW";
}

export function formatFlightLinehaulNumber(sequence: number) {
  return `FLH${String(sequence).padStart(4, "0")}`;
}

export async function allocateFlightLinehaulNumber(session?: mongoose.ClientSession): Promise<string> {
  const counter = await FlightLinehaulCounter.findOneAndUpdate(
    { _id: "flight-linehaul" },
    [
      {
        $set: {
          sequence: { $max: [{ $ifNull: ["$sequence", 0] }, 0] },
          reusableSequences: {
            $filter: {
              input: { $setUnion: [{ $ifNull: ["$reusableSequences", []] }, []] },
              as: "c",
              cond: { $gte: ["$$c", 1] }
            }
          }
        }
      },
      {
        $set: {
          lastAllocatedSequence: {
            $cond: [{ $gt: [{ $size: "$reusableSequences" }, 0] }, { $min: "$reusableSequences" }, { $add: ["$sequence", 1] }]
          },
          sequence: {
            $cond: [{ $gt: [{ $size: "$reusableSequences" }, 0] }, "$sequence", { $add: ["$sequence", 1] }]
          },
          reusableSequences: {
            $cond: [
              { $gt: [{ $size: "$reusableSequences" }, 0] },
              { $setDifference: ["$reusableSequences", [{ $min: "$reusableSequences" }]] },
              "$reusableSequences"
            ]
          }
        }
      }
    ],
    { upsert: true, returnDocument: "after", session, updatePipeline: true }
  ).exec();
  if (!counter) throw new FlightLinehaulServiceError("Flight number could not be generated.", 500);
  const seq = counter.lastAllocatedSequence ?? counter.sequence;
  return formatFlightLinehaulNumber(seq);
}

async function audit(
  action: string,
  flightId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  metadata: Record<string, unknown>,
  session?: mongoose.ClientSession
) {
  await AuditLog.create(
    [
      {
        action: action as never,
        entityType: "FLIGHT_LINEHAUL",
        entityId: flightId,
        performedBy: userId,
        performedAt: new Date(),
        metadata
      }
    ],
    { session }
  );
}

async function notifyFlightStaffSafely(
  branchId: mongoose.Types.ObjectId,
  input: {
    type: PortalNotificationType;
    title: string;
    message: string;
    href: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  session?: mongoose.ClientSession
) {
  try {
    await notifyFlightOperationsStaff(branchId, input, session);
  } catch (error) {
    // The flight state and audit trail are authoritative. Notification delivery
    // is retried through the operational workflow/email outbox, so it must not
    // make a valid flight transition fail.
    console.error("Flight status notification could not be queued.", {
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

async function maybeMarkCostSheetsForReview(flightId: mongoose.Types.ObjectId) {
  try {
    const manifests = await OperationsManifest.find({ flightLinehaulId: flightId }).select("_id").lean().exec();
    for (const manifest of manifests) {
      const { markSheetReviewRequiredIfChanged } = await import("./flightProfitability.service.js");
      // Flight allocation/offload is a physical-flight change even when the
      // sealed manifest snapshot is immutable and therefore its totals are
      // unchanged. Force a review so a finalized manifest-linked cost sheet
      // cannot remain silently treated as final after cargo changes.
      await markSheetReviewRequiredIfChanged(
        manifest._id as mongoose.Types.ObjectId,
        "Flight allocation/offload changed",
        { force: true }
      );
    }
  } catch {
    // best effort
  }
}

async function recalculateFlightTotals(flightId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  const flight = await FlightLinehaul.findById(flightId).session(session ?? null).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);

  const [allocations, manifests, bags] = await Promise.all([
    FlightShipmentAllocation.find({ flightLinehaulId: flightId, status: { $in: ["ALLOCATED", "CARRIED"] } })
      .session(session ?? null)
      .lean()
      .exec(),
    OperationsManifest.find({ flightLinehaulId: flightId }).session(session ?? null).lean().exec(),
    OperationsManifestBag.find({ manifestId: { $in: await OperationsManifest.find({ flightLinehaulId: flightId }).distinct("_id") }, status: { $ne: "CANCELLED" } })
      .session(session ?? null)
      .lean()
      .exec()
  ]);

  // Prefer manifest-derived if manifests exist? But spec says derived from allocations/manifests
  const allocatedWeightKg = roundWeight(allocations.reduce((sum, a) => sum + a.weightKg, 0));
  const totalShipments = allocations.length;
  // Bags come from manifests, but pieces must describe cargo still assigned to
  // the flight. A sealed manifest is immutable historical evidence and can
  // still contain parcels that were later offloaded.
  let totalBags = 0;
  if (manifests.length) totalBags = bags.length;
  const totalPieces = allocations.reduce((sum, a) => sum + (a.pieces ?? 0), 0);

  flight.allocatedWeightKg = allocatedWeightKg;
  flight.totalShipments = totalShipments;
  flight.totalBags = totalBags;
  flight.totalPieces = totalPieces;
  flight.utilisationPercent = flight.capacityKg > 0 ? Number(((allocatedWeightKg / flight.capacityKg) * 100).toFixed(1)) : 0;
  await flight.save({ session });

  // Auto exception: capacity warning / exceeded
  if (flight.capacityKg > 0) {
    if (allocatedWeightKg > flight.capacityKg) {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "CAPACITY_EXCEEDED",
        severity: "CRITICAL",
        title: "Flight over capacity",
        description: `Allocated ${allocatedWeightKg.toFixed(3)} kg exceeds capacity ${flight.capacityKg.toFixed(3)} kg.`,
        dedupeKey: `CAPACITY_EXCEEDED:${String(flight._id)}`,
        dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
      }, session);
    } else if (flight.utilisationPercent >= 90) {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "CAPACITY_WARNING",
        severity: flight.utilisationPercent >= 95 ? "HIGH" : "MEDIUM",
        title: "Flight near capacity",
        description: `Flight utilisation at ${flight.utilisationPercent}% (${allocatedWeightKg.toFixed(3)}/${flight.capacityKg.toFixed(3)} kg).`,
        dedupeKey: `CAPACITY_WARNING:${String(flight._id)}:${Math.floor(flight.utilisationPercent / 5) * 5}`,
        dueAt: new Date(Date.now() + 12 * 60 * 60 * 1000)
      }, session);
    }
  }

  return flight;
}

export async function createExceptionIdempotent(input: {
  flightId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  description: string;
  dedupeKey: string;
  dueAt?: Date | null;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  bagId?: mongoose.Types.ObjectId | null;
  manifestId?: mongoose.Types.ObjectId | null;
  assignedTo?: mongoose.Types.ObjectId | null;
}, session?: mongoose.ClientSession) {
  try {
    const result = await FlightException.updateOne(
      { dedupeKey: input.dedupeKey },
      {
        $setOnInsert: {
          flightLinehaulId: input.flightId,
          branchId: input.branchId,
          type: input.type as never,
          severity: input.severity,
          status: "OPEN",
          title: input.title,
          description: input.description,
          shipmentDraftId: input.shipmentDraftId ?? null,
          bagId: input.bagId ?? null,
          manifestId: input.manifestId ?? null,
          assignedTo: input.assignedTo ?? null,
          dedupeKey: input.dedupeKey,
          dueAt: input.dueAt ?? null,
          resolutionNotes: ""
        }
      },
      { upsert: true, session }
    ).exec();
    // Notify operations on new high/critical exceptions (idempotent via upsert)
    if ((result as unknown as { upsertedCount?: number }).upsertedCount === 1 || (result as unknown as { upsertedId?: unknown }).upsertedId) {
      if (["HIGH", "CRITICAL"].includes(input.severity)) {
        const notifType =
          input.type === "FLIGHT_DELAY" ? "FLIGHT_DELAY"
          : input.type === "OFFLOAD" ? "FLIGHT_OFFLOAD"
          : input.type === "RISKY_CONNECTION" || input.type === "MISSED_CONNECTION" ? "FLIGHT_CONNECTION_RISK"
          : "FLIGHT_EXCEPTION";
        try {
          // Await this while the transaction is still open. The notification
          // and email outbox rows must join the same transaction; a fire-and-
          // forget call can otherwise use an ended session and silently lose
          // the alert after the flight change commits.
          await notifyFlightOperationsStaff(input.branchId, {
            type: notifType as never,
            title: input.title,
            message: input.description.slice(0, 200),
            href: `/dashboard/flight-linehauls/${String(input.flightId)}`,
            idempotencyKey: `FLIGHT_EXCEPTION:${input.dedupeKey}`,
            metadata: { flightId: String(input.flightId), type: input.type, severity: input.severity }
          }, session);
        } catch (notificationError) {
          // The exception remains the source of truth. A notification failure
          // must not roll back the operational exception itself.
          console.error("Flight exception notification could not be queued.", {
            flightId: String(input.flightId),
            dedupeKey: input.dedupeKey,
            message: notificationError instanceof Error ? notificationError.message : "Unknown error"
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return;
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createFlightLinehaul(input: {
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
  connection?: { transitAirportCode?: string; scheduledArrivalAt?: string | null; scheduledDepartureAt?: string | null } | null;
  /** When supplied, the flight and its manifest attachment are one transaction. */
  manifestId?: string;
  userId: mongoose.Types.ObjectId;
}): Promise<IFlightLinehaul> {
  const branchId = asObjectId(input.branchId, "Branch");
  const branch = await Branch.findOne({ _id: branchId, status: "ACTIVE" }).lean().exec();
  if (!branch) throw new FlightLinehaulServiceError("Select an active branch.", 409);

  const flightNumber = normalizeFlightNumber(input.flightNumber);
  if (!/^[A-Z0-9]{2,4}-\d{1,4}[A-Z]?$/.test(flightNumber)) {
    throw new FlightLinehaulServiceError("Enter a valid flight number (e.g., EY-219 or AI-131).", 400);
  }
  const airlineName = (input.airlineName ?? "").trim();
  if (airlineName.length < 2) throw new FlightLinehaulServiceError("Airline is required.", 400);
  const mawbNumber = (input.mawbNumber ?? "").trim().toUpperCase();
  if (!/^\d{3}-?\d{8}$/.test(mawbNumber)) throw new FlightLinehaulServiceError("Enter a valid MAWB (e.g., 098-12345678).", 400);
  const originIata = (input.originIataCode ?? "").trim().toUpperCase();
  const destIata = (input.destinationIataCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(originIata)) throw new FlightLinehaulServiceError("Origin IATA must be 3 letters.", 400);
  if (!/^[A-Z]{3}$/.test(destIata)) throw new FlightLinehaulServiceError("Destination IATA must be 3 letters.", 400);
  if (originIata === destIata) throw new FlightLinehaulServiceError("Origin and destination airports must be different.", 400);
  const transitIata = (input.transitIataCode ?? "").trim().toUpperCase();
  if (transitIata && !/^[A-Z]{3}$/.test(transitIata)) throw new FlightLinehaulServiceError("Transit IATA must be 3 letters.", 400);

  const scheduledDepartureAt = new Date(input.scheduledDepartureAt);
  const scheduledArrivalAt = new Date(input.scheduledArrivalAt);
  if (Number.isNaN(scheduledDepartureAt.getTime()) || Number.isNaN(scheduledArrivalAt.getTime())) {
    throw new FlightLinehaulServiceError("Scheduled departure and arrival must be valid dates.", 400);
  }
  if (scheduledArrivalAt <= scheduledDepartureAt) throw new FlightLinehaulServiceError("Arrival must be after departure.", 400);
  if (input.capacityKg <= 0 || !Number.isFinite(input.capacityKg)) throw new FlightLinehaulServiceError("Capacity must be a positive number.", 400);

  // Optional connection validation
  let connectionDoc: IFlightLinehaul["connection"] = null;
  if (input.connection?.transitAirportCode) {
    const code = input.connection.transitAirportCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new FlightLinehaulServiceError("Transit airport code must be 3 letters.", 400);
    const sArr = input.connection.scheduledArrivalAt ? new Date(input.connection.scheduledArrivalAt) : null;
    const sDep = input.connection.scheduledDepartureAt ? new Date(input.connection.scheduledDepartureAt) : null;
    let layover: number | null = null;
    if (sArr && sDep && !Number.isNaN(sArr.getTime()) && !Number.isNaN(sDep.getTime())) {
      layover = Math.round((sDep.getTime() - sArr.getTime()) / 60000);
    }
    connectionDoc = {
      transitAirportCode: code,
      scheduledArrivalAt: sArr && !Number.isNaN(sArr.getTime()) ? sArr : null,
      scheduledDepartureAt: sDep && !Number.isNaN(sDep.getTime()) ? sDep : null,
      actualArrivalAt: null,
      actualDepartureAt: null,
      layoverMinutes: layover,
      riskLevel: calculateConnectionRisk(layover)
    };
  }

  // Airline flight and MAWB references are operational data, not portal IDs:
  // the generated FLH number identifies each Swiftline movement. A manifest can
  // still be attached to only one active flight, which prevents double-loading.
  const manifestId = input.manifestId ? asObjectId(input.manifestId, "Manifest") : null;

  const session = await mongoose.startSession();
  try {
    let created: IFlightLinehaul | null = null;
    await session.withTransaction(async () => {
      const flightLinehaulNumber = await allocateFlightLinehaulNumber(session);
      const docs = await FlightLinehaul.create(
        [
          {
            flightLinehaulNumber,
            branchId,
            flightNumber,
            airlineName,
            mawbNumber,
            originIataCode: originIata,
            destinationIataCode: destIata,
            transitIataCode: transitIata || connectionDoc?.transitAirportCode || "",
            scheduledDepartureAt,
            scheduledArrivalAt,
            capacityKg: roundWeight(input.capacityKg),
            allocatedWeightKg: 0,
            utilisationPercent: 0,
            totalShipments: 0,
            totalBags: 0,
            totalPieces: 0,
            status: "BOOKING_CONFIRMED",
            connection: connectionDoc,
            customsStatus: "PENDING",
            destinationAgent: (input.destinationAgent ?? "").trim(),
            finalMileCarrier: (input.finalMileCarrier ?? "").trim(),
            handoverReference: "",
            cancellationReason: "",
            createdBy: input.userId
          }
        ],
        { session }
      );
      created = docs[0] ?? null;
      if (!created) throw new FlightLinehaulServiceError("Flight could not be created.", 500);
      await audit("FLIGHT_LINEHAUL_CREATED", created._id as mongoose.Types.ObjectId, input.userId, { flightLinehaulNumber, flightNumber, branchId: String(branchId) }, session);
      if (manifestId) {
        await attachManifestInTransaction({
          flightId: created._id as mongoose.Types.ObjectId,
          manifestId,
          userId: input.userId,
          session
        });
      }
    });
    if (!created) throw new FlightLinehaulServiceError("Flight could not be created.", 500);
    const createdFlight = created as IFlightLinehaul;
    if (manifestId) {
      const createdFlightId = createdFlight._id as mongoose.Types.ObjectId;
      await recalculateFlightTotals(createdFlightId);
      void maybeMarkCostSheetsForReview(createdFlightId);
    }
    return createdFlight;
  } finally {
    await session.endSession();
  }
}

export async function listFlightLinehauls(input: {
  page: number;
  limit: number;
  status?: string;
  branchId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  allowedBranchIds?: string[] | null;
}) {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.branchId && mongoose.Types.ObjectId.isValid(input.branchId)) {
    filter.branchId = new mongoose.Types.ObjectId(input.branchId);
  } else if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined) {
    filter.branchId = { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }
  if (input.search?.trim()) {
    const term = input.search.trim().toUpperCase();
    filter.$or = [
      { flightNumber: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { flightLinehaulNumber: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { mawbNumber: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { airlineName: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }
    ];
  }
  if (input.dateFrom || input.dateTo) {
    const range: Record<string, Date> = {};
    if (input.dateFrom) {
      const from = new Date(input.dateFrom);
      if (!Number.isNaN(from.getTime())) range.$gte = from;
    }
    if (input.dateTo) {
      const to = new Date(input.dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        range.$lte = to;
      }
    }
    if (Object.keys(range).length) filter.scheduledDepartureAt = range;
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    FlightLinehaul.find(filter).sort({ scheduledDepartureAt: -1, updatedAt: -1 }).skip(skip).limit(input.limit).lean().exec(),
    FlightLinehaul.countDocuments(filter).exec()
  ]);

  const branchIds = [...new Set(items.map((i) => String(i.branchId)))];
  const branches = branchIds.length ? await Branch.find({ _id: { $in: branchIds } }).select("name code").lean().exec() : [];
  const branchById = new Map(branches.map((b) => [String(b._id), b]));

  return {
    items: items.map((item) => ({
      ...item,
      id: String(item._id),
      branch: branchById.get(String(item.branchId)) ?? null
    })),
    pagination: { page: input.page, limit: input.limit, total, pages: Math.max(1, Math.ceil(total / input.limit)) }
  };
}

export async function getFlightLinehaulSummary(input: { allowedBranchIds?: string[] | null }) {
  const branchFilter: Record<string, unknown> =
    input.allowedBranchIds !== null && input.allowedBranchIds !== undefined
      ? { branchId: { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } }
      : {};

  const now = new Date();
  const tonightStart = new Date(now);
  tonightStart.setHours(0, 0, 0, 0);
  const tonightEnd = new Date(now);
  tonightEnd.setHours(23, 59, 59, 999);
  const tomorrowEnd = new Date(tonightEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const statuses = flightStatusOrder;

  const [byStatus, tonightDepartures, exceptionCounts, offloadedCount, delayedFlights] = await Promise.all([
    FlightLinehaul.aggregate([
      { $match: { ...branchFilter, status: { $ne: "CANCELLED" } } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]).exec(),
    FlightLinehaul.countDocuments({ ...branchFilter, scheduledDepartureAt: { $gte: tonightStart, $lte: tonightEnd }, status: { $in: allocationOpenStatuses } }).exec(),
    FlightException.aggregate([
      { $match: { ...(input.allowedBranchIds !== null && input.allowedBranchIds !== undefined ? { branchId: { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } } : {}), status: { $in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } } },
      { $group: { _id: null, count: { $sum: 1 } } }
    ]).exec(),
    FlightException.countDocuments({ ...(input.allowedBranchIds !== null && input.allowedBranchIds !== undefined ? { branchId: { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } } : {}), type: "OFFLOAD", status: { $in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } }).exec(),
    FlightLinehaul.countDocuments({
      ...branchFilter,
      status: { $in: allocationOpenStatuses },
      scheduledDepartureAt: { $lt: new Date(now.getTime() - FLIGHT_SLA.delayThresholdMinutes * 60 * 1000) }
    }).exec()
  ]);

  const statusMap = new Map<string, number>(byStatus.map((r) => [r._id, r.count]));

  const awaitingFlight = statusMap.get("CARGO_ALLOCATED") ?? 0;
  const departed = (statusMap.get("DEPARTED") ?? 0) + (statusMap.get("IN_TRANSIT") ?? 0) + (statusMap.get("CONNECTION") ?? 0);
  const connectionRisk = await FlightException.countDocuments({
    ...(input.allowedBranchIds !== null && input.allowedBranchIds !== undefined ? { branchId: { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } } : {}),
    type: { $in: ["RISKY_CONNECTION", "MISSED_CONNECTION"] },
    status: { $in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] }
  }).exec();
  const destinationArrived = (statusMap.get("ARRIVED_DESTINATION") ?? 0) + (statusMap.get("CUSTOMS") ?? 0) + (statusMap.get("HANDED_TO_FINAL_MILE") ?? 0);

  return {
    cards: {
      tonightDepartures,
      awaitingFlight,
      departed,
      connectionRisk,
      offloaded: offloadedCount,
      delayed: delayedFlights,
      destinationArrived,
      actionRequiredExceptions: exceptionCounts[0]?.count ?? 0
    },
    byStatus: statuses.map((s) => ({ status: s, count: statusMap.get(s) ?? 0 }))
  };
}

export async function getFlightLinehaulDetail(flightIdValue: string, options?: { allowedBranchIds?: string[] | null }) {
  const flightId = asObjectId(flightIdValue, "Flight");
  const flight = await FlightLinehaul.findById(flightId).lean().exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (options?.allowedBranchIds !== null && options?.allowedBranchIds !== undefined) {
    if (!options.allowedBranchIds.includes(String(flight.branchId))) throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }

  const [allocations, manifests, offloads, exceptions, documents, auditHistory] = await Promise.all([
    FlightShipmentAllocation.find({ flightLinehaulId: flightId }).sort({ allocatedAt: 1 }).lean().exec(),
    OperationsManifest.find({ flightLinehaulId: flightId }).sort({ createdAt: 1 }).lean().exec(),
    FlightOffload.find({ flightLinehaulId: flightId }).sort({ createdAt: -1 }).lean().exec(),
    FlightException.find({ flightLinehaulId: flightId }).sort({ createdAt: -1 }).limit(100).lean().exec(),
    FlightDocument.find({ flightLinehaulId: flightId }).sort({ createdAt: -1 }).lean().exec(),
    AuditLog.find({ entityType: "FLIGHT_LINEHAUL", entityId: flightId }).sort({ performedAt: -1 }).limit(100).lean().exec()
  ]);

  const branch = await Branch.findById(flight.branchId).select("name code").lean().exec();

  // Bags via manifests
  const manifestIds = manifests.map((m) => m._id);
  const bags = manifestIds.length ? await OperationsManifestBag.find({ manifestId: { $in: manifestIds } }).sort({ sequence: 1 }).lean().exec() : [];
  const consignments = manifestIds.length ? await OperationsManifestConsignment.find({ manifestId: { $in: manifestIds }, status: { $ne: "REMOVED" } }).sort({ createdAt: 1 }).lean().exec() : [];
  // Build bagNumbers per consignment from accepted scans (split consignments may span multiple bags)
  const bagNumberById = new Map(bags.map((b) => [String(b._id), b.bagNumber]));
  let bagsByConsignment = new Map<string, string[]>();
  if (consignments.length) {
    const consignmentIds = consignments.map((c) => c._id);
    const scans = await OperationsManifestScan.find({ consignmentId: { $in: consignmentIds }, status: "ACCEPTED" }).select("consignmentId bagId").lean().exec();
    for (const scan of scans) {
      const cid = String(scan.consignmentId);
      const bn = bagNumberById.get(String(scan.bagId)) ?? "";
      if (!bn) continue;
      const arr = bagsByConsignment.get(cid) ?? [];
      if (!arr.includes(bn)) arr.push(bn);
      bagsByConsignment.set(cid, arr);
    }
  }

  // Derived stats (recalculated)
  const activeOrCarried = allocations.filter((a) => ["ALLOCATED", "CARRIED"].includes(a.status));
  const allocatedWeightKg = activeOrCarried.reduce((s, a) => s + a.weightKg, 0);
  const utilisationPercent = flight.capacityKg > 0 ? Number(((allocatedWeightKg / flight.capacityKg) * 100).toFixed(1)) : 0;

  // Check auto exceptions for SLA evaluation
  await evaluateFlightExceptions(flight as IFlightLinehaul, allocations);

  return {
    flight: { ...flight, id: String(flight._id), branch },
    stats: {
      allocatedWeightKg: roundWeight(allocatedWeightKg),
      utilisationPercent,
      totalShipments: activeOrCarried.length,
      totalBags: bags.filter((b) => b.status !== "CANCELLED").length,
      totalPieces: activeOrCarried.reduce((s, a) => s + a.pieces, 0),
      manifestCount: manifests.length
    },
    allocations: allocations.map((a) => {
      const activeParcelNumbers = activeParcelNumbersForAllocation(a);
      const activeSet = new Set(activeParcelNumbers);
      const offloadedSet = new Set(normalizedParcelNumbers(a.offloadedParcelNumbers));
      return {
        ...a,
        id: String(a._id),
        flightLinehaulId: String(a.flightLinehaulId),
        activeParcelNumbers,
        offloadedParcelNumbers: [...offloadedSet],
        parcelDetails: flightAllocationParcelDetails(a.snapshot).map((parcel) => ({
          ...parcel,
          status: offloadedSet.has(parcel.parcelNumber)
            ? "OFFLOADED"
            : activeSet.has(parcel.parcelNumber) ? "ALLOCATED" : "INACTIVE"
        }))
      };
    }),
    manifests: manifests.map((m) => ({ ...m, id: String(m._id), flightLinehaulId: String(m.flightLinehaulId ?? "") })),
    bags: bags.map((b) => ({ ...b, id: String(b._id) })),
    consignments: consignments.map((c) => {
      const raw = c as unknown as { bagId?: unknown; consignmentNumber: string };
      const fallbackBag = raw.bagId ? bagNumberById.get(String(raw.bagId)) : "";
      const bagNumbers = bagsByConsignment.get(String(c._id)) ?? (fallbackBag ? [fallbackBag] : []);
      return {
        ...c,
        id: String(c._id),
        bagNumbers,
        displayConsignmentNumber: (c as unknown as { consignmentNumber: string }).consignmentNumber ?? String(c._id).slice(-8),
        // keep original consignmentNumber for detail but also expose for frontend join
        consignmentNumber: (c as unknown as { consignmentNumber: string }).consignmentNumber
      };
    }),
    offloads: offloads.map((o) => ({ ...o, id: String(o._id) })),
    exceptions: exceptions.map((e) => ({ ...e, id: String(e._id) })),
    documents: documents.map((d) => ({ ...d, id: String(d._id) })),
    auditHistory: auditHistory.map((a) => ({ ...a, id: String(a._id) }))
  };
}

async function evaluateFlightExceptions(flight: IFlightLinehaul, allocations: Array<{ status: string; weightKg: number }>) {
  const now = new Date();
  // Delay
  if (allocationOpenStatuses.includes(flight.status)) {
    const delayMs = now.getTime() - flight.scheduledDepartureAt.getTime();
    if (delayMs > FLIGHT_SLA.delayThresholdMinutes * 60 * 1000) {
      const hours = Math.floor(delayMs / 3600000);
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "FLIGHT_DELAY",
        severity: hours >= 6 ? "CRITICAL" : hours >= 3 ? "HIGH" : "MEDIUM",
        title: "Flight delayed",
        description: `Scheduled departure ${flight.scheduledDepartureAt.toISOString()} delayed by ~${hours}h.`,
        dedupeKey: `FLIGHT_DELAY:${String(flight._id)}:${flight.scheduledDepartureAt.toISOString().slice(0, 10)}`,
        dueAt: new Date(now.getTime() + 2 * 60 * 60 * 1000)
      });
    }
  }
  // Shipment not manifested before departure
  if (["DEPARTED", "IN_TRANSIT", "CONNECTION", "ARRIVED_DESTINATION"].includes(flight.status)) {
    const allocatedCount = allocations.filter((a) => ["ALLOCATED", "CARRIED"].includes(a.status)).length;
    const manifest = await OperationsManifest.find({ flightLinehaulId: flight._id }).lean().exec();
    const hasManifestReady = manifest.some((m) => ["SEALED", "DISPATCHED"].includes(m.status));
    if (allocatedCount > 0 && !hasManifestReady) {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "NOT_MANIFESTED",
        severity: "HIGH",
        title: "Shipments not manifested before departure",
        description: `${allocatedCount} shipment(s) allocated but no sealed manifest found.`,
        dedupeKey: `NOT_MANIFESTED:${String(flight._id)}`,
        dueAt: new Date(now.getTime() + 4 * 60 * 60 * 1000)
      });
    }
  }
  // Arrival without customs
  if (flight.status === "ARRIVED_DESTINATION" && flight.arrivalAt) {
    const elapsedHours = (now.getTime() - new Date(flight.arrivalAt).getTime()) / 3600000;
    if (elapsedHours > FLIGHT_SLA.customsSlaHours && flight.customsStatus === "PENDING") {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "ARRIVAL_WITHOUT_CUSTOMS",
        severity: elapsedHours > FLIGHT_SLA.customsCriticalHours ? "CRITICAL" : "HIGH",
        title: "Arrival without customs update",
        description: `Flight arrived ${elapsedHours.toFixed(1)}h ago but customs status still pending.`,
        dedupeKey: `ARRIVAL_WITHOUT_CUSTOMS:${String(flight._id)}`,
        dueAt: new Date(now.getTime() + 6 * 60 * 60 * 1000)
      });
    }
  }
  // Customs cleared without handover
  if (flight.customsStatus === "CLEARED" && flight.customsClearedAt && !flight.handoverAt) {
    const elapsedHours = (now.getTime() - new Date(flight.customsClearedAt).getTime()) / 3600000;
    if (elapsedHours > FLIGHT_SLA.finalMileSlaHours) {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: "CUSTOMS_CLEARED_WITHOUT_HANDOVER",
        severity: elapsedHours > FLIGHT_SLA.finalMileCriticalHours ? "CRITICAL" : "HIGH",
        title: "Customs cleared without final-mile handover",
        description: `Customs cleared ${elapsedHours.toFixed(1)}h ago but no final-mile handover recorded.`,
        dedupeKey: `CUSTOMS_WITHOUT_HANDOVER:${String(flight._id)}`,
        dueAt: new Date(now.getTime() + 6 * 60 * 60 * 1000)
      });
    }
  }
  // Risky connection
  if (flight.connection?.layoverMinutes != null) {
    const risk = calculateConnectionRisk(flight.connection.layoverMinutes);
    if (["HIGH", "CRITICAL", "MISSED"].includes(risk)) {
      await createExceptionIdempotent({
        flightId: flight._id as mongoose.Types.ObjectId,
        branchId: flight.branchId,
        type: risk === "MISSED" ? "MISSED_CONNECTION" : "RISKY_CONNECTION",
        severity: risk === "MISSED" || risk === "CRITICAL" ? "CRITICAL" : "HIGH",
        title: risk === "MISSED" ? "Missed connection" : "Risky connection",
        description: `Transit layover ${flight.connection.layoverMinutes} min - risk ${risk}.`,
        dedupeKey: `${risk === "MISSED" ? "MISSED" : "RISKY"}:${String(flight._id)}:${flight.connection.transitAirportCode}`,
        dueAt: new Date(now.getTime() + 3 * 60 * 60 * 1000)
      });
    }
  }
}

/**
 * Scheduled exception pass for flights that are still operationally active.
 * Detail-page reads also evaluate one flight for immediate feedback, but that
 * cannot be the only trigger because a delayed flight may have no viewer.
 * Exception dedupe keys make this safe to run repeatedly from cron.
 */
export async function runFlightLinehaulExceptionSweep() {
  const activeStatuses: FlightLinehaulStatus[] = [
    "PLANNED",
    "BOOKING_CONFIRMED",
    "CARGO_ALLOCATED",
    "MANIFEST_READY",
    "HANDED_TO_AIRLINE",
    "DEPARTED",
    "IN_TRANSIT",
    "CONNECTION",
    "ARRIVED_DESTINATION",
    "CUSTOMS",
    "HANDED_TO_FINAL_MILE"
  ];
  const flights = await FlightLinehaul.find({ status: { $in: activeStatuses } })
    .sort({ scheduledDepartureAt: 1 })
    .lean()
    .exec();

  if (!flights.length) return { evaluated: 0 };

  const allocations = await FlightShipmentAllocation.find({
    flightLinehaulId: { $in: flights.map((flight) => flight._id) }
  })
    .select("flightLinehaulId status weightKg")
    .lean()
    .exec();

  const allocationsByFlight = new Map<string, Array<{ status: string; weightKg: number }>>();
  for (const allocation of allocations) {
    const flightKey = String(allocation.flightLinehaulId);
    const current = allocationsByFlight.get(flightKey) ?? [];
    current.push({ status: allocation.status, weightKg: allocation.weightKg });
    allocationsByFlight.set(flightKey, current);
  }

  for (const flight of flights) {
    await evaluateFlightExceptions(
      flight as unknown as IFlightLinehaul,
      allocationsByFlight.get(String(flight._id)) ?? []
    );
  }

  return { evaluated: flights.length };
}

export async function updateFlightLinehaul(input: {
  flightId: string;
  updates: Partial<{
    airlineName: string;
    mawbNumber: string;
    originIataCode: string;
    destinationIataCode: string;
    transitIataCode: string;
    scheduledDepartureAt: string;
    scheduledArrivalAt: string;
    capacityKg: number;
    destinationAgent: string;
    finalMileCarrier: string;
  }>;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Closed or cancelled flights cannot be edited.", 409);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  if (input.updates.airlineName !== undefined) {
    before.airlineName = flight.airlineName;
    flight.airlineName = input.updates.airlineName.trim();
    if (flight.airlineName && flight.airlineName.length < 2) throw new FlightLinehaulServiceError("Airline must contain at least 2 characters.", 400);
    after.airlineName = flight.airlineName;
  }
  if (input.updates.mawbNumber !== undefined) {
    before.mawbNumber = flight.mawbNumber;
    flight.mawbNumber = input.updates.mawbNumber.trim().toUpperCase();
    if (flight.mawbNumber && !/^\d{3}-?\d{8}$/.test(flight.mawbNumber)) throw new FlightLinehaulServiceError("Enter a valid MAWB (e.g., 098-12345678).", 400);
    after.mawbNumber = flight.mawbNumber;
  }
  if (input.updates.originIataCode !== undefined) {
    const v = input.updates.originIataCode.trim().toUpperCase();
    if (v && !/^[A-Z]{3}$/.test(v)) throw new FlightLinehaulServiceError("Origin IATA must be 3 letters.", 400);
    before.originIataCode = flight.originIataCode;
    flight.originIataCode = v;
    after.originIataCode = v;
  }
  if (input.updates.destinationIataCode !== undefined) {
    const v = input.updates.destinationIataCode.trim().toUpperCase();
    if (v && !/^[A-Z]{3}$/.test(v)) throw new FlightLinehaulServiceError("Destination IATA must be 3 letters.", 400);
    before.destinationIataCode = flight.destinationIataCode;
    flight.destinationIataCode = v;
    after.destinationIataCode = v;
  }
  if (flight.originIataCode && flight.destinationIataCode && flight.originIataCode === flight.destinationIataCode) {
    throw new FlightLinehaulServiceError("Origin and destination airports must be different.", 400);
  }
  if (input.updates.transitIataCode !== undefined) {
    const v = input.updates.transitIataCode.trim().toUpperCase();
    if (v && !/^[A-Z]{3}$/.test(v)) throw new FlightLinehaulServiceError("Transit IATA must be 3 letters.", 400);
    before.transitIataCode = flight.transitIataCode;
    flight.transitIataCode = v;
    after.transitIataCode = v;
  }
  if (input.updates.scheduledDepartureAt !== undefined) {
    const d = new Date(input.updates.scheduledDepartureAt);
    if (Number.isNaN(d.getTime())) throw new FlightLinehaulServiceError("Invalid departure date.", 400);
    before.scheduledDepartureAt = flight.scheduledDepartureAt;
    flight.scheduledDepartureAt = d;
    after.scheduledDepartureAt = d;
  }
  if (input.updates.scheduledArrivalAt !== undefined) {
    const d = new Date(input.updates.scheduledArrivalAt);
    if (Number.isNaN(d.getTime())) throw new FlightLinehaulServiceError("Invalid arrival date.", 400);
    before.scheduledArrivalAt = flight.scheduledArrivalAt;
    flight.scheduledArrivalAt = d;
    after.scheduledArrivalAt = d;
  }
  if (flight.scheduledArrivalAt <= flight.scheduledDepartureAt) throw new FlightLinehaulServiceError("Arrival must be after departure.", 400);

  if (input.updates.capacityKg !== undefined) {
    if (!Number.isFinite(input.updates.capacityKg) || input.updates.capacityKg <= 0) throw new FlightLinehaulServiceError("Capacity must be positive.", 400);
    before.capacityKg = flight.capacityKg;
    flight.capacityKg = roundWeight(input.updates.capacityKg);
    after.capacityKg = flight.capacityKg;
    flight.utilisationPercent = flight.capacityKg > 0 ? Number(((flight.allocatedWeightKg / flight.capacityKg) * 100).toFixed(1)) : 0;
  }
  if (input.updates.destinationAgent !== undefined) {
    before.destinationAgent = flight.destinationAgent;
    flight.destinationAgent = input.updates.destinationAgent.trim();
    after.destinationAgent = flight.destinationAgent;
  }
  if (input.updates.finalMileCarrier !== undefined) {
    before.finalMileCarrier = flight.finalMileCarrier;
    flight.finalMileCarrier = input.updates.finalMileCarrier.trim();
    after.finalMileCarrier = flight.finalMileCarrier;
  }

  // Once booking is confirmed, core airline identity and route data cannot be
  // cleared. Legacy planned flights may still be completed incrementally.
  if (flight.status !== "PLANNED" && (
    flight.airlineName.trim().length < 2
    || !/^\d{3}-?\d{8}$/.test(flight.mawbNumber)
    || !/^[A-Z]{3}$/.test(flight.originIataCode)
    || !/^[A-Z]{3}$/.test(flight.destinationIataCode)
  )) {
    throw new FlightLinehaulServiceError("Airline, MAWB, origin, and destination are required after booking confirmation.", 409);
  }

  flight.updatedBy = input.userId;
  await flight.save();
  await audit("FLIGHT_LINEHAUL_UPDATED", flight._id as mongoose.Types.ObjectId, input.userId, { before, after });
  await recalculateFlightTotals(flight._id as mongoose.Types.ObjectId);
  return flight;
}

async function assertFlightManifestReady(flightId: mongoose.Types.ObjectId, session: mongoose.ClientSession) {
  const manifests = await OperationsManifest.find({ flightLinehaulId: flightId, status: { $ne: "CANCELLED" } })
    .session(session)
    .lean()
    .exec();
  if (manifests.length !== 1) {
    throw new FlightLinehaulServiceError("V1 requires exactly one active operations manifest on the flight.", 409);
  }

  const manifest = manifests[0]!;
  if (!("SEALED" === manifest.status || "DISPATCHED" === manifest.status)) {
    throw new FlightLinehaulServiceError("The operations manifest must be sealed or dispatched before departure.", 409);
  }

  const [allocations, consignments, bags, criticalException] = await Promise.all([
    FlightShipmentAllocation.find({ flightLinehaulId: flightId, status: { $in: ["ALLOCATED", "OFFLOADED"] } })
      .session(session)
      .select(
        "shipmentDraftId status activeParcelNumbers offloadedParcelNumbers snapshot actualWeightKg volumetricWeightKg chargeableWeightKg weightKg pieces"
      )
      .exec(),
    OperationsManifestConsignment.find({ manifestId: manifest._id, status: { $ne: "REMOVED" } })
      .session(session)
      .select("shipmentDraftId status expectedParcelNumbers scannedParcelNumbers")
      .lean()
      .exec(),
    OperationsManifestBag.find({ manifestId: manifest._id, status: { $ne: "CANCELLED" } })
      .session(session)
      .select("status")
      .lean()
      .exec(),
    FlightException.exists({
      flightLinehaulId: flightId,
      severity: "CRITICAL",
      status: { $in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] }
    }).session(session)
  ]);

  const activeAllocations = allocations.filter((allocation) => allocation.status === "ALLOCATED");
  if (!activeAllocations.length) throw new FlightLinehaulServiceError("Allocate at least one active shipment before departure.", 409);
  if (!bags.length || bags.some((bag) => !["CLOSED", "READY"].includes(bag.status))) {
    throw new FlightLinehaulServiceError("Every active manifest bag must be closed before departure.", 409);
  }
  if (criticalException) {
    throw new FlightLinehaulServiceError("Resolve every critical flight exception before departure.", 409);
  }

  const allowedManifestIds = new Set(allocations.map((allocation) => String(allocation.shipmentDraftId)));
  const manifestedIds = new Set(consignments.map((consignment) => String(consignment.shipmentDraftId)));
  if (activeAllocations.some((allocation) => !manifestedIds.has(String(allocation.shipmentDraftId)))) {
    throw new FlightLinehaulServiceError("Every active flight allocation must be present in the operations manifest.", 409);
  }
  if (consignments.some((consignment) => !allowedManifestIds.has(String(consignment.shipmentDraftId)))) {
    throw new FlightLinehaulServiceError("The operations manifest contains a shipment that is not allocated to this flight.", 409);
  }
  const consignmentByShipment = new Map(consignments.map((consignment) => [String(consignment.shipmentDraftId), consignment]));
  for (const allocation of activeAllocations) {
    const consignment = consignmentByShipment.get(String(allocation.shipmentDraftId));
    const scanned = new Set(consignment?.scannedParcelNumbers.map((parcelNumber) => parcelNumber.toUpperCase()) ?? []);
    const activeParcels = activeParcelNumbersForAllocation(allocation);
    const travellingParcels = activeParcels.filter((parcelNumber) => scanned.has(parcelNumber));
    if (!travellingParcels.length) {
      throw new FlightLinehaulServiceError("Every active flight allocation must contain at least one parcel scanned into the operations manifest.", 409);
    }
    if (travellingParcels.length !== activeParcels.length) {
      const totals = remainingFlightAllocationTotals(
        flightAllocationParcelDetails(allocation.snapshot),
        travellingParcels
      );
      allocation.activeParcelNumbers = travellingParcels;
      allocation.actualWeightKg = totals.actualWeightKg;
      allocation.volumetricWeightKg = totals.volumetricWeightKg;
      allocation.chargeableWeightKg = totals.chargeableWeightKg;
      allocation.weightKg = totals.chargeableWeightKg;
      allocation.pieces = totals.pieces;
      await allocation.save({ session });
    }
  }

  return manifest;
}

type FlightTimelineAllocation = {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  status: string;
  activeParcelNumbers?: unknown;
  offloadedParcelNumbers?: unknown;
  snapshot: unknown;
};

/**
 * Add only safe shipment-level flight milestones. A shipment event cannot
 * represent a partially offloaded shipment, so those allocations remain at
 * their previous shipment milestone and are shown through parcel activity.
 */
async function recordFlightShipmentMilestones(input: {
  flight: IFlightLinehaul;
  allocations: FlightTimelineAllocation[];
  status: "IN_TRANSIT" | "DESTINATION_ARRIVED";
  eventAt: Date;
  userId: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const laterStatuses = input.status === "IN_TRANSIT"
    ? ["DESTINATION_ARRIVED", "IMPORT_CUSTOMS_CLEARANCE", "IMPORT_CUSTOMS_CLEARED", "DELIVERY_PARTNER_TRANSFERRED", "DELIVERY_HUB_ARRIVED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "LOST", "DAMAGED"]
    : ["IMPORT_CUSTOMS_CLEARANCE", "IMPORT_CUSTOMS_CLEARED", "DELIVERY_PARTNER_TRANSFERRED", "DELIVERY_HUB_ARRIVED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "LOST", "DAMAGED"];
  const milestoneKey = input.status;
  const location = input.status === "IN_TRANSIT" ? input.flight.originIataCode : input.flight.destinationIataCode;
  const sourceReference = `FLIGHT:${String(input.flight._id)}:${input.status}`;

  for (const allocation of input.allocations) {
    if (!(["ALLOCATED", "CARRIED"] as string[]).includes(allocation.status)) continue;
    const active = activeParcelNumbersForAllocation(allocation);
    const offloaded = normalizedParcelNumbers(allocation.offloadedParcelNumbers);
    // No shipment-level flight milestone is safe when the shipment is only
    // partially travelling or has been completely removed from the flight.
    if (!active.length || offloaded.length) continue;

    const recordedEvents = await ShipmentEvent.find({ shipmentDraftId: allocation.shipmentDraftId })
      .sort({ eventAt: 1, createdAt: 1 })
      .select("status eventAt")
      .session(input.session)
      .lean()
      .exec();
    const latest = recordedEvents[recordedEvents.length - 1];
    if (!latest) continue;
    if (["ON_HOLD", "SHIPMENT_CANCELLED", "DELIVERED", "RETURNED", "LOST", "DAMAGED"].includes(String(latest.status))) continue;
    if (laterStatuses.includes(String(latest.status)) || latest.eventAt > input.eventAt) continue;

    const missing = findMissingPrerequisites(milestoneKey, recordedEvents.map((event) => event.status));
    if (missing.length) {
      throw new FlightLinehaulServiceError(
        `Flight cannot be marked ${input.status === "IN_TRANSIT" ? "departed" : "arrived at destination"} because shipment ${String(allocation.shipmentDraftId).slice(-8)} is missing required milestones. ${describeMissingPrerequisites(milestoneKey, missing)} No flight or shipment status was changed.`,
        409
      );
    }

    // Manifest dispatch and a manual arrival update may already represent this
    // milestone. Reuse either event instead of risking a duplicate-key failure
    // when the flight status is synchronized later.
    const existingMilestone = await ShipmentEvent.findOne({
      shipmentDraftId: allocation.shipmentDraftId,
      milestoneKey
    }).session(input.session).select("_id").lean().exec();
    if (existingMilestone) continue;

    await ShipmentEvent.findOneAndUpdate(
      { shipmentDraftId: allocation.shipmentDraftId, source: "SYSTEM", sourceReference },
      {
        $setOnInsert: {
          shipmentDraftId: allocation.shipmentDraftId,
          dpdShipmentId: allocation.dpdShipmentId,
          status: input.status,
          milestoneKey,
          note: resolveShipmentEventNote("", input.status),
          location,
          source: "SYSTEM",
          sourceReference,
          customerVisible: true,
          createdBy: input.userId,
          eventAt: input.eventAt
        }
      },
      { upsert: true, new: true, session: input.session }
    ).lean().exec();
  }
}

export async function transitionFlightStatus(input: {
  flightId: string;
  toStatus: FlightLinehaulStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const session = await mongoose.startSession();
  try {
    let updated: IFlightLinehaul | null = null;
    await session.withTransaction(async () => {
      const flight = await FlightLinehaul.findById(flightId).session(session).exec();
      if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
      if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
        throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
      }
      const from = flight.status;
      const to = input.toStatus;
      if (from === to) throw new FlightLinehaulServiceError(`Flight is already ${from}.`, 409);
      if (!canTransition(from, to)) throw new FlightLinehaulServiceError(`Cannot transition from ${from} to ${to}.`, 409);

      // Prerequisites
      if (to === "BOOKING_CONFIRMED") {
        if (!flight.flightNumber || !flight.scheduledDepartureAt || !flight.scheduledArrivalAt) {
          throw new FlightLinehaulServiceError("Flight number and schedule required before booking confirmation.", 409);
        }
        if (
          flight.airlineName.trim().length < 2
          || !/^\d{3}-?\d{8}$/.test(flight.mawbNumber)
          || !/^[A-Z]{3}$/.test(flight.originIataCode)
          || !/^[A-Z]{3}$/.test(flight.destinationIataCode)
        ) {
          throw new FlightLinehaulServiceError("Airline, valid MAWB, origin, and destination are required before booking confirmation.", 409);
        }
      }
      if (to === "CARGO_ALLOCATED") {
        const count = await FlightShipmentAllocation.countDocuments({ flightLinehaulId: flightId, status: "ALLOCATED" }).session(session).exec();
        if (count === 0) throw new FlightLinehaulServiceError("Allocate at least one shipment before cargo allocation.", 409);
      }
      if (to === "DEPARTED") {
        // The removed Manifest Ready and Handed to Airline steps were only
        // readiness gates. Keep those protections at the one consequential
        // action: recording actual departure.
        await assertFlightManifestReady(flightId, session);
        if (!input.metadata?.actualDepartureAt && !flight.actualDepartureAt) {
          // Allow transition with provided actual time, otherwise require it now
          throw new FlightLinehaulServiceError("Provide actual departure time.", 400);
        }
        if (input.metadata?.actualDepartureAt && Number.isNaN(new Date(String(input.metadata.actualDepartureAt)).getTime())) {
          throw new FlightLinehaulServiceError("Actual departure time must be a valid date.", 400);
        }
      }
      if (to === "ARRIVED_DESTINATION") {
        if (!input.metadata?.actualArrivalAt && !input.metadata?.arrivalAt && !flight.arrivalAt && !flight.actualArrivalAt) {
          throw new FlightLinehaulServiceError("Provide actual arrival time.", 400);
        }
        const arrivalValue = input.metadata?.actualArrivalAt ?? input.metadata?.arrivalAt;
        if (arrivalValue && Number.isNaN(new Date(String(arrivalValue)).getTime())) {
          throw new FlightLinehaulServiceError("Actual arrival time must be a valid date.", 400);
        }
      }

      const before = flight.status;
      flight.status = to;
      flight.updatedBy = input.userId;

      // Side effects per target
      if (input.metadata?.actualDepartureAt) flight.actualDepartureAt = new Date(String(input.metadata.actualDepartureAt));
      if (input.metadata?.actualArrivalAt) flight.actualArrivalAt = new Date(String(input.metadata.actualArrivalAt));
      if (input.metadata?.arrivalAt) flight.arrivalAt = new Date(String(input.metadata.arrivalAt));
      if (to === "DEPARTED" && !flight.actualDepartureAt) flight.actualDepartureAt = new Date();
      if (to === "ARRIVED_DESTINATION" && !flight.arrivalAt) flight.arrivalAt = new Date();
      if (to === "CLOSED") {
        flight.closedAt = new Date();
        flight.closedBy = input.userId;
      }

      await flight.save({ session });
      await audit("FLIGHT_LINEHAUL_STATUS_CHANGED", flight._id as mongoose.Types.ObjectId, input.userId, { from: before, to, reason: input.reason ?? "", metadata: input.metadata ?? {} }, session);
      updated = flight;

      // Auto tracking is deliberately limited to shipments whose complete
      // allocation is still on the flight. Partial offloads remain visible in
      // the parcel activity panel and do not receive a misleading shipment
      // departure/arrival milestone.
      if (to === "DEPARTED" || to === "ARRIVED_DESTINATION") {
        const allocations = await FlightShipmentAllocation.find({
          flightLinehaulId: flightId,
          status: { $in: to === "DEPARTED" ? ["ALLOCATED"] : ["ALLOCATED", "CARRIED"] }
        })
          .session(session)
          .select("shipmentDraftId dpdShipmentId status activeParcelNumbers offloadedParcelNumbers snapshot")
          .lean()
          .exec();
        await recordFlightShipmentMilestones({
          flight,
          allocations,
          status: to === "DEPARTED" ? "IN_TRANSIT" : "DESTINATION_ARRIVED",
          eventAt: to === "DEPARTED"
            ? flight.actualDepartureAt ?? new Date()
            : flight.arrivalAt ?? flight.actualArrivalAt ?? new Date(),
          userId: input.userId,
          session
        });
        if (to === "DEPARTED") {
          await FlightShipmentAllocation.updateMany(
            { flightLinehaulId: flightId, status: "ALLOCATED" },
            { $set: { status: "CARRIED" } },
            { session }
          ).exec();
        }

        await notifyFlightStaffSafely(flight.branchId, {
          type: to === "DEPARTED" ? "FLIGHT_DEPARTED" : "FLIGHT_ARRIVED",
          title: to === "DEPARTED" ? "Flight departed" : "Flight arrived at destination",
          message: `${flight.flightNumber} ${to === "DEPARTED" ? "departed" : "arrived at destination"}.`,
          href: `/dashboard/flight-linehauls/${String(flight._id)}`,
          idempotencyKey: `FLIGHT_STATUS:${String(flight._id)}:${to}`,
          metadata: { flightId: String(flight._id), flightNumber: flight.flightNumber, status: to }
        }, session);

        // Auto exception for a flight that departed without cargo.
        if (to === "DEPARTED" && !allocations.length) {
          await createExceptionIdempotent({
            flightId,
            branchId: flight.branchId,
            type: "NOT_MANIFESTED",
            severity: "HIGH",
            title: "No cargo allocated at departure",
            description: "Flight departed without allocated shipments.",
            dedupeKey: `NOT_MANIFESTED_EMPTY:${String(flightId)}`,
            dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
          }, session);
        }
      }
    });
    if (!updated) throw new FlightLinehaulServiceError("Status transition failed.", 500);
    // Recalc after transaction
    await recalculateFlightTotals(flightId);
    return updated;
  } finally {
    await session.endSession();
  }
}

export async function cancelFlightLinehaul(input: { flightId: string; reason: string; userId: mongoose.Types.ObjectId; allowedBranchIds?: string[] | null }) {
  const flightId = asObjectId(input.flightId, "Flight");
  if (!input.reason.trim() || input.reason.trim().length < 5) throw new FlightLinehaulServiceError("Enter a cancellation reason of at least 5 characters.", 400);
  const session = await mongoose.startSession();
  let cancelledFlight: IFlightLinehaul | null = null;
  try {
    await session.withTransaction(async () => {
      const flight = await FlightLinehaul.findById(flightId).session(session).exec();
      if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
      if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
        throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
      }
      if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Flight already closed or cancelled.", 409);
      if (isDepartureLocked(flight.status)) {
        throw new FlightLinehaulServiceError("Cannot cancel after departure.", 409);
      }

      const sealedManifest = await OperationsManifest.findOne({
        flightLinehaulId: flightId,
        status: { $in: ["SEALED", "DISPATCHED"] }
      }).session(session).select("manifestNumber status").lean().exec();
      if (sealedManifest) {
        throw new FlightLinehaulServiceError("A sealed or dispatched manifest cannot be cancelled. Offload the affected parcels, or use Shipment Rebook to create a new full shipment.", 409);
      }

      const now = new Date();
      flight.status = "CANCELLED";
      flight.cancelledAt = now;
      flight.cancelledBy = input.userId;
      flight.cancellationReason = input.reason.trim();
      flight.updatedBy = input.userId;
      await flight.save({ session });
      await FlightShipmentAllocation.updateMany(
        { flightLinehaulId: flightId, status: "ALLOCATED" },
        { $set: { status: "REMOVED", removedAt: now, removedBy: input.userId, removalReason: `Flight cancelled: ${input.reason.trim()}` } },
        { session }
      ).exec();
      await OperationsManifest.updateMany(
        { flightLinehaulId: flightId, status: { $ne: "CANCELLED" } },
        { $set: { flightLinehaulId: null } },
        { session }
      ).exec();
      await audit("FLIGHT_LINEHAUL_CANCELLED", flight._id as mongoose.Types.ObjectId, input.userId, { reason: input.reason.trim() }, session);
      cancelledFlight = flight;
    });
  } finally {
    await session.endSession();
  }
  if (!cancelledFlight) throw new FlightLinehaulServiceError("Flight cancellation failed.", 500);
  await recalculateFlightTotals(flightId);
  return cancelledFlight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocations
// ─────────────────────────────────────────────────────────────────────────────

type EligibleShipment = {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  awb: string;
  actualWeightKg: number;
  volumetricWeightKg: number;
  chargeableWeightKg: number;
  weightKg: number;
  pieces: number;
  destinationCountryCode: string;
  destinationCountryName: string;
  parcelDetails: FlightAllocationParcelDetail[];
  snapshot: Record<string, unknown>;
};

export type FlightAllocationParcelDetail = {
  parcelNumber: string;
  actualWeightKg: number;
  volumetricWeightKg: number;
  chargeableWeightKg: number;
};

export function flightAllocationParcelDetails(snapshotValue: unknown): FlightAllocationParcelDetail[] {
  const snapshot = readShipmentBookingSnapshot(snapshotValue);
  if (!snapshot) return [];
  const pricingParcels = Array.isArray(snapshot.pricing.parcels) ? snapshot.pricing.parcels : [];

  return snapshot.parcels.flatMap((parcel, index) => {
    const parcelNumber = String(parcel.swiftlineParcelNumber ?? "").trim().toUpperCase();
    const actualWeightKg = Number(parcel.actualWeightKg);
    const priced = pricingParcels[index];
    const volumetricWeightKg = Number(priced?.volumetricWeightKg);
    if (!parcelNumber || !Number.isFinite(actualWeightKg) || actualWeightKg <= 0) return [];
    if (!Number.isFinite(volumetricWeightKg) || volumetricWeightKg < 0) return [];
    // Capacity is governed by the two auditable physical measures. Do not
    // trust a stale persisted chargeable value if it is lower than either one.
    const chargeableWeightKg = roundWeight(Math.max(actualWeightKg, volumetricWeightKg));
    return [{
      parcelNumber,
      actualWeightKg: roundWeight(actualWeightKg),
      volumetricWeightKg: roundWeight(volumetricWeightKg),
      chargeableWeightKg
    }];
  });
}

function normalizedParcelNumbers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().toUpperCase()).filter(Boolean))];
}

export function remainingAllocatableParcelNumbers(
  parcelNumbers: string[],
  histories: Array<{
    manifestId?: string;
    manifestStatus: string;
    scannedParcelNumbers?: string[];
    parcelDispositions?: Array<{ parcelNumber: string; disposition: string }>;
  }>,
  options: { ignoreManifestId?: string } = {}
) {
  const ignoredManifestId = options.ignoreManifestId?.trim();
  const travelled = new Set<string>();
  const cancelled = new Set<string>();
  for (const history of histories) {
    // A flight is attached after its operations manifest has been dispatched.
    // Its own scans describe the parcels being allocated now, not parcels that
    // travelled on an earlier flight. Other dispatched manifests remain
    // authoritative history and continue to prevent duplicate allocation.
    if (ignoredManifestId && history.manifestId === ignoredManifestId) continue;
    if (history.manifestStatus !== "DISPATCHED") continue;
    for (const parcelNumber of normalizedParcelNumbers(history.scannedParcelNumbers)) {
      travelled.add(parcelNumber);
      cancelled.delete(parcelNumber);
    }
    for (const disposition of history.parcelDispositions ?? []) {
      const parcelNumber = disposition.parcelNumber.trim().toUpperCase();
      if (parcelNumber && disposition.disposition === "CANCELLED" && !travelled.has(parcelNumber)) {
        cancelled.add(parcelNumber);
      }
    }
  }
  return normalizedParcelNumbers(parcelNumbers).filter(
    (parcelNumber) => !travelled.has(parcelNumber) && !cancelled.has(parcelNumber)
  );
}

async function loadRemainingAllocatableParcelNumbers(
  draftId: mongoose.Types.ObjectId,
  parcelNumbers: string[],
  session?: mongoose.ClientSession,
  ignoreManifestId?: mongoose.Types.ObjectId
) {
  const consignmentQuery = OperationsManifestConsignment.find({
    shipmentDraftId: draftId,
    status: { $ne: "REMOVED" }
  }).select("manifestId scannedParcelNumbers parcelDispositions").lean();
  if (session) consignmentQuery.session(session);
  const consignments = await consignmentQuery.exec();
  if (!consignments.length) return normalizedParcelNumbers(parcelNumbers);

  const manifestQuery = OperationsManifest.find({
    _id: { $in: consignments.map((item) => item.manifestId) }
  }).select("status").lean();
  if (session) manifestQuery.session(session);
  const manifests = await manifestQuery.exec();
  const statusByManifestId = new Map(manifests.map((item) => [String(item._id), item.status]));
  return remainingAllocatableParcelNumbers(parcelNumbers, consignments.map((item) => ({
    manifestId: String(item.manifestId),
    manifestStatus: statusByManifestId.get(String(item.manifestId)) ?? "UNKNOWN",
    scannedParcelNumbers: item.scannedParcelNumbers,
    parcelDispositions: item.parcelDispositions
  })), {
    ignoreManifestId: ignoreManifestId ? String(ignoreManifestId) : undefined
  });
}

function activeParcelNumbersForAllocation(allocation: {
  activeParcelNumbers?: unknown;
  offloadedParcelNumbers?: unknown;
  snapshot: unknown;
}) {
  // An explicitly empty array means every parcel was offloaded. Only legacy
  // documents that do not have this field should fall back to the snapshot.
  if (Array.isArray(allocation.activeParcelNumbers)) {
    return normalizedParcelNumbers(allocation.activeParcelNumbers);
  }
  const storedActive = normalizedParcelNumbers(allocation.activeParcelNumbers);
  if (storedActive.length) return storedActive;
  const offloaded = new Set(normalizedParcelNumbers(allocation.offloadedParcelNumbers));
  return flightAllocationParcelDetails(allocation.snapshot)
    .map((parcel) => parcel.parcelNumber)
    .filter((parcelNumber) => !offloaded.has(parcelNumber));
}

export function remainingFlightAllocationTotals(
  parcels: FlightAllocationParcelDetail[],
  remainingParcelNumbers: string[]
) {
  const remaining = new Set(normalizedParcelNumbers(remainingParcelNumbers));
  const selected = parcels.filter((parcel) => remaining.has(parcel.parcelNumber));
  return {
    actualWeightKg: roundWeight(selected.reduce((sum, parcel) => sum + parcel.actualWeightKg, 0)),
    volumetricWeightKg: roundWeight(selected.reduce((sum, parcel) => sum + parcel.volumetricWeightKg, 0)),
    chargeableWeightKg: roundWeight(selected.reduce((sum, parcel) => sum + parcel.chargeableWeightKg, 0)),
    pieces: selected.length
  };
}

async function latestShipmentEventStatus(draftId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  const query = ShipmentEvent.findOne({ shipmentDraftId: draftId })
    .sort({ eventAt: -1, createdAt: -1 })
    .select("status")
    .lean();
  if (session) query.session(session);
  const event = await query.exec();
  return event?.status ?? null;
}

async function buildShipmentSnapshot(
  draftId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession,
  options: { ignoreManifestId?: mongoose.Types.ObjectId } = {}
): Promise<EligibleShipment | null> {
  // A Swiftline booking may travel with a DPD label supplied later by the
  // client or another approved source. Allocation therefore needs a durable
  // booking snapshot, not a locally stored DPD label at this point.
  const dpdQuery = DpdShipment.findOne({ shipmentDraftId: draftId, status: { $in: ["DPD_CREATED", "LABEL_RECEIVED"] } }).lean();
  const hubQuery = ShipmentEvent.exists({ shipmentDraftId: draftId, status: "ORIGIN_HUB_PROCESSED" });
  if (session) {
    dpdQuery.session(session);
    hubQuery.session(session);
  }
  const [dpd, hubReceived, latestStatus] = await Promise.all([
    dpdQuery.exec(),
    hubQuery.exec(),
    latestShipmentEventStatus(draftId, session)
  ]);
  if (!dpd || !hubReceived) return null;
  if (["ON_HOLD", "SHIPMENT_CANCELLED", "DELIVERED"].includes(String(latestStatus))) return null;
  const snapshot = readShipmentBookingSnapshot(dpd.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(dpd.bookingSnapshot);
  if (!snapshot) return null;
  if (!snapshot.parcels.length || !Array.isArray(snapshot.pricing.parcels) || snapshot.pricing.parcels.length !== snapshot.parcels.length) return null;

  const allParcelDetails = flightAllocationParcelDetails(snapshot);
  if (allParcelDetails.length !== snapshot.parcels.length) return null;
  const allocatableParcelNumbers = new Set(await loadRemainingAllocatableParcelNumbers(
    draftId,
    allParcelDetails.map((parcel) => parcel.parcelNumber),
    session,
    options.ignoreManifestId
  ));
  const parcelDetails = allParcelDetails.filter((parcel) => allocatableParcelNumbers.has(parcel.parcelNumber));
  if (!parcelDetails.length) return null;
  const actualWeightKg = roundWeight(parcelDetails.reduce((sum, parcel) => sum + parcel.actualWeightKg, 0));
  const volumetricWeightKg = roundWeight(parcelDetails.reduce((sum, parcel) => sum + parcel.volumetricWeightKg, 0));
  const chargeableWeightKg = roundWeight(parcelDetails.reduce((sum, parcel) => sum + parcel.chargeableWeightKg, 0));
  const pieces = parcelDetails.length;
  const party = snapshot.consignee as unknown as Record<string, unknown>;
  const destinationCountryCode = String((party as Record<string, unknown>)?.countryCode ?? "").toUpperCase();
  const destinationCountryName = String((party as Record<string, unknown>)?.countryName ?? (party as Record<string, unknown>)?.countryCode ?? "").trim();
  return {
    shipmentDraftId: draftId,
    dpdShipmentId: dpd._id as mongoose.Types.ObjectId,
    awb: snapshot.tracking.swiftlineTrackingNumber || dpd.swiftlineTrackingNumber || "",
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    weightKg: chargeableWeightKg,
    pieces,
    destinationCountryCode,
    destinationCountryName,
    parcelDetails,
    snapshot: snapshot as unknown as Record<string, unknown>
  };
}

export async function searchEligibleShipments(input: {
  branchId?: string;
  q?: string;
  limit?: number;
  allowedBranchIds?: string[] | null;
  excludeFlightId?: string;
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const branchFilter: Record<string, unknown> = {};
  if (input.branchId && mongoose.Types.ObjectId.isValid(input.branchId)) {
    branchFilter.branchId = new mongoose.Types.ObjectId(input.branchId);
  } else if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined) {
    branchFilter.branchId = { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  // Only booked shipments not already allocated
  const allocatedIds = await FlightShipmentAllocation.distinct("shipmentDraftId", { status: "ALLOCATED" }).exec();
  const cancelledIds = await ShipmentCancellation.distinct("shipmentDraftId", { status: { $in: ["REQUESTED", "COMPLETED"] } }).exec();

  // Hold history is intentionally not an exclusion list: a released shipment
  // can be allocated again. buildShipmentSnapshot checks the latest event so an
  // active hold is still blocked without hiding released shipments forever.
  const exclude = new Set([...allocatedIds, ...cancelledIds].map(String));

  // Find dpd shipments that are booked
  const dpdFilter: Record<string, unknown> = { status: { $in: ["DPD_CREATED", "LABEL_RECEIVED"] } };
  if (input.q?.trim()) {
    const term = input.q.trim().toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    dpdFilter.$or = [
      { swiftlineTrackingNumber: { $regex: term, $options: "i" } },
      { dpdShipmentId: { $regex: term, $options: "i" } }
    ];
  }

  // Need to filter via ShipmentDraft branch - join via drafts
  const drafts = await ShipmentDraft.find({ ...branchFilter, deletedAt: null }).select("_id businessAccountId branchId").lean().exec();
  const draftIds = drafts.map((d) => d._id);
  if (!draftIds.length) return { shipments: [] };

  const dpdShipments = await DpdShipment.find({ ...dpdFilter, shipmentDraftId: { $in: draftIds } })
    .select("shipmentDraftId swiftlineTrackingNumber dpdShipmentId bookingSnapshot currentShipmentSnapshot")
    .limit(limit * 2)
    .lean()
    .exec();

  const results: EligibleShipment[] = [];
  for (const dpd of dpdShipments) {
    if (exclude.has(String(dpd.shipmentDraftId))) continue;
    // Branch scoping already via draftIds
    const snap = await buildShipmentSnapshot(dpd.shipmentDraftId as mongoose.Types.ObjectId);
    if (!snap) continue;
    if (input.q?.trim()) {
      const term = input.q.trim().toUpperCase();
      if (!snap.awb.toUpperCase().includes(term) && !String(dpd.swiftlineTrackingNumber ?? "").toUpperCase().includes(term)) continue;
    }
    results.push(snap);
    if (results.length >= limit) break;
  }

  return { shipments: results.map((s) => ({ ...s, shipmentDraftId: String(s.shipmentDraftId), dpdShipmentId: String(s.dpdShipmentId) })) };
}

export async function allocateShipments(input: {
  flightId: string;
  shipmentDraftIds: string[];
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
  idempotencyKey?: string;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (isDepartureLocked(flight.status)) {
    throw new FlightLinehaulServiceError("Shipments cannot be allocated in current flight status.", 409);
  }
  if (!input.shipmentDraftIds.length) throw new FlightLinehaulServiceError("Select at least one shipment.", 400);
  if (input.shipmentDraftIds.length > 100) throw new FlightLinehaulServiceError("Cannot allocate more than 100 shipments at once.", 400);

  const uniqueIds = [...new Set(input.shipmentDraftIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length !== input.shipmentDraftIds.length) throw new FlightLinehaulServiceError("Duplicate shipment ids in request.", 400);

  const results: Array<{ shipmentDraftId: string; status: "allocated" | "skipped"; reason?: string }> = [];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const draftIdStr of uniqueIds) {
        const draftId = asObjectId(draftIdStr, "Shipment");
        // Idempotent: if already allocated to this flight, skip
        const existing = await FlightShipmentAllocation.findOne({ shipmentDraftId: draftId, flightLinehaulId: flightId, status: "ALLOCATED" }).session(session).exec();
        if (existing) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Already allocated to this flight." });
          continue;
        }
        const activeElsewhere = await FlightShipmentAllocation.findOne({ shipmentDraftId: draftId, status: "ALLOCATED" }).session(session).exec();
        if (activeElsewhere) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Already allocated to another active flight." });
          continue;
        }
        const snap = await buildShipmentSnapshot(draftId, session);
        if (!snap) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Shipment not booked or snapshot unavailable." });
          continue;
        }
        const draft = await ShipmentDraft.findById(draftId).select("branchId").session(session).lean().exec();
        if (!draft) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Shipment not found." });
          continue;
        }
        if (String(draft.branchId) !== String(flight.branchId)) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Shipment belongs to a different branch." });
          continue;
        }
        const cancellation = await ShipmentCancellation.findOne({ shipmentDraftId: draftId, status: { $in: ["REQUESTED", "COMPLETED"] } }).session(session).lean().exec();
        if (cancellation) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Shipment has cancellation request." });
          continue;
        }
        // Reserve capacity on the flight document itself. The conditional update
        // serializes concurrent allocation requests; an aggregate-only check can
        // let two transactions both pass against the same old total.
        const capacityReservation = await FlightLinehaul.findOneAndUpdate(
          {
            _id: flightId,
            status: { $in: allocationOpenStatuses },
            $expr: {
              $or: [
                { $eq: ["$capacityKg", 0] },
                { $lte: [{ $add: [{ $ifNull: ["$allocatedWeightKg", 0] }, snap.chargeableWeightKg] }, "$capacityKg"] }
              ]
            }
          },
          { $inc: { allocatedWeightKg: snap.chargeableWeightKg } },
          { session, new: true }
        ).exec();
        if (!capacityReservation) {
          results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Capacity exceeded or flight is no longer accepting allocations." });
          continue;
        }

        try {
          await FlightShipmentAllocation.create(
            [
              {
                flightLinehaulId: flightId,
                branchId: flight.branchId,
                shipmentDraftId: draftId,
                dpdShipmentId: snap.dpdShipmentId,
                awb: snap.awb,
                actualWeightKg: snap.actualWeightKg,
                volumetricWeightKg: snap.volumetricWeightKg,
                chargeableWeightKg: snap.chargeableWeightKg,
                destinationCountryCode: snap.destinationCountryCode,
                destinationCountryName: snap.destinationCountryName,
                weightKg: snap.weightKg,
                pieces: snap.pieces,
                activeParcelNumbers: snap.parcelDetails.map((parcel) => parcel.parcelNumber),
                offloadedParcelNumbers: [],
                snapshot: snap.snapshot,
                status: "ALLOCATED",
                allocatedBy: input.userId,
                allocatedAt: new Date()
              }
            ],
            { session }
          );
          results.push({ shipmentDraftId: draftIdStr, status: "allocated" });
        } catch (error) {
          if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
            // The reservation was made before the allocation insert. Release it
            // when another request won the unique allocation race.
            await FlightLinehaul.updateOne(
              { _id: flightId },
              { $inc: { allocatedWeightKg: -snap.chargeableWeightKg } },
              { session }
            ).exec();
            results.push({ shipmentDraftId: draftIdStr, status: "skipped", reason: "Duplicate allocation detected." });
            continue;
          }
          throw error;
        }
      }

      // Recalculate totals inside transaction
      const allocatedWeightKg = await FlightShipmentAllocation.aggregate([
        { $match: { flightLinehaulId: flightId, status: "ALLOCATED" } },
        { $group: { _id: null, total: { $sum: "$weightKg" } } }
      ]).session(session).exec();
      const totalWeight = roundWeight(allocatedWeightKg[0]?.total ?? 0);
      const count = await FlightShipmentAllocation.countDocuments({ flightLinehaulId: flightId, status: "ALLOCATED" }).session(session).exec();
      await FlightLinehaul.updateOne(
        { _id: flightId },
        { $set: { allocatedWeightKg: totalWeight, totalShipments: count, utilisationPercent: flight.capacityKg > 0 ? Number(((totalWeight / flight.capacityKg) * 100).toFixed(1)) : 0 } },
        { session }
      ).exec();

      if (results.some((r) => r.status === "allocated")) {
        await audit("FLIGHT_ALLOCATION_CREATED", flightId, input.userId, { allocated: results.filter((r) => r.status === "allocated").map((r) => r.shipmentDraftId), flightId: String(flightId) }, session);
      }
    });
  } finally {
    await session.endSession();
  }

  await recalculateFlightTotals(flightId);
  if (results.some((r) => r.status === "allocated")) void maybeMarkCostSheetsForReview(flightId);

  const allocatedCount = results.filter((r) => r.status === "allocated").length;
  return { results, allocatedCount };
}

export async function removeAllocation(input: {
  flightId: string;
  allocationId: string;
  reason: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const allocationId = asObjectId(input.allocationId, "Allocation");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (isDepartureLocked(flight.status)) {
    throw new FlightLinehaulServiceError("Allocations cannot be removed after departure.", 409);
  }
  if (!input.reason.trim() || input.reason.trim().length < 3) throw new FlightLinehaulServiceError("Enter a removal reason.", 400);
  const allocation = await FlightShipmentAllocation.findOne({ _id: allocationId, flightLinehaulId: flightId, status: "ALLOCATED" }).exec();
  if (!allocation) throw new FlightLinehaulServiceError("Active allocation was not found.", 404);

  allocation.status = "REMOVED";
  allocation.removedAt = new Date();
  allocation.removedBy = input.userId;
  allocation.removalReason = input.reason.trim();
  await allocation.save();
  await audit("FLIGHT_ALLOCATION_REMOVED", flightId, input.userId, { allocationId: String(allocationId), shipmentDraftId: String(allocation.shipmentDraftId), reason: input.reason.trim() });
  await recalculateFlightTotals(flightId);
  void maybeMarkCostSheetsForReview(flightId);
  return allocation;
}

export async function moveAllocation(input: {
  sourceFlightId: string;
  allocationId: string;
  targetFlightId: string;
  reason: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const sourceId = asObjectId(input.sourceFlightId, "Source flight");
  const targetId = asObjectId(input.targetFlightId, "Target flight");
  const allocationId = asObjectId(input.allocationId, "Allocation");
  if (String(sourceId) === String(targetId)) throw new FlightLinehaulServiceError("Source and target flights must differ.", 400);

  const [source, target] = await Promise.all([FlightLinehaul.findById(sourceId).exec(), FlightLinehaul.findById(targetId).exec()]);
  if (!source || !target) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined) {
    if (!input.allowedBranchIds.includes(String(source.branchId)) || !input.allowedBranchIds.includes(String(target.branchId))) {
      throw new FlightLinehaulServiceError("You do not have access to one of the flights.", 403);
    }
  }
  if (String(source.branchId) !== String(target.branchId)) throw new FlightLinehaulServiceError("Flights must belong to the same branch to move shipments.", 409);
  if (["CLOSED", "CANCELLED"].includes(source.status) || ["CLOSED", "CANCELLED"].includes(target.status)) throw new FlightLinehaulServiceError("Cannot move from/to closed or cancelled flights.", 409);
  if (isDepartureLocked(source.status)) {
    throw new FlightLinehaulServiceError("Cannot move from a departed flight. Use offload instead.", 409);
  }
  if (isDepartureLocked(target.status)) {
    throw new FlightLinehaulServiceError("Target flight cannot accept allocations in its current status.", 409);
  }
  const allocation = await FlightShipmentAllocation.findOne({ _id: allocationId, flightLinehaulId: sourceId, status: "ALLOCATED" }).exec();
  if (!allocation) throw new FlightLinehaulServiceError("Active allocation was not found.", 404);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Remove from source
      allocation.status = "REMOVED";
      allocation.removedAt = new Date();
      allocation.removedBy = input.userId;
      allocation.removalReason = `Moved to ${target.flightLinehaulNumber}: ${input.reason.trim()}`;
      await allocation.save({ session });

      // Create on target (preserve original allocation snapshot)
      const existsElsewhere = await FlightShipmentAllocation.findOne({ shipmentDraftId: allocation.shipmentDraftId, status: "ALLOCATED" }).session(session).exec();
      if (existsElsewhere && String(existsElsewhere._id) !== String(allocationId)) {
        throw new FlightLinehaulServiceError("Shipment already allocated elsewhere.", 409);
      }

      const moveWeightKg = allocation.chargeableWeightKg ?? allocation.weightKg;
      const targetReservation = await FlightLinehaul.findOneAndUpdate(
        {
          _id: targetId,
          status: { $in: allocationOpenStatuses },
          $expr: {
            $or: [
              { $eq: ["$capacityKg", 0] },
              { $lte: [{ $add: [{ $ifNull: ["$allocatedWeightKg", 0] }, moveWeightKg] }, "$capacityKg"] }
            ]
          }
        },
        { $inc: { allocatedWeightKg: moveWeightKg } },
        { session, new: true }
      ).exec();
      if (!targetReservation) {
        throw new FlightLinehaulServiceError("Target flight capacity exceeded or it is no longer accepting allocations.", 409);
      }

      // Since we just marked source as REMOVED, the unique partial index allows new
      await FlightShipmentAllocation.create(
        [
          {
            flightLinehaulId: targetId,
            branchId: target.branchId,
            shipmentDraftId: allocation.shipmentDraftId,
            dpdShipmentId: allocation.dpdShipmentId,
            awb: allocation.awb,
            actualWeightKg: allocation.actualWeightKg,
            volumetricWeightKg: allocation.volumetricWeightKg,
            chargeableWeightKg: allocation.chargeableWeightKg,
            destinationCountryCode: allocation.destinationCountryCode,
            destinationCountryName: allocation.destinationCountryName,
            weightKg: allocation.weightKg,
            pieces: allocation.pieces,
            activeParcelNumbers: allocation.activeParcelNumbers,
            offloadedParcelNumbers: allocation.offloadedParcelNumbers,
            snapshot: allocation.snapshot,
            status: "ALLOCATED",
            allocatedBy: input.userId,
            allocatedAt: new Date()
          }
        ],
        { session }
      );

      await audit("FLIGHT_ALLOCATION_MOVED", sourceId, input.userId, { allocationId: String(allocationId), shipmentDraftId: String(allocation.shipmentDraftId), from: source.flightLinehaulNumber, to: target.flightLinehaulNumber, reason: input.reason.trim() }, session);
      await audit("FLIGHT_ALLOCATION_CREATED", targetId, input.userId, { shipmentDraftId: String(allocation.shipmentDraftId), movedFrom: String(sourceId) }, session);
    });
  } finally {
    await session.endSession();
  }

  await Promise.all([recalculateFlightTotals(sourceId), recalculateFlightTotals(targetId)]);
  void maybeMarkCostSheetsForReview(sourceId);
  void maybeMarkCostSheetsForReview(targetId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest attach
// ─────────────────────────────────────────────────────────────────────────────

async function attachManifestInTransaction(input: {
  flightId: mongoose.Types.ObjectId;
  manifestId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const { flightId, manifestId, session } = input;
  const lockedFlight = await FlightLinehaul.findById(flightId).session(session).exec();
  const lockedManifest = await OperationsManifest.findById(manifestId).session(session).exec();
  if (!lockedFlight || !lockedManifest) throw new FlightLinehaulServiceError("Flight or manifest was not found.", 404);
  if (isDepartureLocked(lockedFlight.status)) {
    throw new FlightLinehaulServiceError("Manifests cannot be attached in current flight status.", 409);
  }
  if (String(lockedManifest.branchId) !== String(lockedFlight.branchId)) {
    throw new FlightLinehaulServiceError("Manifest and flight must belong to the same branch.", 409);
  }
  if (lockedManifest.status === "CANCELLED") throw new FlightLinehaulServiceError("Cancelled manifests cannot be attached.", 409);
  if (lockedManifest.flightLinehaulId && String(lockedManifest.flightLinehaulId) !== String(flightId)) {
    throw new FlightLinehaulServiceError("Manifest was attached to another flight while this request was being saved.", 409);
  }
  if (lockedManifest.flightLinehaulId && String(lockedManifest.flightLinehaulId) === String(flightId)) {
    throw new FlightLinehaulServiceError("Manifest already attached to this flight.", 409);
  }

  const existingManifest = await OperationsManifest.findOne({
    flightLinehaulId: flightId,
    _id: { $ne: manifestId },
    status: { $ne: "CANCELLED" }
  }).select("manifestNumber").lean().session(session).exec();
  if (existingManifest) {
    throw new FlightLinehaulServiceError(`Flight already has manifest ${existingManifest.manifestNumber}. V1 supports one active manifest per flight.`, 409);
  }

  const headerChecks: Array<[string, string, string]> = [
    ["flight number", lockedFlight.flightNumber, lockedManifest.header.flightNumber],
    ["origin airport", lockedFlight.originIataCode, lockedManifest.header.originIataCode],
    ["destination airport", lockedFlight.destinationIataCode, lockedManifest.header.destinationIataCode],
    ["MAWB", lockedFlight.mawbNumber, lockedManifest.header.mawbNumber]
  ];
  for (const [label, flightValue, manifestValue] of headerChecks) {
    const valuesMatch = label === "flight number"
      ? comparableFlightNumber(flightValue) === comparableFlightNumber(manifestValue)
      : flightValue.trim().toUpperCase() === manifestValue.trim().toUpperCase();
    if (flightValue && manifestValue && !valuesMatch) {
      throw new FlightLinehaulServiceError(`Manifest ${label} does not match the flight.`, 409);
    }
  }
  const flightDate = lockedFlight.scheduledDepartureAt.toISOString().slice(0, 10);
  if (lockedManifest.header.departureDate && lockedManifest.header.departureDate !== flightDate) {
    throw new FlightLinehaulServiceError("Manifest departure date does not match the flight.", 409);
  }

  const consignments = await OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } })
    .select("shipmentDraftId consignmentNumber scannedParcelNumbers")
    .lean()
    .session(session)
    .exec();
  if (!consignments.length) throw new FlightLinehaulServiceError("The manifest has no packed shipments to attach.", 409);
  const shipmentIds = consignments.map((consignment) => consignment.shipmentDraftId);
  const activeAllocations = await FlightShipmentAllocation.find({
    shipmentDraftId: { $in: shipmentIds },
    status: "ALLOCATED"
  }).select("shipmentDraftId flightLinehaulId").lean().session(session).exec();
  const elsewhere = activeAllocations.find((allocation) => String(allocation.flightLinehaulId) !== String(flightId));
  if (elsewhere) {
    throw new FlightLinehaulServiceError("A manifest shipment is already allocated to another active flight.", 409);
  }
  const allocatedHere = new Set(activeAllocations.map((allocation) => String(allocation.shipmentDraftId)));
  const newAllocations: Array<Record<string, unknown>> = [];
  let addedWeightKg = 0;
  for (const consignment of consignments) {
    if (allocatedHere.has(String(consignment.shipmentDraftId))) continue;
    const cancellation = await ShipmentCancellation.findOne({
      shipmentDraftId: consignment.shipmentDraftId,
      status: { $in: ["REQUESTED", "COMPLETED"] }
    }).select("status").lean().session(session).exec();
    if (cancellation) throw new FlightLinehaulServiceError("A manifest shipment has a pending or completed cancellation.", 409);
    const snapshot = await buildShipmentSnapshot(consignment.shipmentDraftId, session, { ignoreManifestId: manifestId });
    if (!snapshot) {
      throw new FlightLinehaulServiceError(
        `Manifest shipment ${consignment.consignmentNumber || String(consignment.shipmentDraftId)} is not eligible for flight allocation. Confirm it is booked, origin processed, active, and has allocatable parcel data.`,
        409
      );
    }
    const travelling = consignment.scannedParcelNumbers.map((value) => value.toUpperCase());
    if (!travelling.length) throw new FlightLinehaulServiceError("Every manifest shipment must contain at least one scanned parcel.", 409);
    const totals = remainingFlightAllocationTotals(flightAllocationParcelDetails(snapshot.snapshot), travelling);
    addedWeightKg = roundWeight(addedWeightKg + totals.chargeableWeightKg);
    newAllocations.push({
      flightLinehaulId: flightId,
      branchId: lockedFlight.branchId,
      shipmentDraftId: consignment.shipmentDraftId,
      dpdShipmentId: snapshot.dpdShipmentId,
      awb: snapshot.awb,
      actualWeightKg: totals.actualWeightKg,
      volumetricWeightKg: totals.volumetricWeightKg,
      chargeableWeightKg: totals.chargeableWeightKg,
      destinationCountryCode: snapshot.destinationCountryCode,
      destinationCountryName: snapshot.destinationCountryName,
      weightKg: totals.chargeableWeightKg,
      pieces: totals.pieces,
      activeParcelNumbers: travelling,
      offloadedParcelNumbers: [],
      snapshot: snapshot.snapshot,
      status: "ALLOCATED",
      allocatedBy: input.userId,
      allocatedAt: new Date()
    });
  }
  if (lockedFlight.capacityKg > 0 && roundWeight(lockedFlight.allocatedWeightKg + addedWeightKg) > lockedFlight.capacityKg) {
    throw new FlightLinehaulServiceError(
      `Manifest requires ${addedWeightKg.toFixed(3)} kg but the flight has only ${Math.max(0, lockedFlight.capacityKg - lockedFlight.allocatedWeightKg).toFixed(3)} kg available. Increase capacity before attaching it.`,
      409
    );
  }
  if (newAllocations.length) await FlightShipmentAllocation.insertMany(newAllocations, { session });
  lockedManifest.flightLinehaulId = flightId;
  await lockedManifest.save({ session });
  if (["PLANNED", "BOOKING_CONFIRMED"].includes(lockedFlight.status)) {
    const beforeStatus = lockedFlight.status;
    lockedFlight.status = "CARGO_ALLOCATED";
    lockedFlight.updatedBy = input.userId;
    await lockedFlight.save({ session });
    await audit("FLIGHT_LINEHAUL_STATUS_CHANGED", flightId, input.userId, {
      from: beforeStatus,
      to: "CARGO_ALLOCATED",
      reason: "Manifest attached during flight setup.",
      metadata: { source: "MANIFEST_ATTACH", manifestId: String(manifestId) }
    }, session);
  }
  await audit("FLIGHT_ALLOCATION_CREATED", flightId, input.userId, {
    source: "MANIFEST_ATTACH",
    manifestId: String(manifestId),
    allocated: newAllocations.map((allocation) => String(allocation.shipmentDraftId))
  }, session);
  await audit("FLIGHT_MANIFEST_ATTACHED", flightId, input.userId, {
    manifestId: String(manifestId),
    manifestNumber: lockedManifest.manifestNumber,
    shipmentsAllocated: newAllocations.length
  }, session);
  return lockedManifest;
}

export async function attachManifest(input: {
  flightId: string;
  manifestId: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const manifestId = asObjectId(input.manifestId, "Manifest");
  const flight = await FlightLinehaul.findById(flightId).select("branchId").lean().exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }

  const session = await mongoose.startSession();
  try {
    let attached: IOperationsManifest | null = null;
    await session.withTransaction(async () => {
      attached = await attachManifestInTransaction({ flightId, manifestId, userId: input.userId, session });
    });
    if (!attached) throw new FlightLinehaulServiceError("Manifest attachment failed.", 500);
    const attachedManifest = attached as IOperationsManifest;
    await recalculateFlightTotals(flightId);
    void maybeMarkCostSheetsForReview(flightId);
    return attachedManifest;
  } finally {
    await session.endSession();
  }
}

export async function detachManifest(input: {
  flightId: string;
  manifestId: string;
  reason: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const manifestId = asObjectId(input.manifestId, "Manifest");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Cannot detach from closed or cancelled flight.", 409);
  if (isDepartureLocked(flight.status)) {
    throw new FlightLinehaulServiceError("Cannot detach after departure.", 409);
  }
  const manifest = await OperationsManifest.findOne({ _id: manifestId, flightLinehaulId: flightId }).exec();
  if (!manifest) throw new FlightLinehaulServiceError("Manifest not attached to this flight.", 404);
  if (["SEALED", "DISPATCHED"].includes(manifest.status)) {
    // Allow but warn? Spec says preserve seal/dispatch rules, but detaching a sealed manifest is questionable.
    // For now allow with reason length check.
    if (!input.reason.trim() || input.reason.trim().length < 5) throw new FlightLinehaulServiceError("Detaching a sealed/dispatched manifest requires a reason of at least 5 characters.", 400);
  }
  manifest.flightLinehaulId = null;
  await manifest.save();
  await audit("FLIGHT_MANIFEST_DETACHED", flightId, input.userId, { manifestId: String(manifestId), manifestNumber: manifest.manifestNumber, reason: input.reason.trim() });
  await recalculateFlightTotals(flightId);
  void maybeMarkCostSheetsForReview(flightId);
  return manifest;
}

export async function listAttachableManifests(input: { flightId: string; allowedBranchIds?: string[] | null }) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).lean().exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  const filter: Record<string, unknown> = {
    branchId: flight.branchId,
    status: { $in: ["DRAFT", "PACKING", "READY_TO_SEAL", "SEALED", "DISPATCHED"] },
    $or: [{ flightLinehaulId: null }, { flightLinehaulId: { $exists: false } }]
  };
  const manifests = await OperationsManifest.find(filter).sort({ updatedAt: -1 }).limit(50).lean().exec();
  return manifests.map((m) => ({ id: String(m._id), manifestNumber: m.manifestNumber, status: m.status, totalBags: m.totalBags, totalConsignments: m.totalConsignments, totalWeightKg: m.totalWeightKg, header: m.header }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

export async function updateConnection(input: {
  flightId: string;
  transitAirportCode: string;
  scheduledArrivalAt?: string | null;
  scheduledDepartureAt?: string | null;
  actualArrivalAt?: string | null;
  actualDepartureAt?: string | null;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Cannot update connection for closed/cancelled flight.", 409);
  const code = input.transitAirportCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new FlightLinehaulServiceError("Transit airport code must be 3 letters.", 400);
  const sArr = input.scheduledArrivalAt ? new Date(input.scheduledArrivalAt) : null;
  const sDep = input.scheduledDepartureAt ? new Date(input.scheduledDepartureAt) : null;
  const aArr = input.actualArrivalAt ? new Date(input.actualArrivalAt) : null;
  const aDep = input.actualDepartureAt ? new Date(input.actualDepartureAt) : null;
  if (sArr && Number.isNaN(sArr.getTime())) throw new FlightLinehaulServiceError("Invalid scheduled arrival.", 400);
  if (sDep && Number.isNaN(sDep.getTime())) throw new FlightLinehaulServiceError("Invalid scheduled departure.", 400);
  if (aArr && Number.isNaN(aArr.getTime())) throw new FlightLinehaulServiceError("Invalid actual arrival.", 400);
  if (aDep && Number.isNaN(aDep.getTime())) throw new FlightLinehaulServiceError("Invalid actual departure.", 400);
  if (sArr && sDep && sDep <= sArr) throw new FlightLinehaulServiceError("Transit departure must be after arrival.", 400);
  if (aArr && aDep && aDep <= aArr) throw new FlightLinehaulServiceError("Actual departure must be after actual arrival.", 400);

  let layover: number | null = null;
  if (sArr && sDep) layover = Math.round((sDep.getTime() - sArr.getTime()) / 60000);
  else if (aArr && aDep) layover = Math.round((aDep.getTime() - aArr.getTime()) / 60000);

  const before = flight.connection;
  flight.connection = {
    transitAirportCode: code,
    scheduledArrivalAt: sArr,
    scheduledDepartureAt: sDep,
    actualArrivalAt: aArr,
    actualDepartureAt: aDep,
    layoverMinutes: layover,
    riskLevel: calculateConnectionRisk(layover)
  };
  flight.transitIataCode = code;
  flight.updatedBy = input.userId;
  await flight.save();
  await audit("FLIGHT_CONNECTION_UPDATED", flightId, input.userId, { before, after: flight.connection });

  if (["HIGH", "CRITICAL", "MISSED"].includes(flight.connection.riskLevel)) {
    await createExceptionIdempotent({
      flightId,
      branchId: flight.branchId,
      type: flight.connection.riskLevel === "MISSED" ? "MISSED_CONNECTION" : "RISKY_CONNECTION",
      severity: flight.connection.riskLevel === "MISSED" || flight.connection.riskLevel === "CRITICAL" ? "CRITICAL" : "HIGH",
      title: flight.connection.riskLevel === "MISSED" ? "Missed connection" : "Risky connection",
      description: `Transit ${code} layover ${layover} min - risk ${flight.connection.riskLevel}.`,
      dedupeKey: `CONNECTION_RISK:${String(flightId)}:${code}:${layover}`,
      dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
    });
  }

  return flight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offload
// ─────────────────────────────────────────────────────────────────────────────

export async function createOffload(input: {
  flightId: string;
  reason: string;
  offloadReason: string;
  airline?: string;
  affectedParcels: Array<{ shipmentDraftId: string; parcelNumber: string }>;
  responsibleEmployeeId?: string | null;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (isDepartureLocked(flight.status)) {
    throw new FlightLinehaulServiceError("Parcels cannot be offloaded after this flight has departed.", 409);
  }
  if (!input.reason.trim() || input.reason.trim().length < 5) throw new FlightLinehaulServiceError("Offload reason must be at least 5 characters.", 400);
  const reasonValue = input.offloadReason;
  const validReasons = ["AIRLINE_OFFLOAD", "CAPACITY", "WEATHER", "CUSTOMS", "MISSED_CONNECTION", "DAMAGE", "SECURITY", "OTHER"];
  if (!validReasons.includes(reasonValue)) throw new FlightLinehaulServiceError("Invalid offload reason.", 400);

  if (!input.affectedParcels.length) throw new FlightLinehaulServiceError("Select at least one parcel to offload.", 400);
  if (input.affectedParcels.length > 100) throw new FlightLinehaulServiceError("Cannot offload more than 100 parcels at once.", 400);
  const requestedParcels = input.affectedParcels.map((item) => ({
    shipmentDraftId: asObjectId(item.shipmentDraftId, "Shipment"),
    parcelNumber: item.parcelNumber.trim().toUpperCase()
  }));
  if (requestedParcels.some((item) => !item.parcelNumber)) throw new FlightLinehaulServiceError("Every selected parcel must have a parcel number.", 400);
  const requestedKeys = requestedParcels.map((item) => `${String(item.shipmentDraftId)}:${item.parcelNumber}`);
  if (new Set(requestedKeys).size !== requestedKeys.length) throw new FlightLinehaulServiceError("The same parcel was selected more than once.", 400);
  const affectedShipmentIds = [...new Map(requestedParcels.map((item) => [String(item.shipmentDraftId), item.shipmentDraftId])).values()];

  // Idempotency: if identical offload was recorded in last 10s (double-click), return it instead of creating duplicate
  const recentDuplicate = await (FlightOffload.findOne as any)({
    flightLinehaulId: flightId,
    reason: reasonValue,
    detail: input.reason.trim(),
    createdBy: input.userId,
    createdAt: { $gte: new Date(Date.now() - 10000) }
  }).lean().exec();
  if (recentDuplicate) {
    const recentKey = [...(recentDuplicate.affectedParcels ?? [])]
      .map((item: { shipmentDraftId: unknown; parcelNumber: string }) => `${String(item.shipmentDraftId)}:${item.parcelNumber}`)
      .sort()
      .join(",");
    const currentKey = [...requestedKeys].sort().join(",");
    if (recentKey === currentKey) return recentDuplicate as InstanceType<typeof FlightOffload>;
  }

  const session = await mongoose.startSession();
  let offloadDoc: InstanceType<typeof FlightOffload> | null = null;
  try {
    await session.withTransaction(async () => {
      // Re-check the flight inside the transaction. The first read is only a
      // fast validation; without this guard a departure racing the request
      // could still commit an offload after the flight became immutable.
      const transactionalFlight = await FlightLinehaul.findById(flightId).session(session).exec();
      if (!transactionalFlight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
      if (isDepartureLocked(transactionalFlight.status)) {
        throw new FlightLinehaulServiceError("Parcels cannot be offloaded after this flight has departed.", 409);
      }

      const allocations = await FlightShipmentAllocation.find({
        flightLinehaulId: flightId,
        shipmentDraftId: { $in: affectedShipmentIds },
        status: "ALLOCATED"
      }).session(session).exec();
      if (allocations.length !== affectedShipmentIds.length) {
        throw new FlightLinehaulServiceError("One or more selected parcels are not on an active allocation for this flight.", 409);
      }

      const selectedByShipment = new Map<string, Set<string>>();
      for (const item of requestedParcels) {
        const key = String(item.shipmentDraftId);
        const selected = selectedByShipment.get(key) ?? new Set<string>();
        selected.add(item.parcelNumber);
        selectedByShipment.set(key, selected);
      }

      const affectedParcels: Array<{
        shipmentDraftId: mongoose.Types.ObjectId;
        parcelNumber: string;
        actualWeightKg: number;
        volumetricWeightKg: number;
        chargeableWeightKg: number;
      }> = [];
      for (const allocation of allocations) {
        const parcelDetails = flightAllocationParcelDetails(allocation.snapshot);
        const parcelByNumber = new Map(parcelDetails.map((parcel) => [parcel.parcelNumber, parcel]));
        const activeSet = new Set(activeParcelNumbersForAllocation(allocation));
        const selected = selectedByShipment.get(String(allocation.shipmentDraftId)) ?? new Set<string>();
        for (const parcelNumber of selected) {
          const parcel = parcelByNumber.get(parcelNumber);
          if (!parcel) throw new FlightLinehaulServiceError(`Parcel ${parcelNumber} does not belong to the selected shipment.`, 409);
          if (!activeSet.has(parcelNumber)) throw new FlightLinehaulServiceError(`Parcel ${parcelNumber} is no longer active on this flight.`, 409);
          affectedParcels.push({ shipmentDraftId: allocation.shipmentDraftId, ...parcel });
        }
      }
      if (affectedParcels.length !== requestedParcels.length) {
        throw new FlightLinehaulServiceError("One or more selected parcels could not be verified on this flight.", 409);
      }

      const manifests = await OperationsManifest.find({
        flightLinehaulId: flightId,
        status: { $ne: "CANCELLED" }
      }).session(session).select("_id status").lean().exec();
      const manifestIds = manifests.map((manifest) => manifest._id);
      const acceptedScans = manifestIds.length
        ? await OperationsManifestScan.find({
            manifestId: { $in: manifestIds },
            parcelNumber: { $in: affectedParcels.map((parcel) => parcel.parcelNumber) },
            status: "ACCEPTED"
          }).session(session).select("manifestId bagId parcelNumber").lean().exec()
        : [];
      const editableManifestIds = new Set(
        manifests.filter((manifest) => ["DRAFT", "PACKING", "READY_TO_SEAL"].includes(manifest.status)).map((manifest) => String(manifest._id))
      );
      const editableAcceptedScan = acceptedScans.find((scan) => editableManifestIds.has(String(scan.manifestId)));
      if (editableAcceptedScan) {
        throw new FlightLinehaulServiceError(
          `Parcel ${editableAcceptedScan.parcelNumber} is still packed in an editable operations manifest. Reopen its bag and remove the parcel scan before recording the offload.`,
          409
        );
      }

      const affectedBagIds = [...new Map(
        acceptedScans.filter((scan) => scan.bagId).map((scan) => [String(scan.bagId), scan.bagId as mongoose.Types.ObjectId])
      ).values()];
      const affectedWeightKg = roundWeight(affectedParcels.reduce((sum, parcel) => sum + parcel.chargeableWeightKg, 0));
      const affectedPieces = affectedParcels.length;
      const created = await FlightOffload.create(
        [
          {
            flightLinehaulId: flightId,
            // Rebooking is a separate whole-shipment operation. An offload
            // must never move the original shipment to another flight.
            replacementFlightId: null,
            branchId: transactionalFlight.branchId,
            reason: reasonValue as never,
            detail: input.reason.trim(),
            airline: (input.airline ?? "").trim(),
            affectedShipmentIds,
            affectedBagIds,
            affectedParcels,
            affectedWeightKg,
            affectedPieces,
            responsibleEmployeeId: input.responsibleEmployeeId && mongoose.Types.ObjectId.isValid(input.responsibleEmployeeId) ? new mongoose.Types.ObjectId(input.responsibleEmployeeId) : null,
            createdBy: input.userId
          }
        ],
        { session }
      );
      offloadDoc = created[0] ?? null;
      if (!offloadDoc) throw new FlightLinehaulServiceError("Offload could not be recorded.", 500);

      // Offload changes only the physical parcels assigned to this flight. It
      // never creates a replacement allocation or a parcel-level rebooking.
      const now = new Date();
      for (const allocation of allocations) {
        const selected = selectedByShipment.get(String(allocation.shipmentDraftId)) ?? new Set<string>();
        const active = activeParcelNumbersForAllocation(allocation);
        const remaining = active.filter((parcelNumber) => !selected.has(parcelNumber));
        const offloaded = new Set(normalizedParcelNumbers(allocation.offloadedParcelNumbers));
        for (const parcelNumber of selected) offloaded.add(parcelNumber);
        const totals = remainingFlightAllocationTotals(flightAllocationParcelDetails(allocation.snapshot), remaining);

        allocation.activeParcelNumbers = remaining;
        allocation.offloadedParcelNumbers = [...offloaded];
        allocation.actualWeightKg = totals.actualWeightKg;
        allocation.volumetricWeightKg = totals.volumetricWeightKg;
        allocation.chargeableWeightKg = totals.chargeableWeightKg;
        allocation.weightKg = totals.chargeableWeightKg;
        allocation.pieces = totals.pieces;
        if (!remaining.length) {
          allocation.status = "OFFLOADED";
          allocation.offloadId = (offloadDoc as InstanceType<typeof FlightOffload>)._id as mongoose.Types.ObjectId;
          allocation.removedAt = now;
          allocation.removedBy = input.userId;
          allocation.removalReason = `All parcels offloaded: ${input.reason.trim()}`;
        }
        await allocation.save({ session });
      }

      await audit("FLIGHT_OFFLOAD_CREATED", flightId, input.userId, {
        offloadId: String((offloadDoc as InstanceType<typeof FlightOffload>)._id),
        reason: input.reason.trim(),
        affectedWeightKg,
        affectedParcels: affectedParcels.map((parcel) => ({ shipmentDraftId: String(parcel.shipmentDraftId), parcelNumber: parcel.parcelNumber }))
      }, session);

      // Auto exception for offload
      await createExceptionIdempotent(
        {
          flightId,
          branchId: transactionalFlight.branchId,
          type: "OFFLOAD",
          severity: "HIGH",
          title: "Parcels offloaded",
          description: `${affectedPieces} parcel(s) offloaded from ${affectedShipmentIds.length} shipment(s) - ${input.reason.trim()}.`,
          dedupeKey: `OFFLOAD:${String(flightId)}:${String((offloadDoc as InstanceType<typeof FlightOffload>)._id)}`,
          dueAt: new Date(Date.now() + 4 * 60 * 60 * 1000)
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  await recalculateFlightTotals(flightId);
  void maybeMarkCostSheetsForReview(flightId);

  return offloadDoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination handover
// ─────────────────────────────────────────────────────────────────────────────

export function shouldRecordFlightCustomsRelease(input: {
  previousCustomsStatus: string;
  nextCustomsStatus: string;
  latestShipmentStatus?: string | null;
  latestShipmentHoldReason?: string | null;
}) {
  return input.previousCustomsStatus === "HELD"
    && input.nextCustomsStatus !== "HELD"
    && input.latestShipmentStatus === "ON_HOLD"
    && input.latestShipmentHoldReason === "customs_query";
}

async function recordFlightCustomsShipmentEvents(input: {
  flight: IFlightLinehaul;
  customsStatus: string;
  customsNote: string;
  previousCustomsStatus: string;
  userId: mongoose.Types.ObjectId;
}) {
  const allocations = await FlightShipmentAllocation.find({
    flightLinehaulId: input.flight._id,
    status: { $in: ["ALLOCATED", "CARRIED"] }
  }).select("shipmentDraftId dpdShipmentId").lean().exec();
  if (!allocations.length) return 0;
  const now = new Date();
  const location = input.flight.destinationIataCode || "Destination Customs";
  let written = 0;

  for (const allocation of allocations) {
    const latest = await ShipmentEvent.findOne({ shipmentDraftId: allocation.shipmentDraftId })
      .sort({ eventAt: -1, createdAt: -1 })
      .select("_id status holdReason")
      .lean()
      .exec();
    const events: Array<{
      status: "IMPORT_CUSTOMS_CLEARANCE" | "IMPORT_CUSTOMS_CLEARED" | "ON_HOLD" | "RELEASED_FROM_HOLD";
      customerVisible: boolean;
      holdReason?: "customs_query";
      note: string;
      sourceReference: string;
      eventAt: Date;
    }> = [];
    if (shouldRecordFlightCustomsRelease({
      previousCustomsStatus: input.previousCustomsStatus,
      nextCustomsStatus: input.customsStatus,
      latestShipmentStatus: latest?.status,
      latestShipmentHoldReason: latest?.holdReason
    }) && latest?._id) {
      events.push({
        status: "RELEASED_FROM_HOLD",
        customerVisible: true,
        note: input.customsNote || "Customs hold released and the shipment has resumed its journey.",
        // Tie the release to the hold it resolves, not to a mutable flight
        // timestamp. Concurrent/repeated saves now upsert one release row.
        sourceReference: `FLIGHT_CUSTOMS_RELEASE:${String(input.flight._id)}:${String(latest._id)}`,
        eventAt: now
      });
    }
    if (input.customsStatus === "SUBMITTED") {
      events.push({
        status: "IMPORT_CUSTOMS_CLEARANCE",
        customerVisible: false,
        note: input.customsNote || resolveShipmentEventNote("", "IMPORT_CUSTOMS_CLEARANCE"),
        sourceReference: `FLIGHT_CUSTOMS_SUBMITTED:${String(input.flight._id)}`,
        eventAt: input.flight.customsSubmittedAt ?? now
      });
    } else if (input.customsStatus === "CLEARED") {
      events.push({
        status: "IMPORT_CUSTOMS_CLEARED",
        customerVisible: false,
        note: input.customsNote || resolveShipmentEventNote("", "IMPORT_CUSTOMS_CLEARED"),
        sourceReference: `FLIGHT_CUSTOMS_CLEARED:${String(input.flight._id)}`,
        eventAt: input.flight.customsClearedAt ?? now
      });
    } else if (input.customsStatus === "HELD"
      && input.previousCustomsStatus !== "HELD"
      && !(latest?.status === "ON_HOLD" && latest.holdReason === "customs_query")) {
      events.push({
        status: "ON_HOLD",
        holdReason: "customs_query",
        customerVisible: true,
        note: input.customsNote,
        sourceReference: `FLIGHT_CUSTOMS_HOLD:${String(input.flight._id)}:${input.flight.updatedAt.toISOString()}`,
        eventAt: now
      });
    }

    for (const event of events) {
      const result = await ShipmentEvent.updateOne(
        {
          shipmentDraftId: allocation.shipmentDraftId,
          source: "SYSTEM",
          sourceReference: event.sourceReference
        },
        {
          $setOnInsert: {
            shipmentDraftId: allocation.shipmentDraftId,
            dpdShipmentId: allocation.dpdShipmentId,
            status: event.status,
            holdReason: event.holdReason ?? null,
            milestoneKey: "",
            note: event.note,
            location,
            source: "SYSTEM",
            sourceReference: event.sourceReference,
            customerVisible: event.customerVisible,
            createdBy: input.userId,
            eventAt: event.eventAt
          }
        },
        { upsert: true }
      ).exec();
      written += result.upsertedCount;
    }
  }
  return written;
}

export async function updateDestinationHandover(input: {
  flightId: string;
  arrivalAt?: string | null;
  customsStatus?: string;
  customsNote?: string;
  customsClearedAt?: string | null;
  destinationAgent?: string;
  finalMileCarrier?: string;
  handoverAt?: string | null;
  handoverReference?: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Cannot update handover for closed/cancelled flight.", 409);

  const before: Record<string, unknown> = {
    arrivalAt: flight.arrivalAt,
    customsStatus: flight.customsStatus,
    customsClearedAt: flight.customsClearedAt,
    destinationAgent: flight.destinationAgent,
    finalMileCarrier: flight.finalMileCarrier,
    handoverAt: flight.handoverAt,
    handoverReference: flight.handoverReference
  };

  if (input.arrivalAt !== undefined) {
    if (input.arrivalAt) {
      const d = new Date(input.arrivalAt);
      if (Number.isNaN(d.getTime())) throw new FlightLinehaulServiceError("Invalid arrival time.", 400);
      flight.arrivalAt = d;
      flight.actualArrivalAt = d;
    } else {
      flight.arrivalAt = null;
    }
  }
  if (input.customsStatus !== undefined) {
    const allowed = ["PENDING", "SUBMITTED", "CLEARED", "HELD"];
    if (!allowed.includes(input.customsStatus)) throw new FlightLinehaulServiceError("Invalid customs status.", 400);
    if (input.customsStatus === "HELD" && (input.customsNote?.trim().length ?? 0) < 5) {
      throw new FlightLinehaulServiceError("Enter a clear customs hold reason of at least 5 characters.", 400);
    }
    flight.customsStatus = input.customsStatus as never;
    if (input.customsStatus === "CLEARED" && !flight.customsClearedAt) {
      flight.customsClearedAt = input.customsClearedAt ? new Date(input.customsClearedAt) : new Date();
    } else if (input.customsClearedAt !== undefined) {
      flight.customsClearedAt = input.customsClearedAt ? new Date(input.customsClearedAt) : null;
    }
    if (input.customsStatus === "SUBMITTED" && !flight.customsSubmittedAt) {
      flight.customsSubmittedAt = new Date();
    }
  } else if (input.customsClearedAt !== undefined) {
    flight.customsClearedAt = input.customsClearedAt ? new Date(input.customsClearedAt) : null;
  }

  if (input.destinationAgent !== undefined) flight.destinationAgent = input.destinationAgent.trim();
  if (input.finalMileCarrier !== undefined) flight.finalMileCarrier = input.finalMileCarrier.trim();
  if (input.handoverAt !== undefined) {
    if (input.handoverAt) {
      const d = new Date(input.handoverAt);
      if (Number.isNaN(d.getTime())) throw new FlightLinehaulServiceError("Invalid handover time.", 400);
      flight.handoverAt = d;
    } else {
      flight.handoverAt = null;
    }
  }
  if (input.handoverReference !== undefined) flight.handoverReference = input.handoverReference.trim();

  // Enforce handover completion must have customs cleared
  if (flight.handoverAt && flight.customsStatus !== "CLEARED") {
    throw new FlightLinehaulServiceError("Customs must be cleared before handover.", 409);
  }

  const previousCustomsStatus = String(before.customsStatus ?? "PENDING");
  const customsBecameHeld = input.customsStatus === "HELD" && previousCustomsStatus !== "HELD";

  flight.updatedBy = input.userId;
  await flight.save();
  const customsShipmentEvents = input.customsStatus
    ? await recordFlightCustomsShipmentEvents({
      flight,
      customsStatus: input.customsStatus,
      customsNote: input.customsNote?.trim() ?? "",
      previousCustomsStatus,
      userId: input.userId
    })
    : 0;
  await audit("FLIGHT_HANDOVER_COMPLETED", flightId, input.userId, { before, customsShipmentEvents, after: { arrivalAt: flight.arrivalAt, customsStatus: flight.customsStatus, customsClearedAt: flight.customsClearedAt, destinationAgent: flight.destinationAgent, finalMileCarrier: flight.finalMileCarrier, handoverAt: flight.handoverAt, handoverReference: flight.handoverReference } });

  const handoverCompleted = Boolean(flight.handoverAt) && !before.handoverAt;
  if (customsBecameHeld) {
    await notifyFlightStaffSafely(flight.branchId, {
      type: "FLIGHT_CUSTOMS_HOLD",
      title: "Flight customs hold",
      message: `${flight.flightNumber} is on customs hold and requires operations attention.`,
      href: `/dashboard/flight-linehauls/${String(flight._id)}`,
      idempotencyKey: `FLIGHT_CUSTOMS_HOLD:${String(flight._id)}:${flight.updatedAt.toISOString()}`,
      metadata: { flightId: String(flight._id), flightNumber: flight.flightNumber, customsStatus: flight.customsStatus }
    });
  }
  if (handoverCompleted) {
    await notifyFlightStaffSafely(flight.branchId, {
      type: "FLIGHT_FINAL_MILE_HANDOVER",
      title: "Flight handed to final mile",
      message: `${flight.flightNumber} was handed to the destination final-mile operation.`,
      href: `/dashboard/flight-linehauls/${String(flight._id)}`,
      idempotencyKey: `FLIGHT_FINAL_MILE_HANDOVER:${String(flight._id)}:${flight.handoverAt?.toISOString() ?? ""}`,
      metadata: { flightId: String(flight._id), flightNumber: flight.flightNumber, handoverAt: flight.handoverAt }
    });
  }

  // Auto status progression
  if (flight.arrivalAt && flight.status === "IN_TRANSIT") {
    // Allow manual progression via status transition, but we can auto-move to ARRIVED_DESTINATION if arrivalAt set
    // Do not auto-transition to keep audit trail explicit; frontend will call status transition.
  }

  return flight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

export const flightDocumentAllowedTypes = new Set(["MAWB", "BOOKING_CONFIRMATION", "CARGO_MANIFEST", "BAG_MANIFEST", "SECURITY", "CUSTOMS", "HANDOVER", "PROOF", "OTHER"]);
export const maxFlightDocumentBytes = 10 * 1024 * 1024;

export async function listFlightDocuments(flightIdValue: string, allowedBranchIds?: string[] | null) {
  const flightId = asObjectId(flightIdValue, "Flight");
  const flight = await FlightLinehaul.findById(flightId).select("branchId").lean().exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (allowedBranchIds !== null && allowedBranchIds !== undefined && !allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  const docs = await FlightDocument.find({ flightLinehaulId: flightId }).sort({ createdAt: -1 }).lean().exec();
  return docs.map((d) => ({ ...d, id: String(d._id) }));
}

export async function uploadFlightDocument(input: {
  flightId: string;
  documentType: string;
  note: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
}) {
  const flightId = asObjectId(input.flightId, "Flight");
  const flight = await FlightLinehaul.findById(flightId).exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (!flightDocumentAllowedTypes.has(input.documentType)) throw new FlightLinehaulServiceError("Invalid document type.", 400);
  if (input.file.size > maxFlightDocumentBytes) throw new FlightLinehaulServiceError("File must be 10 MB or smaller.", 400);
  const { matchesDeclaredType } = await import("./storage/fileSignature.js");
  if (!matchesDeclaredType(input.file.buffer, input.file.mimetype)) {
    throw new FlightLinehaulServiceError("File does not match its declared type. Upload a valid PDF, JPG, PNG, WebP or XLSX.", 400);
  }
  const { putObject } = await import("./storage/storage.service.js");
  const { flightLinehaulDocumentKey } = await import("./storage/keys.js");
  const key = flightLinehaulDocumentKey(String(flightId), input.file.originalname);
  const stored = await putObject({ key, body: input.file.buffer, contentType: input.file.mimetype });
  const doc = await FlightDocument.create({
    flightLinehaulId: flightId,
    branchId: flight.branchId,
    documentType: input.documentType as never,
    originalName: input.file.originalname,
    storageKey: stored.key,
    mimeType: input.file.mimetype,
    size: input.file.size,
    note: input.note.trim(),
    uploadedBy: input.userId
  });
  await audit("FLIGHT_DOCUMENT_UPLOADED", flightId, input.userId, { documentId: String(doc._id), documentType: input.documentType });
  return doc;
}

export async function deleteFlightDocument(input: { flightId: string; documentId: string; userId: mongoose.Types.ObjectId; allowedBranchIds?: string[] | null }) {
  const flightId = asObjectId(input.flightId, "Flight");
  const documentId = asObjectId(input.documentId, "Document");
  const flight = await FlightLinehaul.findById(flightId).select("branchId status").lean().exec();
  if (!flight) throw new FlightLinehaulServiceError("Flight was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(flight.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this flight's branch.", 403);
  }
  if (["CLOSED", "CANCELLED"].includes(flight.status)) throw new FlightLinehaulServiceError("Documents cannot be deleted for closed/cancelled flights.", 409);
  const doc = await FlightDocument.findOne({ _id: documentId, flightLinehaulId: flightId }).exec();
  if (!doc) throw new FlightLinehaulServiceError("Document was not found.", 404);
  const { deleteObject } = await import("./storage/storage.service.js");
  try {
    await deleteObject(doc.storageKey);
  } catch {}
  await FlightDocument.deleteOne({ _id: documentId }).exec();
  await audit("FLIGHT_DOCUMENT_DELETED", flightId, input.userId, { documentId: String(documentId) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exceptions
// ─────────────────────────────────────────────────────────────────────────────

export async function listFlightExceptions(input: {
  flightId?: string;
  branchId?: string;
  status?: string;
  severity?: string;
  type?: string;
  page?: number;
  limit?: number;
  allowedBranchIds?: string[] | null;
}) {
  const filter: Record<string, unknown> = {};
  if (input.flightId && mongoose.Types.ObjectId.isValid(input.flightId)) filter.flightLinehaulId = new mongoose.Types.ObjectId(input.flightId);
  if (input.branchId && mongoose.Types.ObjectId.isValid(input.branchId)) filter.branchId = new mongoose.Types.ObjectId(input.branchId);
  else if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined) filter.branchId = { $in: input.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  if (input.status) filter.status = input.status;
  if (input.severity) filter.severity = input.severity;
  if (input.type) filter.type = input.type;

  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    FlightException.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
    FlightException.countDocuments(filter).exec()
  ]);
  const flightIds = [...new Set(items.map((i) => String(i.flightLinehaulId)))];
  const flights = flightIds.length ? await FlightLinehaul.find({ _id: { $in: flightIds } }).select("flightLinehaulNumber flightNumber branchId").lean().exec() : [];
  const flightById = new Map(flights.map((f) => [String(f._id), f]));
  return {
    items: items.map((item) => ({ ...item, id: String(item._id), flight: flightById.get(String(item.flightLinehaulId)) ?? null })),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  };
}

export async function acknowledgeException(input: { exceptionId: string; userId: mongoose.Types.ObjectId; allowedBranchIds?: string[] | null }) {
  const exceptionId = asObjectId(input.exceptionId, "Exception");
  const exception = await FlightException.findById(exceptionId).exec();
  if (!exception) throw new FlightLinehaulServiceError("Exception was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(exception.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this exception.", 403);
  }
  if (exception.status !== "OPEN") throw new FlightLinehaulServiceError("Only open exceptions can be acknowledged.", 409);
  exception.status = "ACKNOWLEDGED";
  exception.acknowledgedAt = new Date();
  exception.acknowledgedBy = input.userId;
  await exception.save();
  await audit("FLIGHT_EXCEPTION_ACKNOWLEDGED", exception.flightLinehaulId, input.userId, { exceptionId: String(exceptionId) });
  return exception;
}

export async function updateExceptionAssignment(input: { exceptionId: string; assignedTo: string | null; status?: string; resolutionNotes?: string; userId: mongoose.Types.ObjectId; allowedBranchIds?: string[] | null }) {
  const exceptionId = asObjectId(input.exceptionId, "Exception");
  const exception = await FlightException.findById(exceptionId).exec();
  if (!exception) throw new FlightLinehaulServiceError("Exception was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(exception.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this exception.", 403);
  }
  if (input.assignedTo !== undefined) {
    if (input.assignedTo && !mongoose.Types.ObjectId.isValid(input.assignedTo)) throw new FlightLinehaulServiceError("Invalid assignee.", 400);
    if (input.assignedTo) {
      const user = await User.findById(input.assignedTo).select("_id role").lean().exec();
      if (!user) throw new FlightLinehaulServiceError("Assignee was not found.", 404);
    }
    exception.assignedTo = input.assignedTo ? new mongoose.Types.ObjectId(input.assignedTo) : null;
  }
  if (input.status) {
    const allowed = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!allowed.includes(input.status)) throw new FlightLinehaulServiceError("Invalid status.", 400);
    // Prevent invalid jumps: OPEN -> IN_PROGRESS requires ACK? Allow flexible but enforce RESOLVED needs notes
    if (input.status === "RESOLVED" && !input.resolutionNotes?.trim() && !exception.resolutionNotes) {
      throw new FlightLinehaulServiceError("Resolution notes required.", 400);
    }
    exception.status = input.status as never;
    if (input.status === "RESOLVED") {
      exception.resolvedAt = new Date();
      exception.resolvedBy = input.userId;
      if (input.resolutionNotes !== undefined) exception.resolutionNotes = input.resolutionNotes.trim();
    }
    if (input.status === "IN_PROGRESS" && !exception.acknowledgedAt) {
      exception.acknowledgedAt = new Date();
      exception.acknowledgedBy = input.userId;
    }
  }
  if (input.resolutionNotes !== undefined && input.status !== "RESOLVED") {
    exception.resolutionNotes = input.resolutionNotes.trim();
  }
  if (input.resolutionNotes !== undefined && exception.status === "RESOLVED" && !input.status) {
    exception.resolutionNotes = input.resolutionNotes.trim();
  }
  await exception.save();
  await audit("FLIGHT_EXCEPTION_UPDATED", exception.flightLinehaulId, input.userId, { exceptionId: String(exceptionId), status: exception.status, assignedTo: exception.assignedTo ? String(exception.assignedTo) : null });
  return exception;
}

export async function resolveException(input: { exceptionId: string; resolutionNotes: string; userId: mongoose.Types.ObjectId; allowedBranchIds?: string[] | null }) {
  const exceptionId = asObjectId(input.exceptionId, "Exception");
  const exception = await FlightException.findById(exceptionId).exec();
  if (!exception) throw new FlightLinehaulServiceError("Exception was not found.", 404);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined && !input.allowedBranchIds.includes(String(exception.branchId))) {
    throw new FlightLinehaulServiceError("You do not have access to this exception.", 403);
  }
  if (["RESOLVED", "CLOSED"].includes(exception.status)) throw new FlightLinehaulServiceError("Exception already resolved.", 409);
  if (!input.resolutionNotes.trim() || input.resolutionNotes.trim().length < 5) throw new FlightLinehaulServiceError("Resolution notes must be at least 5 characters.", 400);
  exception.status = "RESOLVED";
  exception.resolvedAt = new Date();
  exception.resolvedBy = input.userId;
  exception.resolutionNotes = input.resolutionNotes.trim();
  await exception.save();
  await audit("FLIGHT_EXCEPTION_RESOLVED", exception.flightLinehaulId, input.userId, { exceptionId: String(exceptionId), resolutionNotes: input.resolutionNotes.trim() });
  return exception;
}
