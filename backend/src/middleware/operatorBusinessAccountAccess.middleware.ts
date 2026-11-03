import type { NextFunction, Request, Response } from "express";
import type { OperatorContext } from "./operatorContext.middleware.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { getOperatorContext } from "./operatorContext.middleware.js";

export function buildOperatorBusinessAccountFilter(
  context: Pick<OperatorContext, "tenantId" | "role" | "assignedBranches">,
  accountId: string
): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {
    tenantId: context.tenantId,
    accountId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  };
  if (context.role !== "OPERATOR_ADMIN") {
    if (!context.assignedBranches.length) return null;
    filter.assignedBranch = { $in: context.assignedBranches };
  }
  return filter;
}

/** Hides accounts outside both the operator tenant and the user's branch scope. */
export async function requireOperatorBusinessAccountAccess(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const accountIdParam = request.params.accountId;
  const accountId = typeof accountIdParam === "string" ? accountIdParam.trim() : "";
  if (!context || !accountId) {
    return response.status(404).json({ success: false, message: "Business account not found." });
  }

  const filter = buildOperatorBusinessAccountFilter(context, accountId);
  if (!filter) return response.status(404).json({ success: false, message: "Business account not found." });

  const accountExists = await BusinessAccount.exists(filter).exec();
  if (!accountExists) {
    return response.status(404).json({ success: false, message: "Business account not found." });
  }
  return next();
}
