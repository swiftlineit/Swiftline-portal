import { Router, type Request, type RequestHandler } from "express";
import { getOperatorSession } from "../controllers/operatorSession.controller.js";
import { getOperatorHome } from "../controllers/operatorHome.controller.js";
import {
  createClientShipmentLabelAccess,
  downloadClientShipmentInvoicePdf,
  downloadClientCustomsInvoicePdf,
  downloadClientCustomsInvoiceWorkbook,
  getClientCustomsInvoice,
  getClientShipmentDetails,
  getClientShipmentDraft,
  getClientShipmentDraftCostEstimate,
  getClientShipmentDraftRateCardContext,
  getClientShipmentInvoice,
  clientCanAccessDraft,
  listClientShipments,
  trackClientShipment,
  updateClientShipmentDraft
} from "../controllers/client.controller.js";
import { getAdminShipmentDetails } from "../controllers/dpdShipment.controller.js";
import { listClientBookedShipments } from "../controllers/shipmentListing.controller.js";
import {
  autocompleteAddress,
  autocompleteConsignorAddress,
  confirmValidatedAddress,
  getConsignorPlaceAddress,
  getPlaceAddress,
  validateAddress
} from "../controllers/address.controller.js";
import {
  getShipmentDraft,
  getShipmentDraftCostEstimate,
  getShipmentDraftRateCardContext,
  updateShipmentDraft
} from "../controllers/shipmentDraft.controller.js";
import {
  deleteShipmentKycDocument,
  deleteShipmentParcelKycDocument,
  downloadShipmentKycDocument,
  downloadShipmentParcelKycDocument,
  uploadShipmentKycDocument,
  uploadShipmentParcelKycDocument
} from "../controllers/shipmentKyc.controller.js";
import { shipmentKycUpload } from "../middleware/shipmentKycUpload.middleware.js";
import { downloadCustomsInvoicePdf, downloadCustomsInvoiceWorkbook, getCustomsInvoice } from "../controllers/customsInvoice.controller.js";
import { downloadShipmentInvoicePdf, getShipmentInvoice } from "../controllers/shipmentInvoice.controller.js";
import {
  createOperatorManualShipmentDraft,
  createOperatorIndividualShipmentDraft,
  createOperatorClientManualShipmentDraft,
  createOperatorShipmentLabelAccess,
  createOperatorShipment,
  recordOperatorShipmentCounterPayment,
  listOperatorShipmentDrafts,
  listOperatorShipments,
  reconcileOperatorShipmentDocuments,
  requireOperatorShipmentDraftAccess,
  updateOperatorShipmentTracking
} from "../controllers/operatorShipment.controller.js";
import {
  createBranch,
  deleteBranchDocument,
  deleteBranchDraft,
  deleteBranchImage,
  getBranch,
  updateBranch,
  updateBranchStatus,
  uploadBranchDocument,
  uploadBranchImages,
  validateBranchCode,
  viewBranchDocument,
  viewBranchImage
} from "../controllers/branch.controller.js";
import { branchUpload } from "../middleware/branchUpload.middleware.js";
import { attachUser } from "../middleware/auth.middleware.js";
import {
  auditOperatorSupportAccess,
  getOperatorContext,
  requireOperatorContext,
  requireOperatorRole,
  requireOperatorSupportReadOnly,
  withOperatorTenantContext,
  withOperatorTenantUpload
} from "../middleware/operatorContext.middleware.js";
import type { TenantMembershipRole } from "../models/tenantMembership.model.js";
import {
  getOperatorBranchUser,
  getOperatorBranchDetails,
  listOperatorBranches,
  listOperatorBranchUsers,
  listOperatorBusinessAccounts,
  requireOperatorBranchDocumentAccess
} from "../controllers/operatorDirectory.controller.js";
import {
  getOperatorCompanyLogo,
  getOperatorBrandBanner,
  getOperatorInvoiceSettings,
  removeOperatorBrandBanner,
  removeOperatorCompanyLogo,
  uploadOperatorBrandBanner,
  updateOperatorCompanyProfile,
  updateOperatorCompanyLogo,
  updateOperatorPortalSlug
} from "../controllers/operatorSettings.controller.js";
import { operatorBrandLogoUpload } from "../middleware/operatorBrandLogoUpload.middleware.js";
import { operatorBrandBannerUpload } from "../middleware/operatorBrandBannerUpload.middleware.js";
import {
  createBusinessAccount,
  assignBusinessAccountBranch,
  getBusinessAccount,
  submitBusinessAccount,
  updateOperatorNoCompanyBillingAddress,
  updateBusinessAccountKycReview,
  updateBusinessAccountStatus,
  validateBusinessAccountUniqueness,
  viewBusinessAccountDocument
} from "../controllers/businessAccount.controller.js";
import { businessDocumentUpload } from "../middleware/businessDocumentUpload.middleware.js";
import { requireOperatorBusinessAccountAccess } from "../middleware/operatorBusinessAccountAccess.middleware.js";
import {
  createOperatorBusinessAccountClientAccess,
  createOperatorBusinessAccountInvitationLink,
  listOperatorBusinessAccountMembers,
  resendOperatorBusinessAccountInvitation
} from "../controllers/operatorClientAccess.controller.js";
import { listOperatorClientCountryRateCards } from "../controllers/clientRateCard.controller.js";
import {
  createCountryRateCard,
  deleteCountryRateCard,
  listCountryRateCards,
  listCountryRouteCharges,
  saveCountryRouteCharge,
  updateCountryRateCard
} from "../controllers/countryRateCard.controller.js";
import { operatorCreditRouter } from "./operatorCredit.routes.js";
import { operatorShipmentManifestRouter } from "./operatorShipmentManifest.routes.js";
import { operatorShipmentCancellationRouter } from "./operatorShipmentCancellation.routes.js";
import { operatorShipmentAmendmentRouter } from "./operatorShipmentAmendment.routes.js";
import { getProfile, updateProfileBusinessAccount, updateProfileDetails } from "../controllers/profile.controller.js";
import { getNotifications, readAllNotifications, readNotification } from "../controllers/notification.controller.js";
import { getOperatorUserProfile, listOperatorUsers } from "../controllers/operatorUsers.controller.js";
import { getOperatorContactQuery, listOperatorContactQueries, submitOperatorContactQuery } from "../controllers/operatorContact.controller.js";

