import { Router } from "express";
import {
  approveCancellationRequest,
  cancelAdminShipmentDirectly,
  getAdminCancellationCreditNotePdf,
  getAdminCancellationFeeInvoicePdf,
  getAdminShipmentCancellation,
  getAdminShipmentCancellationPreview,
  listShipmentCancellations,
  rejectCancellationRequest,
  requestAdminShipmentCancellation
} from "../controllers/shipmentCancellation.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const shipmentCancellationRouter = Router();

shipmentCancellationRouter.use(attachUser);
shipmentCancellationRouter.use(requireRole("admin", "operations"));

shipmentCancellationRouter.get("/", listShipmentCancellations);
shipmentCancellationRouter.get("/drafts/:draftId", getAdminShipmentCancellation);
shipmentCancellationRouter.get("/drafts/:draftId/direct-preview", requireRole("admin"), getAdminShipmentCancellationPreview);
shipmentCancellationRouter.post("/drafts/:draftId", requestAdminShipmentCancellation);
shipmentCancellationRouter.post("/drafts/:draftId/direct", requireRole("admin"), cancelAdminShipmentDirectly);
shipmentCancellationRouter.post("/:id/approve", approveCancellationRequest);
shipmentCancellationRouter.post("/:id/reject", rejectCancellationRequest);
shipmentCancellationRouter.get("/:id/credit-note/pdf", getAdminCancellationCreditNotePdf);
shipmentCancellationRouter.get("/:id/fee-invoice/pdf", getAdminCancellationFeeInvoicePdf);
