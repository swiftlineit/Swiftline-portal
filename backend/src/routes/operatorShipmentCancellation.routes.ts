import { Router } from "express";
import {
  approveOperatorShipmentCancellation,
  getOperatorCancellationCreditNotePdf,
  getOperatorCancellationFeeInvoicePdf,
  getOperatorShipmentCancellation,
  listOperatorShipmentCancellations,
  rejectOperatorShipmentCancellation,
  requestOperatorShipmentCancellation
} from "../controllers/operatorShipmentCancellation.controller.js";
import { requireOperatorRole } from "../middleware/operatorContext.middleware.js";

export const operatorShipmentCancellationRouter = Router();

operatorShipmentCancellationRouter.get(
  "/shipments/:draftId/cancellation",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  getOperatorShipmentCancellation
);
operatorShipmentCancellationRouter.post(
  "/shipments/:draftId/cancellation",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "CLIENT"),
  requestOperatorShipmentCancellation
);
operatorShipmentCancellationRouter.get(
  "/cancellations",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"),
  listOperatorShipmentCancellations
);
operatorShipmentCancellationRouter.post(
  "/cancellations/:id/approve",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"),
  approveOperatorShipmentCancellation
);
operatorShipmentCancellationRouter.post(
  "/cancellations/:id/reject",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"),
  rejectOperatorShipmentCancellation
);
operatorShipmentCancellationRouter.get(
  "/shipment-cancellations/:id/credit-note/pdf",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  getOperatorCancellationCreditNotePdf
);
operatorShipmentCancellationRouter.get(
  "/shipment-cancellations/:id/fee-invoice/pdf",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  getOperatorCancellationFeeInvoicePdf
);
