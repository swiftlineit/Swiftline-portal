import mongoose from "mongoose";
import { performance } from "node:perf_hooks";
import { AuditLog } from "../models/auditLog.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentEvent, shipmentMilestoneKey } from "../models/shipmentEvent.model.js";
import { resolveShipmentEventNote } from "./shipmentEventCopy.service.js";
import { chargeFinalizingStatuses, markShipmentChargesFinalized } from "./shipmentInvoice.service.js";
import {
  canonicalShipmentStatus,
  describeEventDateProblem,
  describeAlreadyRecorded,
  describeMissingPrerequisites,
  describeRecordedLaterMilestones,
  equivalentMilestoneStatuses,
  findMissingPrerequisites,
  findRecordedLaterMilestones,
  formatShipmentEventLabel,
  type ShipmentOperationalStatus
} from "./shipmentStatusSequence.service.js";
import { resolveBulkTrackingGatewayCode } from "./shipmentGateway.service.js";
import { formatShipmentStatusLabel } from "./shipmentListing.service.js";

export type BulkStatusSkip = {
  shipmentDraftId: string;
  swiftlineTrackingNumber?: string;
  reason: string;
  missingStatuses?: ShipmentOperationalStatus[];
};

export type BulkStatusUpdate = {
  shipmentDraftId: string;
  status: ShipmentOperationalStatus;
  statusLabel: string;
  lastScan: {
    statusLabel: string;
    location: string;
    at: Date;
  };
};

export type BulkStatusBlock = {
  reason: string;
  missingStatuses?: ShipmentOperationalStatus[];
} | null;

/**
 * The batch was refused before anything was written.
 *
 * Distinct from a per-shipment skip: a skip means the rest of the batch went
 * through, this means none of it did and the operator has to change what they
 * selected.
 */
export class BulkStatusSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkStatusSelectionError";
  }
}

/**
 * The stage a shipment with no events yet is standing at.
 *
 * Deliberately the same fallback the shipments list uses for its status column,
 * so what the operator reads in the table is what the batch is judged against.
 */
export const NOT_YET_SCANNED = "SHIPMENT_BOOKED";

export type BulkStatusExpectation = {
  shipmentDraftId: string;
  status: string;
};

/**
 * Detects rows whose current stage changed after the browser selected them.
 * Canonical comparison prevents a harmless legacy alias from looking like a
 * change while still catching a real move such as Destination Arrived to
 * Delivered.
 */
export function findBulkStatusChanges(
  expected: readonly BulkStatusExpectation[],
  currentByDraft: ReadonlyMap<string, string>
) {
  return expected.flatMap((item) => {
    const expectedStatus = canonicalShipmentStatus(item.status) || NOT_YET_SCANNED;
    const currentStatus = canonicalShipmentStatus(currentByDraft.get(item.shipmentDraftId)) || NOT_YET_SCANNED;
    return expectedStatus === currentStatus
      ? []
      : [{ shipmentDraftId: item.shipmentDraftId, expectedStatus, currentStatus }];
  });
}

/**
 * Why this selection cannot be updated as one batch, or null when it can.
 *
 * A batch records one status across many shipments, which only means something
 * if they are all standing at the same point. Mixing stages produces two
 * different outcomes from one click: a booked parcel advances to Parcel
 * Collected, while one already collected gets a second, identical row on the
 * customer's tracker for a scan that never happened twice.
 *
 * The same reasoning rules out a batch whose target is the stage every shipment
 * is already at- there is nothing to advance, only duplicates to write.
 *
 * Refused whole rather than partly applied. A half-written batch leaves the
 * operator guessing which shipments moved.
 */
export function bulkSelectionBlockReason(
  currentStatuses: readonly string[],
  target: ShipmentOperationalStatus
): string | null {
  const distinct = [...new Set(currentStatuses.map((status) => (
    canonicalShipmentStatus(status) || NOT_YET_SCANNED
  )))];
  const canonicalTarget = canonicalShipmentStatus(target);

  if (distinct.length > 1) {
    const labels = distinct.map(formatShipmentEventLabel).sort();
    return "A bulk update covers shipments that are all at the same stage. "
      + `This selection mixes ${labels.join(", ")}. `
      + "Narrow it to shipments that share one current status and update each group separately.";
  }

  if (distinct.length === 1 && distinct[0] === canonicalTarget) {
    return `Every selected shipment is already at ${formatShipmentEventLabel(target)}. `
      + "Choose the stage they should move to next.";
  }

  return null;
}

