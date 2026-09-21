/**
 * The order a shipment travels its operational ladder, and what is missing.
 *
 * Operations used to be able to record any operational status at any time, so a
 * shipment sitting at SHIPMENT_BOOKED could jump straight to FLIGHT_ASSIGNED and
 * leave the three steps between it never recorded. The journey rail then drew
 * those stages as pending while the shipment showed as in flight, and the
 * customer saw a history that skipped steps their parcel had actually been
 * through.
 *
 * The rule enforced here is that a ladder status may only be recorded once every
 * ladder step before it exists on that shipment.
 *
 * Deliberately not "only the immediate next step". Shipments booked before this
 * rule existed can already carry gaps, and a next-only rule would strand them a
 * step behind forever with no way to fill one in. Under this rule they unstick
 * themselves by recording the missed steps- each of which has all of *its* own
 * prerequisites- and no new shipment can develop a gap in the first place.
 */
import {
  shipmentMilestoneKey,
  shipmentOperationalStatusValues,
  type ShipmentEventStatus
} from "../models/shipmentEvent.model.js";

export type ShipmentOperationalStatus = (typeof shipmentOperationalStatusValues)[number];

/**
 * Older events remain valid evidence for the equivalent stage in the new
 * customer journey. They are aliases, not rewritten records: audit history and
 * every historical timestamp stay exactly as recorded.
 */
const legacyStatusAliases: Partial<Record<ShipmentOperationalStatus, readonly ShipmentEventStatus[]>> = {
  READY_FOR_EXPORT: ["EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED"],
  IN_TRANSIT: ["FLIGHT_DEPARTED"]
};

/** Every stored name that proves the requested current milestone happened. */
export function equivalentMilestoneStatuses(status: ShipmentOperationalStatus): readonly ShipmentEventStatus[] {
  return [status, ...(legacyStatusAliases[status] ?? [])];
}

/**
 * The single operational name represented by a stored event status.
 *
 * Historical event rows stay untouched for audit purposes. Readers use this
 * function so an old export/flight event and its current milestone never appear
 * as two different shipment stages in lists, filters or bulk validation.
 */
export function canonicalShipmentStatus(status?: string | null): string {
  if (!status) return "";
  return shipmentMilestoneKey(status) || status;
}

/**
 * Stored status values that can represent one current stage.
 *
 * This is intentionally a query helper, not a grouped UI filter: staff choose
 * one canonical stage while historical aliases remain findable internally.
 */
export function equivalentCurrentStatusValues(status: string): readonly string[] {
  const canonical = canonicalShipmentStatus(status);
  return isOperationalStatus(canonical)
    ? equivalentMilestoneStatuses(canonical)
    : [canonical];
}

export function hasRecordedMilestone(
  status: ShipmentOperationalStatus,
  recorded: Iterable<ShipmentEventStatus | string>
): boolean {
  const already = new Set(recorded);
  // Before origin dispatch and actual flight departure were separated, the
  // legacy FLIGHT_DEPARTED row represented both movements. Keep that evidence
  // valid for historical shipments without making it a current-status alias.
  if (status === "ORIGIN_HUB_DISPATCHED" && already.has("FLIGHT_DEPARTED")) return true;
  return equivalentMilestoneStatuses(status).some((candidate) => already.has(candidate));
}

export function isOperationalStatus(value: string): value is ShipmentOperationalStatus {
  return (shipmentOperationalStatusValues as readonly string[]).includes(value);
}

/**
 * Turns SHIPMENT_BOOKED into "Shipment Booked".
 *
 * Lives here rather than beside its callers because the sequence message, the
 * client event serialiser and the public tracking payload all need the same
 * label, and three copies would be free to drift.
 */
