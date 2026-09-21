/**
 * What a tracking timeline says when the operator did not write a note.
 *
 * Every status update carries a free-text note, and for a long time each caller
 * invented its own filler for the blank case- the bulk dialog sent "Bulk status
 * update by Swiftline Operations", the single-shipment form sent "Live action
 * updated by Swiftline Operations". Both were written verbatim into the event
 * and then read straight back out by the public tracker, the client portal and
 * the staff timeline, so the customer was shown how the office works rather
 * than where their parcel is.
 *
 * These lines describe the parcel. They never name the operator, the batch, or
 * the screen the update came from- whether one shipment moved or four hundred
 * did is an audit question, and `AuditLog.metadata.source` already answers it.
 *
 * An operator's own note always wins; this only fills the gap.
 */
import type { ShipmentEventStatus } from "../models/shipmentEvent.model.js";

const eventNotes: Record<ShipmentEventStatus, string> = {
  SHIPMENT_CREATED: "Shipment details received and the booking is being prepared.",
  SHIPMENT_BOOKED: "Shipment booked with Swiftline and awaiting collection.",
  SHIPMENT_CANCELLED: "Shipment cancelled and no longer in transit.",
  ON_HOLD: "Shipment is on hold pending review.",
  RELEASED_FROM_HOLD: "Hold released and the shipment has resumed its journey.",
  PARCEL_COLLECTED: "Parcel collected from the sender and on its way to the Swiftline hub.",
  WAREHOUSE_SCAN_IN: "Shipment received at the origin facility.",
  ORIGIN_HUB_PROCESSED: "Shipment is being processed for export.",
  READY_FOR_EXPORT: "Shipment is ready for dispatch.",
  ORIGIN_HUB_DISPATCHED: "Shipment departed from the origin facility.",
  EXPORT_CUSTOMS_CLEARED: "Export customs clearance completed.",
  FLIGHT_ASSIGNED: "Allocated to an outbound flight.",
  FLIGHT_DEPARTED: "Shipment is in international transit.",
  DESTINATION_ARRIVED: "Arrived in the destination country.",
  IMPORT_CUSTOMS_CLEARANCE: "Undergoing import customs clearance.",
  IMPORT_CUSTOMS_CLEARED: "Import customs clearance completed.",
  DELIVERY_PARTNER_TRANSFERRED: "Shipment transferred to the last-mile delivery network.",
  DELIVERY_HUB_ARRIVED: "Shipment arrived at the local delivery hub.",
  IN_TRANSIT: "Shipment is in international transit.",
  OUT_FOR_DELIVERY: "Out for delivery with the local delivery partner.",
  DELIVERED: "Delivered to the recipient.",
  RETURNED: "Shipment returned to the sender.",
  LOST: "Shipment could not be located and is under investigation.",
  DAMAGED: "Damage reported and the shipment is under investigation."
};

/**
 * The line to store or show for `status` when no operator note exists.
 *
 * Falls back to a neutral sentence rather than an empty string: a timeline row
 * with a date and nothing beside it reads as a rendering fault.
 */
export function defaultShipmentEventNote(status?: string | null): string {
  if (status && status in eventNotes) return eventNotes[status as ShipmentEventStatus];
  return "Shipment progress updated.";
}

/**
 * An operator note if there is one, otherwise the standard line for the status.
 *
 * Used on the write path so the professional copy is what lands in the
 * database, and on the read path so events recorded before this existed still
 * present properly.
 */
export function resolveShipmentEventNote(note: string | null | undefined, status?: string | null): string {
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed || defaultShipmentEventNote(status);
}

/**
 * Notes earlier versions of the portal invented when the operator left the note
 * blank, before this module existed.
 *
 * Kept as data rather than folded into history, because two jobs need to
 * recognise a system-written note: the backfill that rewrites them, and the
 * dedupe that decides whether removing a repeated row would lose something a
 * person typed. Neither may depend on the other having run first.
 */
export const legacyFilledNotes: readonly string[] = [
  "Bulk status update by Swiftline Operations",
  "Live action updated by Swiftline Operations"
];

/**
 * Whether this note was filled in by the portal rather than typed by a person.
 *
 * True for a blank note, for the current standard line, and for the strings
 * older versions used. Anything else is treated as an operator's own words and
 * is never discarded by an automated job.
 */
export function isSystemWrittenNote(note: string | null | undefined, status?: string | null): boolean {
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (!trimmed) return true;
  if (trimmed === defaultShipmentEventNote(status)) return true;
  return legacyFilledNotes.includes(trimmed);
}
