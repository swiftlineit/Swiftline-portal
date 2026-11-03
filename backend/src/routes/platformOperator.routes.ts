import { Router } from "express";
import {
  createOperatorDraft,
  activateOperatorPortal,
  createOperatorAdminInvitation,
  createOperatorAdminInvitationLink,
  listDraftOperators,
  updateOperatorSlug,
  updateOperatorStatus,
} from "../controllers/platformOperator.controller.js";
import { endOperatorSupportSession, startOperatorSupportSession } from "../controllers/operatorSupport.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const platformOperatorRouter = Router();

// Global admin is reserved for Swiftline platform staff. Operator administrators
// will have tenant membership, never this legacy global role.
platformOperatorRouter.use(attachUser, requireRole("admin"));
platformOperatorRouter.get("/", listDraftOperators);
platformOperatorRouter.post("/", createOperatorDraft);
platformOperatorRouter.post("/:tenantId/admin-invitations", createOperatorAdminInvitation);
platformOperatorRouter.post("/:tenantId/admin-invitations/:userId/link", createOperatorAdminInvitationLink);
platformOperatorRouter.post("/:tenantId/activate", activateOperatorPortal);
platformOperatorRouter.patch("/:tenantId/status", updateOperatorStatus);
platformOperatorRouter.patch("/:tenantId/slug", updateOperatorSlug);
platformOperatorRouter.post("/:tenantId/support-sessions", startOperatorSupportSession);
platformOperatorRouter.delete("/:tenantId/support-sessions/current", endOperatorSupportSession);
