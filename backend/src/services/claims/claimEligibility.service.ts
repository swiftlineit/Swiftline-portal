import mongoose from "mongoose";
import { BusinessAccount } from "../../models/businessAccount.model.js";
import { BusinessAccountMember } from "../../models/businessAccountMember.model.js";
import { Claim } from "../../models/claim.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentCancellation } from "../../models/shipmentCancellation.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../../models/shipmentEvent.model.js";
import { activeClaimStatusValues, claimFilingDeadline } from "../../models/claimTypes.js";
import { clientCan } from "./claimPermissions.js";

/**
 * Decides whether a client may raise a claim on a shipment, and says why not.
 *
 * The "why not" matters as much as the answer: a client who cannot file needs to
 * know whether to wait, to contact support, or that they are simply too late.
 * A bare `false` sends them to the help desk.
 *
 * One rule overrides all the others- a shipment belonging to another business
 * account returns the same not-found answer as a shipment that does not exist.
 * Confirming that another company's tracking number is real would leak the fact
 * that they ship with Swiftline.
 */

export class ClaimEligibilityError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ClaimEligibilityError";
  }
}

export const claimIneligibilityReasonValues = [
  "NOT_BOOKED",
  "NOT_COLLECTED",
  "CANCELLED_BEFORE_COLLECTION",
  "CLAIM_ALREADY_ACTIVE",
  "NO_BRANCH_ACCESS",
  "NOT_PERMITTED",
  "ACCOUNT_INACTIVE",
  "PAST_FILING_DEADLINE"
] as const;

export type ClaimIneligibilityReason = (typeof claimIneligibilityReasonValues)[number];

/** Wording shown to the client. Explains the next step, not just the refusal. */
const reasonMessages: Record<ClaimIneligibilityReason, string> = {
  NOT_BOOKED: "This shipment has not been booked yet, so there is nothing to claim for.",
  NOT_COLLECTED:
    "This shipment has not been collected yet. A claim can be raised once it has entered its journey.",
  CANCELLED_BEFORE_COLLECTION:
    "This shipment was cancelled before collection. Cancellation refunds are handled separately from claims.",
  CLAIM_ALREADY_ACTIVE: "A claim is already open for this shipment.",
  NO_BRANCH_ACCESS: "You do not have access to the branch this shipment was booked under.",
  NOT_PERMITTED: "Your role does not allow raising claims. Ask an account owner or admin.",
  ACCOUNT_INACTIVE: "Claims are available to active business accounts only.",
  PAST_FILING_DEADLINE:
    "The filing window for this shipment has passed. You can still submit, and our team will review whether it can be accepted."
};

export interface ClaimEligibility {
  eligible: boolean;
  reason: ClaimIneligibilityReason | null;
  message: string | null;
  /**
   * True when the only obstacle is the deadline. Late claims are flagged for
   * staff review rather than blocked- carrier tracking is often incomplete or
   * delayed, and a client should not lose a valid claim to a date.
   */
  requiresStaffReview: boolean;
  shipment: EligibleShipmentSummary | null;
}

export interface EligibleShipmentSummary {
  shipmentDraftId: string;
  trackingNumber: string;
  carrierTrackingNumbers: string[];
  bookedAt: Date | null;
  collectedAt: Date | null;
  deliveredAt: Date | null;
  parcelCount: number;
  businessAccountId: string;
  branchId: string;
}

function ineligible(
  reason: ClaimIneligibilityReason,
  shipment: EligibleShipmentSummary | null = null
): ClaimEligibility {
  return {
    eligible: false,
    reason,
    message: reasonMessages[reason],
    requiresStaffReview: false,
    shipment
  };
}

/**
 * The operational milestones a claim depends on.
 *
 * `PARCEL_COLLECTED` and `DELIVERED` are read from the event trail rather than
 * from a status field because a shipment's current status only tells you where
 * it is now, and a delivered-then-disputed parcel still needs its delivery date.
 */
async function milestones(shipmentDraftId: mongoose.Types.ObjectId) {
  const [collected, delivered] = await Promise.all([
    ShipmentEvent.findOne({ shipmentDraftId, status: "PARCEL_COLLECTED" })
      .sort({ eventAt: 1 })
      .select("eventAt")
      .lean()
      .exec(),
    ShipmentEvent.findOne({ shipmentDraftId, status: "DELIVERED" })
      .sort({ eventAt: -1 })
      .select("eventAt")
      .lean()
      .exec()
  ]);

  return {
    collectedAt: collected?.eventAt ?? null,
    deliveredAt: delivered?.eventAt ?? null
  };
}

