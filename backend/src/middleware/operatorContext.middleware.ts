import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { TenantMembership, type TenantMembershipRole } from "../models/tenantMembership.model.js";
import { resolveTenantSlug } from "../services/tenantRegistry.service.js";

export interface OperatorContext {
  tenantId: mongoose.Types.ObjectId;
  slug: string;
  role: TenantMembershipRole;
  assignedBranches: mongoose.Types.ObjectId[];
}

export function getOperatorContext(request: Request): OperatorContext | null {
  return (request as Request & { operatorContext?: OperatorContext }).operatorContext ?? null;
}

/** Only for operator routes. Never grants access from the URL slug alone. */
export async function requireOperatorContext(request: Request, response: Response, next: NextFunction) {
  const user = (request as Request & { user?: { _id?: unknown; role?: string } }).user;
  if (!user?._id) return response.status(401).json({ success: false, message: "Unauthorized" });
  // A global Swiftline staff role must never double as an operator role.
  if (user.role !== "client") return response.status(403).json({ success: false, message: "Forbidden" });

  const slug = typeof request.params.operatorSlug === "string" ? request.params.operatorSlug : "";
  const resolved = await resolveTenantSlug(slug);
  if (!resolved || resolved.tenant.kind !== "OPERATOR") {
    return response.status(404).json({ success: false, message: "Operator not found." });
  }
  const userId = String(user._id);
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }
  const membership = await TenantMembership.findOne({
    tenantId: resolved.tenant._id,
    userId: new mongoose.Types.ObjectId(userId),
    status: "ACTIVE"
  }).lean().exec();
  if (!membership) return response.status(404).json({ success: false, message: "Operator not found." });
  // Reveal the new slug only after verifying access to this operator.
  if (resolved.redirect) {
    return response.status(409).json({ success: false, message: "Operator URL has changed.", canonicalSlug: resolved.canonicalSlug });
  }

  (request as Request & { operatorContext?: OperatorContext }).operatorContext = {
    tenantId: resolved.tenant._id,
    slug: resolved.canonicalSlug,
    role: membership.role,
    assignedBranches: membership.assignedBranches
  };
  return next();
}

export function requireOperatorRole(...roles: TenantMembershipRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const context = getOperatorContext(request);
    if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!roles.includes(context.role)) return response.status(403).json({ success: false, message: "Forbidden" });
    return next();
  };
}
