import mongoose from "mongoose";
import type { ShipmentManifestAssignments } from "../models/shipmentDraft.model.js";
import type { IShipmentManifest, ShipmentManifestActorRole, ShipmentManifestType } from "../models/shipmentManifest.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentManifestServiceError } from "./shipmentManifest.service.js";

export type ShipmentManifestAssignmentSlot = "CLIENT_ACCOUNT" | "STAFF_ACCOUNT" | "STAFF_COMBINED";

const slotField: Record<ShipmentManifestAssignmentSlot, keyof ShipmentManifestAssignments> = {
  CLIENT_ACCOUNT: "clientAccountManifestId",
  STAFF_ACCOUNT: "staffAccountManifestId",
  STAFF_COMBINED: "staffCombinedManifestId"
};

const membershipFields: Array<keyof ShipmentManifestAssignments> = [
  "clientAccountManifestId",
  "staffAccountManifestId",
  "staffCombinedManifestId"
];

function hasAssignment(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).length > 0;
}

export function shipmentManifestAssignmentSlot(
  actorRole: ShipmentManifestActorRole,
  manifestType: ShipmentManifestType
): ShipmentManifestAssignmentSlot {
  if (actorRole === "client") {
    if (manifestType !== "ACCOUNT") {
      throw new ShipmentManifestServiceError("Clients can only create account-specific manifests.", 403);
    }
    return "CLIENT_ACCOUNT";
  }
  return manifestType === "COMBINED" ? "STAFF_COMBINED" : "STAFF_ACCOUNT";
}

export function shipmentManifestAssignmentAvailability(
  assignments: ShipmentManifestAssignments | null | undefined,
  actorRole: ShipmentManifestActorRole
) {
  const hasClientAccount = hasAssignment(assignments?.clientAccountManifestId);
  const hasStaffAccount = hasAssignment(assignments?.staffAccountManifestId);
  const hasStaffCombined = hasAssignment(assignments?.staffCombinedManifestId);

  return {
    hasAny: hasClientAccount || hasStaffAccount || hasStaffCombined,
    hasClientAccount,
    hasStaffAccount,
    hasStaffCombined,
    canCreateAccount: actorRole === "client"
      ? !hasClientAccount
      : !hasStaffAccount && !hasStaffCombined,
    canCreateCombined: actorRole === "admin" && !hasStaffCombined
  };
}

export function shipmentManifestAssignmentClaimFilter(
  shipmentDraftId: mongoose.Types.ObjectId,
  slot: ShipmentManifestAssignmentSlot
) {
  const fieldsToKeepEmpty: Array<keyof ShipmentManifestAssignments> = slot === "CLIENT_ACCOUNT"
    ? ["clientAccountManifestId"]
    : slot === "STAFF_ACCOUNT"
      ? ["staffAccountManifestId", "staffCombinedManifestId"]
      : ["staffCombinedManifestId"];

  return {
    _id: shipmentDraftId,
    ...Object.fromEntries(fieldsToKeepEmpty.map((field) => [`shipmentManifestAssignments.${field}`, null]))
  };
}

function conflictMessage(slot: ShipmentManifestAssignmentSlot) {
  if (slot === "CLIENT_ACCOUNT") {
    return "One or more selected shipments already belong to a client manifest.";
  }
  if (slot === "STAFF_ACCOUNT") {
    return "One or more selected shipments already belong to a staff manifest and cannot be added to another account-specific manifest.";
  }
  return "One or more selected shipments already belong to a staff combined manifest.";
}

export async function claimShipmentManifestAssignments(
  shipmentDraftIds: mongoose.Types.ObjectId[],
  manifestId: mongoose.Types.ObjectId,
  actorRole: ShipmentManifestActorRole,
  manifestType: ShipmentManifestType,
  session: mongoose.ClientSession
) {
  const slot = shipmentManifestAssignmentSlot(actorRole, manifestType);

  for (const shipmentDraftId of shipmentDraftIds) {
    const filter = shipmentManifestAssignmentClaimFilter(shipmentDraftId, slot);
    const fieldPath = `shipmentManifestAssignments.${slotField[slot]}`;
    const result = await ShipmentDraft.updateOne(
      filter,
      { $set: { [fieldPath]: manifestId } },
      { session }
    ).exec();
    if (result.matchedCount !== 1) throw new ShipmentManifestServiceError(conflictMessage(slot), 409);
  }
}

export async function releaseShipmentManifestAssignments(
  manifests: Pick<IShipmentManifest, "_id" | "actorRole" | "manifestType" | "shipmentDraftIds">[],
  session: mongoose.ClientSession
) {
  for (const manifest of manifests) {
    const slot = shipmentManifestAssignmentSlot(manifest.actorRole, manifest.manifestType ?? "ACCOUNT");
    const fieldPath = `shipmentManifestAssignments.${slotField[slot]}`;
    for (const shipmentDraftId of manifest.shipmentDraftIds) {
      await ShipmentDraft.updateOne(
        { _id: shipmentDraftId, [fieldPath]: manifest._id },
        { $unset: { [fieldPath]: "" } },
        { session }
      ).exec();
      await ShipmentDraft.updateOne(
        {
          _id: shipmentDraftId,
          shipmentManifestAssignments: { $exists: true },
          ...Object.fromEntries(membershipFields.map((field) => [`shipmentManifestAssignments.${field}`, null]))
        },
        { $unset: { shipmentManifestAssignments: "" } },
        { session }
      ).exec();
    }
  }
}

export function shipmentManifestAssignmentSlotField(slot: ShipmentManifestAssignmentSlot) {
  return slotField[slot];
}
