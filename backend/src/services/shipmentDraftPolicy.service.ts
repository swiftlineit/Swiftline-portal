import { shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import mongoose from "mongoose";
import { BalanceReservation } from "../models/balanceReservation.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { PickupRequestShipment } from "../models/pickupRequestShipment.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import {
  ShipmentDraft,
  type IShipmentDraft,
  type ShipmentDraftBookingState
} from "../models/shipmentDraft.model.js";
import { getTenantContext } from "./tenantScope.service.js";

// Business-account seats, not portal roles. "operations" appears in both
// vocabularies and means different things: here it is a client's own staff
// member, not Swiftline operations.
const clientShipmentEditorRoles = new Set<string>(shipmentBookingRoles);
export class ShipmentDraftPolicyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ShipmentDraftPolicyError";
  }
}

export async function resolveDraftBookingState(
  draft: Pick<IShipmentDraft, "_id" | "bookingState">
): Promise<ShipmentDraftBookingState> {
  if (draft.bookingState && draft.bookingState !== "EDITABLE") return draft.bookingState;

  // Legacy development records predate bookingState. Carrier state remains the
  // authoritative fallback so old booked drafts become read-only immediately.
  const carrierBooking = await DpdShipment.findOne({ shipmentDraftId: draft._id })
    .select("status")
    .lean()
    .exec();

  if (!carrierBooking || carrierBooking.status === "DPD_REJECTED") return "EDITABLE";
  if (["DPD_STATUS_UNKNOWN", "DPD_CREATED"].includes(carrierBooking.status)) return "REVIEW_REQUIRED";
  if (carrierBooking.status === "DPD_CREATING") return "BOOKING";
  return carrierBooking.status === "LABEL_RECEIVED" ? "BOOKED" : "EDITABLE";
}

function getBookingStateMessage(bookingState: ShipmentDraftBookingState) {
  if (bookingState === "BOOKING") {
    return "This shipment is currently being booked. Wait for the booking result before trying again.";
  }
  if (bookingState === "REVIEW_REQUIRED") {
    return "This shipment is awaiting booking reconciliation and cannot be edited. Contact Swiftline Operations.";
  }
  return "This shipment has already been booked. Submit an amendment to request changes.";
}

export async function assertShipmentDraftEditable(draft: IShipmentDraft) {
  // Checked here rather than at each call site so every mutation path- field
  // edits, KYC uploads, address selection, booking, amendments- refuses a
  // deleted draft without needing its own filter.
  if (draft.deletedAt) {
    throw new ShipmentDraftPolicyError("This shipment draft has been deleted.", 404);
  }

  const bookingState = await resolveDraftBookingState(draft);
  if (bookingState === "EDITABLE") return;

  throw new ShipmentDraftPolicyError(getBookingStateMessage(bookingState), 409);
}

export async function beginShipmentDraftBooking(input: {
  draft: IShipmentDraft;
  bookingAttemptId: string;
}) {
  const currentState = await resolveDraftBookingState(input.draft);
  if (currentState !== "EDITABLE") {
    throw new ShipmentDraftPolicyError(getBookingStateMessage(currentState), 409);
  }

  const lockedDraft = await ShipmentDraft.findOneAndUpdate(
    { _id: input.draft._id, bookingState: "EDITABLE", updatedAt: input.draft.updatedAt },
    {
      $set: {
        bookingState: "BOOKING",
        bookingAttemptId: input.bookingAttemptId,
        lockedAt: new Date()
      }
    },
    { returnDocument: "after", runValidators: true }
  ).exec();

  if (lockedDraft) return lockedDraft;

  const concurrentDraft = await ShipmentDraft.findById(input.draft._id).exec();
  const concurrentState = concurrentDraft
    ? await resolveDraftBookingState(concurrentDraft)
    : "REVIEW_REQUIRED";
  if (concurrentState === "EDITABLE") {
    throw new ShipmentDraftPolicyError(
      "Shipment details changed while booking started. Review the latest values and try again.",
      409
    );
  }
  throw new ShipmentDraftPolicyError(getBookingStateMessage(concurrentState), 409);
}

export async function transitionShipmentDraftBooking(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  bookingAttemptId: string;
  bookingState: ShipmentDraftBookingState;
}) {
  const update = input.bookingState === "EDITABLE"
    ? {
      $set: { bookingState: "EDITABLE", bookingAttemptId: "", lockedAt: null }
    }
    : {
      $set: { bookingState: input.bookingState }
    };

  return ShipmentDraft.findOneAndUpdate(
    { _id: input.shipmentDraftId, bookingAttemptId: input.bookingAttemptId },
    update,
    { returnDocument: "after", runValidators: true }
  ).exec();
}

export async function clientCanAccessShipmentDraft(input: {
  userId: string | mongoose.Types.ObjectId;
  draft: Pick<IShipmentDraft, "businessAccountId" | "branchId">;
  requireEditPermission?: boolean;
}) {
  const membership = await BusinessAccountMember.findOne({
    user: input.userId,
    businessAccount: input.draft.businessAccountId,
    status: "active"
  })
    .select("role assignedBranches")
    .lean()
    .exec();
  if (!membership) return false;
  if (input.requireEditPermission && !clientShipmentEditorRoles.has(membership.role)) return false;

  const explicitBranchIds = (membership.assignedBranches ?? []).map(String);
  if (explicitBranchIds.length) return explicitBranchIds.includes(String(input.draft.branchId));

  const account = await BusinessAccount.findById(input.draft.businessAccountId)
    .select("assignedBranch")
    .lean()
    .exec();
  return Boolean(account?.assignedBranch && String(account.assignedBranch) === String(input.draft.branchId));
}

