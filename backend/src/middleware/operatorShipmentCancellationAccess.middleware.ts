import type { TenantMembershipRole } from "../models/tenantMembership.model.js";

export type OperatorCancellationAction = "read" | "request" | "review";

export function operatorCancellationActionAllowed(
  role: TenantMembershipRole,
  action: OperatorCancellationAction
): boolean {
  if (action === "read") return true;
  if (action === "request") return role === "OPERATOR_ADMIN" || role === "OPERATIONS" || role === "CLIENT";
  return role === "OPERATOR_ADMIN" || role === "OPERATIONS" || role === "FINANCE";
}

export function operatorCancellationBranchAllowed(
  context: Pick<{ role: TenantMembershipRole; assignedBranches: readonly unknown[] }, "role" | "assignedBranches">,
  branchId: unknown
): boolean {
  if (context.role === "OPERATOR_ADMIN") return true;
  return context.assignedBranches.some((assignedBranch) => String(assignedBranch) === String(branchId));
}
