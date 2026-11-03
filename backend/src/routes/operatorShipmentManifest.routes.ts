import { Router, type RequestHandler } from "express";
import {
  createAdminBulkShipmentManifest,
  createAdminCombinedShipmentManifest,
  createAdminShipmentManifest,
  createClientBulkShipmentManifest,
  createClientShipmentManifest,
  deleteAdminBulkShipmentManifests,
  deleteAdminShipmentManifest,
  downloadAdminShipmentManifest,
  downloadAdminShipmentManifestExcel,
  downloadAdminShipmentManifestPdf,
  downloadClientShipmentManifest,
  downloadClientShipmentManifestExcel,
  downloadClientShipmentManifestPdf,
  getAdminShipmentManifestContext,
  getClientShipmentManifestContext,
  listAdminShipmentManifests,
  listClientShipmentManifests
} from "../controllers/shipmentManifest.controller.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import type { TenantMembershipRole } from "../models/tenantMembership.model.js";
import {
  operatorManifestActionAllowed,
  type OperatorManifestAction,
  requireOperatorManifestAccess,
  requireOperatorManifestBulkDeleteAccess,
  requireOperatorManifestDraftAccess,
  requireOperatorManifestDraftBranches
} from "../middleware/operatorShipmentManifestAccess.middleware.js";

export const operatorShipmentManifestRouter = Router({ mergeParams: true });

function dispatchManifestRoleHandlers(
  action: OperatorManifestAction,
  handlers: Partial<Record<TenantMembershipRole, RequestHandler>>
): RequestHandler {
  return (request, response, next) => {
    const context = getOperatorContext(request);
    if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!operatorManifestActionAllowed(context.role, action)) {
      return response.status(403).json({ success: false, message: "Forbidden" });
    }
    const handler = handlers[context.role];
    if (!handler) return response.status(403).json({ success: false, message: "Forbidden" });
    return handler(request, response, next);
  };
}

function withGuards(handler: RequestHandler, ...guards: RequestHandler[]): RequestHandler {
  return (request, response, next) => {
    let index = 0;
    const run = () => {
      const guard = guards[index++];
      if (!guard) return handler(request, response, next);
      return guard(request, response, (error?: unknown) => error ? next(error) : run());
    };
    return run();
  };
}

operatorShipmentManifestRouter.get("/", dispatchManifestRoleHandlers("read", {
  OPERATOR_ADMIN: listAdminShipmentManifests,
  OPERATIONS: listAdminShipmentManifests,
  FINANCE: listAdminShipmentManifests,
  CLIENT: listClientShipmentManifests
}));

operatorShipmentManifestRouter.get("/drafts/:draftId/context", dispatchManifestRoleHandlers("read", {
  OPERATOR_ADMIN: withGuards(getAdminShipmentManifestContext, requireOperatorManifestDraftAccess),
  OPERATIONS: withGuards(getAdminShipmentManifestContext, requireOperatorManifestDraftAccess),
  CLIENT: getClientShipmentManifestContext
}));

operatorShipmentManifestRouter.post("/", dispatchManifestRoleHandlers("createAccount", {
  OPERATOR_ADMIN: withGuards(createAdminShipmentManifest, requireOperatorManifestDraftBranches),
  OPERATIONS: withGuards(createAdminShipmentManifest, requireOperatorManifestDraftBranches),
  CLIENT: createClientShipmentManifest
}));

operatorShipmentManifestRouter.post("/bulk", dispatchManifestRoleHandlers("createAccount", {
  OPERATOR_ADMIN: withGuards(createAdminBulkShipmentManifest, requireOperatorManifestDraftBranches),
  OPERATIONS: withGuards(createAdminBulkShipmentManifest, requireOperatorManifestDraftBranches),
  CLIENT: createClientBulkShipmentManifest
}));

operatorShipmentManifestRouter.post("/combined", dispatchManifestRoleHandlers("createCombined", {
  OPERATOR_ADMIN: withGuards(createAdminCombinedShipmentManifest, requireOperatorManifestDraftBranches),
  OPERATIONS: withGuards(createAdminCombinedShipmentManifest, requireOperatorManifestDraftBranches)
}));

operatorShipmentManifestRouter.post("/bulk-delete", dispatchManifestRoleHandlers("delete", {
  OPERATOR_ADMIN: withGuards(deleteAdminBulkShipmentManifests, requireOperatorManifestBulkDeleteAccess),
  OPERATIONS: withGuards(deleteAdminBulkShipmentManifests, requireOperatorManifestBulkDeleteAccess)
}));

operatorShipmentManifestRouter.get("/:manifestId/download", dispatchManifestRoleHandlers("read", {
  OPERATOR_ADMIN: withGuards(downloadAdminShipmentManifest, requireOperatorManifestAccess),
  OPERATIONS: withGuards(downloadAdminShipmentManifest, requireOperatorManifestAccess),
  FINANCE: withGuards(downloadAdminShipmentManifest, requireOperatorManifestAccess),
  CLIENT: downloadClientShipmentManifest
}));

operatorShipmentManifestRouter.get("/:manifestId/pdf", dispatchManifestRoleHandlers("read", {
  OPERATOR_ADMIN: withGuards(downloadAdminShipmentManifestPdf, requireOperatorManifestAccess),
  OPERATIONS: withGuards(downloadAdminShipmentManifestPdf, requireOperatorManifestAccess),
  FINANCE: withGuards(downloadAdminShipmentManifestPdf, requireOperatorManifestAccess),
  CLIENT: downloadClientShipmentManifestPdf
}));

operatorShipmentManifestRouter.get("/:manifestId/xlsx", dispatchManifestRoleHandlers("read", {
  OPERATOR_ADMIN: withGuards(downloadAdminShipmentManifestExcel, requireOperatorManifestAccess),
  OPERATIONS: withGuards(downloadAdminShipmentManifestExcel, requireOperatorManifestAccess),
  FINANCE: withGuards(downloadAdminShipmentManifestExcel, requireOperatorManifestAccess),
  CLIENT: downloadClientShipmentManifestExcel
}));

operatorShipmentManifestRouter.delete("/:manifestId", dispatchManifestRoleHandlers("delete", {
  OPERATOR_ADMIN: withGuards(deleteAdminShipmentManifest, requireOperatorManifestAccess),
  OPERATIONS: withGuards(deleteAdminShipmentManifest, requireOperatorManifestAccess)
}));