/**
 * Branches an internal member may act in.
 *
 * Mirrors `allowedBranchIds` in branchAccess.middleware.ts, which reads the same
 * assignment off the request. The policy is called from services that have no
 * request to read, so the assignment is loaded from the user record instead.
 * A member with no assignment reaches nothing, matching the branch middleware
 * and the draft list, which already shows such a member no drafts at all.
 */
async function assignedBranchIds(userId: string | mongoose.Types.ObjectId) {
  const user = await User.findById(userId).select("assignedBranches").lean().exec();
  return (user?.assignedBranches ?? []).map(String);
}

/**
 * Whether a signed-in member may modify this draft.
 *
 * Admin reaches every branch. Swiftline operations is held to its assigned
 * branches, and the branch on the draft is what that is checked against: a
 * business draft can only be created in the branch its account is assigned to
 * (enforced in manualShipmentDraft.service.ts), so the draft's branch *is* the
 * account's branch. Walk-in drafts point at the individual sentinel, which
 * serves every branch, leaving the draft's branch the only meaningful scope
 * there too. Clients are reached through their business-account membership.
 */
export async function canModifyShipmentDraft(input: {
  draft: Pick<IShipmentDraft, "businessAccountId" | "branchId">;
  userId: string | mongoose.Types.ObjectId;
  portalRole: string;
}) {
  if (input.portalRole === "admin") return true;

  if (input.portalRole === "operations") {
    const tenant = getTenantContext();
    const userId = String(input.userId);
    const branchIds = tenant?.kind === "OPERATOR"
      ? mongoose.Types.ObjectId.isValid(userId)
        ? (await TenantMembership.findOne({
          tenantId: tenant.tenantId,
          userId: new mongoose.Types.ObjectId(userId),
          status: "ACTIVE",
          role: "OPERATIONS"
        }).select("assignedBranches").lean().exec())?.assignedBranches.map(String) ?? []
        : []
      : await assignedBranchIds(input.userId);
    return branchIds.includes(String(input.draft.branchId));
  }

  return input.portalRole === "client" && await clientCanAccessShipmentDraft({
    userId: input.userId,
    draft: input.draft,
    requireEditPermission: true
  });
}

export async function assertShipmentDraftMutationAllowed(input: {
  draft: IShipmentDraft;
  userId: string | mongoose.Types.ObjectId;
  portalRole: string;
}) {
  if (!await canModifyShipmentDraft(input)) {
    throw new ShipmentDraftPolicyError("You do not have permission to modify this shipment draft.", 403);
  }

  await assertShipmentDraftEditable(input.draft);
}

export async function syncLegacyDraftBookingState(draft: IShipmentDraft) {
  const bookingState = await resolveDraftBookingState(draft);
  if (draft.bookingState === bookingState) return bookingState;

  draft.bookingState = bookingState;
  if (bookingState !== "EDITABLE" && !draft.lockedAt) draft.lockedAt = draft.updatedAt ?? new Date();
  await draft.save();
  return bookingState;
}

/**
 * Why a draft cannot be deleted, or null when it can be.
 *
 * `EDITABLE` is necessary but not sufficient. A rejected carrier booking sends a
 * draft back to EDITABLE while leaving its DpdShipment behind, so the carrier
 * record is checked directly rather than inferred from booking state. The
 * remaining checks cover records that would be orphaned by the removal.
 */
export async function findShipmentDraftDeletionBlocker(
  draftId: mongoose.Types.ObjectId
): Promise<string | null> {
  const [carrierBooking, invoice, consignment, manifested, pickup, reservation] = await Promise.all([
    DpdShipment.countDocuments({ shipmentDraftId: draftId }).exec(),
    ShipmentInvoice.countDocuments({ shipmentDraftId: draftId }).exec(),
    OperationsManifestConsignment.countDocuments({
      shipmentDraftId: draftId,
      status: { $ne: "REMOVED" }
    }).exec(),
    ShipmentManifest.countDocuments({ shipmentDraftIds: draftId }).exec(),
    PickupRequestShipment.countDocuments({
      shipmentDraftId: draftId,
      status: { $ne: "CANCELLED" }
    }).exec(),
    BalanceReservation.countDocuments({
      shipmentDraftId: draftId,
      status: { $in: ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"] }
    }).exec()
  ]);

  if (carrierBooking) {
    return "This shipment has already been sent to the carrier and cannot be deleted. Cancel the shipment instead.";
  }
  if (invoice) return "This shipment has an invoice and cannot be deleted. Cancel the shipment instead.";
  if (consignment || manifested) return "This shipment is on a manifest. Remove it from the manifest first.";
  if (pickup) return "This shipment is on a pickup request. Remove it from the pickup first.";
  if (reservation) return "This shipment is holding a credit or prepaid reservation. Contact Swiftline Operations.";

  return null;
}

export async function assertShipmentDraftDeletable(input: {
  draft: IShipmentDraft;
  userId: string | mongoose.Types.ObjectId;
  portalRole: string;
}) {
  // Covers permission plus the EDITABLE requirement; deletion is a mutation like
  // any other, so it must not be reachable on a draft that cannot be edited.
  await assertShipmentDraftMutationAllowed(input);

  const blocker = await findShipmentDraftDeletionBlocker(input.draft._id as mongoose.Types.ObjectId);
  if (blocker) throw new ShipmentDraftPolicyError(blocker, 409);
}
