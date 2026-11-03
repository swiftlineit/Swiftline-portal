import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog, type AuditAction } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { excludeSentinel } from "../services/individualCustomer.service.js";
import { BusinessCreditAccount, creditAccountStatusValues, type CreditAccountStatus, type IBusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { type CreditLedgerEntryType } from "../models/creditLedgerEntry.model.js";
import { CreditLimitHistory } from "../models/creditLimitHistory.model.js";
import { CreditAgreement } from "../models/creditAgreement.model.js";
import { maxCreditLimitLabel, maxCreditLimitMinor } from "../models/financialTypes.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { CreditLimitIncreaseRequest } from "../models/creditLimitIncreaseRequest.model.js";
import {
  appendCreditLedgerEntry, ensureCreditAccount, getCreditActivationBlockers,
  serializeCreditAccount, serializeLimitIncrease
} from "../services/creditAccount.service.js";
import { getCreditRestrictionState } from "../services/creditOverdue.service.js";
import { getCreditBillingSummary } from "../services/creditBilling.summary.service.js";
import { formatMinorRupees } from "../services/prepaid/dailyTopUpLimit.service.js";
import { notifyBusinessFinancialMembers } from "../services/portalNotification.service.js";
import { operationsBranchIds } from "../middleware/operationsBranchAccess.middleware.js";
import { CreditAgreementServiceError, signCreditAgreement } from "../services/creditAgreement.service.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";

const creditClientHref = "/client/credit#credit-summary";

function creditAgreementErrorResponse(error: CreditAgreementServiceError, response: Response) {
  const notFound = ["BUSINESS_NOT_FOUND", "AGREEMENT_NOT_FOUND"].includes(error.code);
  return response.status(notFound ? 404 : 409).json({ success: false, message: error.message, code: error.code });
}

const approvalSchema = z.object({
  approvedCreditLimitMinor: z.number().int()
    .positive("Approved credit limit must be greater than zero.")
    .max(maxCreditLimitMinor, `Approved credit limit cannot exceed ${maxCreditLimitLabel}.`),
  paymentTermsDays: z.union([z.literal(0), z.literal(7), z.literal(15), z.literal(30), z.literal(45)]),
  billingCycle: z.enum(["WEEKLY", "MONTHLY"]),
  validFrom: z.string().trim().optional().default(""),
  validUntil: z.string().trim().optional().default(""),
  gracePeriodDays: z.number().int().min(0).max(90),
  maxOverdueDays: z.number().int().min(0).max(365),
  creditWarningThresholdPercent: z.number().int().min(1).max(100),
  securityDepositRequiredMinor: z.number().int().min(0),
  riskCategory: z.enum(["LOW", "MEDIUM", "HIGH"]),
  internalRemarks: z.string().trim().max(2000).optional().default(""),
  reason: z.string().trim().min(5, "Provide a reason for the credit decision.").max(500)
});

const reasonSchema = z.object({ reason: z.string().trim().min(5).max(500) });
const activationSchema = z.object({
  agreementId: z.string().trim().min(1, "Prepare the credit agreement before activation."),
  accepted: z.literal(true, { error: "Confirm that you have reviewed and approved the credit agreement." })
});

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function accountId(request: Request) {
  const id = typeof request.params.businessAccountId === "string" ? request.params.businessAccountId : "";
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function dateOrNull(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function businessSummary(account: { _id: unknown; accountId: string; status: string; company: { companyName?: string }; kycReview?: { overallStatus?: string }; agreementStatus?: string; depositStatus?: string }) {
  return {
    id: String(account._id), accountId: account.accountId, status: account.status,
    companyName: account.company.companyName || account.accountId,
    kycStatus: account.kycReview?.overallStatus || "documents_pending",
    agreementStatus: account.agreementStatus || "not_generated",
    depositStatus: account.depositStatus || "not_required"
  };
}

async function serializeAdminCreditAccount(account: InstanceType<typeof BusinessCreditAccount>) {
  const serialized = serializeCreditAccount(account);
  const restriction = await getCreditRestrictionState({
    businessAccountId: account.businessAccountId,
    gracePeriodDays: account.gracePeriodDays,
    maxOverdueDays: account.maxOverdueDays
  });
  const availableBookingCapacityMinor = restriction.level === "ALL_BOOKINGS_BLOCKED"
    ? 0
    : restriction.level === "CREDIT_BLOCKED"
      ? serialized.availableAdvanceMinor
      : serialized.availableBookingCapacityMinor;

  return {
    ...serialized,
    availableBookingCapacityMinor,
    restriction,
    billing: await getCreditBillingSummary(account.businessAccountId)
  };
}

export async function listAdminCreditAccounts(request: Request, response: Response): Promise<Response> {
  const requestedStatus = typeof request.query.status === "string" ? request.query.status.toUpperCase() : "";
  const statusFilter = creditAccountStatusValues.includes(requestedStatus as CreditAccountStatus)
    ? requestedStatus as CreditAccountStatus
    : "";

  // The individual-shipment sentinel is approved but is not a customer: it must
  // never be offered a credit account.
  const assignedBranchIds = operationsBranchIds(request);
  const branchScope = assignedBranchIds === null
    ? {}
    : {
        assignedBranch: {
          $in: assignedBranchIds
            .filter((branchId) => mongoose.Types.ObjectId.isValid(branchId))
            .map((branchId) => new mongoose.Types.ObjectId(branchId))
        }
      };
  const businesses = await BusinessAccount.find(excludeSentinel({
    status: { $in: ["approved", "active"] },
    ...branchScope
  }))
    .select("accountId status company.companyName kycReview.overallStatus agreementStatus depositStatus")
    .sort({ updatedAt: -1 }).lean().exec();
  const creditAccounts = await BusinessCreditAccount.find({ businessAccountId: { $in: businesses.map((account) => account._id) } }).exec();
  const byBusinessId = new Map(creditAccounts.map((account) => [String(account.businessAccountId), account]));
  const openRequests = await CreditLimitIncreaseRequest.find({
    businessAccountId: { $in: businesses.map((account) => account._id) },
    status: "PENDING"
  }).lean().exec();
  const requestByBusinessId = new Map(openRequests.map((item) => [String(item.businessAccountId), serializeLimitIncrease(item)]));
  const allAccounts = await Promise.all(businesses.map(async (business) => {
    const account = byBusinessId.get(String(business._id));
    return account
      ? {
          ...await serializeAdminCreditAccount(account),
          businessAccount: businessSummary(business),
          limitIncreaseRequest: requestByBusinessId.get(String(business._id)) ?? null
        }
      // A business with no facility yet still fills every column, because the
      // money formatter renders a missing figure as "Restricted" - which would
      // read as withheld data rather than the zero it actually is.
      : {
          id: "", businessAccountId: String(business._id), status: "NOT_REQUESTED", currency: "INR",
          requestedCreditLimitMinor: 0, approvedCreditLimitMinor: 0, usedCreditMinor: 0,
          unbilledCreditMinor: 0, invoicedOutstandingMinor: 0, totalOwedMinor: 0,
          availableCreditMinor: 0, availableAdvanceMinor: 0, availableBookingCapacityMinor: 0,
          paymentTermsDays: 30, billingCycle: "MONTHLY", businessAccount: businessSummary(business)
        };
  }));
  // The credit facility's status only exists after the businesses/credit-accounts
  // join above, so filtering happens in memory rather than as a DB query.
  const creditAccountsResult = statusFilter
    ? allAccounts.filter((account) => account.status === statusFilter)
    : allAccounts;
  return response.status(200).json({ success: true, creditAccounts: creditAccountsResult });
}

/**
 * Shipments booked but not yet collected, and what they are worth.
 *
 * Billing starts at collection, so these are charges that exist but cannot
 * reach a statement yet. Without a figure for them the money is invisible: it
 * is absent from Billed Outstanding, absent from Total Owed, and shows up only
 * as an account that quietly bills less than it should.
 */
async function summarizeAwaitingCollection(businessAccountId: mongoose.Types.ObjectId) {
  const invoices = await ShipmentInvoice.find({
    businessAccountId,
    chargeFinalizedAt: null,
    billingStatementId: null,
    status: "ISSUED",
    paymentStatus: { $ne: "VOID" },
    creditOutstandingMinor: { $gt: 0 }
  }).select("creditOutstandingMinor issuedAt").lean().exec();

  const oldestIssuedAt = invoices.reduce<Date | null>(
    (oldest, invoice) => (!oldest || invoice.issuedAt < oldest ? invoice.issuedAt : oldest),
    null
  );

  return {
    count: invoices.length,
    valueMinor: invoices.reduce((total, invoice) => total + invoice.creditOutstandingMinor, 0),
    oldestIssuedAt
  };
}

/** The open increase request for one account, so the reviewer sees what was asked for. */
async function openLimitIncrease(businessAccountId: mongoose.Types.ObjectId) {
  const pending = await CreditLimitIncreaseRequest.findOne({ businessAccountId, status: "PENDING" }).lean().exec();
  return pending ? serializeLimitIncrease(pending) : null;
}

export async function getAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const businessAccountId = accountId(request);
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const business = await BusinessAccount.findById(businessAccountId).exec();
  if (!business) return response.status(404).json({ success: false, message: "Business account not found." });
  const account = getOperatorContext(request)?.accessMode === "PLATFORM_SUPPORT"
    ? await BusinessCreditAccount.findOne({ businessAccountId }).exec()
    : await ensureCreditAccount(businessAccountId);
  if (!account) return response.status(404).json({ success: false, message: "Credit account not found." });
  const history = await CreditLimitHistory.find({ businessAccountId }).sort({ changedAt: -1 }).limit(50).lean().exec();
  const summary = businessSummary(business);
  return response.status(200).json({
    success: true,
    creditAccount: { ...await serializeAdminCreditAccount(account), businessAccount: summary },
    businessAccount: summary,
    awaitingCollection: await summarizeAwaitingCollection(businessAccountId),
    limitIncreaseRequest: await openLimitIncrease(businessAccountId),
    limitHistory: history
  });
}

export async function approveAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const operator = getOperatorContext(request);
  const operatorApproval = operator?.accessMode === "MEMBER";
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const parsed = approvalSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Check the credit approval details." });
  const validFrom = dateOrNull(parsed.data.validFrom);
  const validUntil = dateOrNull(parsed.data.validUntil);
  if (parsed.data.validFrom && !validFrom) return response.status(400).json({ success: false, message: "Valid-from date is invalid." });
  if (parsed.data.validUntil && !validUntil) return response.status(400).json({ success: false, message: "Valid-until date is invalid." });
  if (validFrom && validUntil && validUntil <= validFrom) return response.status(400).json({ success: false, message: "Credit expiry must be after its start date." });
  if (parsed.data.maxOverdueDays < parsed.data.gracePeriodDays) {
    return response.status(400).json({ success: false, message: "Maximum overdue days cannot be shorter than the grace period." });
  }

  const session = await mongoose.startSession();
  try {
    let result: { account: ReturnType<typeof serializeCreditAccount>; wasActive: boolean } | undefined;
    await session.withTransaction(async () => {
      const business = await BusinessAccount.findById(businessAccountId).session(session).exec();
      if (!business) throw new Error("BUSINESS_NOT_FOUND");
      const account = await ensureCreditAccount(businessAccountId, session);

      // A live facility must stay live after an edit- resetting it to APPROVED
      // would zero its available credit and break in-flight bookings.
      if (account.status === "CLOSED") throw new Error("CREDIT_CLOSED_IMMUTABLE");
      if (account.status === "SUSPENDED") throw new Error("CREDIT_SUSPENDED_EDIT");
      const wasActive = account.status === "ACTIVE";

      if (operatorApproval) {
        const blockers = getCreditActivationBlockers({
          businessStatus: business.status,
          kycStatus: business.kycReview.overallStatus,
          depositStatus: business.depositStatus,
          securityDepositRequiredMinor: parsed.data.securityDepositRequiredMinor,
          approvedCreditLimitMinor: parsed.data.approvedCreditLimitMinor,
          validUntil
        }, { requireAgreement: false });
        if (blockers.length) throw new Error(`CREDIT_OPERATOR_ACTIVATION_BLOCKED:${blockers[0]}`);
      }

      // Never let the approved limit drop below what is already committed.
      const usedCreditMinor = account.reservedCreditMinor + account.unbilledCreditMinor + account.invoicedOutstandingMinor;
      if (parsed.data.approvedCreditLimitMinor < usedCreditMinor) throw new Error("CREDIT_LIMIT_BELOW_USED");

      const previousLimitMinor = account.approvedCreditLimitMinor;
      account.status = operatorApproval || wasActive ? "ACTIVE" : "APPROVED";
      if (operatorApproval && !wasActive) {
        account.activatedBy = currentUserId;
        account.activatedAt = new Date();
      }
      account.approvedCreditLimitMinor = parsed.data.approvedCreditLimitMinor;
      account.paymentTermsDays = parsed.data.paymentTermsDays;
      account.billingCycle = parsed.data.billingCycle;
      account.validFrom = validFrom;
      account.validUntil = validUntil;
      account.gracePeriodDays = parsed.data.gracePeriodDays;
      account.maxOverdueDays = parsed.data.maxOverdueDays;
      account.creditWarningThresholdPercent = parsed.data.creditWarningThresholdPercent;
      account.securityDepositRequiredMinor = parsed.data.securityDepositRequiredMinor;
      account.riskCategory = parsed.data.riskCategory;
      // Operator reviews do not expose Swiftline's internal-remarks field.
      // Preserve any existing value when the shared approval handler serves an
      // operator member; Swiftline staff continue to save the submitted field.
      if (!operatorApproval) account.internalRemarks = parsed.data.internalRemarks;
      account.reviewedBy = currentUserId;
      account.reviewedAt = new Date();
      account.holdReason = "";
      account.version += 1;
      await account.save({ session });
      // Written as a targeted update rather than business.save(): saving the
      // whole document revalidates every unrelated field, so an account still
      // carrying pre-storage-service KYC rows fails validation and takes the
      // credit decision down with it. Only these two fields are ours to change.
      await BusinessAccount.updateOne(
        { _id: businessAccountId },
        { $set: { creditLimitStatus: "approved", updatedBy: currentUserId } },
        { session }
      ).exec();
      if (previousLimitMinor !== account.approvedCreditLimitMinor) {
        await CreditLimitHistory.create([{
          businessAccountId, creditAccountId: account._id, previousLimitMinor,
          newLimitMinor: account.approvedCreditLimitMinor, reason: parsed.data.reason,
          changedBy: currentUserId, changedAt: new Date()
        }], { session });
      }
      await appendCreditLedgerEntry({
        account, type: previousLimitMinor ? "LIMIT_CHANGED" : "CREDIT_APPROVED",
        reference: `CREDIT-APPROVAL-${account.version}`, description: "Business credit facility approved.",
        amountMinor: account.approvedCreditLimitMinor,
        idempotencyKey: `CREDIT_APPROVAL:${String(account._id)}:${account.version}`,
        createdBy: currentUserId, metadata: { previousLimitMinor, reason: parsed.data.reason }, session
      });
      if (operatorApproval && !wasActive) {
        await appendCreditLedgerEntry({
          account, type: "CREDIT_ACTIVATED", reference: `CREDIT-ACTIVATION-${account.version}`,
          description: "Operator credit facility activated.", amountMinor: 0,
          idempotencyKey: `CREDIT_ACTIVATION:${String(account._id)}:${account.version}`,
          createdBy: currentUserId, session
        });
        await AuditLog.create([{
          action: "CREDIT_ACCOUNT_ACTIVATED", entityType: "BUSINESS_CREDIT_ACCOUNT", entityId: account._id,
          performedBy: currentUserId, performedAt: new Date(), metadata: { businessAccountId }
        }], { session });
      }
      result = { account: serializeCreditAccount(account), wasActive };
    });
    const stayedActive = result?.wasActive ?? false;
    if (result) {
      // Setting the limit answers any open increase request, whatever the
      // reviewer actually granted- so the customer stops seeing "under review"
      // and the next request is not blocked by a stale one.
      await CreditLimitIncreaseRequest.updateOne(
        { businessAccountId, status: "PENDING" },
        {
          $set: {
            status: "APPROVED",
            reviewedBy: currentUserId,
            reviewedAt: new Date(),
            decidedLimitMinor: parsed.data.approvedCreditLimitMinor,
            decisionNote: parsed.data.reason
          }
        }
      ).exec();
      await notifyBusinessFinancialMembers(businessAccountId, {
        // Re-approving a live facility is a terms change, not a new decision.
        type: stayedActive ? "CREDIT_ACCOUNT_STATUS_CHANGED" : "CREDIT_REQUEST_APPROVED",
        title: stayedActive ? "Credit terms updated" : "Credit facility approved",
        message: stayedActive
          ? `Your credit facility now carries a limit of ${formatMinorRupees(result.account.approvedCreditLimitMinor)}.`
          : operatorApproval
            ? `Your credit facility is active with a limit of ${formatMinorRupees(result.account.approvedCreditLimitMinor)}.`
            : `A credit limit of ${formatMinorRupees(result.account.approvedCreditLimitMinor)} was approved. Complete the remaining activation steps to start using it.`,
        href: operatorApproval ? `/portal/${encodeURIComponent(operator!.slug)}/credit` : creditClientHref,
        idempotencyKey: `CREDIT_APPROVED:${result.account.id}:${result.account.version}`,
        metadata: { approvedCreditLimitMinor: result.account.approvedCreditLimitMinor }
      });
    }
    return response.status(200).json({
      success: true,
      message: stayedActive
        ? "Credit facility updated. It remains active with the new terms."
        : operatorApproval
          ? "Credit facility approved and activated."
          : "Credit facility approved. Activate it after all requirements are complete.",
      creditAccount: result?.account
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "BUSINESS_NOT_FOUND") return response.status(404).json({ success: false, message: "Business account not found." });
      if (error.message === "CREDIT_CLOSED_IMMUTABLE") return response.status(409).json({ success: false, message: "A closed credit facility cannot be modified." });
      if (error.message === "CREDIT_SUSPENDED_EDIT") return response.status(409).json({ success: false, message: "Reactivate the credit facility before changing its terms." });
      if (error.message === "CREDIT_LIMIT_BELOW_USED") return response.status(409).json({ success: false, message: "Approved limit cannot be lower than the credit already in use. Collect payments first." });
      if (error.message.startsWith("CREDIT_OPERATOR_ACTIVATION_BLOCKED:")) {
        return response.status(409).json({ success: false, message: error.message.slice("CREDIT_OPERATOR_ACTIVATION_BLOCKED:".length) });
      }
    }
    throw error;
  } finally { await session.endSession(); }
}

export async function activateAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const currentUser = (request as Request & { user?: { _id?: unknown; role?: string; name?: string; email?: string } }).user;
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (currentUser?.role !== "admin") return response.status(403).json({ success: false, message: "Only an administrator can sign and activate a credit facility." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const parsed = activationSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Review and confirm the credit agreement." });
  if (!mongoose.Types.ObjectId.isValid(parsed.data.agreementId)) {
    return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  }
  const business = await BusinessAccount.findById(businessAccountId).exec();
  const account = await BusinessCreditAccount.findOne({ businessAccountId }).exec();
  if (!business || !account) return response.status(404).json({ success: false, message: "Credit account not found." });
  if (account.status !== "APPROVED") return response.status(409).json({ success: false, message: "Approve the credit facility before activation." });
  const blockers = getCreditActivationBlockers({
    businessStatus: business.status,
    kycStatus: business.kycReview.overallStatus,
    agreementStatus: business.agreementStatus,
    depositStatus: business.depositStatus,
    securityDepositRequiredMinor: account.securityDepositRequiredMinor,
    approvedCreditLimitMinor: account.approvedCreditLimitMinor,
    validUntil: account.validUntil
  }, { requireAgreement: false });
  if (blockers.length) return response.status(409).json({ success: false, message: blockers[0], blockers });

  const agreementId = new mongoose.Types.ObjectId(parsed.data.agreementId);
  const agreement = await CreditAgreement.findOne({ _id: agreementId, businessAccountId }).exec();
  if (!agreement) return response.status(404).json({ success: false, message: "Credit agreement was not found." });

  if (agreement.status !== "SIGNED") {
    try {
      await signCreditAgreement({
        agreementId,
        signedBy: currentUserId,
        signer: {
          name: currentUser.name?.trim() || currentUser.email || "Swiftline Administrator",
          email: currentUser.email || "",
          jobTitle: "",
          ipAddress: request.ip || "unknown",
          userAgent: request.get("user-agent") || ""
        },
        notify: false
      });
    } catch (error) {
      if (error instanceof CreditAgreementServiceError) return creditAgreementErrorResponse(error, response);
      throw error;
    }
  }

  // Version-guarded so two concurrent admin actions cannot clobber each other.
  const updated = await BusinessCreditAccount.findOneAndUpdate(
    { _id: account._id, version: account.version, status: "APPROVED" },
    { $set: { status: "ACTIVE", activatedBy: currentUserId, activatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) return response.status(409).json({ success: false, message: "The credit account changed while activating. Reload and try again." });

  await appendCreditLedgerEntry({
    account: updated, type: "CREDIT_ACTIVATED", reference: `CREDIT-ACTIVATION-${updated.version}`,
    description: "Business credit facility activated.", idempotencyKey: `CREDIT_ACTIVATION:${String(updated._id)}:${updated.version}`,
    createdBy: currentUserId
  });
  await AuditLog.create({
    action: "CREDIT_ACCOUNT_ACTIVATED", entityType: "BUSINESS_CREDIT_ACCOUNT", entityId: updated._id,
    performedBy: currentUserId, performedAt: new Date(), metadata: { businessAccountId }
  });
  await notifyBusinessFinancialMembers(businessAccountId, {
    type: "CREDIT_ACCOUNT_STATUS_CHANGED",
    title: "Credit facility activated",
    message: `Your credit facility is live with a limit of ${formatMinorRupees(updated.approvedCreditLimitMinor)}. You can now book shipments on credit.`,
    href: creditClientHref,
    idempotencyKey: `CREDIT_STATUS_NOTICE:${String(updated._id)}:ACTIVE:${updated.version}`,
    metadata: { status: updated.status }
  });
  return response.status(200).json({ success: true, message: "Credit facility activated.", creditAccount: serializeCreditAccount(updated) });
}

class CreditLifecycleError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function humanStatus(status: string) {
  return status.toLowerCase().replace(/_/g, " ");
}

// Shared, version-guarded status transition. The account update and its ledger +
// audit entries all commit together, and the version guard prevents two admins
// from clobbering each other.
async function runCreditStatusTransition(input: {
  businessAccountId: mongoose.Types.ObjectId;
  currentUserId: mongoose.Types.ObjectId;
  allowedFrom: CreditAccountStatus[];
  toStatus: CreditAccountStatus;
  reason: string;
  holdReason: string;
  ledgerType: CreditLedgerEntryType;
  auditAction: AuditAction;
  description: string;
  clientNotice: { title: string; message: string };
  guard?: (account: IBusinessCreditAccount) => string | null;
}) {
  const session = await mongoose.startSession();
  try {
    let serialized: ReturnType<typeof serializeCreditAccount> | undefined;
    await session.withTransaction(async () => {
      const account = await BusinessCreditAccount.findOne({ businessAccountId: input.businessAccountId }).session(session).exec();
      if (!account) throw new CreditLifecycleError(404, "Credit account not found.");
      if (!input.allowedFrom.includes(account.status)) {
        throw new CreditLifecycleError(409, `A ${humanStatus(account.status)} credit facility cannot be moved to ${humanStatus(input.toStatus)}.`);
      }
      const guardMessage = input.guard?.(account);
      if (guardMessage) throw new CreditLifecycleError(409, guardMessage);

      const updated = await BusinessCreditAccount.findOneAndUpdate(
        { _id: account._id, version: account.version },
        { $set: { status: input.toStatus, holdReason: input.holdReason }, $inc: { version: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!updated) throw new CreditLifecycleError(409, "The credit account changed while updating. Try again.");

      await appendCreditLedgerEntry({
        account: updated,
        type: input.ledgerType,
        reference: `CREDIT-${input.toStatus}-${updated.version}`,
        description: input.description,
        idempotencyKey: `CREDIT_STATUS:${String(updated._id)}:${input.toStatus}:${updated.version}`,
        createdBy: input.currentUserId,
        metadata: { reason: input.reason, fromStatus: account.status, toStatus: input.toStatus },
        session
      });
      await AuditLog.create([{
        action: input.auditAction,
        entityType: "BUSINESS_CREDIT_ACCOUNT",
        entityId: updated._id,
        performedBy: input.currentUserId,
        performedAt: new Date(),
        metadata: { businessAccountId: input.businessAccountId, reason: input.reason, fromStatus: account.status, toStatus: input.toStatus }
      }], { session });

      await notifyBusinessFinancialMembers(input.businessAccountId, {
        type: "CREDIT_ACCOUNT_STATUS_CHANGED",
        title: input.clientNotice.title,
        message: input.clientNotice.message,
        href: creditClientHref,
        idempotencyKey: `CREDIT_STATUS_NOTICE:${String(updated._id)}:${input.toStatus}:${updated.version}`,
        metadata: { fromStatus: account.status, toStatus: input.toStatus }
      }, session);

      serialized = serializeCreditAccount(updated);
    });
    return { ok: true as const, account: serialized };
  } catch (error) {
    if (error instanceof CreditLifecycleError) return { ok: false as const, statusCode: error.statusCode, message: error.message };
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function suspendAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const parsed = reasonSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Provide a reason for suspension." });

  const result = await runCreditStatusTransition({
    businessAccountId, currentUserId,
    allowedFrom: ["ACTIVE"], toStatus: "SUSPENDED",
    reason: parsed.data.reason, holdReason: parsed.data.reason,
    ledgerType: "CREDIT_SUSPENDED", auditAction: "CREDIT_ACCOUNT_SUSPENDED",
    description: "Business credit facility suspended.",
    clientNotice: {
      title: "Credit facility suspended",
      message: "Credit bookings are paused while your facility is suspended. Contact your Swiftline branch for details."
    }
  });
  if (!result.ok) return response.status(result.statusCode).json({ success: false, message: result.message });
  return response.status(200).json({ success: true, message: "Credit facility suspended.", creditAccount: result.account });
}

export async function reactivateAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const parsed = reasonSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Provide a reason for reactivation." });

  const result = await runCreditStatusTransition({
    businessAccountId, currentUserId,
    allowedFrom: ["SUSPENDED"], toStatus: "ACTIVE",
    reason: parsed.data.reason, holdReason: "",
    ledgerType: "CREDIT_REACTIVATED", auditAction: "CREDIT_ACCOUNT_REACTIVATED",
    description: "Business credit facility reactivated.",
    clientNotice: {
      title: "Credit facility reactivated",
      message: "Your credit facility is active again and available for bookings."
    },
    guard: (account) => {
      if (account.approvedCreditLimitMinor <= 0) return "Approve a credit limit before reactivating.";
      if (account.validUntil && account.validUntil <= new Date()) {
        return "Credit validity has expired. Re-approve with a new validity period before reactivating.";
      }
      return null;
    }
  });
  if (!result.ok) return response.status(result.statusCode).json({ success: false, message: result.message });
  return response.status(200).json({ success: true, message: "Credit facility reactivated.", creditAccount: result.account });
}

export async function closeAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  const parsed = reasonSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Provide a reason for closing the facility." });

  const result = await runCreditStatusTransition({
    businessAccountId, currentUserId,
    allowedFrom: ["APPROVED", "ACTIVE", "SUSPENDED", "EXPIRED", "REJECTED"], toStatus: "CLOSED",
    reason: parsed.data.reason, holdReason: parsed.data.reason,
    ledgerType: "CREDIT_CLOSED", auditAction: "CREDIT_ACCOUNT_CLOSED",
    description: "Business credit facility closed.",
    clientNotice: {
      title: "Credit facility closed",
      message: "Your credit facility has been closed. Any outstanding statements remain payable."
    },
    // Closing stops new usage but does not forgive outstanding statements; it must
    // not strand funds reserved for a booking still in flight.
    guard: (account) => (account.reservedCreditMinor > 0 || account.reservedAdvanceMinor > 0)
      ? "Resolve in-flight bookings before closing this facility."
      : null
  });
  if (!result.ok) return response.status(result.statusCode).json({ success: false, message: result.message });
  return response.status(200).json({ success: true, message: "Credit facility closed.", creditAccount: result.account });
}

export async function rejectAdminCreditAccount(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const businessAccountId = accountId(request);
  const parsed = reasonSchema.safeParse(request.body);
  if (!currentUserId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found." });
  if (!parsed.success) return response.status(400).json({ success: false, message: "Provide a reason for rejection." });
  const account = await ensureCreditAccount(businessAccountId);
  if (!["NOT_REQUESTED", "PENDING_REVIEW", "APPROVED", "REJECTED"].includes(account.status)) {
    return response.status(409).json({ success: false, message: "This credit facility cannot be rejected in its current status." });
  }

  // Version-guarded so concurrent admin actions cannot clobber each other.
  const updated = await BusinessCreditAccount.findOneAndUpdate(
    { _id: account._id, version: account.version },
    { $set: { status: "REJECTED", internalRemarks: parsed.data.reason, reviewedBy: currentUserId, reviewedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) return response.status(409).json({ success: false, message: "The credit account changed while rejecting. Reload and try again." });

  await BusinessAccount.findByIdAndUpdate(businessAccountId, { creditLimitStatus: "not_approved", updatedBy: currentUserId }).exec();
  await appendCreditLedgerEntry({
    account: updated, type: "CREDIT_REJECTED", reference: `CREDIT-REJECTION-${updated.version}`,
    description: "Business credit request rejected.", idempotencyKey: `CREDIT_REJECTION:${String(updated._id)}:${updated.version}`,
    createdBy: currentUserId, metadata: { reason: parsed.data.reason }
  });
  await notifyBusinessFinancialMembers(businessAccountId, {
    type: "CREDIT_REQUEST_REJECTED",
    title: "Credit request rejected",
    message: `Your credit request was not approved. Reason: ${parsed.data.reason}`,
    href: creditClientHref,
    idempotencyKey: `CREDIT_REJECTED:${String(updated._id)}:${updated.version}`,
    metadata: { reason: parsed.data.reason }
  });
  return response.status(200).json({ success: true, message: "Credit request rejected.", creditAccount: serializeCreditAccount(updated) });
}
