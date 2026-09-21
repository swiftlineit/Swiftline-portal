import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment, type IDpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, shipmentMilestoneKey } from "../models/shipmentEvent.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { markShipmentChargeFinalized } from "./shipmentInvoice.service.js";
import { resolveShipmentEventNote } from "./shipmentEventCopy.service.js";
import {
  findMissingPrerequisites,
  findRecordedLaterMilestones,
  formatShipmentEventLabel,
  type ShipmentOperationalStatus
} from "./shipmentStatusSequence.service.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";

export type ShipmentOperationsScanAction = "RECEIVE" | "PROCESS";

export class ShipmentOperationsScanError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export type ShipmentOperationsScanProgress = {
  parcelNumber: string;
  scannedParcels: number;
  totalParcels: number;
  remainingParcels: number;
  milestoneRecorded: boolean;
};

export function operationsScanStatus(action: ShipmentOperationsScanAction): ShipmentOperationalStatus {
  return action === "RECEIVE" ? "WAREHOUSE_SCAN_IN" : "ORIGIN_HUB_PROCESSED";
}

function duplicateKey(error: unknown) {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

function normalizedParcelNumbers(parcelNumbers: string[] | undefined) {
  return [...new Set((parcelNumbers ?? [])
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean))];
}

/**
 * Physical Swiftline labels are owned by the frozen booking snapshot. Older
 * booking records can have an empty `DpdShipment.parcelNumbers` field because
 * ALS does not provide a parcel number for every consignment. Prefer the
 * snapshot, then stored Swiftline-label rows, before using that legacy field.
 */
export function resolveOperationsScanParcelNumbers(input: {
  currentShipmentSnapshot?: unknown;
  bookingSnapshot?: unknown;
  swiftlineLabelParcelNumbers?: string[];
  parcelNumbers?: string[];
}) {
  const snapshot = readShipmentBookingSnapshot(input.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(input.bookingSnapshot);
  const snapshotParcelNumbers = normalizedParcelNumbers(
    snapshot?.parcels.map((parcel) => parcel.swiftlineParcelNumber)
  );
  if (snapshotParcelNumbers.length) return snapshotParcelNumbers;

  const labelParcelNumbers = normalizedParcelNumbers(input.swiftlineLabelParcelNumbers);
  if (labelParcelNumbers.length) return labelParcelNumbers;

  return normalizedParcelNumbers(input.parcelNumbers);
}

function makeProgress(parcelNumber: string, scannedParcels: number, totalParcels: number, milestoneRecorded: boolean): ShipmentOperationsScanProgress {
  const completed = Math.min(scannedParcels, totalParcels);
  return {
    parcelNumber,
    scannedParcels: completed,
    totalParcels,
    remainingParcels: Math.max(0, totalParcels - completed),
    milestoneRecorded
  };
}

export async function recordShipmentOperationsScan(input: {
  action: ShipmentOperationsScanAction;
  barcode: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
  location?: string;
  deviceId?: string;
  scanRequestId: string;
}) {
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode) throw new ShipmentOperationsScanError("Scan a Swiftline parcel barcode.");

  const label = await LabelDocument.findOne({ parcelNumber: barcode, labelType: "SWIFTLINE", voidedAt: null })
    .select("dpdShipmentId parcelNumber")
    .lean()
    .exec();
  const shipment = await DpdShipment.findOne({
    ...(label?.dpdShipmentId
      ? { _id: label.dpdShipmentId }
      : {
          $or: [
            { swiftlineTrackingNumber: barcode },
            { dpdShipmentId: barcode },
            { forwardingNumber: barcode },
            { entryNumber: barcode },
            { parcelNumbers: barcode }
          ]
        }),
    status: { $in: ["DPD_CREATED", "LABEL_RECEIVED"] }
  }).exec();
  if (!shipment) throw new ShipmentOperationsScanError("No booked shipment was found for this barcode.", 404);

  let parcelNumbers = resolveOperationsScanParcelNumbers({
    currentShipmentSnapshot: shipment.currentShipmentSnapshot,
    bookingSnapshot: shipment.bookingSnapshot,
    parcelNumbers: shipment.parcelNumbers
  });
  if (!parcelNumbers.length) {
    const swiftlineLabelParcelNumbers = await LabelDocument.find({
      dpdShipmentId: shipment._id,
      labelType: "SWIFTLINE",
      voidedAt: null
    }).distinct("parcelNumber").exec();
    parcelNumbers = resolveOperationsScanParcelNumbers({
      swiftlineLabelParcelNumbers,
      parcelNumbers: shipment.parcelNumbers
    });
  }
  if (!parcelNumbers.length) throw new ShipmentOperationsScanError("This shipment has no parcel labels to scan.", 409);
  const labelParcelNumber = String(label?.parcelNumber ?? "").trim().toUpperCase();
  const parcelNumber = parcelNumbers.find((value) => value === barcode)
    ?? (labelParcelNumber && parcelNumbers.includes(labelParcelNumber) ? labelParcelNumber : "");
  if (parcelNumber) return recordResolvedParcelScan({ ...input, shipment, parcelNumbers, parcelNumber });
  if (parcelNumbers.length === 1) {
    // A one-piece shipment can be received using its HAWB. A multi-piece HAWB
    // cannot stand in for every box because that would misstate physical receipt.
    return recordResolvedParcelScan({ ...input, shipment, parcelNumbers, parcelNumber: parcelNumbers[0]! });
  }
  throw new ShipmentOperationsScanError(
    `This shipment has ${parcelNumbers.length} parcels. Scan each Swiftline parcel barcode; a HAWB cannot mark every parcel as received.`,
    409
  );
}