/**
 * Why a shipment cannot take the requested status, or null when it can.
 *
 * The same gates the single-shipment update enforces- cancellation, hold and
 * sequence prerequisites- held as a pure function so the decision is directly
 * unit-testable. The database is loaded once up front and each row is decided
 * against in-memory data.
 */
export function statusUpdateBlockReason(input: {
  shipmentExists: boolean;
  cancellationStatus?: string;
  onHold: boolean;
  alreadyRecordedAt?: Date | null;
  missingPrerequisites: ShipmentOperationalStatus[];
  laterMilestones?: ShipmentOperationalStatus[];
  /**
   * Why the stated status date will not do for this shipment, or null.
   *
   * Per shipment rather than per batch: one date is applied across the
   * selection, and each shipment's own history decides whether it can take it.
   */
  eventDateProblem?: string | null;
  status: ShipmentOperationalStatus;
}): BulkStatusBlock {
  if (!input.shipmentExists) {
    return { reason: "Shipment is not booked." };
  }
  if (input.cancellationStatus) {
    return {
      reason: input.cancellationStatus === "COMPLETED"
        ? "Shipment has been cancelled and its progress cannot be updated."
        : "Resolve the pending shipment cancellation before updating shipment progress."
    };
  }
  if (input.onHold) {
    return { reason: "Release the shipment before updating its status." };
  }
  if (input.alreadyRecordedAt) {
    return { reason: describeAlreadyRecorded(input.status, input.alreadyRecordedAt) };
  }
  if (input.missingPrerequisites.length) {
    return {
      reason: describeMissingPrerequisites(input.status, input.missingPrerequisites),
      missingStatuses: input.missingPrerequisites
    };
  }
  if (input.laterMilestones?.length) {
    return { reason: describeRecordedLaterMilestones(input.status, input.laterMilestones) };
  }
  if (input.eventDateProblem) {
    return { reason: input.eventDateProblem };
  }
  return null;
}

function isDuplicateKeyError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === 11000;
}

