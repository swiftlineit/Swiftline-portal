import { Router } from "express";
import {
  createAdminBulkShipmentManifest,
  createAdminShipmentManifest,
  deleteAdminBulkShipmentManifests,
  deleteAdminShipmentManifest,
  downloadAdminShipmentManifest,
  downloadAdminShipmentManifestExcel,
  downloadAdminShipmentManifestPdf,
  getAdminShipmentManifestContext,
  listAdminShipmentManifests
} from "../controllers/shipmentManifest.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const shipmentManifestRouter = Router();

shipmentManifestRouter.use(attachUser);
shipmentManifestRouter.use(requireRole("admin", "operations"));
shipmentManifestRouter.get("/", listAdminShipmentManifests);
shipmentManifestRouter.get("/drafts/:draftId/context", getAdminShipmentManifestContext);
shipmentManifestRouter.post("/", createAdminShipmentManifest);
shipmentManifestRouter.post("/bulk", createAdminBulkShipmentManifest);
shipmentManifestRouter.post("/bulk-delete", deleteAdminBulkShipmentManifests);
shipmentManifestRouter.get("/:manifestId/download", downloadAdminShipmentManifest);
shipmentManifestRouter.get("/:manifestId/xlsx", downloadAdminShipmentManifestExcel);
shipmentManifestRouter.get("/:manifestId/pdf", downloadAdminShipmentManifestPdf);
shipmentManifestRouter.delete("/:manifestId", deleteAdminShipmentManifest);