export function formatShipmentEventLabel(value?: string | null): string {
  if (!value) return "Shipment Created";
  const status = canonicalShipmentStatus(value);
  const approvedLabels: Partial<Record<ShipmentEventStatus | ShipmentOperationalStatus, string>> = {
    SHIPMENT_BOOKED: "Booking Confirmed",
    WAREHOUSE_SCAN_IN: "Received at Origin Facility",
    ORIGIN_HUB_PROCESSED: "Processing for Export",
    READY_FOR_EXPORT: "Ready for Dispatch",
    ORIGIN_HUB_DISPATCHED: "Departed from Origin Facility",
    IN_TRANSIT: "In International Transit",
    DESTINATION_ARRIVED: "Arrived in Destination Country",
    IMPORT_CUSTOMS_CLEARANCE: "Customs Processing",
    IMPORT_CUSTOMS_CLEARED: "Customs Cleared",
    DELIVERY_PARTNER_TRANSFERRED: "Transferred to Delivery Partner",
    DELIVERY_HUB_ARRIVED: "Arrived at Delivery Hub",
    OUT_FOR_DELIVERY: "Out for Delivery",
    DELIVERED: "Delivered"
  };
  return approvedLabels[status as ShipmentEventStatus | ShipmentOperationalStatus] ?? status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The ladder steps before `target` that this shipment has not recorded yet, in
 * the order it should record them.
 *
 * An empty array means the update is allowed. Statuses off the ladder- holds,
 * releases, cancellations, the booking event itself- return empty too: they can
 * legitimately happen at any point, so the rule has nothing to say about them.
 */
export function findMissingPrerequisites(
  target: string,
  recorded: Iterable<ShipmentEventStatus | string>
): ShipmentOperationalStatus[] {
  if (!isOperationalStatus(target)) return [];

  const already = [...recorded];

  return shipmentOperationalStatusValues
    .slice(0, shipmentOperationalStatusValues.indexOf(target))
    // Collection is a real milestone for pickup shipments, but counter drop-
    // offs legitimately enter the journey at the hub and have no collection
    // event to record.
    .filter((status) => status !== "PARCEL_COLLECTED")
    .filter((status) => !hasRecordedMilestone(status, already));
}

/**
 * Earlier milestones cannot be inserted after a later milestone has already
 * been recorded. This is the reverse-order guard that keeps legacy bulk/manual
 * updates from creating a timeline that goes backwards.
 */
export function findRecordedLaterMilestones(
  target: string,
  recorded: Iterable<ShipmentEventStatus | string>
): ShipmentOperationalStatus[] {
  if (!isOperationalStatus(target)) return [];

  const already = [...recorded];
  const targetIndex = shipmentOperationalStatusValues.indexOf(target);
  return shipmentOperationalStatusValues
    .slice(targetIndex + 1)
    .filter((status) => hasRecordedMilestone(status, already));
}

/**
 * The statuses this shipment may record right now.
 *
 * Used by the staff form to grey out both future steps and completed milestones.
 * A raw barcode may be scanned repeatedly, but the customer journey milestone
 * it proves is recorded once; raw scanner history belongs to its scan/audit log.
 */
export function allowedOperationalStatuses(
  recorded: Iterable<ShipmentEventStatus | string>
): ShipmentOperationalStatus[] {
  const already = [...recorded];
  return shipmentOperationalStatusValues.filter(
    (status) => !hasRecordedMilestone(status, already)
      && findMissingPrerequisites(status, already).length === 0
      && findRecordedLaterMilestones(status, already).length === 0
  );
}

export function describeAlreadyRecorded(status: ShipmentOperationalStatus, eventAt?: Date | null): string {
  const when = eventAt && !Number.isNaN(eventAt.getTime())
    ? ` on ${formatEventTimestamp(eventAt)}`
    : "";
  return `${formatShipmentEventLabel(status)} was already recorded${when}. Refresh the shipment before updating it again.`;
}

/**
 * What to tell Operations when they pick a step the shipment has not reached.
 *
 * Names every outstanding step rather than only the first, so one message is
 * enough to explain the whole gap instead of sending them round the form three
 * times.
 */
export function describeMissingPrerequisites(
  target: string,
  missing: readonly ShipmentOperationalStatus[]
): string {
  const labels = missing.map(formatShipmentEventLabel);
  const list = labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : labels[0] ?? "";

  return `${formatShipmentEventLabel(target)} cannot be recorded yet. `
    + `${list} ${labels.length > 1 ? "are" : "is"} still outstanding- `
    + "shipment progress must be recorded in order.";
}

export function describeRecordedLaterMilestones(
  target: string,
  later: readonly ShipmentOperationalStatus[]
): string {
  const labels = later.map(formatShipmentEventLabel);
  const list = labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : labels[0] ?? "a later milestone";

  return `${formatShipmentEventLabel(target)} cannot be recorded because ${list} `
    + `${labels.length > 1 ? "are" : "is"} already recorded. Use the controlled correction process for historical data.`;
}

/**
 * When a recorded event happened, spelled the way the portal writes dates.
 *
 * Kept local rather than borrowed from the email formatters: this string only
 * ever appears inside the message below, and the two have no reason to move
 * together.
 */
function formatEventTimestamp(value: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(value);
}

/**
 * Why an operator-supplied status date cannot stand, or null when it can.
 *
 * Operations record a status when they get round to it, which is not always when
 * the scan actually happened- a parcel collected on Monday can be keyed in on
 * Wednesday. The date is therefore theirs to state, and the timeline shows what
 * they state rather than the moment the button was pressed. Two limits keep the
 * result readable:
 *
 * - **Not in the future.** A tracking timeline says what has happened. A scan
 *   dated tomorrow reads as broken to every customer who opens it.
 * - **Not before the last recorded event.** Every reader takes the newest event
 *   as the shipment's current stage, ordering on `eventAt`. A date slipped in
 *   behind an existing event would quietly rewind the shipment to a stage it has
 *   already left.
 *
 * An omitted date is not this function's business- callers fall back to the
 * current time and never call in.
 */
export function describeEventDateProblem(input: {
  eventAt: Date;
  previousEventAt?: Date | null;
  now?: Date;
}): string | null {
  if (Number.isNaN(input.eventAt.getTime())) return "Enter a valid status date.";

  const now = input.now ?? new Date();
  if (input.eventAt.getTime() > now.getTime()) {
    return "A status date cannot be in the future. Leave it empty to record this update as happening now.";
  }

  const previous = input.previousEventAt;
  if (previous && input.eventAt.getTime() < previous.getTime()) {
    return "A status date cannot be earlier than this shipment's last recorded update on "
      + `${formatEventTimestamp(previous)}. Shipment progress is recorded in order.`;
  }

  return null;
}
