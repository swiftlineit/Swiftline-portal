import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import {
  BusinessAccountMember,
  accountAdminRoles,
  businessAccountMemberRoleLabels,
  businessAccountMemberRoleValues
} from "../models/businessAccountMember.model.js";
import { User } from "../models/user.model.js";
import { notifyOperationsStaff } from "../services/portalNotification.service.js";

/**
 * The people on a business account, managed by that account's administrators.
 *
 * An invitation raised here does not create a login. It creates a request in
 * `pending_approval` and tells Swiftline, because anyone named would gain
 * immediate sight of the account's shipments, invoices and claims- and a
 * customer minting portal logins unsupervised is not a feature.
 */

function actorId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

/** The caller's own administrator membership, or null. */
async function adminMembership(userId: mongoose.Types.ObjectId) {
  const membership = await BusinessAccountMember.findOne({
    user: userId,
    status: "active",
    role: { $in: accountAdminRoles }
  }).select("businessAccount role").lean().exec();
  if (membership) {
    const account = await BusinessAccount.findById(membership.businessAccount).select("status suspension.mode").lean().exec();
    if (!account || (account.status === "suspended" && account.suspension?.mode === "SECURITY_LOCK")) return null;
  }
  return membership ?? null;
}

function serialize(member: {
  _id: unknown;
  role: string;
  status: string;
  createdAt?: Date;
  joinedAt?: Date | null;
  user?: unknown;
  assignedBranches?: unknown;
  requestedInvite?: { firstName?: string; lastName?: string; email?: string } | null;
}) {
  const user = member.user as {
    _id?: unknown; firstName?: string; lastName?: string; name?: string; email?: string; phone?: string;
  } | null;
  const branches = (member.assignedBranches ?? []) as Array<{ name?: string; code?: string }>;
  const invite = member.requestedInvite;

  return {
    id: String(member._id),
    userId: user?._id ? String(user._id) : "",
    // A pending request has no user of its own yet, so it reads from the
    // details the administrator typed.
    name: member.status === "pending_approval"
      ? [invite?.firstName, invite?.lastName].filter(Boolean).join(" ")
      : [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.name || "",
    email: member.status === "pending_approval" ? invite?.email ?? "" : user?.email ?? "",
    phone: user?.phone ?? "",
    role: member.role,
    roleLabel: businessAccountMemberRoleLabels[member.role as keyof typeof businessAccountMemberRoleLabels] ?? member.role,
    status: member.status,
    branches: branches.map((branch) => `${branch.name ?? ""}${branch.code ? ` (${branch.code})` : ""}`.trim()),
    requestedAt: member.createdAt ?? null,
    joinedAt: member.joinedAt ?? null
  };
}

export async function listClientTeam(request: Request, response: Response): Promise<Response> {
  const userId = actorId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const membership = await adminMembership(userId);
  if (!membership) {
    return response.status(403).json({ success: false, message: "Team members are managed by account owners and administrators." });
  }

  const members = await BusinessAccountMember.find({
    businessAccount: membership.businessAccount,
    status: { $ne: "removed" }
  })
    .populate("user", "firstName lastName name email phone userStatus")
    .populate("assignedBranches", "name code")
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  return response.status(200).json({
    success: true,
    members: members.map((member) => serialize(member as never)),
    roles: businessAccountMemberRoleValues
      // An account cannot appoint another owner; that stays Swiftline's.
      .filter((role) => role !== "account_owner")
      .map((role) => ({ value: role, label: businessAccountMemberRoleLabels[role] }))
  });
}

const inviteSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().toLowerCase(),
  phone: z.string().trim().min(8, "Enter the phone number in international format.").max(30),
  role: z.enum(businessAccountMemberRoleValues).refine((role) => role !== "account_owner", {
    message: "Contact Swiftline to change the account owner."
  })
});