/**
 * Whether a live claim already occupies this shipment.
 *
 * Queried on `status` rather than on the `activeShipmentDraftId` marker so that
 * a row written before the marker existed, or one left inconsistent by a partial
 * write, still blocks a duplicate. The unique index is the guarantee; this is
 * the friendly answer that avoids hitting it.
 */
async function hasActiveClaim(
  shipmentDraftId: mongoose.Types.ObjectId,
  excludeClaimId?: string
) {
  const existing = await Claim.exists({
    shipmentDraftId,
    status: { $in: activeClaimStatusValues },
    // The claim being submitted is itself active- a draft counts as occupying
    // its shipment. Without this exclusion the re-check at submission finds the
    // very claim it is validating and refuses it, so nothing could ever be filed.
    ...(excludeClaimId ? { _id: { $ne: new mongoose.Types.ObjectId(excludeClaimId) } } : {})
  });
  return Boolean(existing);
}

export async function checkClaimEligibility(input: {
  userId: string;
  shipmentDraftId: string;
  now?: Date;
  /** The claim being validated, so it does not count as blocking itself. */
  excludeClaimId?: string;
}): Promise<ClaimEligibility> {
  const now = input.now ?? new Date();

  if (!mongoose.isValidObjectId(input.shipmentDraftId)) {
    throw new ClaimEligibilityError("Shipment not found.", 404);
  }

  const shipmentDraftId = new mongoose.Types.ObjectId(input.shipmentDraftId);
  const shipment = await ShipmentDraft.findById(shipmentDraftId)
    .select("businessAccountId branchId bookingState parcelList parcelCount createdAt updatedAt")
    .lean()
    .exec();

  if (!shipment) throw new ClaimEligibilityError("Shipment not found.", 404);

  const membership = await BusinessAccountMember.findOne({
    user: new mongoose.Types.ObjectId(input.userId),
    businessAccount: shipment.businessAccountId,
    status: "active"
  })
    .select("role assignedBranches")
    .lean()
    .exec();

  // No membership means this shipment belongs to someone else. Same answer as a
  // shipment that does not exist- see the note at the top of this file.
  if (!membership) throw new ClaimEligibilityError("Shipment not found.", 404);

  const account = await BusinessAccount.findById(shipment.businessAccountId)
    .select("status")
    .lean()
    .exec();

  // Claims are a business-account feature. Individual and counter customers are
  // out of scope entirely.
  if (!account || account.status !== "active") return ineligible("ACCOUNT_INACTIVE");

  if (!clientCan(membership.role, "CREATE")) return ineligible("NOT_PERMITTED");

  // An empty assignment list means every branch for this member- the account's
  // own scoping convention, distinct from staff branch scoping.
  const assigned = (membership.assignedBranches ?? []).map(String);
  if (assigned.length > 0 && !assigned.includes(String(shipment.branchId))) {
    return ineligible("NO_BRANCH_ACCESS");
  }

  if (shipment.bookingState !== "BOOKED") return ineligible("NOT_BOOKED");

  const [{ collectedAt, deliveredAt }, cancellation, booking, claimExists] = await Promise.all([
    milestones(shipmentDraftId),
    ShipmentCancellation.findOne({ shipmentDraftId, status: { $in: ["REQUESTED", "COMPLETED"] } })
      .select("status")
      .lean()
      .exec(),
    DpdShipment.findOne({ shipmentDraftId })
      .select("swiftlineTrackingNumber parcelNumbers createdAt")
      .lean()
      .exec(),
    hasActiveClaim(shipmentDraftId, input.excludeClaimId)
  ]);

  const summary: EligibleShipmentSummary = {
    shipmentDraftId: String(shipment._id),
    trackingNumber: booking?.swiftlineTrackingNumber ?? "",
    carrierTrackingNumbers: booking?.parcelNumbers ?? [],
    bookedAt: booking?.createdAt ?? null,
    collectedAt,
    deliveredAt,
    parcelCount: shipment.parcelCount ?? shipment.parcelList?.length ?? 0,
    businessAccountId: String(shipment.businessAccountId),
    branchId: String(shipment.branchId)
  };

  // Cancelled before it ever moved: there is no loss to compensate, and the
  // refund path handles the money.
  if (cancellation && !collectedAt) return ineligible("CANCELLED_BEFORE_COLLECTION", summary);

  if (!collectedAt) return ineligible("NOT_COLLECTED", summary);
  if (claimExists) return ineligible("CLAIM_ALREADY_ACTIVE", summary);

  // A LOST or DAMAGED tracking event would be helpful here but is deliberately
  // not required: carrier feeds are often incomplete or days behind, and waiting
  // for one would cost clients their filing window.

  const deadline = filingDeadlineFor({ bookedAt: summary.bookedAt, deliveredAt, now });

  if (deadline.passed) {
    return {
      eligible: true,
      reason: "PAST_FILING_DEADLINE",
      message: reasonMessages.PAST_FILING_DEADLINE,
      requiresStaffReview: true,
      shipment: summary
    };
  }

  return { eligible: true, reason: null, message: null, requiresStaffReview: false, shipment: summary };
}

