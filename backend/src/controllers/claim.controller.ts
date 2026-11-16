import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Claim } from "../models/claim.model.js";
import { ClaimDocument, claimDocumentCategoryValues } from "../models/claimDocument.model.js";
import { ClaimEvent } from "../models/claimEvent.model.js";
import { ClaimMessage } from "../models/claimMessage.model.js";
import { ClaimDecision } from "../models/claimDecision.model.js";
import { ClaimBeneficiary, ClaimSettlement } from "../models/claimSettlement.model.js";
import { ClaimRecovery } from "../models/claimRecovery.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { User } from "../models/user.model.js";
import { claimCategoryValues, claimRecoveryStateValues, claimStatusValues } from "../models/claimTypes.js";
import { buildClaimChecklistFor } from "../services/claims/claimChecklist.service.js";
import { claimExportColumns, claimFinancialExportColumns, staffClaimExportColumns } from "../services/export/exportColumns.js";
import { EXPORT_ROW_CAP, describeFilters, exportFormat, sendTableExport } from "../services/export/tableExportHttp.js";
import {
  acceptSettlement,
  ClaimDecisionError,
  decideClaim,
  recordSettlement,
  submitAppeal,
  submitBeneficiary,
  upsertRecovery,
  verifyBeneficiary
} from "../services/claims/claimDecision.service.js";
import {
  ClaimDocumentError,
  removeClaimDocument,
  reviewClaimDocument,
  streamClaimDocument,
  uploadClaimDocument
} from "../services/claims/claimDocument.service.js";
import {
  checkClaimEligibility,
  ClaimEligibilityError,
  listClaimableShipments
} from "../services/claims/claimEligibility.service.js";
import {
  ClaimSubmissionError,
  createClaimDraft,
  deleteClaimDraft,
  submitClaim,
  updateClaimDraft
} from "../services/claims/claimSubmission.service.js";
import { availableTransitions } from "../services/claims/claimStateMachine.js";
import { clientCan, staffCan, type ClaimAction } from "../services/claims/claimPermissions.js";
import {
  awaitClaimThirdParty,
  claimCarrierAcknowledged,
  closeClaim,
  completeClaimDocuments,
  disputeClaimSettlement,
  receiveClaimInformation,
  reopenClaim,
  requestClaimDocuments,
  requestClaimInformation,
  sendClaimForApproval,
  startClaimReview,
  thirdPartyResponded,
  waiveClaimDocument,
  requestConditionalDocuments,
  withdrawClaim,
  ClaimWorkflowError
} from "../services/claims/claimWorkflow.service.js";
import { notifyClaimClientReplied } from "../services/claims/claimNotification.service.js";
import { setClaimLegalHold, ClaimRetentionError } from "../services/claims/claimRetention.service.js";
import { computeClaimSla } from "../services/claims/claimSla.service.js";
import { buildClaimDecisionPdf } from "../services/claims/claimDecisionPdf.service.js";
import { decryptSecret } from "../services/credentialEncryption.service.js";
import { AuditLog } from "../models/auditLog.model.js";
import type { Role } from "../models/user.model.js";
import {
  availableClientAccountIds,
  securityLockMessage,
  suspensionMessage,
  suspensionMode
} from "../services/businessAccountSuspension.service.js";

/**
 * HTTP surface for claims- client and staff.
 *
 * Route handlers stay thin: they authenticate, validate, delegate, and shape a
 * response. Every rule that matters lives in the services, so nothing can be
 * bypassed by reaching a different endpoint.
 */

type AuthedRequest = Request & {
  user?: { _id?: unknown; role?: Role; assignedBranches?: unknown[] };
};

function actor(request: Request) {
  const user = (request as AuthedRequest).user;
  const id = user?._id;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return {
    id: String(id),
    role: (user?.role ?? "client") as Role,
    branchIds: (user?.assignedBranches ?? []).map(String)
  };
}

/**
 * Maps a service error to its status code.
 *
 * Anything unrecognised is passed to the error middleware rather than guessed
 * at- a 500 that reaches the logs is better than a 400 that hides a bug.
 */
function handle(error: unknown, response: Response, next: NextFunction) {
  const known =
    error instanceof ClaimSubmissionError ||
    error instanceof ClaimEligibilityError ||
    error instanceof ClaimDocumentError ||
    error instanceof ClaimDecisionError ||
    error instanceof ClaimWorkflowError ||
    error instanceof ClaimRetentionError;

  if (known) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return response.status(400).json({ success: false, message: error.issues[0]?.message ?? "Invalid request." });
  }

  /**
   * A model validator refusing the input.
   *
   * These are rules the caller broke- approving more than was requested, paying
   * more than was approved- not server faults. Reported with the validator's
   * own message, which is written for a person, rather than as a 500.
   */
  if (error instanceof mongoose.Error.ValidationError) {
    const first = Object.values(error.errors)[0];
    return response.status(400).json({
      success: false,
      message: first?.message ?? "Some of the values supplied are not valid."
    });
  }

  /**
   * A unique-index collision, translated into the reason it happened.
   *
   * The service checks for an existing claim before creating one, so reaching
   * the index means two requests raced- two tabs, or a double submit. That is a
   * conflict the caller can act on, not a server fault, and "Internal server
   * error" tells them nothing.
   */
  const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (duplicate?.code === 11000) {
    const key = Object.keys(duplicate.keyPattern ?? {})[0];
    const message =
      key === "activeShipmentDraftId"
        ? "A claim is already open for this shipment."
        : key === "claimNumber"
          ? "A claim number collided. Please try again."
          : "That record already exists.";
    return response.status(409).json({ success: false, message });
  }
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode && statusCode < 500) {
    return response.status(statusCode).json({ success: false, message: (error as Error).message });
  }
  return next(error);
}

/**
 * Confirms the caller is an active member of the claim's account.
 *
 * Returns null rather than throwing so callers answer 404- a 403 would confirm
 * the claim exists to someone with no right to know that.
 */
