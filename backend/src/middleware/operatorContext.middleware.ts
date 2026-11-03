import type { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import { TenantMembership, type TenantMembershipRole } from "../models/tenantMembership.model.js";
import { resolveTenantSlug } from "../services/tenantRegistry.service.js";
import { activeOperatorSupportSessionFilter } from "../services/operatorSupportSession.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

export type OperatorAccessMode = "MEMBER" | "PLATFORM_SUPPORT";

export interface OperatorContext {
  tenantId: mongoose.Types.ObjectId;
  slug: string;
  role: TenantMembershipRole;
  assignedBranches: mongoose.Types.ObjectId[];
  accessMode: OperatorAccessMode;
  supportSessionId?: mongoose.Types.ObjectId;
  supportExpiresAt?: Date;
}

export function getOperatorContext(request: Request): OperatorContext | null {
  return (request as Request & { operatorContext?: OperatorContext }).operatorContext ?? null;
}

/** Re-enters the verified operator scope across callback-based middleware such as multipart uploads. */
export function withOperatorTenantContext(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    const operatorContext = getOperatorContext(request);
    if (!operatorContext) return response.status(401).json({ success: false, message: "Unauthorized" });

    const tenantContext = {
      tenantId: operatorContext.tenantId,
      kind: "OPERATOR" as const,
      readOnly: operatorContext.accessMode === "PLATFORM_SUPPORT",
      ...(operatorContext.supportSessionId ? { supportSessionId: operatorContext.supportSessionId } : {})
    };
    const nextInTenantContext: NextFunction = (error?: unknown) =>
      runWithTenantContext(tenantContext, () => next(error));

    return runWithTenantContext(tenantContext, () => handler(request, response, nextInTenantContext));
  };
}

/** Restores tenant scope after callback-based uploads before running the handler. */
export function withOperatorTenantUpload(upload: RequestHandler, handler: RequestHandler): RequestHandler {
  const scopedUpload = withOperatorTenantContext(upload);
  const scopedHandler = withOperatorTenantContext(handler);

  return (request, response, next) => scopedUpload(request, response, (error?: unknown) => {
    if (error) return next(error);
    return scopedHandler(request, response, next);
  });
}

/** Only for operator routes. Never grants access from the URL slug alone. */
export async function requireOperatorContext(request: Request, response: Response, next: NextFunction) {
  const user = (request as Request & { user?: { _id?: unknown; role?: string } }).user;
  if (!user?._id) return response.status(401).json({ success: false, message: "Unauthorized" });
  const supportToken = request.headers["x-operator-support-token"];
  const isPlatformAdmin = user.role === "admin";
  if (isPlatformAdmin && typeof supportToken !== "string") {
    return response.status(403).json({ success: false, message: "A recorded operator support session is required." });
  }
  if (supportToken !== undefined && (!isPlatformAdmin || typeof supportToken !== "string" || !/^[a-f0-9]{64}$/.test(supportToken))) {
    return response.status(403).json({ success: false, message: "Invalid operator support session." });
  }
  if (!isPlatformAdmin && user.role !== "client") {
    return response.status(403).json({ success: false, message: "Forbidden" });
  }

  const slug = typeof request.params.operatorSlug === "string" ? request.params.operatorSlug : "";
  const resolved = await resolveTenantSlug(slug);
  if (!resolved || resolved.tenant.kind !== "OPERATOR") {
    return response.status(404).json({ success: false, message: "Operator not found." });
  }
  const userId = String(user._id);
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }
  const actorId = new mongoose.Types.ObjectId(userId);
  const supportSession = isPlatformAdmin
    ? await OperatorSupportSession.findOne({
      ...activeOperatorSupportSessionFilter({
        token: supportToken as string,
        tenantId: resolved.tenant._id,
        actorUserId: actorId
      })
    }).lean().exec()
    : null;
  if (isPlatformAdmin && (!supportSession || resolved.tenant.status !== "ACTIVE")) {
    return response.status(403).json({ success: false, message: "The operator support session is invalid or expired." });
  }
  const membership = isPlatformAdmin ? null : await TenantMembership.findOne({
    tenantId: resolved.tenant._id,
    userId: actorId,
    status: "ACTIVE"
  }).lean().exec();
  if (!isPlatformAdmin && !membership) return response.status(404).json({ success: false, message: "Operator not found." });
  // Reveal the new slug only after verifying access to this operator.
  if (resolved.redirect) {
    return response.status(409).json({ success: false, message: "Operator URL has changed.", canonicalSlug: resolved.canonicalSlug });
  }

  (request as Request & { operatorContext?: OperatorContext }).operatorContext = {
    tenantId: resolved.tenant._id,
    slug: resolved.canonicalSlug,
    role: supportSession ? "OPERATOR_ADMIN" : membership!.role,
    assignedBranches: supportSession ? [] : membership!.assignedBranches,
    accessMode: supportSession ? "PLATFORM_SUPPORT" : "MEMBER",
    ...(supportSession ? {
      supportSessionId: supportSession._id,
      supportExpiresAt: supportSession.expiresAt
    } : {})
  };
  return runWithTenantContext({
    tenantId: resolved.tenant._id,
    kind: "OPERATOR",
    readOnly: supportSession !== null,
    ...(supportSession ? { supportSessionId: supportSession._id } : {})
  }, next);
}

/** Platform support may read operator routes, but cannot submit any route mutation. */
export function requireOperatorSupportReadOnly(request: Request, response: Response, next: NextFunction) {
  const context = getOperatorContext(request);
  if (context?.accessMode === "PLATFORM_SUPPORT" && request.method !== "GET" && request.method !== "HEAD") {
    return response.status(403).json({ success: false, message: "Operator support access is read-only." });
  }
  return next();
}

/** Records each operator API resource opened during an audited support session. */
export async function auditOperatorSupportAccess(request: Request, _response: Response, next: NextFunction) {
  const context = getOperatorContext(request);
  if (context?.accessMode !== "PLATFORM_SUPPORT" || !context.supportSessionId) return next();
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  if (!user?._id) return next(new Error("The support actor is missing."));
  const resource = request.path.split("/").filter(Boolean)[0] || "overview";
  try {
    await AuditLog.create({
      action: "PLATFORM_OPERATOR_SUPPORT_DATA_VIEWED",
      entityType: "TENANT",
      entityId: context.tenantId,
      performedBy: new mongoose.Types.ObjectId(String(user._id)),
      performedAt: new Date(),
      metadata: { supportSessionId: String(context.supportSessionId), resource, method: request.method }
    });
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireOperatorRole(...roles: TenantMembershipRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const context = getOperatorContext(request);
    if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!roles.includes(context.role)) return response.status(403).json({ success: false, message: "Forbidden" });
    return next();
  };
}
