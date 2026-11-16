import mongoose from "mongoose";
import { Claim } from "../../models/claim.model.js";
import type { ClaimAffectedItem, IClaim } from "../../models/claim.model.js";
import { ClaimEvent } from "../../models/claimEvent.model.js";
import type { ClaimEventType } from "../../models/claimEvent.model.js";
import { ClaimDocument } from "../../models/claimDocument.model.js";
import { ClaimMessage } from "../../models/claimMessage.model.js";
import { BusinessAccountMember } from "../../models/businessAccountMember.model.js";
import { BusinessAccount } from "../../models/businessAccount.model.js";
import { claimCategoryValues } from "../../models/claimTypes.js";
import type { ClaimCategory } from "../../models/claimTypes.js";
import { AuditLog } from "../../models/auditLog.model.js";
import { deleteObject } from "../storage/storage.service.js";
import { allocateClaimNumber } from "./claimNumber.service.js";
import { computeClaimDeadlines, selectPolicyRule } from "./claimPolicy.service.js";
import { captureShipmentSnapshot, resolveSnapshotItem } from "./claimSnapshot.service.js";
import { checkClaimEligibility, ClaimEligibilityError } from "./claimEligibility.service.js";
import { assertTransition } from "./claimStateMachine.js";
import { notifyClaimSubmitted } from "./claimNotification.service.js";
import { attachPortalDocuments } from "./claimPortalDocuments.service.js";
import { currentDeclarationVersion as declarationVersion } from "./claimDeclaration.js";
import { securityLockMessage, suspensionMessage, suspensionMode } from "../businessAccountSuspension.service.js";

/**
 * Creating a claim draft and turning it into a filed claim.
 *
 * The two are separate on purpose. A draft is private working space with no
 * number and no deadlines; submission is the moment the claim becomes a record
 *- number allocated, snapshot frozen, clocks started, acknowledgement sent.
 */

export class ClaimSubmissionError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ClaimSubmissionError";
  }
}

export { currentDeclarationVersion } from "./claimDeclaration.js";

export interface CreateClaimDraftInput {
  userId: string;
  shipmentDraftId: string;
  category: ClaimCategory;
  /**
   * The Help Desk ticket or POD dispute this claim came from.
   *
   * Recorded so a reviewer can see the client already reported the problem
   * elsewhere, and when. Neither is closed by the claim: an enquiry and a
   * compensation request are separate things with separate outcomes.
   */
  linkedSupportTicketId?: string | null;
  linkedPodDisputeId?: string | null;
}

export interface UpdateClaimDraftInput {
  claimId: string;
  userId: string;
  category?: ClaimCategory;
  requestedAmountMinor?: number;
  incidentDate?: Date | null;
  description?: string;
  packagingCondition?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  affectedParcelSequences?: number[];
  affectedItems?: Array<{
    parcelSequence: number;
    itemIndex: number;
    quantityAffected: number;
    clientNarrative?: string;
  }>;
}

/**
 * Opens a draft claim.
 *
 * Eligibility is checked here as well as at submission. A client who starts a
 * claim on an ineligible shipment should be told immediately, not after filling
 * in six screens.
 */
export async function createClaimDraft(input: CreateClaimDraftInput) {
  if (!claimCategoryValues.includes(input.category)) {
    throw new ClaimSubmissionError("Choose a valid claim category.");
  }

  const eligibility = await checkClaimEligibility({
    userId: input.userId,
    shipmentDraftId: input.shipmentDraftId
  });

  if (!eligibility.eligible || !eligibility.shipment) {
    throw new ClaimSubmissionError(
      eligibility.message ?? "A claim cannot be raised for this shipment.",
      409
    );
  }

  // Captured at draft creation as well as at submission. The client has to pick
  // affected parcels and items before they can file, and they cannot do that
  // against a shipment the claim does not yet hold. Submission re-captures, and
  // that later copy is the one that counts- this is working data, taken while
  // the claim is still private and editable.
  const draftSnapshot = await captureShipmentSnapshot(
    new mongoose.Types.ObjectId(input.shipmentDraftId)
  );

  const claim = await Claim.create({
    businessAccountId: new mongoose.Types.ObjectId(eligibility.shipment.businessAccountId),
    branchId: new mongoose.Types.ObjectId(eligibility.shipment.branchId),
    shipmentDraftId: new mongoose.Types.ObjectId(input.shipmentDraftId),
    claimantUserId: new mongoose.Types.ObjectId(input.userId),
    category: input.category,
    status: "DRAFT",
    shipmentSnapshot: draftSnapshot,
    linkedSupportTicketId: input.linkedSupportTicketId
      ? new mongoose.Types.ObjectId(input.linkedSupportTicketId)
      : null,
    linkedPodDisputeId: input.linkedPodDisputeId
      ? new mongoose.Types.ObjectId(input.linkedPodDisputeId)
      : null,
    // Placeholder until the client enters a figure. Submission refuses zero, so
    // a draft cannot be filed without one.
    requestedAmountMinor: 0
  });

  await recordEvent({
    claimId: claim._id,
    type: "CREATED",
    actorUserId: new mongoose.Types.ObjectId(input.userId),
    actorKind: "CLIENT",
    toStatus: "DRAFT",
    visibility: "PUBLIC"
  });

  return claim;
}

