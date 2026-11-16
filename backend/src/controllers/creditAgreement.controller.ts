import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditAgreement, creditAgreementStatusValues, type ICreditAgreement } from "../models/creditAgreement.model.js";
import {
  createCreditAgreementDraft,
  CreditAgreementServiceError,
  generateCreditAgreement,
  serializeCreditAgreement,
  signCreditAgreement
} from "../services/creditAgreement.service.js";
import {
  StorageObjectNotFoundError,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import { getCreditActivationBlockers, getMemberCreditPermissions } from "../services/creditAccount.service.js";
import { suspensionMode } from "../services/businessAccountSuspension.service.js";

const listAdminQuerySchema = z.object({
  businessAccountId: z.string().trim().optional(),
  status: z.enum(creditAgreementStatusValues).optional()
});

function authenticatedUser(request: Request) {
  return (request as Request & { user?: { _id?: unknown; email?: string; name?: string; role?: string } }).user;
}

// Client access remains read-only; administrators complete signing during activation.

function authenticatedUserId(request: Request) {
  const id = authenticatedUser(request)?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function objectId(value: unknown) {
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

async function clientMembership(request: Request, businessAccountId: mongoose.Types.ObjectId) {
  const userId = authenticatedUserId(request);
  if (!userId) return null;
  const membership = await BusinessAccountMember.findOne({
    businessAccount: businessAccountId,
    user: userId,
    status: "active"
  }).exec();
  if (!membership) return null;

  // Agreement PDFs and terms are account-specific financial records. A user
  // who can still work in another account must not use that session to read a
  // security-locked account's agreements.
  const account = await BusinessAccount.findById(businessAccountId)
    .select("status suspension.mode")
    .lean()
    .exec();
  return account && suspensionMode(account) !== "SECURITY_LOCK" ? membership : null;
}

function serviceErrorResponse(error: CreditAgreementServiceError, response: Response) {
  if (["BUSINESS_NOT_FOUND", "AGREEMENT_NOT_FOUND"].includes(error.code)) {
    return response.status(404).json({ success: false, message: error.message });
  }
  return response.status(409).json({ success: false, message: error.message, code: error.code });
}

export async function generateAdminCreditAgreement(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Please sign in again." });
  const agreementId = objectId(request.params.agreementId);
  if (!agreementId) return response.status(404).json({ success: false, message: "Credit agreement was not found." });

  try {
    const agreement = await generateCreditAgreement({ agreementId, generatedBy: userId });
    return response.status(200).json({
      success: true,
      message: "Credit agreement generated.",
      agreement: serializeCreditAgreement(agreement, { includeAuditDetails: true })
    });
  } catch (error) {
    if (error instanceof CreditAgreementServiceError) return serviceErrorResponse(error, response);
    throw error;
  }
}
export async function getAdminCreditAgreementPdf(request: Request, response: Response): Promise<Response | void> {
  const agreementId = objectId(request.params.agreementId);
  if (!agreementId) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const agreement = await CreditAgreement.findById(agreementId).exec();
  const document = agreement?.signedDocument ?? agreement?.generatedDocument;
  if (!agreement || !document) {
    return response.status(409).json({ success: false, message: "Generate the credit agreement before opening its PDF." });
  }

  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: "application/pdf",
      filename: document.originalName,
      disposition: request.query.download === "1" ? "attachment" : "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "The generated agreement file could not be found." });
    }
    throw error;
  }
}

export async function createAdminCreditAgreementDraft(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Please sign in again." });
  const businessAccountId = objectId(request.params.businessAccountId);
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account was not found." });

  try {
    const agreement = await createCreditAgreementDraft({ businessAccountId, createdBy: userId });
    return response.status(201).json({
      success: true,
      message: "Credit agreement draft created.",
      agreement: serializeCreditAgreement(agreement, { includeAuditDetails: true })
    });
  } catch (error) {
    if (error instanceof CreditAgreementServiceError) return serviceErrorResponse(error, response);
    throw error;
  }
}
/**
 * Prepares the agreement shown by the admin activation dialog. Preparation is
 * deliberately separate from activation so the admin can review the exact PDF
 * that will be signed, while the final activation request remains guarded by
 * the account and agreement version checks.
 */
export async function prepareAdminCreditActivationAgreement(request: Request, response: Response): Promise<Response> {
  const currentUser = authenticatedUser(request);
  const userId = authenticatedUserId(request);
  if (!userId || currentUser?.role !== "admin") {
    return response.status(403).json({ success: false, message: "Only an administrator can prepare an activation agreement." });
  }
  const businessAccountId = objectId(request.params.businessAccountId);
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account was not found." });

  try {
    const [business, credit] = await Promise.all([
      BusinessAccount.findById(businessAccountId).exec(),
      BusinessCreditAccount.findOne({ businessAccountId }).exec()
    ]);
    if (!business || !credit) return response.status(404).json({ success: false, message: "Credit account was not found." });
    if (credit.status !== "APPROVED") {
      return response.status(409).json({ success: false, message: "Approve the credit facility before activation." });
    }

    const blockers = getCreditActivationBlockers({
      businessStatus: business.status,
      kycStatus: business.kycReview.overallStatus,
      agreementStatus: business.agreementStatus,
      depositStatus: business.depositStatus,
      securityDepositRequiredMinor: credit.securityDepositRequiredMinor,
      approvedCreditLimitMinor: credit.approvedCreditLimitMinor,
      validUntil: credit.validUntil
    }, { requireAgreement: false });
    if (blockers.length) return response.status(409).json({ success: false, message: blockers[0], blockers });

    let agreement: ICreditAgreement | null = await CreditAgreement.findOne({
      businessAccountId,
      status: { $in: ["DRAFT", "GENERATED", "SENT", "VIEWED", "SIGNED"] }
    }).sort({ version: -1 }).exec();

    if (!agreement) {
      try {
        agreement = await createCreditAgreementDraft({ businessAccountId, createdBy: userId });
      } catch (error) {
        if (!(error instanceof CreditAgreementServiceError) || error.code !== "OPEN_AGREEMENT_EXISTS") throw error;
        agreement = await CreditAgreement.findOne({
          businessAccountId,
          status: { $in: ["DRAFT", "GENERATED", "SENT", "VIEWED", "SIGNED"] }
        }).sort({ version: -1 }).exec();
      }
    }

    if (!agreement) return response.status(409).json({ success: false, message: "The activation agreement changed while it was being prepared. Try again." });
    if (agreement.status === "DRAFT") agreement = await generateCreditAgreement({ agreementId: agreement._id, generatedBy: userId });

    return response.status(200).json({
      success: true,
      message: agreement.status === "SIGNED" ? "The signed credit agreement is ready." : "The credit agreement is ready for administrator approval.",
      agreement: serializeCreditAgreement(agreement, { includeAuditDetails: true })
    });
  } catch (error) {
    if (error instanceof CreditAgreementServiceError) return serviceErrorResponse(error, response);
    throw error;
  }
}
export async function listAdminCreditAgreements(request: Request, response: Response): Promise<Response> {
  const parsed = listAdminQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Check the agreement filters." });
  const filter: Record<string, unknown> = {};
  if (parsed.data.status) filter.status = parsed.data.status;
  if (parsed.data.businessAccountId) {
    const businessAccountId = objectId(parsed.data.businessAccountId);
    if (!businessAccountId) return response.status(400).json({ success: false, message: "Business account filter is invalid." });
    filter.businessAccountId = businessAccountId;
  }

  const agreements = await CreditAgreement.find(filter).sort({ createdAt: -1 }).limit(100).exec();
  return response.status(200).json({
    success: true,
    agreements: agreements.map((agreement) => serializeCreditAgreement(agreement, { includeAuditDetails: true }))
  });
}

export async function getAdminCreditAgreement(request: Request, response: Response): Promise<Response> {
  const agreementId = objectId(request.params.agreementId);
  if (!agreementId) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const agreement = await CreditAgreement.findById(agreementId).exec();
  if (!agreement) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const auditHistory = await AuditLog.find({ entityType: "CREDIT_AGREEMENT", entityId: agreement._id })
    .sort({ performedAt: -1 })
    .lean()
    .exec();
  return response.status(200).json({
    success: true,
    agreement: serializeCreditAgreement(agreement, { includeAuditDetails: true }),
    auditHistory
  });
}

export async function listClientCreditAgreements(request: Request, response: Response): Promise<Response> {
  const businessAccountId = objectId(request.query.businessAccountId);
  if (!businessAccountId) return response.status(400).json({ success: false, message: "Select a valid business account." });
  const membership = await clientMembership(request, businessAccountId);
  if (!membership) return response.status(404).json({ success: false, message: "Business account access was not found." });
  const permissions = getMemberCreditPermissions(membership.role, membership.creditPermissions);
  if (!permissions.includes("viewCreditDetails")) {
    return response.status(403).json({ success: false, message: "Your account role cannot view credit agreements." });
  }
  const agreements = await CreditAgreement.find({ businessAccountId }).sort({ version: -1 }).limit(50).exec();
  return response.status(200).json({
    success: true,
    agreements: agreements.map((agreement) => serializeCreditAgreement(agreement))
  });
}

export async function getClientCreditAgreement(request: Request, response: Response): Promise<Response> {
  const agreementId = objectId(request.params.agreementId);
  if (!agreementId) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const agreement = await CreditAgreement.findById(agreementId).exec();
  if (!agreement) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const membership = await clientMembership(request, agreement.businessAccountId);
  if (!membership) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const permissions = getMemberCreditPermissions(membership.role, membership.creditPermissions);
  if (!permissions.includes("viewCreditDetails")) {
    return response.status(403).json({ success: false, message: "Your account role cannot view credit agreements." });
  }
  return response.status(200).json({
    success: true,
    agreement: serializeCreditAgreement(agreement)
  });
}

export async function getClientCreditAgreementPdf(request: Request, response: Response): Promise<Response | void> {
  const userId = authenticatedUserId(request);
  const agreementId = objectId(request.params.agreementId);
  if (!userId) return response.status(401).json({ success: false, message: "Please sign in again." });
  if (!agreementId) return response.status(404).json({ success: false, message: "Credit agreement was not found." });

  const agreement = await CreditAgreement.findById(agreementId).exec();
  if (!agreement || agreement.status === "DRAFT") return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const membership = await clientMembership(request, agreement.businessAccountId);
  if (!membership) return response.status(404).json({ success: false, message: "Credit agreement was not found." });
  const permissions = getMemberCreditPermissions(membership.role, membership.creditPermissions);
  if (!permissions.includes("viewCreditDetails")) {
    return response.status(403).json({ success: false, message: "Your account role cannot view credit agreements." });
  }

  const document = agreement.signedDocument ?? agreement.generatedDocument;
  if (!document) return response.status(409).json({ success: false, message: "The agreement document is not available yet." });

  if (["GENERATED", "SENT"].includes(agreement.status)) {
    const viewedAt = new Date();
    const viewed = await CreditAgreement.findOneAndUpdate(
      { _id: agreement._id, status: { $in: ["GENERATED", "SENT"] } },
      { $set: { status: "VIEWED", viewedAt, updatedBy: userId } },
      { returnDocument: "after" }
    ).exec();
    if (viewed) {
      await AuditLog.create({
        action: "CREDIT_AGREEMENT_VIEWED",
        entityType: "CREDIT_AGREEMENT",
        entityId: agreement._id,
        performedBy: userId,
        performedAt: viewedAt,
        metadata: { businessAccountId: agreement.businessAccountId, agreementNumber: agreement.agreementNumber }
      });
    }
  }

  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: "application/pdf",
      filename: document.originalName,
      disposition: request.query.download === "1" ? "attachment" : "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "The agreement file could not be found." });
    }
    throw error;
  }
}

// Client signing is intentionally not exposed by this router.