export const operatorRouter = Router({ mergeParams: true });

function dispatchOperatorRoleHandlers(handlers: Partial<Record<TenantMembershipRole, RequestHandler>>): RequestHandler {
  return (request, response, next) => {
    const role = getOperatorContext(request)?.role;
    const handler = role ? handlers[role] : undefined;
    if (!handler) return response.status(403).json({ success: false, message: "Forbidden" });
    return handler(request, response, next);
  };
}

function requireOperatorDraftAccess(handler: RequestHandler): RequestHandler {
  return (request, response, next) => requireOperatorShipmentDraftAccess(
    request,
    response,
    (error?: unknown) => error ? next(error) : handler(request, response, next)
  );
}

function withOperatorPortalRole(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    const context = getOperatorContext(request);
    const user = (request as Request & { user?: { role?: string } }).user;
    if (!context || !user) return response.status(401).json({ success: false, message: "Unauthorized" });
    user.role = {
      OPERATOR_ADMIN: "admin",
      OPERATIONS: "operations",
      FINANCE: "finance",
      CLIENT: "client"
    }[context.role];
    return handler(request, response, next);
  };
}

function withOperatorClientDraftAccess(handler: RequestHandler, requireEditPermission = false): RequestHandler {
  return async (request, response, next) => {
    const user = (request as Request & { user?: { _id?: unknown } }).user;
    const draftId = typeof request.params.id === "string" ? request.params.id : "";
    if (!user?._id) return response.status(401).json({ success: false, message: "Unauthorized" });
    try {
      if (!await clientCanAccessDraft(String(user._id), draftId, requireEditPermission)) {
        return response.status(404).json({ success: false, message: "Shipment draft not found." });
      }
      return handler(request, response, next);
    } catch (error) {
      return next(error);
    }
  };
}

