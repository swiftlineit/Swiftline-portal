import { Router } from "express";
import {
  getAadhaarOcrFeature,
  updateAadhaarOcrFeature,
} from "../controllers/aadhaarOcrFeature.controller.js";
import { attachUser, requireAuthenticated, requireRole } from "../middleware/auth.middleware.js";

export const aadhaarOcrFeatureRouter = Router();

aadhaarOcrFeatureRouter.use(attachUser, requireAuthenticated);
aadhaarOcrFeatureRouter.get("/", requireRole("admin", "operations", "client"), getAadhaarOcrFeature);
aadhaarOcrFeatureRouter.patch("/", requireRole("admin"), updateAadhaarOcrFeature);
