import mongoose from "mongoose";
import type { QueryFilter } from "mongoose";
import type { IBusinessAccount } from "../models/businessAccount.model.js";
import type { IBranch } from "../models/branch.model.js";
import type { OperatorContext } from "../middleware/operatorContext.middleware.js";

type OperatorDirectoryRole = OperatorContext["role"];

function ids(values: readonly unknown[]): mongoose.Types.ObjectId[] {
  return values
    .map((value) => String(value))
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));
}

/**
 * Builds the record-level access predicate for an operator's account directory.
 * An empty branch/account assignment intentionally resolves to no records.
 */
export function buildOperatorAccountAccessFilter(input: {
  role: OperatorDirectoryRole;
  assignedBranches: readonly unknown[];
  clientAccountIds?: readonly unknown[];
}): QueryFilter<IBusinessAccount> {
  if (input.role === "OPERATOR_ADMIN") return {};
  if (input.role === "CLIENT") {
    return { _id: { $in: ids(input.clientAccountIds ?? []) } };
  }
  return { assignedBranch: { $in: ids(input.assignedBranches) } };
}

/** Branch directory access follows the same tenant membership boundary. */
export function buildOperatorBranchAccessFilter(input: {
  role: OperatorDirectoryRole;
  assignedBranches: readonly unknown[];
  clientBranchIds?: readonly unknown[];
}): QueryFilter<unknown> {
  if (input.role === "OPERATOR_ADMIN") return {};
  if (input.role === "CLIENT") {
    return { _id: { $in: ids(input.clientBranchIds ?? []) } };
  }
  return { _id: { $in: ids(input.assignedBranches) } };
}

/** Pins branch detail reads to both the active tenant and the caller's branch access. */
export function buildOperatorBranchRecordAccessFilter(input: {
  tenantId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  role: OperatorDirectoryRole;
  assignedBranches: readonly unknown[];
}): QueryFilter<IBranch> {
  return {
    $and: [
      { tenantId: input.tenantId, _id: input.branchId },
      buildOperatorBranchAccessFilter({ role: input.role, assignedBranches: input.assignedBranches })
    ]
  };
}