export async function requestClientTeamInvite(request: Request, response: Response): Promise<Response> {
  const userId = actorId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const membership = await adminMembership(userId);
  if (!membership) {
    return response.status(403).json({ success: false, message: "Team members are managed by account owners and administrators." });
  }
  const accountStatus = await BusinessAccount.findById(membership.businessAccount).select("status").lean().exec();
  if (accountStatus?.status === "suspended") return response.status(423).json({ success: false, message: "Team changes are paused while this account is suspended." });

  const parsed = inviteSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the invitation details." });
  }

  // A portal identity belongs to one account, so an address already in use
  // cannot be invited into a second one.
  const existingUser = await User.findOne({ email: parsed.data.email }).select("_id").lean().exec();
  if (existingUser) {
    const alreadyHere = await BusinessAccountMember.exists({
      user: existingUser._id,
      businessAccount: membership.businessAccount,
      status: { $ne: "removed" }
    });
    return response.status(409).json({
      success: false,
      message: alreadyHere
        ? "That person already has access to this account."
        : "That email address is already registered with Swiftline."
    });
  }

  const pending = await BusinessAccountMember.exists({
    businessAccount: membership.businessAccount,
    status: "pending_approval",
    "requestedInvite.email": parsed.data.email
  });
  if (pending) {
    return response.status(409).json({ success: false, message: "A request for that email address is already awaiting Swiftline approval." });
  }

  /**
   * No user record is created yet.
   *
   * The login exists only once Swiftline approves, so a declined request
   * leaves no account behind and reserves no address. `user` points at the
   * requester until then, the schema requiring one.
   */
  const member = await BusinessAccountMember.create({
    businessAccount: membership.businessAccount,
    user: userId,
    role: parsed.data.role,
    status: "pending_approval",
    invitedBy: userId,
    requestedInvite: parsed.data
  });

  const account = await BusinessAccount.findById(membership.businessAccount).select("accountId company.companyName").lean().exec();
  const accountLabel = account ? `${account.company?.companyName ?? ""} (${account.accountId})` : "A customer";

  await AuditLog.create({
    action: "BUSINESS_ACCOUNT_MEMBER_INVITE_REQUESTED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: membership.businessAccount,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { email: parsed.data.email, role: parsed.data.role }
  });

  await notifyOperationsStaff({
    type: "CLIENT_ACCESS_REQUESTED",
    title: "Client login request",
    message: `${accountLabel} asked for portal access for ${parsed.data.firstName} ${parsed.data.lastName} (${parsed.data.email}) as ${businessAccountMemberRoleLabels[parsed.data.role]}.`,
    href: "/dashboard/users?tab=requests",
    idempotencyKey: `client-access-request:${String(member._id)}`,
    businessAccountId: membership.businessAccount
  });

  return response.status(201).json({
    success: true,
    message: "Request sent to Swiftline. Access is granted once it is approved."
  });
}

const roleChangeSchema = z.object({
  role: z.enum(businessAccountMemberRoleValues).refine((role) => role !== "account_owner", {
    message: "Contact Swiftline to change the account owner."
  })
});

/**
 * Changes a colleague's role.
 *
 * An administrator may not change their own, and may not touch the owner's:
 * both would let one login quietly widen or entrench its own reach.
 */
export async function updateClientTeamMemberRole(request: Request, response: Response): Promise<Response> {
  const userId = actorId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const membership = await adminMembership(userId);
  if (!membership) {
    return response.status(403).json({ success: false, message: "Team members are managed by account owners and administrators." });
  }
  const account = await BusinessAccount.findById(membership.businessAccount).select("status").lean().exec();
  if (account?.status === "suspended") return response.status(423).json({ success: false, message: "Team changes are paused while this account is suspended." });

  const parsed = roleChangeSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Choose a valid role." });
  }

  const memberId = String(request.params.memberId ?? "");
  if (!mongoose.Types.ObjectId.isValid(memberId)) {
    return response.status(404).json({ success: false, message: "Team member was not found." });
  }

  const target = await BusinessAccountMember.findOne({
    _id: memberId,
    businessAccount: membership.businessAccount
  }).exec();
  if (!target) return response.status(404).json({ success: false, message: "Team member was not found." });
  if (String(target.user) === String(userId)) {
    return response.status(409).json({ success: false, message: "You cannot change your own role." });
  }
  if (target.role === "account_owner") {
    return response.status(409).json({ success: false, message: "Contact Swiftline to change the account owner." });
  }

  const previous = target.role;
  target.role = parsed.data.role;
  await target.save();

  await AuditLog.create({
    action: "BUSINESS_ACCOUNT_MEMBER_ROLE_CHANGED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: membership.businessAccount,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { memberId: String(target._id), from: previous, to: parsed.data.role }
  });

  return response.status(200).json({ success: true, message: "Role updated." });
}
