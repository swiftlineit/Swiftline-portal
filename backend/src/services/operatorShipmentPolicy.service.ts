export const operatorTrackingStatusValues = [
  "PARCEL_COLLECTED",
  "IN_TRANSIT",
  "DESTINATION_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED"
] as const;

export type OperatorTrackingStatus = (typeof operatorTrackingStatusValues)[number];

const trackingOrder: Record<OperatorTrackingStatus, number> = {
  PARCEL_COLLECTED: 1,
  IN_TRANSIT: 2,
  DESTINATION_ARRIVED: 3,
  OUT_FOR_DELIVERY: 4,
  DELIVERED: 5,
  RETURNED: 6
};

export function isOperatorBusinessAccountApproved(status: string): boolean {
  return status === "approved" || status === "active";
}

export function isOperatorBusinessAccountBookable(input: {
  status: string;
  kycStatus?: string | null;
}): boolean {
  return isOperatorBusinessAccountApproved(input.status) && input.kycStatus === "verified";
}

export function getOperatorShipmentEligibilityError(input: {
  branchStatus: string;
  accountStatus: string;
  accountKind?: string | null;
  assignedBranchId?: unknown;
  shipmentBranchId: unknown;
}): string | null {
  if (input.branchStatus !== "ACTIVE") {
    return "The assigned operator branch is not active.";
  }
  if (!isOperatorBusinessAccountApproved(input.accountStatus)) {
    return "The operator client account must be approved before booking.";
  }
  // Individual customers do not belong to a client account. Their system
  // sentinel intentionally has no assignedBranch; the authenticated staff
  // branch check is enforced when the draft is created and booked.
  if (input.accountKind === "INDIVIDUAL_SENTINEL") return null;
  if (!input.assignedBranchId || String(input.assignedBranchId) !== String(input.shipmentBranchId)) {
    return "The selected operator branch is not assigned to this client account.";
  }
  return null;
}

export function getOperatorTrackingTransitionError(input: {
  currentStatus?: string | null;
  currentEventAt?: Date | null;
  nextStatus: OperatorTrackingStatus;
  nextEventAt: Date;
}): string | null {
  if (input.currentStatus === "DELIVERED" || input.currentStatus === "RETURNED") {
    return "This shipment already has a terminal tracking status.";
  }
  if (input.currentEventAt && input.nextEventAt < input.currentEventAt) {
    return "Tracking updates must be in chronological order.";
  }

  const currentOrder = input.currentStatus && operatorTrackingStatusValues.includes(input.currentStatus as OperatorTrackingStatus)
    ? trackingOrder[input.currentStatus as OperatorTrackingStatus]
    : 0;
  if (trackingOrder[input.nextStatus] < currentOrder) {
    return "Tracking updates cannot move the shipment backwards.";
  }
  if (input.currentStatus === input.nextStatus) {
    return "This tracking milestone has already been recorded.";
  }
  return null;
}