/**
 * Saves draft edits.
 *
 * Only a draft is editable. Once filed, the claim's content is what a reviewer
 * is judging, and changing it underneath them would make the timeline a lie-
 * corrections after submission go through messages and document replacement.
 */
export async function updateClaimDraft(input: UpdateClaimDraftInput) {
  const claim = await loadOwnedClaim(input.claimId, input.userId);

  if (claim.status !== "DRAFT") {
    throw new ClaimSubmissionError("This claim has been submitted and can no longer be edited.", 409);
  }

  if (input.category !== undefined) claim.category = input.category;
  if (input.requestedAmountMinor !== undefined) claim.requestedAmountMinor = input.requestedAmountMinor;
  if (input.incidentDate !== undefined) claim.incidentDate = input.incidentDate;
  if (input.description !== undefined) claim.description = input.description;
  if (input.packagingCondition !== undefined) claim.packagingCondition = input.packagingCondition;
  if (input.contactName !== undefined) claim.contactName = input.contactName;
  if (input.contactPhone !== undefined) claim.contactPhone = input.contactPhone;
  if (input.contactEmail !== undefined) claim.contactEmail = input.contactEmail;
  if (input.affectedParcelSequences !== undefined) {
    claim.affectedParcelSequences = input.affectedParcelSequences;
  }

  // Affected items are resolved against a snapshot taken now, so a draft always
  // reflects the shipment as it currently stands. The snapshot that matters is
  // the one taken at submission; this one is for validation and display.
  if (input.affectedItems !== undefined) {
    const snapshot = await captureShipmentSnapshot(claim.shipmentDraftId);
    claim.affectedItems = input.affectedItems.map((item) =>
      buildAffectedItem(snapshot, item)
    ) as ClaimAffectedItem[];
  }

  await claim.save();
  return claim;
}

/**
 * Permanently removes a draft claim and everything it accumulated.
 *
 * Only a draft can be deleted. Once filed, a claim is a record- a number has
 * been allocated, staff may already be reviewing it- so it must be withdrawn
 * or closed, never erased. A draft is private working space, so nothing on it
 * is worth keeping: uploaded evidence files, timeline events, and any messages
 * go with it.
 */
export async function deleteClaimDraft(input: { claimId: string; userId: string }) {
  const claim = await loadOwnedClaim(input.claimId, input.userId);

  if (claim.status !== "DRAFT") {
    throw new ClaimSubmissionError(
      "Only draft claims can be deleted. A filed claim must be withdrawn instead.",
      409
    );
  }

  const documents = await ClaimDocument.find({ claimId: claim._id }).select("storageKey").exec();
  await Promise.all(documents.map((document) => deleteObject(document.storageKey).catch(() => undefined)));

  await ClaimDocument.deleteMany({ claimId: claim._id }).exec();
  await ClaimEvent.deleteMany({ claimId: claim._id }).exec();
  await ClaimMessage.deleteMany({ claimId: claim._id }).exec();

  await claim.deleteOne();

  await AuditLog.create({
    action: "CLAIM_DRAFT_DELETED",
    entityType: "CLAIM",
    entityId: claim._id,
    performedBy: new mongoose.Types.ObjectId(input.userId),
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: claim.shipmentDraftId,
      category: claim.category,
      branchId: claim.branchId
    }
  });

  return claim;
}

