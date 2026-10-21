import { Router } from "express";
import {
  createOperatorDraft,
  listDraftOperators,
  updateOperatorSlug
} from "../controllers/platformOperator.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const platformOperatorRouter = Router();

// Global admin is reserved for Swiftline platform staff. Operator administrators
// will have tenant membership, never this legacy global role.
platformOperatorRouter.use(attachUser, requireRole("admin"));
platformOperatorRouter.get("/", listDraftOperators);
platformOperatorRouter.post("/", createOperatorDraft);
platformOperatorRouter.patch("/:tenantId/slug", updateOperatorSlug);