function withKycUpload(handler: RequestHandler): RequestHandler {
  return withOperatorTenantUpload(shipmentKycUpload, handler);
}

const requireOperatorMemberAccess: RequestHandler = (request, response, next) => {
  if (getOperatorContext(request)?.accessMode !== "MEMBER") {
    return response.status(403).json({ success: false, message: "Operator member access is required." });
  }
  return next();
};

operatorRouter.use(attachUser, requireOperatorContext, requireOperatorSupportReadOnly, auditOperatorSupportAccess);
operatorRouter.use("/credit", operatorCreditRouter);
operatorRouter.use("/manifests", operatorShipmentManifestRouter);
operatorRouter.use(operatorShipmentAmendmentRouter);
operatorRouter.use(operatorShipmentCancellationRouter);
operatorRouter.get("/me", getOperatorSession);
operatorRouter.get("/home", getOperatorHome);
operatorRouter.post("/contact", requireOperatorMemberAccess, requireOperatorRole("CLIENT"), submitOperatorContactQuery);
operatorRouter.get("/queries", requireOperatorMemberAccess, requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"), listOperatorContactQueries);
operatorRouter.get("/queries/:queryId", requireOperatorMemberAccess, requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"), getOperatorContactQuery);
operatorRouter.get("/users", requireOperatorMemberAccess, requireOperatorRole("OPERATOR_ADMIN"), listOperatorUsers);
operatorRouter.get("/users/:audience/:membershipId", requireOperatorMemberAccess, requireOperatorRole("OPERATOR_ADMIN"), getOperatorUserProfile);
operatorRouter.get("/notifications", requireOperatorMemberAccess, getNotifications);
operatorRouter.patch("/notifications/read-all", requireOperatorMemberAccess, readAllNotifications);
operatorRouter.patch("/notifications/:notificationId/read", requireOperatorMemberAccess, readNotification);
operatorRouter.get("/profile", requireOperatorRole("CLIENT"), getProfile);
operatorRouter.patch("/profile", requireOperatorRole("CLIENT"), updateProfileDetails);
operatorRouter.patch("/profile/business-accounts/:accountId", requireOperatorRole("CLIENT"), updateProfileBusinessAccount);
operatorRouter.patch("/settings/slug", requireOperatorRole("OPERATOR_ADMIN"), updateOperatorPortalSlug);
operatorRouter.get("/settings", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"), getOperatorInvoiceSettings);
operatorRouter.patch("/settings/company", requireOperatorRole("OPERATOR_ADMIN"), updateOperatorCompanyProfile);
operatorRouter.get("/settings/logo", getOperatorCompanyLogo);
operatorRouter.put(
  "/settings/logo",
  requireOperatorRole("OPERATOR_ADMIN"),
  withOperatorTenantUpload(operatorBrandLogoUpload, updateOperatorCompanyLogo)
);
operatorRouter.delete("/settings/logo", requireOperatorRole("OPERATOR_ADMIN"), removeOperatorCompanyLogo);
operatorRouter.get("/settings/banners/:bannerId", getOperatorBrandBanner);
operatorRouter.post(
  "/settings/banners",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  withOperatorTenantUpload(operatorBrandBannerUpload, uploadOperatorBrandBanner)
);
operatorRouter.delete("/settings/banners/:bannerId", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"), removeOperatorBrandBanner);
operatorRouter.get(
  "/business-accounts",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  listOperatorBusinessAccounts
);
operatorRouter.get(
  "/business-accounts/validate-unique",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  validateBusinessAccountUniqueness
);
operatorRouter.post(
  "/business-accounts",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  withOperatorTenantContext(businessDocumentUpload),
  withOperatorTenantContext(createBusinessAccount)
);
operatorRouter.get(
  "/business-accounts/:accountId",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  requireOperatorBusinessAccountAccess,
  getBusinessAccount
);
operatorRouter.patch(
  "/business-accounts/:accountId/billing-address",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  requireOperatorBusinessAccountAccess,
  withOperatorTenantContext(updateOperatorNoCompanyBillingAddress)
);
operatorRouter.post(
  "/business-accounts/:accountId/submit",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  requireOperatorBusinessAccountAccess,
  submitBusinessAccount
);
operatorRouter.patch(
  "/business-accounts/:accountId/kyc-review",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  updateBusinessAccountKycReview
);
operatorRouter.patch(
  "/business-accounts/:accountId/status",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  updateBusinessAccountStatus
);
operatorRouter.patch(
  "/business-accounts/:accountId/assign-branch",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  assignBusinessAccountBranch
);
operatorRouter.get(
  "/business-accounts/:accountId/documents/:documentType",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  requireOperatorBusinessAccountAccess,
  viewBusinessAccountDocument
);
operatorRouter.get(
  "/business-accounts/:accountId/members",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  listOperatorBusinessAccountMembers
);
operatorRouter.post(
  "/business-accounts/:accountId/client-access",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  createOperatorBusinessAccountClientAccess
);
operatorRouter.post(
  "/business-accounts/:accountId/members/:memberId/resend-invitation",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  resendOperatorBusinessAccountInvitation
);
operatorRouter.post(
  "/business-accounts/:accountId/members/:memberId/invitation-link",
  requireOperatorRole("OPERATOR_ADMIN"),
  requireOperatorBusinessAccountAccess,
  createOperatorBusinessAccountInvitationLink
);
operatorRouter.get(
  "/branches",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"),
  listOperatorBranches
);
operatorRouter.get("/branches/validate-code", requireOperatorRole("OPERATOR_ADMIN"), validateBranchCode);
operatorRouter.get("/branches/:branchId/details", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"), getOperatorBranchDetails);
operatorRouter.get("/branches/:branchId/users/:membershipId", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"), getOperatorBranchUser);
operatorRouter.get("/branches/:branchId/users", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"), listOperatorBranchUsers);
operatorRouter.get("/branches/:branchId", requireOperatorRole("OPERATOR_ADMIN"), getBranch);
operatorRouter.post("/branches", requireOperatorRole("OPERATOR_ADMIN"), createBranch);
operatorRouter.patch("/branches/:branchId", requireOperatorRole("OPERATOR_ADMIN"), updateBranch);
operatorRouter.patch("/branches/:branchId/status", requireOperatorRole("OPERATOR_ADMIN"), updateBranchStatus);
operatorRouter.delete("/branches/:branchId", requireOperatorRole("OPERATOR_ADMIN"), deleteBranchDraft);
operatorRouter.post(
  "/branches/:branchId/images",
  requireOperatorRole("OPERATOR_ADMIN"),
  withOperatorTenantUpload(branchUpload, uploadBranchImages)
);
operatorRouter.get("/branches/:branchId/images/:imageIndex", requireOperatorRole("OPERATOR_ADMIN"), viewBranchImage);
operatorRouter.delete("/branches/:branchId/images/:imageIndex", requireOperatorRole("OPERATOR_ADMIN"), deleteBranchImage);
operatorRouter.post(
  "/branches/:branchId/documents",
  requireOperatorRole("OPERATOR_ADMIN"),
  withOperatorTenantUpload(branchUpload, uploadBranchDocument)
);
operatorRouter.get("/branches/:branchId/documents/:docIndex", requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"), requireOperatorBranchDocumentAccess, viewBranchDocument);
operatorRouter.delete("/branches/:branchId/documents/:docIndex", requireOperatorRole("OPERATOR_ADMIN"), deleteBranchDocument);
// Operator commercial cards use the existing audited/versioned rate-card
// controllers. The outer operator middleware has already established tenant
// context; only the operator administrator may change rates or surcharges.
operatorRouter.get("/country-rate-cards/client", requireOperatorRole("CLIENT"), listOperatorClientCountryRateCards);
operatorRouter.get("/country-rate-cards", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(listCountryRateCards));
operatorRouter.get("/country-rate-cards/route-charges", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(listCountryRouteCharges));
operatorRouter.post("/country-rate-cards", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(createCountryRateCard));
operatorRouter.put("/country-rate-cards/route-charges", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(saveCountryRouteCharge));
operatorRouter.patch("/country-rate-cards/:id", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(updateCountryRateCard));
operatorRouter.delete("/country-rate-cards/:id", requireOperatorRole("OPERATOR_ADMIN"), withOperatorPortalRole(deleteCountryRateCard));
operatorRouter.get("/shipments", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: listOperatorShipments,
  OPERATIONS: listOperatorShipments,
  FINANCE: listOperatorShipments,
  CLIENT: listClientShipments
}));
operatorRouter.get("/booked-shipments", requireOperatorRole("CLIENT"), listClientBookedShipments);
operatorRouter.post("/dpd-labels/drafts/manual", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: createOperatorManualShipmentDraft,
  OPERATIONS: createOperatorManualShipmentDraft,
  CLIENT: createOperatorClientManualShipmentDraft
}));
operatorRouter.post("/dpd-labels/drafts/individual", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: createOperatorIndividualShipmentDraft,
  OPERATIONS: createOperatorIndividualShipmentDraft
}));
operatorRouter.get("/dpd-labels/drafts", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: listOperatorShipmentDrafts,
  OPERATIONS: listOperatorShipmentDrafts,
  FINANCE: listOperatorShipmentDrafts
}));
operatorRouter.get("/dpd-labels/drafts/:id/rate-card-context", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(getShipmentDraftRateCardContext),
  OPERATIONS: requireOperatorDraftAccess(getShipmentDraftRateCardContext),
  FINANCE: requireOperatorDraftAccess(getShipmentDraftRateCardContext),
  CLIENT: getClientShipmentDraftRateCardContext
}));
operatorRouter.get("/dpd-labels/drafts/:id", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(getShipmentDraft),
  OPERATIONS: requireOperatorDraftAccess(getShipmentDraft),
  FINANCE: requireOperatorDraftAccess(getShipmentDraft),
  CLIENT: getClientShipmentDraft
}));
operatorRouter.patch("/dpd-labels/drafts/:id", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(updateShipmentDraft)),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(updateShipmentDraft)),
  CLIENT: updateClientShipmentDraft
}));
operatorRouter.post("/dpd-labels/drafts/:id/cost-estimate", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(getShipmentDraftCostEstimate),
  OPERATIONS: requireOperatorDraftAccess(getShipmentDraftCostEstimate),
  CLIENT: getClientShipmentDraftCostEstimate
}));
operatorRouter.post("/dpd-labels/drafts/:id/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(withKycUpload(uploadShipmentKycDocument))),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(withKycUpload(uploadShipmentKycDocument))),
  CLIENT: withOperatorClientDraftAccess(withKycUpload(uploadShipmentKycDocument), true)
}));
operatorRouter.delete("/dpd-labels/drafts/:id/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(deleteShipmentKycDocument)),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(deleteShipmentKycDocument)),
  CLIENT: withOperatorClientDraftAccess(deleteShipmentKycDocument, true)
}));
operatorRouter.get("/dpd-labels/drafts/:id/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentKycDocument)),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentKycDocument)),
  FINANCE: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentKycDocument)),
  CLIENT: withOperatorClientDraftAccess(downloadShipmentKycDocument)
}));
operatorRouter.post("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(withKycUpload(uploadShipmentParcelKycDocument))),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(withKycUpload(uploadShipmentParcelKycDocument))),
  CLIENT: withOperatorClientDraftAccess(withKycUpload(uploadShipmentParcelKycDocument), true)
}));
operatorRouter.delete("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(deleteShipmentParcelKycDocument)),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(deleteShipmentParcelKycDocument)),
  CLIENT: withOperatorClientDraftAccess(deleteShipmentParcelKycDocument, true)
}));
operatorRouter.get("/dpd-labels/drafts/:id/parcels/:sequence/kyc-documents/:type", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentParcelKycDocument)),
  OPERATIONS: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentParcelKycDocument)),
  FINANCE: requireOperatorDraftAccess(withOperatorPortalRole(downloadShipmentParcelKycDocument)),
  CLIENT: withOperatorClientDraftAccess(downloadShipmentParcelKycDocument)
}));
operatorRouter.post(
  "/dpd-labels/drafts/:id/create-shipment",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "CLIENT"),
  createOperatorShipment
);
operatorRouter.post("/dpd-labels/addresses/autocomplete", autocompleteAddress);
operatorRouter.post("/dpd-labels/addresses/consignor/autocomplete", autocompleteConsignorAddress);
operatorRouter.get("/dpd-labels/addresses/places/:placeId", getPlaceAddress);
operatorRouter.get("/dpd-labels/addresses/consignor/places/:placeId", getConsignorPlaceAddress);
operatorRouter.post("/dpd-labels/addresses/validate", validateAddress);
operatorRouter.post("/dpd-labels/addresses/confirm", confirmValidatedAddress);
operatorRouter.get("/shipments/:id", requireOperatorRole("CLIENT"), getClientShipmentDetails);
operatorRouter.get(
  "/shipments/:draftId/details",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE"),
  requireOperatorDraftAccess(getAdminShipmentDetails)
);
operatorRouter.post(
  "/shipments/:id/counter-payment",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  requireOperatorDraftAccess(recordOperatorShipmentCounterPayment)
);
operatorRouter.post(
  "/shipments/:id/tracking-events",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  updateOperatorShipmentTracking
);
operatorRouter.post(
  "/shipments/:shipmentId/reconcile-documents",
  requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS"),
  reconcileOperatorShipmentDocuments
);
operatorRouter.get("/shipments/:draftId/labels/:labelId/access", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(createOperatorShipmentLabelAccess),
  OPERATIONS: requireOperatorDraftAccess(createOperatorShipmentLabelAccess),
  FINANCE: requireOperatorDraftAccess(createOperatorShipmentLabelAccess),
  CLIENT: createClientShipmentLabelAccess
}));
operatorRouter.get("/tracking/:trackingNumber", requireOperatorRole("CLIENT"), trackClientShipment);
operatorRouter.get("/shipments/:draftId/invoice", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(getShipmentInvoice),
  OPERATIONS: requireOperatorDraftAccess(getShipmentInvoice),
  FINANCE: requireOperatorDraftAccess(getShipmentInvoice),
  CLIENT: getClientShipmentInvoice
}));
operatorRouter.get("/shipments/:draftId/invoice/pdf", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(downloadShipmentInvoicePdf),
  OPERATIONS: requireOperatorDraftAccess(downloadShipmentInvoicePdf),
  FINANCE: requireOperatorDraftAccess(downloadShipmentInvoicePdf),
  CLIENT: downloadClientShipmentInvoicePdf
}));
operatorRouter.get("/shipments/:draftId/shipment-invoice", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(getCustomsInvoice),
  OPERATIONS: requireOperatorDraftAccess(getCustomsInvoice),
  FINANCE: requireOperatorDraftAccess(getCustomsInvoice),
  CLIENT: getClientCustomsInvoice
}));
operatorRouter.get("/shipments/:draftId/shipment-invoice/pdf", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(downloadCustomsInvoicePdf),
  OPERATIONS: requireOperatorDraftAccess(downloadCustomsInvoicePdf),
  FINANCE: requireOperatorDraftAccess(downloadCustomsInvoicePdf),
  CLIENT: downloadClientCustomsInvoicePdf
}));
operatorRouter.get("/shipments/:draftId/shipment-invoice/xlsx", dispatchOperatorRoleHandlers({
  OPERATOR_ADMIN: requireOperatorDraftAccess(downloadCustomsInvoiceWorkbook),
  OPERATIONS: requireOperatorDraftAccess(downloadCustomsInvoiceWorkbook),
  FINANCE: requireOperatorDraftAccess(downloadCustomsInvoiceWorkbook),
  CLIENT: downloadClientCustomsInvoiceWorkbook
}));