/**
 * Files the claim.
 *
 * Everything that makes a claim a record happens here, inside one transaction:
 * the number is allocated, the shipment is frozen, and the deadlines are fixed.
 * A partial failure that allocated a number without freezing a snapshot would
 * leave an unexplainable gap in the financial-year sequence.
 */
export async function submitClaim(input: {
  claimId: string;
  userId: string;
  declarationAccepted: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claim = await loadOwnedClaim(input.claimId, input.userId);

  assertTransition("SUBMIT", { status: claim.status, actorKind: "CLIENT" });

  if (!input.declarationAccepted) {
    throw new ClaimSubmissionError("Accept the declaration before submitting the claim.");
  }
  if (claim.requestedAmountMinor <= 0) {
    throw new ClaimSubmissionError("Enter the amount you are claiming.");
  }
  if (!claim.description.trim()) {
    throw new ClaimSubmissionError("Describe what happened to the shipment.");
  }
  if (claim.affectedItems.length === 0) {
    throw new ClaimSubmissionError("Select at least one affected item.");
  }

  // Re-checked at the moment of filing, not just at draft creation: another
  // member of the same account may have filed on this shipment meanwhile.
  const eligibility = await checkClaimEligibility({
    userId: input.userId,
    shipmentDraftId: String(claim.shipmentDraftId),
    excludeClaimId: String(claim._id),
    now
  });
  if (!eligibility.eligible) {
    throw new ClaimSubmissionError(eligibility.message ?? "This shipment is no longer eligible.", 409);
  }

  const snapshot = await captureShipmentSnapshot(claim.shipmentDraftId);

  const rule = await selectPolicyRule({
    category: claim.category,
    originCountryCode: snapshot.originCountryCode,
    destinationCountryCode: snapshot.destinationCountryCode,
    businessAccountId: String(claim.businessAccountId),
    now
  });

  const deadlines = computeClaimDeadlines({
    rule,
    bookedAt: snapshot.bookedAt,
    deliveredAt: snapshot.deliveredAt,
    filedAt: now
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { claimNumber } = await allocateClaimNumber({ now, session });

      claim.claimNumber = claimNumber;
      claim.status = "SUBMITTED";
      claim.submissionStage = "PRELIMINARY";
      claim.shipmentSnapshot = snapshot;
      claim.submittedAt = now;
      claim.declarationVersion = declarationVersion;
      claim.declarationAcceptedAt = now;
      claim.deadlines = {
        policyRuleId: rule ? rule._id : null,
        filingBasis: deadlines.filingBasis,
        filingDeadlineAt: deadlines.filingDeadlineAt,
        evidenceDeadlineAt: deadlines.evidenceDeadlineAt,
        appealDeadlineAt: null,
        internalReviewDueAt: deadlines.internalReviewDueAt,
        filedLate: deadlines.filedLate
      };

      await claim.save({ session });

      await ClaimEvent.create(
        [
          {
            claimId: claim._id,
            type: "SUBMITTED",
            fromStatus: "DRAFT",
            toStatus: "SUBMITTED",
            actorUserId: new mongoose.Types.ObjectId(input.userId),
            actorKind: "CLIENT",
            visibility: "PUBLIC",
            reason: "Preliminary claim notice received."
          },
          {
            claimId: claim._id,
            type: "NUMBER_ALLOCATED",
            actorUserId: new mongoose.Types.ObjectId(input.userId),
            actorKind: "SYSTEM",
            visibility: "PUBLIC",
            reason: `Claim number ${claimNumber} allocated.`,
            metadata: {
              claimNumber,
              filedLate: deadlines.filedLate,
              // Surfaced to staff at decision time: the client's claim is valid
              // but the carrier can likely no longer be billed for it.
              outsideCarrierWindow: deadlines.outsideCarrierWindow
            }
          }
        ],
        { session, ordered: true }
      );
    });
  } finally {
    await session.endSession();
  }

  await AuditLog.create({
    action: "CLAIM_SUBMITTED",
    entityType: "CLAIM",
    entityId: claim._id,
    performedBy: new mongoose.Types.ObjectId(input.userId),
    performedAt: now,
    metadata: {
      claimNumber: claim.claimNumber,
      category: claim.category,
      requestedAmountMinor: claim.requestedAmountMinor,
      filedLate: deadlines.filedLate
    }
  });

  // Both after the transaction, never inside it: neither a mail outage nor an
  // unreadable source file may roll back a claim that already has a number.
  await attachPortalDocuments(claim, new mongoose.Types.ObjectId(input.userId));
  await notifyClaimSubmitted(claim, deadlines.filedLate);

  return { claim, filedLate: deadlines.filedLate, outsideCarrierWindow: deadlines.outsideCarrierWindow };
}

