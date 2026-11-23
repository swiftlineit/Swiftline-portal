import { Router } from "express";
import { exportAdminPrepaidLedger, getAdminPrepaidLedger } from "../controllers/adminPrepaid.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const adminPrepaidRouter = Router();

adminPrepaidRouter.use(attachUser, requireRole("admin", "finance", "operations"));
adminPrepaidRouter.get("/:businessAccountId/ledger", getAdminPrepaidLedger);
adminPrepaidRouter.get("/:businessAccountId/ledger/export", exportAdminPrepaidLedger);
