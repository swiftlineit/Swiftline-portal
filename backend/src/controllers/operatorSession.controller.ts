import type { Request, Response } from "express";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";

export function getOperatorSession(request: Request, response: Response) {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  return response.json({
    success: true,
    operator: { id: String(context.tenantId), slug: context.slug },
    membership: {
      role: context.role,
      assignedBranches: context.assignedBranches.map(String)
    }
  });
}