/**
 * Builds one affected-item row from a coordinate.
 *
 * The client sends only a position and a quantity. Everything else is copied
 * from the snapshot rather than accepted from the request, so a client cannot
 * declare their own item values- the declared value on a claim is whatever was
 * declared at booking.
 */
function buildAffectedItem(
  snapshot: Awaited<ReturnType<typeof captureShipmentSnapshot>>,
  input: { parcelSequence: number; itemIndex: number; quantityAffected: number; clientNarrative?: string }
): ClaimAffectedItem {
  const resolved = resolveSnapshotItem(snapshot, input);
  if (!resolved) {
    throw new ClaimSubmissionError(
      `Parcel ${input.parcelSequence} has no item at position ${input.itemIndex + 1}.`
    );
  }
  if (input.quantityAffected < 1) {
    throw new ClaimSubmissionError("Affected quantity must be at least one.");
  }
  if (input.quantityAffected > resolved.quantityShipped) {
    throw new ClaimSubmissionError(
      `Only ${resolved.quantityShipped} of "${resolved.description}" were shipped.`
    );
  }

  return {
    parcelSequence: input.parcelSequence,
    itemIndex: input.itemIndex,
    pieceCode: "",
    descriptionSnapshot: resolved.description,
    quantityShipped: resolved.quantityShipped,
    quantityAffected: input.quantityAffected,
    declaredUnitValueMinor: resolved.declaredUnitValueMinor,
    clientNarrative: input.clientNarrative ?? ""
  };
}

/**
 * Loads a claim the caller is entitled to act on.
 *
 * A claim belonging to another account returns not-found rather than forbidden,
 * for the same reason eligibility does: a 403 would confirm the claim exists.
 */
async function loadOwnedClaim(claimId: string, userId: string) {
  if (!mongoose.isValidObjectId(claimId)) {
    throw new ClaimSubmissionError("Claim not found.", 404);
  }

  const claim = await Claim.findById(claimId).exec();
  if (!claim) throw new ClaimSubmissionError("Claim not found.", 404);

  const membership = await BusinessAccountMember.findOne({
    user: new mongoose.Types.ObjectId(userId),
    businessAccount: claim.businessAccountId,
    status: "active"
  })
    .select("role assignedBranches")
    .lean()
    .exec();

  if (!membership) throw new ClaimSubmissionError("Claim not found.", 404);

  const account = await BusinessAccount.findById(claim.businessAccountId)
    .select("status suspension.mode")
    .lean()
    .exec();
  const accountSuspensionMode = account ? suspensionMode(account) : null;
  if (!account || accountSuspensionMode === "SECURITY_LOCK") {
    throw new ClaimSubmissionError(securityLockMessage, 404);
  }
  if (account.status !== "active") {
    throw new ClaimSubmissionError(
      accountSuspensionMode ? suspensionMessage : "Claims are available to active business accounts only.",
      423
    );
  }

  const assigned = (membership.assignedBranches ?? []).map(String);
  if (assigned.length > 0 && !assigned.includes(String(claim.branchId))) {
    throw new ClaimSubmissionError("Claim not found.", 404);
  }

  return claim;
}

async function recordEvent(input: {
  claimId: mongoose.Types.ObjectId;
  type: ClaimEventType;
  actorUserId: mongoose.Types.ObjectId | null;
  actorKind: "CLIENT" | "STAFF" | "SYSTEM";
  fromStatus?: IClaim["status"] | null;
  toStatus?: IClaim["status"] | null;
  visibility: "PUBLIC" | "INTERNAL";
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  await ClaimEvent.create({
    claimId: input.claimId,
    type: input.type,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    visibility: input.visibility,
    reason: input.reason ?? "",
    metadata: input.metadata ?? {}
  });
}

export { ClaimEligibilityError };
