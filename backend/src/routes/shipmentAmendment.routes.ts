import { Router } from "express";
import {
  approveShipmentAmendment,
  createShipmentAmendmentDirectPayment,
  getPendingShipmentAmendment,
  listShipmentAmendments,
  rejectShipmentAmendment,
  verifyShipmentAmendmentDirectPayment
} from "../controllers/shipmentAmendment.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const shipmentAmendmentRouter = Router();

shipmentAmendmentRouter.use(attachUser);
shipmentAmendmentRouter.use(requireRole("admin", "operations"));

shipmentAmendmentRouter.get("/", listShipmentAmendments);
shipmentAmendmentRouter.get("/draft/:draftId/pending", (request, response) => getPendingShipmentAmendment(request, response, "staff"));
shipmentAmendmentRouter.post("/:id/direct-payment", createShipmentAmendmentDirectPayment);
shipmentAmendmentRouter.post("/:id/direct-payment/verify", verifyShipmentAmendmentDirectPayment);
shipmentAmendmentRouter.post("/:id/approve", approveShipmentAmendment);
shipmentAmendmentRouter.post("/:id/reject", rejectShipmentAmendment);
