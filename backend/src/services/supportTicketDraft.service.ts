import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { SupportTicketDraft, type ISupportTicketDraft } from "../models/supportTicketDraft.model.js";
import { SupportTicketError } from "./supportTicket.service.js";
import { createClientSupportTicket } from "./supportTicket.service.js";
import { availableClientAccountIds, suspensionMode } from "./businessAccountSuspension.service.js";
import {
  shipmentIssueCategoryValues,
  type SupportTicketCategory,
} from "../models/supportTicket.model.js";

function isShipmentIssueCategory(category: SupportTicketCategory) {
  return (shipmentIssueCategoryValues as readonly string[]).includes(category);
}

async function assertMembership(userId: mongoose.Types.ObjectId, businessAccountId: mongoose.Types.ObjectId) {
  const membership = await BusinessAccountMember.findOne({ user: userId, businessAccount: businessAccountId, status: "active" }).exec();
  if (!membership) throw new SupportTicketError("You do not have access to this business account.", 403);
  const account = await BusinessAccount.findById(businessAccountId).select("status suspension.mode").lean().exec();
  if (!account || suspensionMode(account) === "SECURITY_LOCK") {
    throw new SupportTicketError("You do not have access to this business account.", 403);
  }
  return membership;
}

async function canViewDraft(draft: ISupportTicketDraft, userId: mongoose.Types.ObjectId) {
  const membership = await BusinessAccountMember.findOne({
    user: userId,
    businessAccount: draft.businessAccountId,
    status: "active",
  }).exec();
  if (!membership) throw new SupportTicketError("Draft not found.", 404);
  const account = await BusinessAccount.findById(draft.businessAccountId).select("status suspension.mode").lean().exec();
  if (!account || suspensionMode(account) === "SECURITY_LOCK") {
    throw new SupportTicketError("Draft not found.", 404);
  }
  const isOwner = String(draft.createdBy) === String(userId);
  const isAdminLike = ["account_owner", "account_admin"].includes(membership.role);
  if (!isOwner && !isAdminLike) throw new SupportTicketError("Draft not found.", 404);
  return membership;
}

export type UpsertDraftInput = {
  businessAccountId: string;
  category?: SupportTicketCategory;
  subject?: string;
  description?: string;
  relatedShipmentDraftId?: string | null;
  version?: number;
};

export async function listTicketDrafts(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" }).select("businessAccount").lean().exec();
  const accountIds = await availableClientAccountIds(memberships.map((m) => m.businessAccount as mongoose.Types.ObjectId));
  if (!accountIds.length) return [];
  const drafts = await SupportTicketDraft.find({
    businessAccountId: { $in: accountIds },
    // The resume page belongs to the author. Account admins may inspect a
    // draft through a direct API read, but must not see another user's work in
    // their personal draft list or accidentally edit it.
    createdBy: userId,
  })
    .sort({ updatedAt: -1 })
    .lean()
    .exec();
  return drafts;
}

export async function getTicketDraft(draftId: string, userId: mongoose.Types.ObjectId) {
  if (!mongoose.Types.ObjectId.isValid(draftId)) throw new SupportTicketError("Draft not found.", 404);
  const draft = await SupportTicketDraft.findById(draftId).exec();
  if (!draft) throw new SupportTicketError("Draft not found.", 404);
  await canViewDraft(draft, userId);
  return draft;
}

