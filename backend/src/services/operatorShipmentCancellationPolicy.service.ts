import type { ShipmentEventStatus } from "../models/shipmentEvent.model.js";

export const terminalOperatorShipmentStatuses: readonly ShipmentEventStatus[] = [
  "SHIPMENT_CANCELLED",
  "DELIVERED",
  "RETURNED",
  "LOST",
  "DAMAGED"
];

export function getOperatorCancellationEligibility(input: {
  hasBooked: boolean;
  latestStatus?: ShipmentEventStatus | null;
  hasTerminalStatus?: boolean;
  alreadyCancelled: boolean;
}): { allowed: boolean; message: string } {
  if (input.alreadyCancelled || input.latestStatus === "SHIPMENT_CANCELLED") {
    return { allowed: false, message: "This shipment has already been cancelled." };
  }
  if (!input.hasBooked) {
    return { allowed: false, message: "Only booked shipments can be cancelled." };
  }
  if (input.hasTerminalStatus || (input.latestStatus && terminalOperatorShipmentStatuses.includes(input.latestStatus))) {
    return { allowed: false, message: "This shipment can no longer be cancelled." };
  }
  // Operator bookings use internal labels and manual tracking. A cancellation
  // request remains pending for operator staff review even after dispatch.
  return { allowed: true, message: "" };
}
