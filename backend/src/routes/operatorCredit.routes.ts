import { Router, type Request, type RequestHandler } from "express";
import mongoose from "mongoose";
import { approveAdminCreditAccount, closeAdminCreditAccount, getAdminCreditAccount, reactivateAdminCreditAccount, rejectAdminCreditAccount, suspendAdminCreditAccount } from "../controllers/adminCredit.controller.js";
import { listOperatorCreditAccounts } from "../controllers/operatorCredit.controller.js";
import {
  exportAdminLedger,
  exportClientLedger,
  getAdminLedger,
  getAdminStatement,
  getClientLedger,
  getClientStatement,
  handleCreditBillingError,
  listAdminPayments,
  listAdminStatements,
  listClientPayments,
  listClientStatements,
  downloadAdminStatement,
  downloadClientStatement,
  closeAdminBillingCycle,
  createAdminOfflinePayment,
  verifyAdminOfflinePayment,
  writeOffAdminStatement
} from "../controllers/creditBilling.controller.js";
import {
  getClientCreditLimitIncrease,
  getClientCreditSummary,
  requestClientCredit,
  requestClientCreditLimitIncrease
} from "../controllers/clientCredit.controller.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import type { TenantMembershipRole } from "../models/tenantMembership.model.js";
import { getOperatorContext, requireOperatorRole } from "../middleware/operatorContext.middleware.js";
import { getMemberCreditPermissions } from "../services/creditAccount.service.js";

export const operatorCreditRouter = Router({ mergeParams: true });

export function buildOperatorCreditAccountFilter(input: {
  tenantId: mongoose.Types.ObjectId;
  role: TenantMembershipRole;
  assignedBranches: readonly mongoose.Types.ObjectId[];
  businessAccountId: string;
}) {
  const filter: Record<string, unknown> = {
    _id: new mongoose.Types.ObjectId(input.businessAccountId),
    tenantId: input.tenantId
  };
  if (input.role !== "OPERATOR_ADMIN") {
    filter.assignedBranch = { $in: input.assignedBranches };
  }
  return filter;
}

const requireOperatorCreditStaff = requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS", "FINANCE");
const requireOperatorCreditFinance = requireOperatorRole("OPERATOR_ADMIN", "FINANCE");

const requireOperatorCreditAccountAccess: RequestHandler = async (request, response, next) => {
  const context = getOperatorContext(request);
  const id = typeof request.params.businessAccountId === "string" ? request.params.businessAccountId : "";
  if (!context || !mongoose.Types.ObjectId.isValid(id)) {
    return response.status(404).json({ success: false, message: "Business account not found." });
  }

  const businessAccount = await BusinessAccount.findOne(buildOperatorCreditAccountFilter({
    tenantId: context.tenantId,
    role: context.role,
    assignedBranches: context.assignedBranches,
    businessAccountId: id
  })).select("_id").lean().exec();
  if (!businessAccount) {
    return response.status(404).json({ success: false, message: "Business account not found." });
  }
  return next();
};

const requireOperatorClientCreditDetails: RequestHandler = async (request, response, next) => {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  if (!user?._id || !mongoose.Types.ObjectId.isValid(String(user._id)) || !mongoose.Types.ObjectId.isValid(businessAccountId)) {
    return response.status(404).json({ success: false, message: "Business account access was not found." });
  }
  const membership = await BusinessAccountMember.findOne({
    user: new mongoose.Types.ObjectId(String(user._id)),
    businessAccount: new mongoose.Types.ObjectId(businessAccountId),
    status: "active"
  }).select("role creditPermissions").lean().exec();
  if (!membership) return response.status(404).json({ success: false, message: "Business account access was not found." });
  if (!getMemberCreditPermissions(membership.role, membership.creditPermissions).includes("viewCreditDetails")) {
    return response.status(403).json({ success: false, message: "Your account role cannot view credit details." });
  }
  return next();
};

// Every account-specific staff endpoint is tenant, branch, and account scoped.
operatorCreditRouter.use("/accounts/:businessAccountId", requireOperatorCreditStaff, requireOperatorCreditAccountAccess);

operatorCreditRouter.get("/accounts", requireOperatorCreditStaff, listOperatorCreditAccounts);
operatorCreditRouter.get("/accounts/:businessAccountId", getAdminCreditAccount);
operatorCreditRouter.post("/accounts/:businessAccountId/approve", requireOperatorCreditFinance, approveAdminCreditAccount);
operatorCreditRouter.post("/accounts/:businessAccountId/reject", requireOperatorCreditFinance, rejectAdminCreditAccount);
operatorCreditRouter.post("/accounts/:businessAccountId/suspend", requireOperatorCreditFinance, suspendAdminCreditAccount);
operatorCreditRouter.post("/accounts/:businessAccountId/reactivate", requireOperatorCreditFinance, reactivateAdminCreditAccount);
operatorCreditRouter.post("/accounts/:businessAccountId/close", requireOperatorCreditFinance, closeAdminCreditAccount);

operatorCreditRouter.get("/accounts/:businessAccountId/statements", listAdminStatements);
operatorCreditRouter.post("/accounts/:businessAccountId/close-cycle", requireOperatorCreditFinance, closeAdminBillingCycle);
operatorCreditRouter.get("/accounts/:businessAccountId/statements/:statementId", getAdminStatement);
operatorCreditRouter.get("/accounts/:businessAccountId/statements/:statementId/pdf", downloadAdminStatement);
operatorCreditRouter.post("/accounts/:businessAccountId/statements/:statementId/write-off", requireOperatorCreditFinance, writeOffAdminStatement);
operatorCreditRouter.get("/accounts/:businessAccountId/payments", listAdminPayments);
operatorCreditRouter.post("/accounts/:businessAccountId/payments/offline", requireOperatorCreditFinance, createAdminOfflinePayment);
operatorCreditRouter.post("/accounts/:businessAccountId/payments/:paymentId/verify", requireOperatorCreditFinance, verifyAdminOfflinePayment);
operatorCreditRouter.get("/accounts/:businessAccountId/ledger", getAdminLedger);
operatorCreditRouter.get("/accounts/:businessAccountId/ledger/export", exportAdminLedger);

operatorCreditRouter.get("/client/summary", requireOperatorRole("CLIENT"), getClientCreditSummary);
operatorCreditRouter.post("/client/requests", requireOperatorRole("CLIENT"), requestClientCredit);
operatorCreditRouter.get("/client/limit-increase", requireOperatorRole("CLIENT"), requireOperatorClientCreditDetails, getClientCreditLimitIncrease);
operatorCreditRouter.post("/client/limit-increase", requireOperatorRole("CLIENT"), requestClientCreditLimitIncrease);
operatorCreditRouter.get("/client/statements", requireOperatorRole("CLIENT"), listClientStatements);
operatorCreditRouter.get("/client/statements/:statementId", requireOperatorRole("CLIENT"), getClientStatement);
operatorCreditRouter.get("/client/statements/:statementId/pdf", requireOperatorRole("CLIENT"), downloadClientStatement);
operatorCreditRouter.get("/client/payments", requireOperatorRole("CLIENT"), listClientPayments);
operatorCreditRouter.get("/client/ledger", requireOperatorRole("CLIENT"), getClientLedger);
operatorCreditRouter.get("/client/ledger/export", requireOperatorRole("CLIENT"), exportClientLedger);

operatorCreditRouter.use((error: unknown, _request: Request, response: import("express").Response, next: import("express").NextFunction) => {
  try {
    handleCreditBillingError(error, response);
  } catch (unhandled) {
    next(unhandled);
  }
});