function roundedDuration(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

/**
 * Records one operational status across many shipments at once.
 *
 * Each shipment is held to the same rule as the single-shipment update, so a
 * batch can never write a jump the detail page would reject. Shipments that
 * cannot take the status yet are skipped and reported, letting the eligible
 * ones move on while Operations fixes the rest- the common same-day, same-
 * flight case updates together and stragglers are named in the response.
 */
export async function bulkRecordOperationalStatus(input: {
  shipmentDraftIds: string[];
  status: ShipmentOperationalStatus;
  note?: string;
  location?: string;
  /** When the scan happened. Omitted, each event is stamped with the time it is written. */
  eventAt?: Date;
  gatewayCode?: string;
  partnerName?: string;
  partnerCode?: string;
  /** Browser snapshot used only to detect rows that changed before submission. */
  expectedStatuses?: BulkStatusExpectation[];
  userId: mongoose.Types.ObjectId;
}): Promise<{ updatedCount: number; skipped: BulkStatusSkip[]; updated: BulkStatusUpdate[] }> {
  const operationStartedAt = performance.now();
  const timings = {
    readMs: 0,
    validationMs: 0,
    eventWriteMs: 0,
    invoiceWriteMs: 0,
    auditWriteMs: 0
  };
  let outcome = "failed";
  let updatedCount = 0;
  let skippedCount = 0;
  const uniqueIds = [...new Set(input.shipmentDraftIds)];
  const draftObjectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
  const targetStatuses = [...equivalentMilestoneStatuses(input.status)];

  try {
    const readStartedAt = performance.now();
    const [shipments, drafts, cancellations, eventSummaries] = await Promise.all([
      DpdShipment.find({ shipmentDraftId: { $in: draftObjectIds } })
        .select("shipmentDraftId swiftlineTrackingNumber")
        .lean()
        .exec(),
      ShipmentDraft.find({ _id: { $in: draftObjectIds } })
        .select("consigneeEnteredAddress.countryCode")
        .lean()
        .exec(),
      ShipmentCancellation.find({
        shipmentDraftId: { $in: draftObjectIds },
        status: { $in: ["REQUESTED", "COMPLETED"] }
      })
        .select("shipmentDraftId status")
        .lean()
        .exec(),
      // Collapse history inside MongoDB. The service needs the latest scan and
      // the set of milestones, not every event document and its unused fields.
      ShipmentEvent.aggregate<{
        _id: mongoose.Types.ObjectId;
        latestStatus: string;
        latestEventAt: Date;
        recordedStatuses: string[];
        targetEventAt: Date | null;
      }>([
        { $match: { shipmentDraftId: { $in: draftObjectIds } } },
        { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
        {
          $group: {
            _id: "$shipmentDraftId",
            latestStatus: { $first: "$status" },
            latestEventAt: { $first: "$eventAt" },
            recordedStatuses: { $addToSet: "$status" },
            targetEventAt: {
              $max: {
                $cond: [{ $in: ["$status", targetStatuses] }, "$eventAt", null]
              }
            }
          }
        }
      ]).exec()
    ]);
    timings.readMs = roundedDuration(readStartedAt);

    const validationStartedAt = performance.now();
    const shipmentByDraft = new Map(shipments.map((shipment) => [String(shipment.shipmentDraftId), shipment]));

    const cancellationByDraft = new Map<string, string>(
      cancellations.map((cancellation) => [String(cancellation.shipmentDraftId), cancellation.status])
    );
    const destinationCountryByDraft = new Map(
      drafts.map((draft) => [String(draft._id), draft.consigneeEnteredAddress?.countryCode ?? ""])
    );
    const latestStatusByDraft = new Map(
      eventSummaries.map((summary) => [String(summary._id), summary.latestStatus])
    );
    const latestEventAtByDraft = new Map(
      eventSummaries.map((summary) => [String(summary._id), summary.latestEventAt])
    );
    const recordedByDraft = new Map(
      eventSummaries.map((summary) => [String(summary._id), new Set(summary.recordedStatuses)])
    );
    const targetEventAtByDraft = new Map(
      eventSummaries.flatMap((summary) => summary.targetEventAt
        ? [[String(summary._id), summary.targetEventAt] as const]
        : [])
    );

    const selectedIdSet = new Set(uniqueIds);
    const changedSelections = findBulkStatusChanges(
      (input.expectedStatuses ?? []).filter((item) => selectedIdSet.has(item.shipmentDraftId)),
      latestStatusByDraft
    );
    if (changedSelections.length) {
      const visible = changedSelections.slice(0, 8).map((change) => {
        const shipment = shipmentByDraft.get(change.shipmentDraftId);
        const reference = shipment?.swiftlineTrackingNumber || change.shipmentDraftId;
        return `${reference} is now ${formatShipmentEventLabel(change.currentStatus)}`
          + ` (was ${formatShipmentEventLabel(change.expectedStatus)})`;
      });
      const remainder = changedSelections.length - visible.length;
      throw new BulkStatusSelectionError(
        `Shipment statuses changed after they were selected. ${visible.join("; ")}.`
          + (remainder > 0 ? ` ${remainder} more shipment(s) changed.` : "")
          + " Refresh the list and select the current rows again."
      );
    }

    // Judged only over shipments that are actually booked. An unbooked row
    // stays a reported skip rather than failing the whole batch.
    const selectionBlock = bulkSelectionBlockReason(
      uniqueIds
        .filter((draftId) => shipmentByDraft.has(draftId))
        .map((draftId) => latestStatusByDraft.get(draftId) ?? NOT_YET_SCANNED),
      input.status
    );
    if (selectionBlock) throw new BulkStatusSelectionError(selectionBlock);

    const gateway = resolveBulkTrackingGatewayCode({
      status: input.status,
      destinationCountryCodes: uniqueIds
        .filter((draftId) => shipmentByDraft.has(draftId))
        .map((draftId) => destinationCountryByDraft.get(draftId) ?? ""),
      gatewayCode: input.gatewayCode
    });
    if (gateway.error) throw new BulkStatusSelectionError(gateway.error);

    const note = resolveShipmentEventNote(input.note, input.status);
    const skipped: BulkStatusSkip[] = [];
    const prepared: Array<{
      draftId: string;
      shipment: (typeof shipments)[number];
      eventId: mongoose.Types.ObjectId;
      eventAt: Date;
    }> = [];

    for (const draftId of uniqueIds) {
      const shipment = shipmentByDraft.get(draftId);
      if (!shipment) {
        skipped.push({ shipmentDraftId: draftId, reason: "Shipment is not booked." });
        continue;
      }

      const block = statusUpdateBlockReason({
        shipmentExists: true,
        cancellationStatus: cancellationByDraft.get(draftId),
        onHold: latestStatusByDraft.get(draftId) === "ON_HOLD",
        alreadyRecordedAt: targetEventAtByDraft.get(draftId),
        missingPrerequisites: findMissingPrerequisites(input.status, recordedByDraft.get(draftId) ?? []),
        laterMilestones: findRecordedLaterMilestones(input.status, recordedByDraft.get(draftId) ?? []),
        eventDateProblem: input.eventAt
          ? describeEventDateProblem({
            eventAt: input.eventAt,
            previousEventAt: latestEventAtByDraft.get(draftId) ?? null
          })
          : null,
        status: input.status
      });

      if (block) {
        skipped.push({
          shipmentDraftId: draftId,
          swiftlineTrackingNumber: shipment.swiftlineTrackingNumber,
          reason: block.reason,
          missingStatuses: block.missingStatuses
        });
        continue;
      }

      prepared.push({
        draftId,
        shipment,
        eventId: new mongoose.Types.ObjectId(),
        eventAt: input.eventAt ?? new Date()
      });
    }
    timings.validationMs = roundedDuration(validationStartedAt);
    skippedCount = skipped.length;

    const eventDocuments = prepared.map(({ shipment, eventId, eventAt }) => ({
      _id: eventId,
      shipmentDraftId: shipment.shipmentDraftId,
      dpdShipmentId: shipment._id,
      status: input.status,
      milestoneKey: shipmentMilestoneKey(input.status),
      note,
      location: input.location ?? "",
      source: "MANUAL",
      gatewayCode: gateway.gatewayCode,
      partnerName: input.partnerName ?? "",
      partnerCode: input.partnerCode ?? "",
      customerVisible: true,
      createdBy: input.userId,
      // One stated date across the batch- the same-day, same-flight scan they
      // are all recording. Omitted, each row is stamped as it is prepared.
      eventAt
    }));

    if (eventDocuments.length) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const eventWriteStartedAt = performance.now();
          await ShipmentEvent.insertMany(eventDocuments, { session });
          timings.eventWriteMs += roundedDuration(eventWriteStartedAt);

          // Collection settles the charge, exactly as it does on the
          // single-shipment update- see chargeFinalizingStatuses.
          const invoiceWriteStartedAt = performance.now();
          if ((chargeFinalizingStatuses as readonly string[]).includes(input.status)) {
            await markShipmentChargesFinalized(prepared.map((item) => ({
              shipmentDraftId: item.shipment.shipmentDraftId,
              finalizedAt: item.eventAt
            })), session);
          }
          timings.invoiceWriteMs += roundedDuration(invoiceWriteStartedAt);

          const auditWriteStartedAt = performance.now();
          const performedAt = new Date();
          await AuditLog.insertMany(prepared.map((item) => ({
            action: "SHIPMENT_STATUS_UPDATED" as const,
            entityType: "DPD_SHIPMENT" as const,
            entityId: item.shipment._id,
            performedBy: input.userId,
            performedAt,
            metadata: {
              shipmentDraftId: item.draftId,
              status: input.status,
              note,
              gatewayCode: gateway.gatewayCode,
              // performedAt above stays the real moment; together the two show
              // a backdated batch for what it is.
              eventAt: item.eventAt,
              source: "BULK"
            }
          })), { session });
          timings.auditWriteMs += roundedDuration(auditWriteStartedAt);
        });
      } catch (error) {
        // The unique milestone index is the final race guard. A second request
        // reaching it first aborts this transaction, so it cannot leave events,
        // invoice stamps and audit rows out of sync.
        if (isDuplicateKeyError(error)) {
          throw new BulkStatusSelectionError(
            "One or more shipment statuses changed while this batch was being saved. "
              + "Refresh the list and select the current rows again."
          );
        }
        throw error;
      } finally {
        await session.endSession();
      }
    }

    const statusLabel = formatShipmentStatusLabel(input.status, {
      gatewayCode: gateway.gatewayCode,
      location: input.location ?? ""
    });
    const updated: BulkStatusUpdate[] = prepared.map((item) => ({
      shipmentDraftId: item.draftId,
      status: input.status,
      statusLabel,
      lastScan: {
        statusLabel,
        location: input.location ?? "",
        at: item.eventAt
      }
    }));
    updatedCount = updated.length;
    skippedCount = skipped.length;
    outcome = "succeeded";
    return { updatedCount, skipped, updated };
  } catch (error) {
    outcome = error instanceof BulkStatusSelectionError ? "rejected" : "failed";
    throw error;
  } finally {
    console.info("[performance] bulk shipment status", {
      outcome,
      status: input.status,
      requestedCount: uniqueIds.length,
      updatedCount,
      skippedCount,
      ...timings,
      totalMs: roundedDuration(operationStartedAt)
    });
  }
}
