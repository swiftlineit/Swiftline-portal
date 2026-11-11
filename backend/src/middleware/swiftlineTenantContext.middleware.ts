import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { getTenantContext, runWithTenantContext } from "../services/tenantScope.service.js";
import { getSwiftlineTenantId } from "../services/swiftlineTenant.service.js";

/** Establishes the legacy API's explicit Swiftline boundary before data routes run. */
export async function establishSwiftlineTenantContext(
  _request: Request,
  response: Response,
  next: NextFunction
) {
  const current = getTenantContext();
  if (current) {
    if (current.kind === "SWIFTLINE") return next();
    return response.status(403).json({ success: false, message: "This endpoint is available only in the Swiftline workspace." });
  }
  // Existing integration tests use isolated databases without a seeded root
  // tenant; production and development requests must always resolve explicitly.
  if (env.NODE_ENV === "test") return next();

  try {
    const tenantId = await getSwiftlineTenantId();
    return runWithTenantContext({ tenantId, kind: "SWIFTLINE" }, next);
  } catch (error) {
    return next(error);
  }
}
