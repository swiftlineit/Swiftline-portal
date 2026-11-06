import { Router } from "express";
import {
  createIndividualShipmentDraftHandler,
  createManualShipmentDraft,
  deleteShipmentDraftHandler,
  deleteShipmentDraftsHandler,
  getShipmentDraft,
  getShipmentDraftRateCardContext,
  getShipmentDraftCostEstimate,
  listEditableShipmentDrafts,
  rebookShipmentDraftHandler,
  restoreShipmentDraftHandler,
  updateShipmentDraft,
  validateShipmentDraft
} from "../controllers/shipmentDraft.controller.js";
import { createShipment } from "../controllers/dpdShipment.controller.js";
import {
  createAdminShipmentAmendment,
  previewShipmentAmendment
} from "../controllers/shipmentAmendment.controller.js";
import {
  deleteShipmentKycDocument,
  deleteShipmentParcelKycDocument,
  downloadShipmentKycDocument,
  downloadShipmentParcelKycDocument,
  ocrShipmentDraftAadhaar,
  uploadShipmentKycDocument,
  uploadShipmentParcelKycDocument
} from "../controllers/shipmentKyc.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";
import { aadhaarOcrUpload } from "../middleware/aadhaarOcrUpload.middleware.js";
import { shipmentKycUpload } from "../middleware/shipmentKycUpload.middleware.js";

export const shipmentDraftRouter = Router();

shipmentDraftRouter.use(attachUser);
// Delivery may open a shipment to see what it is carrying, so the router-wide
// floor admits it. Everything that edits a draft, books it, or reads consignor
// KYC re-checks with `requireOperations` below.
shipmentDraftRouter.use(requireRole("admin", "operations", "delivery"));

const requireOperations = requireRole("admin", "operations");

shipmentDraftRouter.post("/manual", requireOperations, createManualShipmentDraft);
// Walk-in counter booking. Same guard as the manual draft above: admin and
// operations book on the customer's behalf; individuals have no portal login.
shipmentDraftRouter.post("/individual", requireOperations, createIndividualShipmentDraftHandler);
// Collection route first: it is answered before the "/:id" guard below, which
// would otherwise read "editable" as a draft id.
shipmentDraftRouter.get("/editable", requireOperations, listEditableShipmentDrafts);
shipmentDraftRouter.post("/bulk-delete", requireOperations, deleteShipmentDraftsHandler);
shipmentDraftRouter.get("/:id", getShipmentDraft);
// Only an unbooked draft can be deleted, and deletion is soft- see
// shipmentDraftDeletion.service.ts. Restore backs the undo on the delete toast.
shipmentDraftRouter.delete("/:id", requireOperations, deleteShipmentDraftHandler);
shipmentDraftRouter.post("/:id/restore", requireOperations, restoreShipmentDraftHandler);
shipmentDraftRouter.get("/:id/rate-card-context", requireOperations, getShipmentDraftRateCardContext);
// POST because the booking form prices the values it currently holds, which are
// sent in the body. Nothing is written.
shipmentDraftRouter.post("/:id/cost-estimate", requireOperations, getShipmentDraftCostEstimate);
shipmentDraftRouter.patch("/:id", requireOperations, updateShipmentDraft);
shipmentDraftRouter.post("/:id/amendments/preview", requireOperations, previewShipmentAmendment);
shipmentDraftRouter.post("/:id/amendments", requireOperations, createAdminShipmentAmendment);
shipmentDraftRouter.post("/:id/aadhaar-ocr", requireOperations, aadhaarOcrUpload, ocrShipmentDraftAadhaar);
shipmentDraftRouter.post("/:id/kyc-documents/:type", requireOperations, shipmentKycUpload, uploadShipmentKycDocument);
shipmentDraftRouter.delete("/:id/kyc-documents/:type", requireOperations, deleteShipmentKycDocument);
shipmentDraftRouter.get("/:id/kyc-documents/:type", requireOperations, downloadShipmentKycDocument);
shipmentDraftRouter.post("/:id/parcels/:sequence/kyc-documents/:type", requireOperations, shipmentKycUpload, uploadShipmentParcelKycDocument);
shipmentDraftRouter.delete("/:id/parcels/:sequence/kyc-documents/:type", requireOperations, deleteShipmentParcelKycDocument);
shipmentDraftRouter.get("/:id/parcels/:sequence/kyc-documents/:type", requireOperations, downloadShipmentParcelKycDocument);
shipmentDraftRouter.post("/:id/validate", requireOperations, validateShipmentDraft);
shipmentDraftRouter.post("/:id/rebook", requireOperations, rebookShipmentDraftHandler);
shipmentDraftRouter.post("/:id/create-shipment", requireOperations, createShipment);
