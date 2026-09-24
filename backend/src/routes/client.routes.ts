import { Router } from "express";
import {
  createClientShipmentAmendment,
  downloadClientCustomsInvoicePdf,
  downloadClientCustomsInvoiceWorkbook,
  downloadClientShipmentInvoicePdf,
  getClientCustomsInvoice,
  createClientShipment,

  createClientShipmentLabelAccess,
  createClientManualShipmentDraft,
  deleteClientShipmentDraft,
  deleteClientShipmentDrafts,
  deleteClientShipmentKycDocument,
  deleteClientShipmentParcelKycDocument,
  restoreClientShipmentDraft,
  downloadClientShipmentKycDocument,
  downloadClientShipmentParcelKycDocument,
  uploadClientShipmentKycDocument,
  uploadClientShipmentParcelKycDocument,
  getClientDashboard,
  listClientShipments,
  getClientShipmentDetails,
  trackClientShipment,
  getClientShipmentInvoice,
  getClientShipmentDraft,
  downloadClientShipmentInvoiceRevisedDocumentPdf,
  getClientShipmentInvoiceRevisedDocument,
  listClientShipmentInvoiceRevisedDocuments,  getClientShipmentDraftRateCardContext,
  getClientShipmentDraftCostEstimate,
  previewClientShipmentAmendment,
  createClientShipmentImportBatch,
  createClientShipmentImportDrafts,
  downloadClientShipmentImportTemplate,
  getClientShipmentImportBatch,
  updateClientShipmentDraft
} from "../controllers/client.controller.js";
import {
  createClientPrepaidTopUp,
  getClientPrepaidAccount,
  getClientPrepaidTopUp,
  listClientPrepaidTopUps,
  listClientPrepaidTransactions,
  verifyClientPrepaidTopUp
} from "../controllers/prepaid.controller.js";
import {
  autocompleteAddress,
  autocompleteConsignorAddress,
  confirmValidatedAddress,
  getConsignorPlaceAddress,
  getPlaceAddress,
  validateAddress
} from "../controllers/address.controller.js";
import {
  createClientBulkShipmentManifest,
  createClientShipmentManifest,
  downloadClientShipmentManifest,
  downloadClientShipmentManifestPdf,
  getClientShipmentManifestContext,
  listClientShipmentManifests
} from "../controllers/shipmentManifest.controller.js";
import { listClientBookedShipments } from "../controllers/shipmentListing.controller.js";
import {
  getClientOverview,
  listClientActions,
  listClientExceptions,
  searchClient,
  listClientShipmentDocuments,
  uploadClientShipmentDocument,
  downloadClientShipmentDocument
} from "../controllers/clientOverview.controller.js";
import { listClientCountryRateCards } from "../controllers/clientRateCard.controller.js";
import {
  downloadClientRateCardSharePdf,
  downloadClientRateCardShareWorkbook,
  getClientRateCardShare,
  listClientRateCardShares,
  markClientRateCardShareRead
} from "../controllers/rateCardShare.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";
import { shipmentImportUpload } from "../middleware/shipmentImportUpload.middleware.js";
import { shipmentKycUpload } from "../middleware/shipmentKycUpload.middleware.js";
import { shipmentSupportingDocumentUpload } from "../middleware/shipmentSupportingDocumentUpload.middleware.js";
import {
  acceptClientPaymentTerms, getClientCreditLimitIncrease, getClientCreditSummary, getClientPaymentTerms,
  requestClientCredit, requestClientCreditLimitIncrease
} from "../controllers/clientCredit.controller.js";
import {
  getClientCreditAgreement,
  getClientCreditAgreementPdf,
  listClientCreditAgreements
} from "../controllers/creditAgreement.controller.js";
import {
  closeClientBillingCycle,
  createClientOnlinePayment,
  downloadClientStatement,
  exportClientLedger,
  getClientLedger,
  getClientStatement,
  handleCreditBillingError,
  listClientPayments,
  listClientStatements,
  submitClientOfflinePayment,
  verifyClientOnlinePayment
} from "../controllers/creditBilling.controller.js";
import {
  getClientCancellationCreditNotePdf,
  getClientCancellationFeeInvoicePdf,
  getClientShipmentCancellation,
  requestClientShipmentCancellation
} from "../controllers/shipmentCancellation.controller.js";
import {
  convertClientShipmentQuote, createClientQuoteShipmentDraft, createClientShipmentQuote, estimateClientShipmentQuote,
  getClientQuoteContext, getClientShipmentQuote, listClientShipmentQuotes
} from "../controllers/shipmentQuote.controller.js";
import {
  createClientTicket, getClientTicket, listClientTickets, replyClientTicket
} from "../controllers/supportTicket.controller.js";
import {
  listClientCalendarEntries,
  listClientRegulatoryUpdates,
  listClientServiceDisruptions
} from "../controllers/operationsAdvisory.controller.js";
import { listClientBookingPauses } from "../controllers/bookingPause.controller.js";
import { cancelClientPickupRequest, createClientPickupRequest, rescheduleClientPickupRequest, getClientPickupRequest, listClientEligiblePickups, listClientPickupRequests, viewClientPickupProof } from "../controllers/pickup.controller.js";
import { checkClientServiceability } from "../controllers/serviceability.controller.js";
import { getClientCustomsKyc } from "../controllers/customsKyc.controller.js";
import { getClientActivity } from "../controllers/clientActivity.controller.js";
import { listClientTeam, requestClientTeamInvite, updateClientTeamMemberRole } from "../controllers/clientTeam.controller.js";
import { createPodDispute, downloadClientPodPdf, emailClientPod, getClientPod, listClientPodCentre, viewPodEvidence } from "../controllers/pod.controller.js";
import { addressBookRouter } from "./addressBook.routes.js";
import { listClientDocuments } from "../controllers/clientDocumentCentre.controller.js";
import { supportTicketDraftRouter } from "./supportTicketDraft.routes.js";