async function recordResolvedParcelScan(input: {
  action: ShipmentOperationsScanAction;
  barcode: string;
  userId: mongoose.Types.ObjectId;
  allowedBranchIds?: string[] | null;
  location?: string;
  deviceId?: string;
  scanRequestId: string;
  shipment: IDpdShipment;
  parcelNumbers: string[];
  parcelNumber: string;
}) {
  const { shipment, parcelNumbers, parcelNumber } = input;
  const draft = await ShipmentDraft.findById(shipment.shipmentDraftId).select("branchId").lean().exec();
  if (!draft) throw new ShipmentOperationsScanError("The shipment record is incomplete.", 409);
  if (input.allowedBranchIds !== null && input.allowedBranchIds !== undefined
    && !input.allowedBranchIds.includes(String(draft.branchId))) {
    throw new ShipmentOperationsScanError("This shipment belongs to a branch you cannot access.", 403);
  }

  const [branch, cancellation, events] = await Promise.all([
    Branch.findById(draft.branchId).select("name code address.city").lean().exec(),
    ShipmentCancellation.findOne({
      shipmentDraftId: shipment.shipmentDraftId,
      status: { $in: ["REQUESTED", "COMPLETED"] }
    }).select("status").lean().exec(),
    ShipmentEvent.find({ shipmentDraftId: shipment.shipmentDraftId })
      .select("status eventAt")
      .sort({ eventAt: 1, createdAt: 1 })
      .lean()
      .exec()
  ]);
  if (cancellation) {
    throw new ShipmentOperationsScanError(
      cancellation.status === "COMPLETED"
        ? "This shipment is cancelled and cannot be scanned."
        : "Resolve the pending cancellation before scanning this shipment.",
      409
    );
  }
  if (events.at(-1)?.status === "ON_HOLD") {
    throw new ShipmentOperationsScanError("Release the shipment before scanning it.", 409);
  }

  const status = operationsScanStatus(input.action);
  const recordedStatuses = new Set(events.map((event) => event.status));
  const existingMilestone = events.find((event) => shipmentMilestoneKey(event.status) === shipmentMilestoneKey(status));
  const location = input.location?.trim()
    || String(branch?.address?.city ?? "").trim()
    || branch?.name
    || "Origin Facility";
  if (existingMilestone) {
    return {
      alreadyRecorded: true,
      status,
      statusLabel: formatShipmentEventLabel(status),
      eventAt: existingMilestone.eventAt,
      location,
      swiftlineTrackingNumber: shipment.swiftlineTrackingNumber ?? "",
      parcelNumbers,
      progress: makeProgress(parcelNumber, parcelNumbers.length, parcelNumbers.length, true)
    };
  }
  const missing = findMissingPrerequisites(status, recordedStatuses);
  if (missing.length) {
    throw new ShipmentOperationsScanError(
      `${formatShipmentEventLabel(status)} cannot be recorded yet. Scan ${missing.map(formatShipmentEventLabel).join(", ")} first.`,
      409
    );
  }
  const later = findRecordedLaterMilestones(status, recordedStatuses);
  if (later.length) {
    throw new ShipmentOperationsScanError(
      `${formatShipmentEventLabel(status)} cannot be recorded because ${later.map(formatShipmentEventLabel).join(", ")} is already recorded.`,
      409
    );
  }

  const session = await mongoose.startSession();
  try {
    let saved: { alreadyRecorded: boolean; eventAt: Date; progress: ShipmentOperationsScanProgress } | null = null;
    await session.withTransaction(async () => {
      const existingScan = await ShipmentOperationsParcelScan.findOne({
        shipmentDraftId: shipment.shipmentDraftId,
        action: input.action,
        parcelNumber
      }).select("scannedAt").lean().session(session).exec();
      const existingEvent = await ShipmentEvent.findOne({
        shipmentDraftId: shipment.shipmentDraftId,
        milestoneKey: shipmentMilestoneKey(status)
      }).select("eventAt").lean().session(session).exec();
      if (existingScan || existingEvent) {
        const count = existingEvent
          ? parcelNumbers.length
          : await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: shipment.shipmentDraftId, action: input.action }).session(session);
        saved = {
          alreadyRecorded: true,
          eventAt: existingEvent?.eventAt ?? existingScan?.scannedAt ?? new Date(),
          progress: makeProgress(parcelNumber, count, parcelNumbers.length, Boolean(existingEvent))
        };
        return;
      }

      const scannedAt = new Date();
      await ShipmentOperationsParcelScan.create([{
        shipmentDraftId: shipment.shipmentDraftId,
        dpdShipmentId: shipment._id,
        action: input.action,
        parcelNumber,
        location,
        deviceId: input.deviceId?.trim() ?? "",
        scanRequestId: input.scanRequestId,
        scannedBy: input.userId,
        scannedAt
      }], { session });
      const scannedParcels = await ShipmentOperationsParcelScan.countDocuments({
        shipmentDraftId: shipment.shipmentDraftId,
        action: input.action
      }).session(session);
      const complete = scannedParcels >= parcelNumbers.length;
      if (complete) {
        await ShipmentEvent.create([{
          shipmentDraftId: shipment.shipmentDraftId,
          dpdShipmentId: shipment._id,
          status,
          milestoneKey: shipmentMilestoneKey(status),
          note: resolveShipmentEventNote("", status),
          location,
          source: "SCAN",
          sourceReference: `ORIGIN_SCAN:${input.action}:${String(shipment._id)}`,
          customerVisible: true,
          createdBy: input.userId,
          eventAt: scannedAt
        }], { session });
        if (status === "WAREHOUSE_SCAN_IN") {
          await markShipmentChargeFinalized({
            shipmentDraftId: shipment.shipmentDraftId,
            finalizedAt: scannedAt,
            session
          });
        }
      }
      await AuditLog.create([{
        action: "SHIPMENT_STATUS_UPDATED",
        entityType: "DPD_SHIPMENT",
        entityId: shipment._id,
        performedBy: input.userId,
        performedAt: scannedAt,
        metadata: {
          shipmentDraftId: String(shipment.shipmentDraftId),
          status,
          source: "SCAN",
          barcode: input.barcode.trim().toUpperCase(),
          parcelNumber,
          scanRequestId: input.scanRequestId,
          deviceId: input.deviceId?.trim() ?? "",
          location,
          scannedParcels,
          totalParcels: parcelNumbers.length,
          milestoneRecorded: complete
        }
      }], { session });
      saved = {
        alreadyRecorded: false,
        eventAt: scannedAt,
        progress: makeProgress(parcelNumber, scannedParcels, parcelNumbers.length, complete)
      };
    });
    if (!saved) throw new ShipmentOperationsScanError("The scan could not be recorded.", 500);
    const savedScan = saved as { alreadyRecorded: boolean; eventAt: Date; progress: ShipmentOperationsScanProgress };
    return {
      alreadyRecorded: savedScan.alreadyRecorded,
      status,
      statusLabel: formatShipmentEventLabel(status),
      eventAt: savedScan.eventAt,
      location,
      swiftlineTrackingNumber: shipment.swiftlineTrackingNumber ?? "",
      parcelNumbers,
      progress: savedScan.progress
    };
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    const [winner, count] = await Promise.all([
      ShipmentEvent.findOne({ shipmentDraftId: shipment.shipmentDraftId, milestoneKey: shipmentMilestoneKey(status) }).select("eventAt").lean().exec(),
      ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: shipment.shipmentDraftId, action: input.action })
    ]);
    return {
      alreadyRecorded: true,
      status,
      statusLabel: formatShipmentEventLabel(status),
      eventAt: winner?.eventAt ?? new Date(),
      location,
      swiftlineTrackingNumber: shipment.swiftlineTrackingNumber ?? "",
      parcelNumbers,
      progress: makeProgress(parcelNumber, winner ? parcelNumbers.length : count, parcelNumbers.length, Boolean(winner))
    };
  } finally {
    await session.endSession();
  }
}
