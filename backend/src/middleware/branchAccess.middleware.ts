import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { getOperatorContext } from "./operatorContext.middleware.js";

type BranchScopedUser = {
  _id: mongoose.Types.ObjectId;
  role: string;
  assignedBranches?: mongoose.Types.ObjectId[];
};

function branchScopedUser(request: Request) {
  return (request as Request & { user?: BranchScopedUser }).user;
}

/** Admin is global; every other internal role is limited to its assignments. */
export function allowedBranchIds(request: Request): string[] | null {
  const operator = getOperatorContext(request);
  if (operator) {
    if (operator.role === "OPERATOR_ADMIN") return null;
    return operator.assignedBranches.map(String);
  }
  const user = branchScopedUser(request);
  if (!user) return [];
  if (user.role === "admin") return null;
  return (user.assignedBranches ?? []).map(String);
}

export function branchListScope(request: Request): Record<string, unknown> {
  const branchIds = allowedBranchIds(request);
  if (branchIds === null) return {};

  return {
    _id: {
      $in: branchIds
        .filter((branchId) => mongoose.Types.ObjectId.isValid(branchId))
        .map((branchId) => new mongoose.Types.ObjectId(branchId))
    }
  };
}

export function canAccessBranch(request: Request, branchId: unknown) {
  const branchIds = allowedBranchIds(request);
  return branchIds === null || branchIds.includes(String(branchId));
}

/**
 * Branch detail/report guard. A 404 prevents an assigned-branch user from using
 * the endpoint to discover another branch's identifiers.
 */
export function requireBranchAccess(request: Request, response: Response, next: NextFunction) {
  const branchId = String(request.params.branchId ?? "");
  if (!mongoose.Types.ObjectId.isValid(branchId) || !canAccessBranch(request, branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }
  return next();
}
