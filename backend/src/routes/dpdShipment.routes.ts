import { Router } from "express";
import {
  createDpdLabelAccessUrl,
  correctDpdShipmentGateway,
  downloadDpdLabel,
  downloadDpdLabelWithToken,
  generateExistingDpdLabel,
  getAdminShipmentDetails,
  getDpdShipment,
  holdDpdShipment,
  listDpdShipmentAudit,
  listDpdShipments,
  reconcileDpdShipmentDocuments,
  releaseDpdShipment,
  refreshCarrierTracking,
  scanShipmentOperationsMilestone,
  resetDevelopmentShipmentBooking,
  updateDpdShipmentOperationalStatus,
  bulkUpdateDpdShipmentOperationalStatus
} from "../controllers/dpdShipment.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";
import { downloadShipmentInvoicePdf, getShipmentInvoice } from "../controllers/shipmentInvoice.controller.js";
import {
  createShipmentInvoiceRevisedDocument,
  deleteShipmentInvoiceRevisedDocument,
  downloadShipmentInvoiceRevisedDocumentPdf,
  getShipmentInvoiceRevisedDocument,
  listShipmentInvoiceRevisedDocuments,
  updateShipmentInvoiceRevisedDocument
} from "../controllers/shipmentInvoiceRevisedDocument.controller.js";
import {
  downloadCustomsInvoicePdf,
  downloadCustomsInvoiceWorkbook,
  getCustomsInvoice
} from "../controllers/customsInvoice.controller.js";
import {
  finalizeFinalShipmentCharge,
  getShipmentChargeVerification,
  previewFinalShipmentCharge
} from "../controllers/shipmentChargeVerification.controller.js";

export const dpdShipmentRouter = Router();

dpdShipmentRouter.get("/:id/label-file", downloadDpdLabelWithToken);

dpdShipmentRouter.use(attachUser);
// Three tiers share this router. The floor covers the read-only tracking views
// every internal role needs; operational actions and the money-side charge
// verification each re-check with a narrower guard below.
dpdShipmentRouter.use(requireRole("admin", "operations", "finance", "delivery"));

const requireOperations = requireRole("admin", "operations");
// Warehouse staff weigh and measure the parcel, so operations records the final
// charge alongside finance. Delivery stays out: it never holds the parcel before
// dispatch.
const requireChargeVerification = requireRole("admin", "operations", "finance");
// The GST invoice is a billing document, so delivery is left out of it. The
// customs invoice below stays on the floor: it declares the goods being carried.
const requireBilling = requireRole("admin", "operations", "finance");

dpdShipmentRouter.get("/", listDpdShipments);
dpdShipmentRouter.post("/bulk-status", requireOperations, bulkUpdateDpdShipmentOperationalStatus);
dpdShipmentRouter.post("/operations-scan", requireOperations, scanShipmentOperationsMilestone);
dpdShipmentRouter.get("/drafts/:draftId/invoice", requireBilling, getShipmentInvoice);
dpdShipmentRouter.get("/drafts/:draftId/invoice/pdf", requireBilling, downloadShipmentInvoicePdf);
// Document-only revised copies of the GST invoice. Reads stay on the billing
// guard; creating, editing and deleting need admin or operations. None of
// these touch the real invoice or any money record.
dpdShipmentRouter.get("/drafts/:draftId/invoice/revised", requireBilling, listShipmentInvoiceRevisedDocuments);
dpdShipmentRouter.post("/drafts/:draftId/invoice/revised", requireOperations, createShipmentInvoiceRevisedDocument);
dpdShipmentRouter.get("/drafts/:draftId/invoice/revised/:copyId", requireBilling, getShipmentInvoiceRevisedDocument);
dpdShipmentRouter.patch("/drafts/:draftId/invoice/revised/:copyId", requireOperations, updateShipmentInvoiceRevisedDocument);
dpdShipmentRouter.delete("/drafts/:draftId/invoice/revised/:copyId", requireOperations, deleteShipmentInvoiceRevisedDocument);
dpdShipmentRouter.get("/drafts/:draftId/invoice/revised/:copyId/pdf", requireBilling, downloadShipmentInvoiceRevisedDocumentPdf);
// Customs ("shipment") invoice: the goods declaration, separate from the GST invoice above.
dpdShipmentRouter.get("/drafts/:draftId/shipment-invoice", getCustomsInvoice);
dpdShipmentRouter.get("/drafts/:draftId/shipment-invoice/pdf", downloadCustomsInvoicePdf);
dpdShipmentRouter.get("/drafts/:draftId/shipment-invoice/xlsx", downloadCustomsInvoiceWorkbook);
dpdShipmentRouter.get("/drafts/:draftId/audit", requireOperations, listDpdShipmentAudit);
dpdShipmentRouter.post("/drafts/:draftId/reset-development-booking", requireOperations, resetDevelopmentShipmentBooking);
dpdShipmentRouter.get("/drafts/:draftId/details", getAdminShipmentDetails);
dpdShipmentRouter.get("/:id", getDpdShipment);
dpdShipmentRouter.get("/:id/charge-verification", requireChargeVerification, getShipmentChargeVerification);
dpdShipmentRouter.post("/:id/charge-verification/preview", requireChargeVerification, previewFinalShipmentCharge);
dpdShipmentRouter.post("/:id/charge-verification/finalize", requireChargeVerification, finalizeFinalShipmentCharge);
dpdShipmentRouter.post("/:id/hold", requireOperations, holdDpdShipment);
dpdShipmentRouter.post("/:id/release", requireOperations, releaseDpdShipment);
dpdShipmentRouter.post("/:id/reconcile-documents", requireOperations, reconcileDpdShipmentDocuments);
dpdShipmentRouter.post("/:id/refresh-carrier-tracking", requireOperations, refreshCarrierTracking);
dpdShipmentRouter.post("/:id/generate-label", requireOperations, generateExistingDpdLabel);
dpdShipmentRouter.post("/:id/status-events", requireOperations, updateDpdShipmentOperationalStatus);
dpdShipmentRouter.patch("/:id/gateway", requireOperations, correctDpdShipmentGateway);
dpdShipmentRouter.get("/:id/label-access", requireOperations, createDpdLabelAccessUrl);
dpdShipmentRouter.get("/:id/label", requireOperations, downloadDpdLabel);
