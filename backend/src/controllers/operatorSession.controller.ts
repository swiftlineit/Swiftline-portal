import type { Request, Response } from "express";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { Tenant } from "../models/tenant.model.js";

export async function getOperatorSession(request: Request, response: Response) {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });

  const tenant = await Tenant.findOne({ _id: context.tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("companyName")
    .lean()
    .exec();
  if (!tenant) return response.status(404).json({ success: false, message: "Operator not found." });

  return response.json({
    success: true,
    operator: { id: String(context.tenantId), slug: context.slug, companyName: tenant.companyName },
    membership: {
      role: context.role,
      assignedBranches: context.assignedBranches.map(String)
    },
    access: {
      mode: context.accessMode,
      readOnly: context.accessMode === "PLATFORM_SUPPORT",
      ...(context.supportExpiresAt ? { expiresAt: context.supportExpiresAt } : {})
    }
  });
}
