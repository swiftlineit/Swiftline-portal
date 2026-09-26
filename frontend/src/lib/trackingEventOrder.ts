/**
 * Returns tracking events in the customer journey order.
 *
 * Event timestamps describe when Operations or a carrier wrote the row; they
 * are not always the order in which a legacy shipment's milestones were
 * recorded. Movement statuses therefore sort by their approved progression,
 * while exceptions stay near the movement state that was current when they
 * occurred. The original event objects and timestamps are not changed.
 */
const milestoneOrder: Record<string, number> = {
  SHIPMENT_CREATED: 0,
  SHIPMENT_BOOKED: 0,
  PARCEL_COLLECTED: 1,
  WAREHOUSE_SCAN_IN: 2,
  ORIGIN_HUB_PROCESSED: 3,
  READY_FOR_EXPORT: 4,
  EXPORT_CUSTOMS_CLEARED: 4,
  FLIGHT_ASSIGNED: 4,
  ORIGIN_HUB_DISPATCHED: 5,
  FLIGHT_DEPARTED: 6,
  IN_TRANSIT: 6,
  DESTINATION_ARRIVED: 7,
  IMPORT_CUSTOMS_CLEARANCE: 8,
  IMPORT_CUSTOMS_CLEARED: 8,
  DELIVERY_PARTNER_TRANSFERRED: 9,
  DELIVERY_HUB_ARRIVED: 10,
  OUT_FOR_DELIVERY: 11,
  DELIVERED: 12,
};

function time(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function orderTrackingEvents<T extends { status: string; eventAt: string }>(events: readonly T[]): T[] {
  const chronological = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => time(left.event.eventAt) - time(right.event.eventAt) || left.index - right.index);

  let highestReached = -1;
  return chronological
    .map(({ event, index }) => {
      const rank = milestoneOrder[event.status];
      if (rank !== undefined) {
        highestReached = Math.max(highestReached, rank);
        return { event, order: rank, index };
      }
      return { event, order: highestReached + 0.5, index };
    })
    .sort((left, right) => left.order - right.order || time(left.event.eventAt) - time(right.event.eventAt) || left.index - right.index)
    .map(({ event }) => event);
}