export async function upsertTicketDraft(userId: mongoose.Types.ObjectId, draftId: string | null, input: UpsertDraftInput) {
  if (!mongoose.Types.ObjectId.isValid(input.businessAccountId)) throw new SupportTicketError("Select a valid business account.", 400);
  const businessAccountId = new mongoose.Types.ObjectId(input.businessAccountId);
  await assertMembership(userId, businessAccountId);

  const account = await BusinessAccount.findById(businessAccountId).select("assignedBranch").lean().exec();
  if (!account) throw new SupportTicketError("Business account not found.", 404);

  let relatedShipmentDraftId: mongoose.Types.ObjectId | null = null;
  if (input.relatedShipmentDraftId) {
    if (!mongoose.Types.ObjectId.isValid(input.relatedShipmentDraftId)) throw new SupportTicketError("Select a valid related shipment.", 400);
    relatedShipmentDraftId = new mongoose.Types.ObjectId(input.relatedShipmentDraftId);
    const exists = await ShipmentDraft.exists({ _id: relatedShipmentDraftId, businessAccountId });
    if (!exists) throw new SupportTicketError("The selected shipment does not belong to this business account.", 400);
  }

  // Optimistic version check if updating existing draft.
  if (draftId) {
    if (!mongoose.Types.ObjectId.isValid(draftId)) throw new SupportTicketError("Draft not found.", 404);
    const existing = await SupportTicketDraft.findById(draftId).exec();
    if (!existing) throw new SupportTicketError("Draft not found.", 404);
    await canViewDraft(existing, userId);
    if (String(existing.createdBy) !== String(userId)) throw new SupportTicketError("Draft not found.", 404);
    if (typeof input.version === "number" && existing.version !== input.version) {
      throw new SupportTicketError("This draft was updated elsewhere. Refresh and try again.", 409);
    }
    if (input.category) existing.category = input.category;
    if (typeof input.subject === "string") existing.subject = input.subject.trim().slice(0, 120);
    if (typeof input.description === "string") existing.description = input.description.trim().slice(0, 2000);
    if (input.relatedShipmentDraftId !== undefined) existing.relatedShipmentDraftId = relatedShipmentDraftId;
    existing.version += 1;
    await existing.save();
    return existing;
  }

  // Create new draft – no ticket number, no SLA, no queue side effects.
  const draft = await SupportTicketDraft.create({
    businessAccountId,
    branchId: account.assignedBranch ?? null,
    createdBy: userId,
    category: input.category ?? "OTHER",
    subject: (input.subject ?? "").trim().slice(0, 120),
    description: (input.description ?? "").trim().slice(0, 2000),
    relatedShipmentDraftId,
    version: 1,
  });
  return draft;
}

export async function deleteTicketDraft(draftId: string, userId: mongoose.Types.ObjectId) {
  const draft = await getTicketDraft(draftId, userId);
  if (String(draft.createdBy) !== String(userId)) throw new SupportTicketError("Draft not found.", 404);
  await SupportTicketDraft.deleteOne({ _id: draft._id }).exec();
  return draft;
}

export async function submitTicketDraft(draftId: string, userId: mongoose.Types.ObjectId) {
  const draft = await getTicketDraft(draftId, userId);
  if (String(draft.createdBy) !== String(userId)) throw new SupportTicketError("Draft not found.", 404);
  // Validation mirrors live ticket creation, but draft itself never enforced
  // duplicate blocking or SLA. Those run here at submission time, where the
  // live path already handles them.
  if (!draft.subject || draft.subject.trim().length < 5) throw new SupportTicketError("Subject must contain at least 5 characters.", 400);
  if (!draft.description || draft.description.trim().length < 10) throw new SupportTicketError("Description must contain at least 10 characters.", 400);
  if (isShipmentIssueCategory(draft.category) && !draft.relatedShipmentDraftId) {
    throw new SupportTicketError("Select the shipment this issue relates to.", 400);
  }

  const ticket = await createClientSupportTicket(userId, {
    businessAccountId: String(draft.businessAccountId),
    category: draft.category,
    subject: draft.subject,
    description: draft.description,
    relatedShipmentDraftId: draft.relatedShipmentDraftId ? String(draft.relatedShipmentDraftId) : null,
    sourceDraftId: String(draft._id),
  });

  // Safe delete – draft gone only after ticket exists. If ticket creation
  // failed, draft remains for resume/retry.
  await SupportTicketDraft.deleteOne({ _id: draft._id }).exec();
  return ticket;
}

export function serializeTicketDraft(draft: ISupportTicketDraft) {
  return {
    id: String(draft._id),
    businessAccountId: String(draft.businessAccountId),
    branchId: draft.branchId ? String(draft.branchId) : null,
    category: draft.category,
    subject: draft.subject,
    description: draft.description,
    relatedShipmentDraftId: draft.relatedShipmentDraftId ? String(draft.relatedShipmentDraftId) : null,
    version: draft.version,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}
