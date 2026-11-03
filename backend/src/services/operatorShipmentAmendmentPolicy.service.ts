import type { TenantMembershipRole } from "../models/tenantMembership.model.js";

export type OperatorAmendmentAction = "read" | "request" | "review";

export const operatorAmendmentBlockedTrackingStatuses = [
  "PARCEL_COLLECTED",
  "IN_TRANSIT",
  "DESTINATION_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "LOST",
  "DAMAGED"
] as const;

export function operatorAmendmentActionAllowed(
  role: TenantMembershipRole,
  action: OperatorAmendmentAction
): boolean {
  if (action === "read") return true;
  if (action === "request") return role === "OPERATOR_ADMIN" || role === "OPERATIONS" || role === "CLIENT";
  return role === "OPERATOR_ADMIN" || role === "OPERATIONS";
}

export function operatorAmendmentBranchAllowed(
  context: Pick<{ role: TenantMembershipRole; assignedBranches: readonly unknown[] }, "role" | "assignedBranches">,
  branchId: unknown
): boolean {
  if (context.role === "OPERATOR_ADMIN") return true;
  return context.assignedBranches.some((assignedBranch) => String(assignedBranch) === String(branchId));
}

export function getOperatorShipmentAmendmentEligibility(input: {
  booked: boolean;
  latestTrackingStatus?: string | null;
  hasCancellationRequest: boolean;
  hasCompletedCancellation: boolean;
  hasPendingAmendment: boolean;
}) {
  if (!input.booked) {
    return { allowed: false, message: "Only booked shipments can be amended." };
  }
  if (input.hasCompletedCancellation) {
    return { allowed: false, message: "This shipment has been cancelled and can no longer be amended." };
  }
  if (input.hasCancellationRequest) {
    return { allowed: false, message: "Resolve the pending cancellation request before requesting an amendment." };
  }
  if (input.latestTrackingStatus && operatorAmendmentBlockedTrackingStatuses.includes(
    input.latestTrackingStatus as typeof operatorAmendmentBlockedTrackingStatuses[number]
  )) {
    return { allowed: false, message: "Shipment amendments are blocked after the operator records parcel collection." };
  }
  if (input.hasPendingAmendment) {
    return { allowed: false, message: "Resolve the pending amendment request before submitting another." };
  }
  return { allowed: true, message: "" };
}