async function clientAccess(claimId: string, userId: string) {
  if (!mongoose.isValidObjectId(claimId)) return null;
  const claim = await Claim.findById(claimId).exec();
  if (!claim) return null;

  const membership = await BusinessAccountMember.findOne({
    user: new mongoose.Types.ObjectId(userId),
    businessAccount: claim.businessAccountId,
    status: "active"
  })
    .select("role assignedBranches")
    .lean()
    .exec();

  if (!membership) return null;

  const account = await BusinessAccount.findById(claim.businessAccountId)
    .select("status suspension.mode")
    .lean()
    .exec();
  const accountSuspensionMode = account ? suspensionMode(account) : null;
  if (!account || accountSuspensionMode === "SECURITY_LOCK") return null;

  const assigned = (membership.assignedBranches ?? []).map(String);
  if (assigned.length > 0 && !assigned.includes(String(claim.branchId))) return null;

  return { claim, membership, accountSuspensionMode };
}

/** Client claims remain readable during an operational hold, but not mutable. */
function rejectSuspendedClientClaimMutation(
  access: { accountSuspensionMode: ReturnType<typeof suspensionMode> },
  response: Response
) {
  if (!access.accountSuspensionMode) return null;
  return response.status(423).json({
    success: false,
    message: access.accountSuspensionMode === "SECURITY_LOCK" ? securityLockMessage : suspensionMessage
  });
}

/** Staff scoping: admins see everything, everyone else their assigned branches. */
function staffCanReachBranch(role: Role, branchIds: string[], claimBranchId: string) {
  if (role === "admin") return true;
  return branchIds.includes(claimBranchId);
}

/**
 * Shapes a claim for the wire.
 *
 * Financial fields are withheld from members who cannot see them- a
 * tracking-only member gets status and nothing that would tell them what the
 * company is claiming.
 */
function serializeClaim(
  claim: InstanceType<typeof Claim>,
  options: { includeFinancials: boolean; audience: "CLIENT" | "STAFF" }
) {
  return {
    id: String(claim._id),
    claimNumber: claim.claimNumber,
    status: claim.status,
    submissionStage: claim.submissionStage,
    category: claim.category,
    shipmentDraftId: String(claim.shipmentDraftId),
    branchId: String(claim.branchId),
    linkedSupportTicketId: claim.linkedSupportTicketId ? String(claim.linkedSupportTicketId) : null,
    linkedPodDisputeId: claim.linkedPodDisputeId ? String(claim.linkedPodDisputeId) : null,
    decisionOutcome: claim.decisionOutcome,
    acceptanceState: claim.acceptanceState,
    appealState: claim.appealState,
    ...(options.audience === "STAFF" ? { recoveryState: claim.recoveryState } : {}),
    incidentDate: claim.incidentDate,
    description: claim.description,
    packagingCondition: claim.packagingCondition,
    affectedItems: claim.affectedItems,
    affectedParcelSequences: claim.affectedParcelSequences,
    shipmentSnapshot: claim.shipmentSnapshot,
    deadlines: claim.deadlines,
    submittedAt: claim.submittedAt,
    decidedAt: claim.decidedAt,
    settledAt: claim.settledAt,
    closedAt: claim.closedAt,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    ...(options.includeFinancials
      ? {
          currency: claim.currency,
          requestedAmountMinor: claim.requestedAmountMinor,
          approvedAmountMinor: claim.approvedAmountMinor,
          paidAmountMinor: claim.paidAmountMinor
        }
      : {})
  };
}

// ---------------------------------------------------------------------------
// Client endpoints
// ---------------------------------------------------------------------------

