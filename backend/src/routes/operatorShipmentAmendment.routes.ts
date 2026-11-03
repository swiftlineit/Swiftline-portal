import { Router } from "express";
import {
  approveOperatorShipmentAmendment,
  createOperatorShipmentAmendment,
  getOperatorShipmentAmendments,
  listOperatorShipmentAmendments,
  previewOperatorShipmentAmendment,
  rejectOperatorShipmentAmendment
} from "../controllers/operatorShipmentAmendment.controller.js";
import { requireOperatorRole } from "../middleware/operatorContext.middleware.js";

export const operatorShipmentAmendmentRouter = Router();

operatorShipmentAmendmentRouter.get(
  "/shipments/:id/amendments",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  getOperatorShipmentAmendments
);
operatorShipmentAmendmentRouter.post(
  "/shipments/:id/amendments/preview",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "CLIENT"),
  previewOperatorShipmentAmendment
);
operatorShipmentAmendmentRouter.post(
  "/shipments/:id/amendments",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "CLIENT"),
  createOperatorShipmentAmendment
);
operatorShipmentAmendmentRouter.get(
  "/shipment-amendments",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"),
  listOperatorShipmentAmendments
);
operatorShipmentAmendmentRouter.post(
  "/shipment-amendments/:id/approve",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  approveOperatorShipmentAmendment
);
operatorShipmentAmendmentRouter.post(
  "/shipment-amendments/:id/reject",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  rejectOperatorShipmentAmendment
);
