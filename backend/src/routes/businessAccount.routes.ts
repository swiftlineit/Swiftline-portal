import { Router } from "express";
import {
  createBusinessAccountClientAccess,
  createBusinessAccountInvitationLink,
  listBusinessAccountMembers,
  resendBusinessAccountInvitation,
  updateBusinessAccountMemberStatus
} from "../controllers/businessAccountAccess.controller.js";
import {
  assignBusinessAccountBranch,
  assignBusinessAccountRateCard,
  createBusinessAccount,
  deleteBusinessAccountDraft,
  getBusinessAccount,
  listBusinessAccountRateCardHistory,
  listBusinessAccounts,
  submitBusinessAccount,
  updateBusinessAccount,
  updateBusinessAccountGstBillingReview,
  updateBusinessAccountOperationalAction,
  updateBusinessAccountVolumetricDiscount,
  updateBusinessAccountKycReview,
  updateBusinessAccountStatus,
  viewBusinessAccountDocument,
  validateBusinessAccountUniqueness
} from "../controllers/businessAccount.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";
import {
  requireAssignedBusinessAccountBranch,
  requireBusinessAccountBranch
} from "../middleware/businessAccountBranchAccess.middleware.js";
import { businessDocumentUpload } from "../middleware/businessDocumentUpload.middleware.js";

export const businessAccountRouter = Router();

businessAccountRouter.use(attachUser);

// Finance can change only this commercial field; it does not gain access to the
// broader onboarding and KYC routes below. Non-admin roles are branch scoped.
businessAccountRouter.patch(
  "/:accountId/rate-card",
  requireRole("admin", "finance", "operations"),
  requireAssignedBusinessAccountBranch,
  assignBusinessAccountRateCard
);
businessAccountRouter.get(
  "/:accountId/rate-card-history",
  requireRole("admin", "finance", "operations"),
  requireAssignedBusinessAccountBranch,
  listBusinessAccountRateCardHistory
);
businessAccountRouter.patch(
  "/:accountId/volumetric-discount",
  requireRole("admin", "operations"),
  requireAssignedBusinessAccountBranch,
  updateBusinessAccountVolumetricDiscount
);
businessAccountRouter.use(requireRole("admin", "operations"));

// Collection routes come first: they are answered before the `/:accountId` guard
// below is reached, which would otherwise treat "validate-unique" as an account.
businessAccountRouter.get("/", listBusinessAccounts);
businessAccountRouter.get("/validate-unique", validateBusinessAccountUniqueness);
businessAccountRouter.post("/", businessDocumentUpload, createBusinessAccount);

// Admin passes straight through; operations only reaches its own branches'
// accounts. `listBusinessAccounts` applies the same scope to the collection.
businessAccountRouter.use("/:accountId", requireBusinessAccountBranch);

businessAccountRouter.get("/:accountId", getBusinessAccount);
businessAccountRouter.get("/:accountId/members", listBusinessAccountMembers);
businessAccountRouter.post("/:accountId/client-access", createBusinessAccountClientAccess);
businessAccountRouter.post("/:accountId/members/:memberId/resend-invitation", resendBusinessAccountInvitation);
businessAccountRouter.post("/:accountId/members/:memberId/invitation-link", createBusinessAccountInvitationLink);
businessAccountRouter.patch("/:accountId/members/:memberId/status", updateBusinessAccountMemberStatus);
businessAccountRouter.get("/:accountId/documents/:documentType", viewBusinessAccountDocument);
businessAccountRouter.patch("/:accountId", businessDocumentUpload, updateBusinessAccount);
businessAccountRouter.patch("/:accountId/assign-branch", assignBusinessAccountBranch);
businessAccountRouter.patch("/:accountId/operational-action", updateBusinessAccountOperationalAction);
businessAccountRouter.patch("/:accountId/kyc-review", updateBusinessAccountKycReview);
businessAccountRouter.patch("/:accountId/gst-billing-review", updateBusinessAccountGstBillingReview);
businessAccountRouter.patch("/:accountId/status", updateBusinessAccountStatus);
businessAccountRouter.post("/:accountId/submit", submitBusinessAccount);
// Draft accounts only; anything already under review goes through the status
// endpoint above instead.
businessAccountRouter.delete("/:accountId", deleteBusinessAccountDraft);