export async function getClientClaimEligibility(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const eligibility = await checkClaimEligibility({
      userId: user.id,
      shipmentDraftId: String(request.params.shipmentId)
    });

    return response.json({ success: true, eligibility });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function listClientClaimableShipments(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const businessAccountId = String(request.query.businessAccountId ?? "");
    if (!mongoose.isValidObjectId(businessAccountId)) {
      return response.status(400).json({ success: false, message: "Select a business account." });
    }

    const shipments = await listClaimableShipments({ userId: user.id, businessAccountId });
    return response.json({ success: true, shipments });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function listClientClaims(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const allMemberships = await BusinessAccountMember.find({
      user: new mongoose.Types.ObjectId(user.id),
      status: "active"
    })
      .select("businessAccount role assignedBranches")
      .lean()
      .exec();

    const visibleAccountIds = new Set((await availableClientAccountIds(
      allMemberships.map((membership) => membership.businessAccount as mongoose.Types.ObjectId)
    )).map(String));
    const memberships = allMemberships.filter((membership) => visibleAccountIds.has(String(membership.businessAccount)));

    if (memberships.length === 0) return response.json({ success: true, claims: [] });

    // A member sees claims for their own account and, where branches are
    // assigned, only those branches.
    const scopes = memberships.map((membership) => {
      const branches = (membership.assignedBranches ?? []).map(String);
      return branches.length > 0
        ? {
            businessAccountId: membership.businessAccount,
            branchId: { $in: branches.map((id) => new mongoose.Types.ObjectId(id)) }
          }
        : { businessAccountId: membership.businessAccount };
    });

    const status = String(request.query.status ?? "");
    const query: Record<string, unknown> = { $or: scopes };
    if (claimStatusValues.includes(status as never)) query.status = status;

    const format = exportFormat(request);
    // The screen shows a capped list; an export is of everything that matched.
    const claims = await Claim.find(query)
      .sort({ createdAt: -1 })
      .limit(format ? EXPORT_ROW_CAP : 100)
      .exec();

    // Financial visibility follows the strongest role the member holds, since a
    // single user can belong to several accounts in different capacities.
    const includeFinancials = memberships.some((membership) =>
      clientCan(membership.role, "VIEW_FINANCIALS")
    );

    const rows = claims.map((claim) => serializeClaim(claim, { includeFinancials, audience: "CLIENT" }));

    if (format) {
      return sendTableExport(response, format, {
        title: "Claims",
        // The money columns are appended only for a member allowed to see
        // them, so an exported file cannot carry amounts the same login is
        // refused on screen.
        columns: includeFinancials
          ? [...claimExportColumns, ...claimFinancialExportColumns]
          : claimExportColumns,
        rows: rows as never[],
        appliedFilters: describeFilters({ Status: request.query.status })
      });
    }

    return response.json({ success: true, claims: rows });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function getClientClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    const { claim, membership } = access;
    const includeFinancials = clientCan(membership.role, "VIEW_FINANCIALS");

    const [checklist, documents, messages, events, decision, beneficiary] = await Promise.all([
      buildClaimChecklistFor(claim, { audience: "CLIENT" }),
      ClaimDocument.find({ claimId: claim._id, deletedAt: null, visibility: "PUBLIC" })
        .select("category originalName mimeType size reviewState rejectionReason createdAt")
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      // Internal notes never leave staff views.
      ClaimMessage.find({ claimId: claim._id, visibility: "PUBLIC" }).sort({ createdAt: 1 }).lean().exec(),
      ClaimEvent.find({ claimId: claim._id, visibility: "PUBLIC" }).sort({ createdAt: -1 }).lean().exec(),
      includeFinancials
        ? ClaimDecision.findOne({ claimId: claim._id }).sort({ revision: -1 }).lean().exec()
        : null,
      includeFinancials
        ? ClaimBeneficiary.findOne({ claimId: claim._id })
            .sort({ version: -1 })
            // The encrypted account number is `select: false` and stays that way.
            .select("version accountHolderName accountNumberMasked ifsc bankName accountType state")
            .lean()
            .exec()
        : null
    ]);

    return response.json({
      success: true,
      claim: serializeClaim(claim, { includeFinancials, audience: "CLIENT" }),
      checklist,
      documents,
      messages,
      events,
      decision,
      beneficiary,
      availableActions: access.accountSuspensionMode ? [] : availableTransitions({
        status: claim.status,
        actorKind: "CLIENT",
        decisionOutcome: claim.decisionOutcome,
        appealDeadlineAt: claim.deadlines?.appealDeadlineAt ?? null,
        // Read off the claim rather than counted, which saves a query: any state
        // but NONE means the one permitted appeal has been used. Without this the
        // appeal button keeps appearing after it has been spent, and the client
        // only learns otherwise from a 409.
        appealCount: claim.appealState === "NONE" ? 0 : 1
      })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

const createSchema = z.object({
  shipmentDraftId: z.string().trim().min(1, "Select a shipment."),
  category: z.enum(claimCategoryValues),
  // Carried through when the client started from a ticket or a POD dispute.
  linkedSupportTicketId: z.string().trim().nullable().optional(),
  linkedPodDisputeId: z.string().trim().nullable().optional()
});

export async function createClientClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const input = createSchema.parse(request.body);
    const claim = await createClaimDraft({ userId: user.id, ...input });

    return response.status(201).json({
      success: true,
      message: "Claim draft created.",
      claim: serializeClaim(claim, { includeFinancials: true, audience: "CLIENT" })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

const draftSchema = z.object({
  category: z.enum(claimCategoryValues).optional(),
  requestedAmountMinor: z.number().int().positive("Enter the amount you are claiming.").optional(),
  incidentDate: z.coerce.date().nullable().optional(),
  description: z.string().trim().max(4000).optional(),
  packagingCondition: z.string().trim().max(1000).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  contactEmail: z.string().trim().email().max(200).optional(),
  affectedParcelSequences: z.array(z.number().int().positive()).optional(),
  affectedItems: z
    .array(
      z.object({
        parcelSequence: z.number().int().positive(),
        itemIndex: z.number().int().nonnegative(),
        quantityAffected: z.number().int().positive(),
        clientNarrative: z.string().trim().max(1000).optional()
      })
    )
    .optional()
});

export async function updateClientClaimDraft(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "EDIT_DRAFT")) {
      return response.status(403).json({ success: false, message: "Your role cannot edit claims." });
    }

    const claim = await updateClaimDraft({
      claimId: String(request.params.claimId),
      userId: user.id,
      ...draftSchema.parse(request.body)
    });

    return response.json({
      success: true,
      message: "Claim saved.",
      claim: serializeClaim(claim, { includeFinancials: true, audience: "CLIENT" })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function deleteClientClaimDraft(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "EDIT_DRAFT")) {
      return response.status(403).json({ success: false, message: "Your role cannot delete claims." });
    }

    await deleteClaimDraft({
      claimId: String(request.params.claimId),
      userId: user.id
    });

    return response.json({ success: true, message: "Claim draft deleted." });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function submitClientClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "CREATE")) {
      return response.status(403).json({ success: false, message: "Your role cannot submit claims." });
    }

    const { declarationAccepted } = z
      .object({ declarationAccepted: z.boolean() })
      .parse(request.body);

    const result = await submitClaim({
      claimId: String(request.params.claimId),
      userId: user.id,
      declarationAccepted
    });

    return response.json({
      success: true,
      message: `Claim ${result.claim.claimNumber} received.`,
      claim: serializeClaim(result.claim, { includeFinancials: true, audience: "CLIENT" }),
      filedLate: result.filedLate
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function uploadClientClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "UPLOAD_DOCUMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot upload documents." });
    }

    const file = request.file;
    if (!file) return response.status(400).json({ success: false, message: "Choose a file to upload." });

    const category = z.enum(claimDocumentCategoryValues).parse(request.body.category);

    const result = await uploadClaimDocument({
      claimId: String(request.params.claimId),
      category,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: user.id,
      uploadedByKind: "CLIENT"
    });

    return response.status(201).json({
      success: true,
      message: result.duplicate ? "That document is already attached." : "Document uploaded.",
      documentId: String(result.document._id)
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function downloadClientClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    return await streamClaimDocument({
      response,
      documentId: String(request.params.documentId),
      claimId: String(request.params.claimId),
      userId: user.id,
      ipAddress: request.ip ?? "",
      disposition: request.query.download === "1" ? "attachment" : "inline"
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function deleteClientClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "UPLOAD_DOCUMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot remove documents." });
    }

    await removeClaimDocument({
      documentId: String(request.params.documentId),
      claimId: String(request.params.claimId),
      userId: user.id
    });

    return response.json({ success: true, message: "Document removed." });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function postClientClaimMessage(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "SEND_MESSAGE")) {
      return response.status(403).json({ success: false, message: "Your role cannot send messages." });
    }

    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(request.body);

    const message = await ClaimMessage.create({
      claimId: access.claim._id,
      authorUserId: new mongoose.Types.ObjectId(user.id),
      authorKind: "CLIENT",
      body,
      visibility: "PUBLIC"
    });

    // Staff are told a client replied; the reverse is visible in the portal
    // and already covered by the claim status notifications.
    await notifyClaimClientReplied(access.claim);

    return response.status(201).json({ success: true, message: "Message sent.", id: String(message._id) });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function acceptClientSettlement(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;

    // Accepting binds the company to a figure, so it stays with owners and admins.
    if (!clientCan(access.membership.role, "ACCEPT_SETTLEMENT")) {
      return response.status(403).json({
        success: false,
        message: "Only an account owner or admin can accept a settlement."
      });
    }

    const claim = await acceptSettlement({ claimId: String(request.params.claimId), userId: user.id });
    return response.json({
      success: true,
      message: "Settlement accepted.",
      claim: serializeClaim(claim, { includeFinancials: true, audience: "CLIENT" })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function submitClientAppeal(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "SUBMIT_APPEAL")) {
      return response.status(403).json({
        success: false,
        message: "Only an account owner or admin can appeal a decision."
      });
    }

    const input = z
      .object({
        reason: z.string().trim().min(10, "Explain why you are appealing.").max(4000),
        newEvidenceDocumentIds: z.array(z.string()).optional()
      })
      .parse(request.body);

    const appeal = await submitAppeal({
      claimId: String(request.params.claimId),
      userId: user.id,
      ...input
    });

    return response.status(201).json({
      success: true,
      message: "Appeal submitted.",
      appealId: String(appeal._id)
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function submitClientBeneficiary(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "MANAGE_BANK_DETAILS")) {
      return response.status(403).json({
        success: false,
        message: "Only an account owner or admin can add settlement bank details."
      });
    }

    const input = z
      .object({
        accountHolderName: z.string().trim().min(2).max(140),
        accountNumber: z.string().trim().min(9).max(20),
        confirmAccountNumber: z.string().trim().min(9).max(20),
        ifsc: z.string().trim().length(11),
        bankName: z.string().trim().min(2).max(140),
        accountType: z.enum(["SAVINGS", "CURRENT"]),
        proofDocumentId: z.string().trim().nullable().optional(),
        authorityDocumentId: z.string().trim().nullable().optional()
      })
      .parse(request.body);

    const beneficiary = await submitBeneficiary({
      claimId: String(request.params.claimId),
      userId: user.id,
      ...input
    });

    return response.status(201).json({
      success: true,
      message: "Bank details submitted for verification.",
      // Only the masked value ever leaves the server.
      beneficiary: {
        version: beneficiary.version,
        accountNumberMasked: beneficiary.accountNumberMasked,
        state: beneficiary.state
      }
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function withdrawClientClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    if (!clientCan(access.membership.role, "WITHDRAW")) {
      return response.status(403).json({ success: false, message: "Your role cannot withdraw claims." });
    }

    const { reason } = z
      .object({ reason: z.string().trim().min(5, "Tell us why you are withdrawing.").max(2000) })
      .parse(request.body);

    await withdrawClaim({
      claimId: String(request.params.claimId),
      actorUserId: user.id,
      actorKind: "CLIENT",
      reason
    });

    return response.json({ success: true, message: "Claim withdrawn." });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function disputeClientSettlement(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    const suspensionResponse = rejectSuspendedClientClaimMutation(access, response);
    if (suspensionResponse) return suspensionResponse;
    // Disputing commits the company to a position, so it sits with the roles
    // that can also accept or appeal.
    if (!clientCan(access.membership.role, "ACCEPT_SETTLEMENT")) {
      return response.status(403).json({
        success: false,
        message: "Only an account owner or admin can respond to a decision."
      });
    }

    const { reason } = z
      .object({ reason: z.string().trim().min(5, "Explain what you disagree with.").max(2000) })
      .parse(request.body);

    await disputeClaimSettlement({
      claimId: String(request.params.claimId),
      actorUserId: user.id,
      reason
    });

    return response.json({ success: true, message: "Your response has been recorded." });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * The decision letter as a PDF.
 *
 * Served to both audiences from one helper because the document is identical-
 * a decision says the same thing to the client and to the handler, and two
 * renderings that could drift apart would be worse than one.
 */
async function streamDecisionLetter(input: {
  response: Response;
  claim: InstanceType<typeof Claim>;
  revision?: string;
  download: boolean;
}) {
  const query: Record<string, unknown> = { claimId: input.claim._id };
  // A specific revision can be asked for, so an appeal outcome does not erase
  // the letter the client was originally sent.
  if (input.revision && Number.isFinite(Number(input.revision))) {
    query.revision = Number(input.revision);
  }

  const decision = await ClaimDecision.findOne(query).sort({ revision: -1 }).exec();
  if (!decision) throw new ClaimDecisionError("This claim has no decision yet.", 404);

  const account = await BusinessAccount.findById(input.claim.businessAccountId)
    .select("company.companyName")
    .lean()
    .exec();

  const pdf = await buildClaimDecisionPdf({
    claim: input.claim,
    decision,
    companyName: account?.company?.companyName ?? ""
  });

  const filename = `${(input.claim.claimNumber ?? "claim").replace(/\//g, "-")}-decision.pdf`;
  input.response.setHeader("Content-Type", "application/pdf");
  input.response.setHeader(
    "Content-Disposition",
    `${input.download ? "attachment" : "inline"}; filename="${filename}"`
  );
  input.response.setHeader("Cache-Control", "private, no-store");
  return input.response.send(pdf);
}

export async function downloadClientDecisionLetter(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Sign in to continue." });

    const access = await clientAccess(String(request.params.claimId), user.id);
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    // The letter states amounts, so it follows financial visibility rather than
    // plain read access.
    if (!clientCan(access.membership.role, "VIEW_FINANCIALS")) {
      return response.status(403).json({ success: false, message: "Your role cannot view claim amounts." });
    }

    return await streamDecisionLetter({
      response,
      claim: access.claim,
      revision: String(request.query.revision ?? ""),
      download: request.query.download === "1"
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function downloadStaffDecisionLetter(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    return await streamDecisionLetter({
      response,
      claim: access.claim,
      revision: String(request.query.revision ?? ""),
      download: request.query.download === "1"
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

// ---------------------------------------------------------------------------
// Staff endpoints
// ---------------------------------------------------------------------------

/** Loads a claim a staff member is scoped to, or null. */
async function staffAccess(request: Request, claimId: string) {
  const user = actor(request);
  if (!user || !staffCan(user.role, "VIEW")) return null;
  if (!mongoose.isValidObjectId(claimId)) return null;

  const claim = await Claim.findById(claimId).exec();
  if (!claim) return null;
  if (!staffCanReachBranch(user.role, user.branchIds, String(claim.branchId))) return null;

  return { claim, user };
}

export async function listStaffClaims(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user || !staffCan(user.role, "VIEW")) {
      return response.status(403).json({ success: false, message: "You do not have access to claims." });
    }

    const query: Record<string, unknown> = {};
    // Anyone but an admin is confined to their assigned branches, and an empty
    // assignment means nothing rather than everything.
    if (user.role !== "admin") {
      query.branchId = { $in: user.branchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const text = (key: string) => String(request.query[key] ?? "").trim();

    const status = text("status");
    if (claimStatusValues.includes(status as never)) query.status = status;

    const category = text("category");
    if (claimCategoryValues.includes(category as never)) query.category = category;

    const outcome = text("decisionOutcome");
    if (["FULLY_APPROVED", "PARTIALLY_APPROVED", "REJECTED"].includes(outcome)) {
      query.decisionOutcome = outcome;
    }

    const recoveryState = text("recoveryState");
    if (claimRecoveryStateValues.includes(recoveryState as never)) query.recoveryState = recoveryState;

    if (mongoose.isValidObjectId(text("businessAccountId"))) {
      query.businessAccountId = new mongoose.Types.ObjectId(text("businessAccountId"));
    }
    // A branch filter narrows within the caller's scope; it can never widen it,
    // because the branch clause above is applied first and this only replaces it
    // for admins.
    if (mongoose.isValidObjectId(text("branchId")) && user.role === "admin") {
      query.branchId = new mongoose.Types.ObjectId(text("branchId"));
    }

    if (request.query.assignedTo === "me") query.assignedTo = new mongoose.Types.ObjectId(user.id);
    else if (request.query.assignedTo === "unassigned") query.assignedTo = null;
    else if (mongoose.isValidObjectId(text("assignedTo"))) {
      query.assignedTo = new mongoose.Types.ObjectId(text("assignedTo"));
    }

    // Claim and tracking numbers are matched as a prefix rather than exactly, so
    // a handler can type the last few digits they remember.
    const search = text("search");
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { claimNumber: { $regex: escaped, $options: "i" } },
        { "shipmentSnapshot.trackingNumber": { $regex: escaped, $options: "i" } }
      ];
    }

    const submittedFrom = text("submittedFrom");
    const submittedTo = text("submittedTo");
    if (submittedFrom || submittedTo) {
      query.submittedAt = {
        ...(submittedFrom ? { $gte: new Date(submittedFrom) } : {}),
        // Inclusive of the whole end day rather than midnight on it, which is
        // what a person picking a date range means.
        ...(submittedTo ? { $lte: new Date(`${submittedTo}T23:59:59.999Z`) } : {})
      };
    }

    const minAmount = Number(text("minAmountMinor"));
    const maxAmount = Number(text("maxAmountMinor"));
    if (Number.isFinite(minAmount) || Number.isFinite(maxAmount)) {
      const range = {
        ...(Number.isFinite(minAmount) && minAmount > 0 ? { $gte: minAmount } : {}),
        ...(Number.isFinite(maxAmount) && maxAmount > 0 ? { $lte: maxAmount } : {})
      };
      if (Object.keys(range).length > 0) query.requestedAmountMinor = range;
    }

    if (request.query.settled === "1") query.status = "SETTLED";
    if (request.query.settled === "0") query.status = { $nin: ["SETTLED", "CLOSED", "WITHDRAWN"] };

    if (request.query.slaOverdue === "1") {
      query["deadlines.internalReviewDueAt"] = { $lt: new Date() };
      query.status = { $nin: ["SETTLED", "CLOSED", "WITHDRAWN"] };
    }

    const staffFormat = exportFormat(request);
    const claims = await Claim.find(query)
      .sort({ updatedAt: -1 })
      .limit(staffFormat ? EXPORT_ROW_CAP : 200)
      .exec();

    // Resolved in three bulk queries rather than per row: a 200-claim queue would
    // otherwise issue 600 lookups to print names the reviewer needs to read.
    const [accounts, branches, handlers] = await Promise.all([
      BusinessAccount.find({ _id: { $in: claims.map((claim) => claim.businessAccountId) } })
        .select("accountId company.companyName")
        .lean()
        .exec(),
      Branch.find({ _id: { $in: claims.map((claim) => claim.branchId) } })
        .select("name code")
        .lean()
        .exec(),
      User.find({
        _id: {
          $in: claims.flatMap((claim) => (claim.assignedTo ? [claim.assignedTo] : []))
        }
      })
        .select("firstName lastName name email")
        .lean()
        .exec()
    ]);

    const accountById = new Map(accounts.map((row) => [String(row._id), row]));
    const branchById = new Map(branches.map((row) => [String(row._id), row]));
    const handlerById = new Map(handlers.map((row) => [String(row._id), row]));

    const nameOf = (row?: { firstName?: string; lastName?: string; name?: string; email?: string }) =>
      row ? [row.firstName, row.lastName].filter(Boolean).join(" ") || row.name || row.email || "" : "";

    const staffIncludesFinancials = staffCan(user.role, "VIEW_FINANCIALS");
    const staffRows = claims.map((claim) => {
      const account = accountById.get(String(claim.businessAccountId));
      const branch = branchById.get(String(claim.branchId));
      const handler = claim.assignedTo ? handlerById.get(String(claim.assignedTo)) : undefined;

      return {
        ...serializeClaim(claim, { includeFinancials: staffIncludesFinancials, audience: "STAFF" }),
        assignedTo: claim.assignedTo ? String(claim.assignedTo) : null,
        // Names rather than object ids: a queue showing raw identifiers is one
        // a reviewer has to decode before they can use it.
        businessAccountName: account?.company?.companyName ?? "",
        businessAccountCode: account?.accountId ?? "",
        branchName: branch?.name ?? "",
        branchCode: branch?.code ?? "",
        assignedToName: nameOf(handler),
        affectedParcelCount: claim.affectedParcelSequences.length,
        // Surfaced in the queue so a late filing is visible before anyone opens it.
        filedLate: claim.deadlines?.filedLate ?? false
      };
    });

    if (staffFormat) {
      return sendTableExport(response, staffFormat, {
        title: "Claims",
        columns: [
          ...claimExportColumns,
          ...staffClaimExportColumns,
          ...(staffIncludesFinancials ? claimFinancialExportColumns : [])
        ] as never[],
        rows: staffRows as never[],
        accountLabel: "Swiftline staff",
        appliedFilters: describeFilters({
          Status: request.query.status,
          Category: request.query.category,
          Outcome: request.query.decisionOutcome,
          Search: request.query.search,
          From: request.query.submittedFrom,
          To: request.query.submittedTo
        })
      });
    }

    return response.json({ success: true, claims: staffRows });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function getStaffClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    const { claim, user } = access;

    const [checklist, documents, messages, events, decisions, beneficiary, settlements, recoveries, sla] =
      await Promise.all([
        buildClaimChecklistFor(claim),
        ClaimDocument.find({ claimId: claim._id, deletedAt: null }).sort({ createdAt: -1 }).lean().exec(),
        // Staff see internal notes as well as the client-facing thread.
        ClaimMessage.find({ claimId: claim._id }).sort({ createdAt: 1 }).lean().exec(),
        ClaimEvent.find({ claimId: claim._id }).sort({ createdAt: -1 }).lean().exec(),
        ClaimDecision.find({ claimId: claim._id }).sort({ revision: -1 }).lean().exec(),
        ClaimBeneficiary.findOne({ claimId: claim._id })
          .sort({ version: -1 })
          .select("version accountHolderName accountNumberMasked ifsc bankName accountType state verifiedAt")
          .lean()
          .exec(),
        ClaimSettlement.find({ claimId: claim._id }).lean().exec(),
        ClaimRecovery.find({ claimId: claim._id }).lean().exec(),
        computeClaimSla(claim)
      ]);

    return response.json({
      success: true,
      claim: serializeClaim(claim, {
        includeFinancials: staffCan(user.role, "VIEW_FINANCIALS"),
        audience: "STAFF"
      }),
      checklist,
      documents,
      messages,
      events,
      decisions,
      beneficiary,
      settlements,
      recoveries,
      sla,
      legalHold: { active: claim.legalHold, reason: claim.legalHoldReason },
      availableActions: availableTransitions({
        status: claim.status,
        actorKind: "STAFF",
        decisionOutcome: claim.decisionOutcome,
        hasConfirmedPayment: settlements.length > 0
      })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function decideStaffClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "DECIDE")) {
      return response.status(403).json({ success: false, message: "Your role cannot decide claims." });
    }

    const input = z
      .object({
        outcome: z.enum(["FULLY_APPROVED", "PARTIALLY_APPROVED", "REJECTED"]),
        approvedAmountMinor: z.number().int().nonnegative(),
        reasonCode: z.string().trim().min(2).max(60),
        customerExplanation: z.string().trim().min(10, "Explain the decision to the customer.").max(4000),
        internalNote: z.string().trim().max(4000).optional()
      })
      .parse(request.body);

    const result = await decideClaim({
      claimId: String(request.params.claimId),
      reviewerId: access.user.id,
      ...input
    });

    return response.json({
      success: true,
      message: "Decision issued.",
      claim: serializeClaim(result.claim, { includeFinancials: true, audience: "STAFF" })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function reviewStaffClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "REVIEW_DOCUMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot review documents." });
    }

    const input = z
      .object({
        decision: z.enum(["ACCEPTED", "REJECTED"]),
        reason: z.string().trim().max(1000).optional()
      })
      .parse(request.body);

    await reviewClaimDocument({
      documentId: String(request.params.documentId),
      claimId: String(request.params.claimId),
      reviewerId: access.user.id,
      ...input
    });

    return response.json({ success: true, message: `Document ${input.decision.toLowerCase()}.` });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function downloadStaffClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    return await streamClaimDocument({
      response,
      documentId: String(request.params.documentId),
      claimId: String(request.params.claimId),
      userId: access.user.id,
      ipAddress: request.ip ?? "",
      disposition: request.query.download === "1" ? "attachment" : "inline"
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function verifyStaffBeneficiary(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "VERIFY_BENEFICIARY")) {
      return response.status(403).json({ success: false, message: "Your role cannot verify bank details." });
    }

    const input = z
      .object({ approved: z.boolean(), reason: z.string().trim().max(1000).optional() })
      .parse(request.body);

    const beneficiary = await verifyBeneficiary({
      claimId: String(request.params.claimId),
      beneficiaryId: String(request.params.beneficiaryId),
      verifierId: access.user.id,
      ...input
    });

    return response.json({
      success: true,
      message: input.approved ? "Bank details verified." : "Bank details rejected.",
      state: beneficiary.state
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function recordStaffSettlement(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "RECORD_PAYMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot record payments." });
    }

    const input = z
      .object({
        paidAmountMinor: z.number().int().positive(),
        transactionReference: z.string().trim().min(4, "Enter the bank reference or UTR.").max(60),
        paymentDate: z.coerce.date(),
        proofDocumentId: z.string().trim().min(1, "Attach the payment proof."),
        idempotencyKey: z.string().trim().min(8).max(200)
      })
      .parse(request.body);

    const result = await recordSettlement({
      claimId: String(request.params.claimId),
      userId: access.user.id,
      ...input
    });

    return response.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.duplicate
        ? "This payment was already recorded."
        : result.settledInFull
          ? "Payment recorded. The claim is settled."
          : `Part payment recorded. ${(result.outstandingMinor / 100).toFixed(2)} still outstanding.`,
      claim: serializeClaim(result.claim, { includeFinancials: true, audience: "STAFF" })
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function upsertStaffRecovery(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "MANAGE_RECOVERY")) {
      return response.status(403).json({ success: false, message: "Your role cannot manage recovery." });
    }

    const input = z
      .object({
        recoveryId: z.string().trim().optional(),
        partyType: z.enum(["CARRIER", "PARTNER", "INSURER"]),
        partyName: z.string().trim().min(2).max(140),
        externalReference: z.string().trim().max(120).optional(),
        submittedAmountMinor: z.number().int().nonnegative().optional(),
        admittedAmountMinor: z.number().int().nonnegative().optional(),
        receivedAmountMinor: z.number().int().nonnegative().optional(),
        followUpAt: z.coerce.date().nullable().optional(),
        notes: z.string().trim().max(4000).optional()
      })
      .parse(request.body);

    const recovery = await upsertRecovery({
      claimId: String(request.params.claimId),
      userId: access.user.id,
      ...input
    });

    return response.json({ success: true, message: "Recovery case updated.", recovery });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * The transitions that move a claim through review.
 *
 * Each gets its own route rather than one endpoint taking a transition name:
 * the permission and the reason requirement differ per command, and a single
 * parameterised mover would be the generic status endpoint the design rules out.
 */
function staffTransitionHandler(options: {
  action: ClaimAction;
  requiresReason?: boolean;
  successMessage: string;
  run: (input: { claimId: string; actorUserId: string; reason: string }) => Promise<unknown>;
}) {
  return async function handler(request: Request, response: Response, next: NextFunction) {
    try {
      const access = await staffAccess(request, String(request.params.claimId));
      if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
      if (!staffCan(access.user.role, options.action)) {
        return response
          .status(403)
          .json({ success: false, message: "Your role cannot take this action." });
      }

      const { reason } = z
        .object({
          reason: options.requiresReason
            ? z.string().trim().min(5, "Give a reason for this action.").max(2000)
            : z.string().trim().max(2000).optional().default("")
        })
        .parse(request.body ?? {});

      await options.run({
        claimId: String(request.params.claimId),
        actorUserId: access.user.id,
        reason
      });

      return response.json({ success: true, message: options.successMessage });
    } catch (error) {
      return handle(error, response, next);
    }
  };
}

export const startStaffClaimReview = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Claim moved into review.",
  run: startClaimReview
});

export const requestStaffClaimDocuments = staffTransitionHandler({
  action: "INVESTIGATE",
  requiresReason: true,
  successMessage: "Documents requested from the client.",
  run: (input) => requestClaimDocuments({ ...input, reason: input.reason })
});

export const requestStaffClaimInformation = staffTransitionHandler({
  action: "INVESTIGATE",
  requiresReason: true,
  successMessage: "Information requested from the client.",
  run: (input) => requestClaimInformation({ ...input, reason: input.reason })
});

export const awaitStaffClaimThirdParty = staffTransitionHandler({
  action: "INVESTIGATE",
  requiresReason: true,
  successMessage: "Claim submitted to the carrier.",
  run: (input) => awaitClaimThirdParty({ ...input, reason: input.reason })
});

export const staffClaimCarrierAcknowledged = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Carrier has begun reviewing the claim.",
  run: claimCarrierAcknowledged
});

export const staffThirdPartyResponded = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Claim returned to review.",
  run: thirdPartyResponded
});

export const receiveStaffClaimInformation = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Claim returned to review.",
  run: (input) => receiveClaimInformation({ ...input, actorKind: "STAFF" })
});

export const completeStaffClaimDocuments = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Evidence pack accepted. Claim is in review.",
  run: (input) => completeClaimDocuments({ ...input, actorKind: "STAFF" })
});

export const sendStaffClaimForApproval = staffTransitionHandler({
  action: "INVESTIGATE",
  successMessage: "Claim sent for approval.",
  run: sendClaimForApproval
});

export const closeStaffClaim = staffTransitionHandler({
  action: "CLOSE",
  successMessage: "Claim closed.",
  run: closeClaim
});

export const reopenStaffClaim = staffTransitionHandler({
  action: "REOPEN",
  requiresReason: true,
  successMessage: "Claim reopened.",
  run: (input) => reopenClaim({ ...input, reason: input.reason })
});

export const withdrawStaffClaim = staffTransitionHandler({
  action: "INVESTIGATE",
  requiresReason: true,
  successMessage: "Claim withdrawn.",
  run: (input) => withdrawClaim({ ...input, actorKind: "STAFF", reason: input.reason })
});

/**
 * Places or lifts a legal hold.
 *
 * Admin only. A hold suspends the retention purge indefinitely, and lifting one
 * re-exposes eight-year-old evidence to deletion- neither belongs with a role
 * that handles claims day to day.
 */
export async function setStaffClaimLegalHold(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "MANAGE_LEGAL_HOLD")) {
      return response.status(403).json({ success: false, message: "Only an admin can manage legal hold." });
    }

    const input = z
      .object({
        hold: z.boolean(),
        reason: z.string().trim().min(5, "Record why the hold is being changed.").max(1000)
      })
      .parse(request.body);

    await setClaimLegalHold({
      claimId: String(request.params.claimId),
      actorUserId: access.user.id,
      ...input
    });

    return response.json({
      success: true,
      message: input.hold ? "Legal hold placed." : "Legal hold lifted."
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * Drops a required document from this claim.
 *
 * Restricted to WAIVE_DOCUMENT- finance can pay a claim but must not be able
 * to lower the evidence bar it was assessed against.
 */
export async function waiveStaffClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "WAIVE_DOCUMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot waive documents." });
    }

    const input = z
      .object({
        category: z.enum(claimDocumentCategoryValues),
        reason: z.string().trim().min(5, "Say why this document is being waived.").max(1000)
      })
      .parse(request.body);

    await waiveClaimDocument({
      claimId: String(request.params.claimId),
      actorUserId: access.user.id,
      ...input
    });

    return response.json({ success: true, message: "Document waived." });
  } catch (error) {
    return handle(error, response, next);
  }
}

/** Asks the client for evidence beyond the standard list for their category. */
export async function requestStaffConditionalDocuments(
  request: Request,
  response: Response,
  next: NextFunction
) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "INVESTIGATE")) {
      return response.status(403).json({ success: false, message: "Your role cannot request documents." });
    }

    const input = z
      .object({
        categories: z.array(z.enum(claimDocumentCategoryValues)).min(1, "Choose at least one document."),
        reason: z.string().trim().min(5, "Tell the client why this is needed.").max(1000)
      })
      .parse(request.body);

    await requestConditionalDocuments({
      claimId: String(request.params.claimId),
      actorUserId: access.user.id,
      ...input
    });

    return response.json({ success: true, message: "Documents requested from the client." });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * Staff document upload.
 *
 * Separate from the client handler because staff attach different things-
 * payment proof above all, which a settlement cannot be recorded without. The
 * client upload route could not serve this: it authorises through business
 * account membership, which no staff user has.
 */
