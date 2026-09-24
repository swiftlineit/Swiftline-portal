import { Router } from "express";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";
import * as controller from "../controllers/operationsManifest.controller.js";
import * as scanSessionController from "../controllers/operationsScanSession.controller.js";
import {
  requireOperationsManifestBranch,
  requireRequestedOperationsBranch
} from "../middleware/operationsBranchAccess.middleware.js";
import { scannerFeedLimiter, scannerPairingLimiter, scannerScanLimiter } from "../middleware/rateLimit.middleware.js";

export const operationsManifestRouter = Router();
operationsManifestRouter.use(attachUser, requireRole("admin", "operations"));
operationsManifestRouter.post("/scan-sessions/pair", scannerPairingLimiter, scanSessionController.pairSession);
operationsManifestRouter.get("/scan-sessions/:sessionId/status", scannerFeedLimiter, scanSessionController.getSessionStatus);
operationsManifestRouter.get("/branches/options", controller.listBranchOptions);
operationsManifestRouter.get("/", controller.listManifests);
operationsManifestRouter.post("/", requireRequestedOperationsBranch, controller.createManifest);
operationsManifestRouter.use("/:manifestId", requireOperationsManifestBranch);
operationsManifestRouter.get("/:manifestId/scan-sessions/active", scannerFeedLimiter, scanSessionController.getActiveSession);
operationsManifestRouter.post("/:manifestId/scan-sessions", scannerPairingLimiter, scanSessionController.createSession);
// Kept for one backwards-compatible release; lifecycle traffic must never spend
// the strict explicit-pairing budget or produce false pairing-attempt toasts.
operationsManifestRouter.patch("/:manifestId/scan-sessions/:sessionId/bag", scannerFeedLimiter, scanSessionController.changeSessionBag);
operationsManifestRouter.delete("/:manifestId/scan-sessions/:sessionId", scannerFeedLimiter, scanSessionController.disconnectSession);
operationsManifestRouter.get("/:manifestId", controller.getManifest);
operationsManifestRouter.patch("/:manifestId", controller.updateManifest);
operationsManifestRouter.post("/:manifestId/bags", controller.createBag);
operationsManifestRouter.post("/:manifestId/scan", scannerScanLimiter, controller.scanParcel);
operationsManifestRouter.post("/:manifestId/consignments/:consignmentId/move", controller.moveConsignment);
operationsManifestRouter.put("/:manifestId/consignments/:consignmentId/parcel-disposition", controller.setParcelDisposition);
operationsManifestRouter.post("/:manifestId/scans/:scanId/remove", controller.removeScan);
operationsManifestRouter.post("/:manifestId/bags/close-all", controller.closeAllBags);
operationsManifestRouter.post("/:manifestId/bags/:bagId/close", controller.closeBag);
operationsManifestRouter.post("/:manifestId/bags/ready", controller.markBagReady);
operationsManifestRouter.post("/:manifestId/bags/:bagId/reopen", controller.reopenBag);
operationsManifestRouter.post("/:manifestId/bags/:bagId/cancel", controller.cancelBag);
operationsManifestRouter.post("/:manifestId/seal", controller.sealManifest);
operationsManifestRouter.post("/:manifestId/dispatch", controller.dispatchManifest);
operationsManifestRouter.post("/:manifestId/cancel", controller.cancelManifest);
operationsManifestRouter.get("/:manifestId/export.xlsx", controller.exportExcel);
operationsManifestRouter.get("/:manifestId/export.pdf", controller.exportPdf);
operationsManifestRouter.get("/:manifestId/export-edi.xlsx", controller.exportEdi);
operationsManifestRouter.get("/:manifestId/export-ops-edi.xls", controller.exportOpsEdi);
operationsManifestRouter.get("/:manifestId/export-uk.xlsx", controller.exportUk);
operationsManifestRouter.delete("/:manifestId", controller.deleteManifest);