/**
 * Whether the filing window has closed.
 *
 * Kept here rather than inlined so the eligibility answer and the deadline
 * frozen onto the claim at submission come from the same rule. They are computed
 * at different moments and must not be able to disagree.
 */
function filingDeadlineFor(input: {
  bookedAt: Date | null;
  deliveredAt: Date | null;
  now: Date;
}) {
  // No booking record means no clock to measure from, so nothing can be late.
  if (!input.bookedAt) return { passed: false, deadline: null };

  const { deadline } = claimFilingDeadline({
    bookedAt: input.bookedAt,
    deliveredAt: input.deliveredAt
  });

  return { passed: input.now > deadline, deadline };
}

/**
 * Shipments this member could start a claim on right now.
 *
 * Scoped to the member's branches and filtered to booked, collected shipments
 * without a live claim. Bounded by `limit` because a busy account can have
 * thousands and the picker only ever shows a page.
 */
export async function listClaimableShipments(input: {
  userId: string;
  businessAccountId: string;
  limit?: number;
}) {
  const membership = await BusinessAccountMember.findOne({
    user: new mongoose.Types.ObjectId(input.userId),
    businessAccount: new mongoose.Types.ObjectId(input.businessAccountId),
    status: "active"
  })
    .select("role assignedBranches")
    .lean()
    .exec();

  if (!membership || !clientCan(membership.role, "CREATE")) return [];

  const account = await BusinessAccount.findById(input.businessAccountId).select("status").lean().exec();
  if (!account || account.status !== "active") return [];

  const assigned = (membership.assignedBranches ?? []).map(String);
  const query: Record<string, unknown> = {
    businessAccountId: new mongoose.Types.ObjectId(input.businessAccountId),
    bookingState: "BOOKED"
  };
  if (assigned.length > 0) query.branchId = { $in: assigned.map((id) => new mongoose.Types.ObjectId(id)) };

  const shipments = await ShipmentDraft.find(query)
    .select("businessAccountId branchId parcelCount updatedAt")
    .sort({ updatedAt: -1 })
    .limit(input.limit ?? 50)
    .lean()
    .exec();

  const ids = shipments.map((shipment) => shipment._id);

  // Three bulk queries rather than per-shipment lookups: a 50-row picker would
  // otherwise issue 150 round trips.
  const [collectedEvents, activeClaims, bookings] = await Promise.all([
    ShipmentEvent.find({ shipmentDraftId: { $in: ids }, status: "PARCEL_COLLECTED" })
      .select("shipmentDraftId eventAt")
      .lean()
      .exec(),
    Claim.find({ shipmentDraftId: { $in: ids }, status: { $in: activeClaimStatusValues } })
      .select("shipmentDraftId")
      .lean()
      .exec(),
    DpdShipment.find({ shipmentDraftId: { $in: ids } })
      .select("shipmentDraftId swiftlineTrackingNumber createdAt")
      .lean()
      .exec()
  ]);

  const collectedAt = new Map(collectedEvents.map((event) => [String(event.shipmentDraftId), event.eventAt]));
  const claimed = new Set(activeClaims.map((claim) => String(claim.shipmentDraftId)));
  const booking = new Map(bookings.map((row) => [String(row.shipmentDraftId), row]));

  return shipments
    .filter((shipment) => collectedAt.has(String(shipment._id)) && !claimed.has(String(shipment._id)))
    .map((shipment) => ({
      shipmentDraftId: String(shipment._id),
      trackingNumber: booking.get(String(shipment._id))?.swiftlineTrackingNumber ?? "",
      bookedAt: booking.get(String(shipment._id))?.createdAt ?? null,
      collectedAt: collectedAt.get(String(shipment._id)) ?? null,
      parcelCount: shipment.parcelCount ?? 0,
      branchId: String(shipment.branchId)
    }));
}