export async function uploadStaffClaimDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    // Recording a payment is what this exists for, so it follows that permission
    // rather than the document-review one.
    if (!staffCan(access.user.role, "RECORD_PAYMENT")) {
      return response.status(403).json({ success: false, message: "Your role cannot upload documents." });
    }

    const file = request.file;
    if (!file) return response.status(400).json({ success: false, message: "Choose a file to upload." });

    const body = z
      .object({
        category: z.enum(claimDocumentCategoryValues),
        // Payment proof and bank evidence live under their own S3 prefixes so a
        // claim's evidence and its financial records stay separable.
        storageType: z.enum(["evidence", "payment-proof", "beneficiary"]).optional(),
        visibility: z.enum(["PUBLIC", "INTERNAL"]).optional()
      })
      .parse(request.body);

    const result = await uploadClaimDocument({
      claimId: String(request.params.claimId),
      category: body.category,
      storageType: body.storageType ?? "evidence",
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: access.user.id,
      uploadedByKind: "STAFF",
      visibility: body.visibility ?? "INTERNAL"
    });

    return response.status(201).json({
      success: true,
      message: result.duplicate ? "That document is already attached." : "Document uploaded.",
      documentId: String(result.document._id)
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * A staff reply, or an internal note.
 *
 * Internal notes share the thread rather than living apart, so a reviewer reads
 * one history instead of reconciling two. `visibility` is what keeps them off
 * the client's copy.
 */
export async function postStaffClaimMessage(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });

    const action: ClaimAction = request.body?.internal ? "INTERNAL_NOTE" : "SEND_MESSAGE";
    if (!staffCan(access.user.role, action)) {
      return response.status(403).json({ success: false, message: "Your role cannot post here." });
    }

    const input = z
      .object({
        body: z.string().trim().min(1, "Write something before sending.").max(4000),
        internal: z.boolean().optional().default(false)
      })
      .parse(request.body);

    const message = await ClaimMessage.create({
      claimId: access.claim._id,
      authorUserId: new mongoose.Types.ObjectId(access.user.id),
      authorKind: "STAFF",
      body: input.body,
      visibility: input.internal ? "INTERNAL" : "PUBLIC"
    });

    return response.status(201).json({
      success: true,
      message: input.internal ? "Internal note added." : "Reply sent to the client.",
      id: String(message._id)
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

/**
 * Reveals the full bank account number, once, to someone about to pay it.
 *
 * The number is encrypted and masked everywhere else precisely so it cannot leak
 * through a list, a log, or a notification. But the person making the transfer
 * has to read it somewhere, and a system that never shows it just moves the
 * problem into an email or a spreadsheet.
 *
 * POST rather than GET so it cannot land in browser history, a proxy log, or a
 * shared URL. Every reveal is audited with who asked and when.
 */
export async function revealStaffBeneficiary(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    // Tied to the ability to pay, not to the ability to read a claim.
    if (!staffCan(access.user.role, "RECORD_PAYMENT")) {
      return response
        .status(403)
        .json({ success: false, message: "Your role cannot view bank details." });
    }

    const beneficiary = await ClaimBeneficiary.findOne({
      _id: String(request.params.beneficiaryId),
      claimId: access.claim._id
    })
      // `select: false` on the model, so it has to be asked for explicitly.
      .select("+accountNumberEncrypted accountHolderName ifsc bankName accountType state version")
      .exec();

    if (!beneficiary) return response.status(404).json({ success: false, message: "Bank details not found." });
    if (beneficiary.state !== "VERIFIED") {
      return response
        .status(409)
        .json({ success: false, message: "Verify these bank details before paying them." });
    }

    await AuditLog.create({
      action: "CLAIM_BENEFICIARY_VERIFIED",
      entityType: "CLAIM_BENEFICIARY",
      entityId: beneficiary._id,
      performedBy: new mongoose.Types.ObjectId(access.user.id),
      performedAt: new Date(),
      // The number itself is never written to the audit trail- only the fact
      // that someone read it.
      metadata: { claimId: String(access.claim._id), action: "REVEALED", version: beneficiary.version }
    });

    return response.json({
      success: true,
      accountHolderName: beneficiary.accountHolderName,
      accountNumber: decryptSecret<string>(beneficiary.accountNumberEncrypted, "taxId"),
      ifsc: beneficiary.ifsc,
      bankName: beneficiary.bankName,
      accountType: beneficiary.accountType
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function assignStaffClaim(request: Request, response: Response, next: NextFunction) {
  try {
    const access = await staffAccess(request, String(request.params.claimId));
    if (!access) return response.status(404).json({ success: false, message: "Claim not found." });
    if (!staffCan(access.user.role, "ASSIGN")) {
      return response.status(403).json({ success: false, message: "Your role cannot assign claims." });
    }

    const { assignedTo } = z
      .object({ assignedTo: z.string().trim().nullable() })
      .parse(request.body);

    access.claim.assignedTo = assignedTo ? new mongoose.Types.ObjectId(assignedTo) : null;
    await access.claim.save();

    await ClaimEvent.create({
      claimId: access.claim._id,
      type: "ASSIGNED",
      actorUserId: new mongoose.Types.ObjectId(access.user.id),
      actorKind: "STAFF",
      visibility: "INTERNAL",
      reason: assignedTo ? "Claim assigned." : "Claim unassigned."
    });

    return response.json({ success: true, message: "Claim assignment updated." });
  } catch (error) {
    return handle(error, response, next);
  }
}