export const clientRouter = Router();

clientRouter.use(attachUser);
clientRouter.use(requireRole("client"));

clientRouter.use("/address-book", addressBookRouter);
clientRouter.get("/documents", listClientDocuments);

// Operations advisory: the header marquee, the Holiday & Cut-Off Calendar and
// the customs & regulatory updates published alongside it.
clientRouter.get("/service-disruptions", listClientServiceDisruptions);
clientRouter.get("/calendar-entries", listClientCalendarEntries);
clientRouter.get("/regulatory-updates", listClientRegulatoryUpdates);
clientRouter.get("/booking-pauses", listClientBookingPauses);

clientRouter.get("/support-tickets", listClientTickets);
clientRouter.post("/support-tickets", createClientTicket);
clientRouter.get("/support-tickets/:ticketId", getClientTicket);
clientRouter.post("/support-tickets/:ticketId/replies", replyClientTicket);
clientRouter.use("/support-ticket-drafts", supportTicketDraftRouter);

clientRouter.get("/dashboard", getClientDashboard);
// The control tower: every dashboard figure counted server-side, plus the
// exception and action feeds the same engine produces.
clientRouter.get("/overview", getClientOverview);
clientRouter.get("/exceptions", listClientExceptions);
clientRouter.get("/actions", listClientActions);
clientRouter.get("/search", searchClient);
// Documents supplied after booking, which is when customs asks for them.
clientRouter.get("/shipments/:draftId/documents", listClientShipmentDocuments);
clientRouter.post("/shipments/:draftId/documents", shipmentSupportingDocumentUpload, uploadClientShipmentDocument);
clientRouter.get("/shipments/:draftId/documents/:documentId", downloadClientShipmentDocument);
clientRouter.get("/quotes/context", getClientQuoteContext);
clientRouter.post("/quotes/estimate", estimateClientShipmentQuote);
clientRouter.post("/quotes/draft", createClientQuoteShipmentDraft);
clientRouter.get("/quotes", listClientShipmentQuotes);
clientRouter.post("/quotes", createClientShipmentQuote);
clientRouter.get("/quotes/:quoteId", getClientShipmentQuote);
clientRouter.post("/quotes/:quoteId/convert", convertClientShipmentQuote);
clientRouter.get("/credit", getClientCreditSummary);
clientRouter.post("/credit/request", requestClientCredit);
clientRouter.get("/credit/limit-increase", getClientCreditLimitIncrease);
clientRouter.post("/credit/limit-increase", requestClientCreditLimitIncrease);
clientRouter.get("/credit/payment-terms", getClientPaymentTerms);
clientRouter.post("/credit/payment-terms/accept", acceptClientPaymentTerms);
clientRouter.get("/credit/statements", listClientStatements);
clientRouter.post("/credit/statements/close-cycle", closeClientBillingCycle);
clientRouter.get("/credit/statements/:statementId", getClientStatement);
clientRouter.get("/credit/statements/:statementId/pdf", downloadClientStatement);
clientRouter.post("/credit/payments/online", createClientOnlinePayment);
clientRouter.post("/credit/payments/online/verify", verifyClientOnlinePayment);
clientRouter.post("/credit/payments/offline", submitClientOfflinePayment);
clientRouter.get("/credit/payments", listClientPayments);
clientRouter.get("/credit/ledger", getClientLedger);
clientRouter.get("/credit/ledger/export", exportClientLedger);
clientRouter.get("/credit-agreements", listClientCreditAgreements);
clientRouter.get("/credit-agreements/:agreementId/pdf", getClientCreditAgreementPdf);
clientRouter.get("/credit-agreements/:agreementId", getClientCreditAgreement);
clientRouter.get("/country-rate-cards", listClientCountryRateCards);
clientRouter.get("/rate-card-shares", listClientRateCardShares);
clientRouter.get("/rate-card-shares/:shareId", getClientRateCardShare);
clientRouter.get("/rate-card-shares/:shareId/pdf", downloadClientRateCardSharePdf);
clientRouter.get("/rate-card-shares/:shareId/xlsx", downloadClientRateCardShareWorkbook);
clientRouter.post("/rate-card-shares/:shareId/read", markClientRateCardShareRead);
clientRouter.get("/prepaid-account", getClientPrepaidAccount);
clientRouter.get("/prepaid-transactions", listClientPrepaidTransactions);
clientRouter.post("/prepaid-topups", createClientPrepaidTopUp);
clientRouter.post("/prepaid-topups/:id/verify", verifyClientPrepaidTopUp);
clientRouter.get("/prepaid-topups/:id", getClientPrepaidTopUp);
clientRouter.get("/prepaid-topups", listClientPrepaidTopUps);
clientRouter.get("/shipment-imports/template", downloadClientShipmentImportTemplate);
clientRouter.post("/shipment-imports/batches", shipmentImportUpload, createClientShipmentImportBatch);
clientRouter.get("/shipment-imports/batches/:batchId", getClientShipmentImportBatch);
clientRouter.post("/shipment-imports/batches/:batchId/create-drafts", createClientShipmentImportDrafts);
clientRouter.post("/dpd-labels/drafts/manual", createClientManualShipmentDraft);
clientRouter.post("/dpd-labels/drafts/bulk-delete", deleteClientShipmentDrafts);
clientRouter.get("/dpd-labels/drafts/:id", getClientShipmentDraft);
clientRouter.get("/dpd-labels/drafts/:id/rate-card-context", getClientShipmentDraftRateCardContext);
clientRouter.patch("/dpd-labels/drafts/:id", updateClientShipmentDraft);
// Unbooked drafts only; deletion is soft and the restore below backs the undo
// action on the delete toast.
clientRouter.delete("/dpd-labels/drafts/:id", deleteClientShipmentDraft);
clientRouter.post("/dpd-labels/drafts/:id/restore", restoreClientShipmentDraft);
// POST because the booking form prices the values it currently holds, which are
// sent in the body. Nothing is written.
clientRouter.post("/dpd-labels/drafts/:id/cost-estimate", getClientShipmentDraftCostEstimate);
clientRouter.post("/dpd-labels/drafts/:id/kyc-documents/:type", shipmentKycUpload, uploadClientShipmentKycDocument);
clientRouter.delete("/dpd-labels/drafts/:id/kyc-documents/:type", deleteClientShipmentKycDocument);
clientRouter.get("/dpd-labels/drafts/:id/kyc-documents/:type", downloadClientShipmentKycDocument);
clientRouter.post("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", shipmentKycUpload, uploadClientShipmentParcelKycDocument);
clientRouter.delete("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", deleteClientShipmentParcelKycDocument);
clientRouter.get("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", downloadClientShipmentParcelKycDocument);
clientRouter.post("/dpd-labels/drafts/:id/create-shipment", createClientShipment);
clientRouter.get("/shipments", listClientShipments);
clientRouter.get("/booked-shipments", listClientBookedShipments);
clientRouter.get("/pickups/eligible-shipments", listClientEligiblePickups);
clientRouter.post("/pickups", createClientPickupRequest);
clientRouter.get("/pickups", listClientPickupRequests);
clientRouter.get("/pickups/:pickupId", getClientPickupRequest);
clientRouter.post("/pickups/:pickupId/cancel", cancelClientPickupRequest);
clientRouter.post("/pickups/:pickupId/reschedule", rescheduleClientPickupRequest);
clientRouter.get("/pickups/:pickupId/proofs/:proofId", viewClientPickupProof);
clientRouter.get("/shipments/:shipmentId/pod", getClientPod);
clientRouter.post("/shipments/:shipmentId/pod/disputes", createPodDispute);
clientRouter.get("/serviceability", checkClientServiceability);
clientRouter.get("/customs-kyc", getClientCustomsKyc);
clientRouter.get("/activity", getClientActivity);
clientRouter.get("/team", listClientTeam);
clientRouter.post("/team/invites", requestClientTeamInvite);
clientRouter.patch("/team/:memberId/role", updateClientTeamMemberRole);
clientRouter.get("/pods", listClientPodCentre);
clientRouter.get("/pods/download", downloadClientPodPdf);
clientRouter.post("/pods/email", emailClientPod);
clientRouter.get("/pod/assignments/:assignmentId/revisions/:revisionId/evidence/:evidenceId", viewPodEvidence);
clientRouter.get("/tracking/:trackingNumber", trackClientShipment);
clientRouter.get("/shipments/:draftId/labels/:labelId/access", createClientShipmentLabelAccess);
clientRouter.get("/shipments/:id", getClientShipmentDetails);
clientRouter.get("/shipments/:draftId/manifests/context", getClientShipmentManifestContext);
clientRouter.get("/shipment-manifests", listClientShipmentManifests);
clientRouter.post("/shipment-manifests", createClientShipmentManifest);
clientRouter.post("/shipment-manifests/bulk", createClientBulkShipmentManifest);
clientRouter.get("/shipment-manifests/:manifestId/download", downloadClientShipmentManifest);
clientRouter.get("/shipment-manifests/:manifestId/pdf", downloadClientShipmentManifestPdf);
clientRouter.get("/shipments/:draftId/cancellation", getClientShipmentCancellation);
clientRouter.post("/shipments/:draftId/cancellation", requestClientShipmentCancellation);
clientRouter.get("/shipment-cancellations/:id/credit-note/pdf", getClientCancellationCreditNotePdf);
clientRouter.get("/shipment-cancellations/:id/fee-invoice/pdf", getClientCancellationFeeInvoicePdf);
clientRouter.post("/shipments/:id/amendments/preview", previewClientShipmentAmendment);
clientRouter.post("/shipments/:id/amendments", createClientShipmentAmendment);
clientRouter.get("/shipments/:draftId/invoice", getClientShipmentInvoice);
clientRouter.get("/shipments/:draftId/invoice/pdf", downloadClientShipmentInvoicePdf);
// Document-only revised copies of the GST invoice, read-only for clients.
clientRouter.get("/shipments/:draftId/invoice/revised", listClientShipmentInvoiceRevisedDocuments);
clientRouter.get("/shipments/:draftId/invoice/revised/:copyId", getClientShipmentInvoiceRevisedDocument);
clientRouter.get("/shipments/:draftId/invoice/revised/:copyId/pdf", downloadClientShipmentInvoiceRevisedDocumentPdf);
// Customs ("shipment") invoice: the goods declaration, separate from the GST invoice above.
clientRouter.get("/shipments/:draftId/shipment-invoice", getClientCustomsInvoice);
clientRouter.get("/shipments/:draftId/shipment-invoice/pdf", downloadClientCustomsInvoicePdf);
clientRouter.get("/shipments/:draftId/shipment-invoice/xlsx", downloadClientCustomsInvoiceWorkbook);
clientRouter.post("/dpd-labels/addresses/autocomplete", autocompleteAddress);
clientRouter.post("/dpd-labels/addresses/consignor/autocomplete", autocompleteConsignorAddress);
clientRouter.get("/dpd-labels/addresses/consignor/places/:placeId", getConsignorPlaceAddress);
clientRouter.get("/dpd-labels/addresses/places/:placeId", getPlaceAddress);
clientRouter.post("/dpd-labels/addresses/validate", validateAddress);
clientRouter.post("/dpd-labels/addresses/confirm", confirmValidatedAddress);
clientRouter.use((error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) => {
  try {
    handleCreditBillingError(error, response);
  } catch (unhandled) {
    next(unhandled);
  }
});
