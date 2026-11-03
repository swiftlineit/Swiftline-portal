import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, type BusinessAccountMemberRole } from "../models/businessAccountMember.model.js";
import { OperatorClientInvitation } from "../models/operatorClientInvitation.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User, type IUser } from "../models/user.model.js";
import { sendClientInvitationEmail } from "./mail.service.js";
import { normalizeUserPhone } from "./userIdentity.service.js";
import { runWithTenantContext } from "./tenantScope.service.js";

const invitationLifetimeMs = 24 * 60 * 60 * 1000;

export class OperatorClientInvitationError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "OperatorClientInvitationError";
  }
}

export function hashOperatorClientInvitationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildActivationUrl(token: string) {
  const url = new URL("/auth/activate", env.CLIENT_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

type ClientAccessInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: BusinessAccountMemberRole;
  assignedBranches: string[];
  sendInvitationEmail: boolean;
};

type IssuedInvitation = {
  activationUrl: string;
  expiresAt: Date;
  user: IUser;
  accountName: string;
  memberId: mongoose.Types.ObjectId;
  requiresSignIn: boolean;
};

function toMemberResponse(member: InstanceType<typeof BusinessAccountMember>) {
  const user = member.user as unknown as Partial<IUser> & { _id?: mongoose.Types.ObjectId };
  const branches = member.assignedBranches as unknown as Array<{
    _id?: mongoose.Types.ObjectId;
    name?: string;
    code?: string;
  }>;
  return {
    _id: String(member._id),
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt ?? null,
    createdAt: member.createdAt,
    user: {
      _id: String(user?._id ?? member.user),
      firstName: user?.firstName ?? "",
      lastName: user?.lastName ?? "",
      name: user?.name ?? "",
      email: user?.email ?? "",
      phone: user?.phone ?? "",
      userStatus: user?.userStatus ?? "invited",
      lastLogin: user?.lastLogin ?? null
    },
    assignedBranches: branches.map((branch) => ({
      _id: String(branch._id ?? ""),
      name: branch.name ?? "",
      code: branch.code ?? ""
    })),
    invitation: null
  };
}

async function issueInvitation(input: {
  tenantId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  accountId: string;
  accountName: string;
  memberId: mongoose.Types.ObjectId;
  user: IUser;
  tenantMembershipId: mongoose.Types.ObjectId;
  invitedBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}): Promise<IssuedInvitation> {
  const now = new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
  await OperatorClientInvitation.updateMany(
    { tenantId: input.tenantId, userId: input.user._id, status: "PENDING" },
    { $set: { status: "REVOKED", revokedAt: now } },
    { session: input.session }
  ).exec();
  await OperatorClientInvitation.create([{
    tenantId: input.tenantId,
    userId: input.user._id,
    businessAccountId: input.businessAccountId,
    memberId: input.memberId,
    tokenHash: hashOperatorClientInvitationToken(token),
    status: "PENDING",
    expiresAt,
    invitedBy: input.invitedBy
  }], { session: input.session });
  await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () => AuditLog.create([{
    action: "OPERATOR_CLIENT_ACCESS_INVITED",
    entityType: "TENANT_MEMBERSHIP",
    entityId: input.tenantMembershipId,
    performedBy: input.invitedBy,
    performedAt: now,
    metadata: { accountId: input.accountId, businessAccountId: String(input.businessAccountId), userId: String(input.user._id) }
  }], { session: input.session }));

  return {
    activationUrl: buildActivationUrl(token),
    expiresAt,
    user: input.user,
    accountName: input.accountName || input.accountId,
    memberId: input.memberId,
    requiresSignIn: input.user.userStatus === "active"
  };
}

/** Creates a tenant membership and account membership atomically before sending the invite. */
export async function createOperatorClientAccess(input: {
  tenantId: mongoose.Types.ObjectId;
  accountId: string;
  actorId: mongoose.Types.ObjectId;
  data: ClientAccessInput;
}) {
  const phone = normalizeUserPhone(input.data.phone);
  if (!phone) {
    throw new OperatorClientInvitationError(400, "Enter a valid phone number in international format, for example +919876543210.");
  }

  const session = await mongoose.startSession();
  let issued: IssuedInvitation | null = null;
  try {
    issued = await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR", status: "ACTIVE" }).session(session).exec();
      if (!tenant) throw new OperatorClientInvitationError(409, "The operator portal must be activated before client logins can be invited.");
      const account = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        BusinessAccount.findOne({ tenantId: input.tenantId, accountId: input.accountId }).session(session).exec()
      );
      if (!account) throw new OperatorClientInvitationError(404, "Business account not found.");
      if (!(account.status === "approved" || account.status === "active") || account.kycReview?.overallStatus !== "verified") {
        throw new OperatorClientInvitationError(409, "Client access requires local account approval and verified KYC.");
      }
      if (!account.assignedBranch) throw new OperatorClientInvitationError(409, "Assign an active branch before creating client access.");

      const requestedBranches = [...new Set(input.data.assignedBranches.filter(Boolean))];
      const assignedBranchId = String(account.assignedBranch);
      if (requestedBranches.length > 1 || (requestedBranches[0] && requestedBranches[0] !== assignedBranchId)) {
        throw new OperatorClientInvitationError(400, "Client access branch must match the business account assigned branch.");
      }
      const branch = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        Branch.findOne({ _id: account.assignedBranch, tenantId: input.tenantId, status: "ACTIVE" }).select("_id").session(session).lean().exec()
      );
      if (!branch) throw new OperatorClientInvitationError(409, "The assigned business account branch is not active.");

      const [emailUser, phoneUser] = await Promise.all([
        User.findOne({ email: input.data.email.toLowerCase() }).session(session).exec(),
        User.findOne({ phone }).session(session).exec()
      ]);
      if (emailUser && phoneUser && !emailUser._id.equals(phoneUser._id)) {
        throw new OperatorClientInvitationError(409, "The email and phone number belong to different portal users.");
      }
      const existingUser = emailUser ?? phoneUser;
      if (existingUser && (
        existingUser.role !== "client" || existingUser.email.toLowerCase() !== input.data.email.toLowerCase()
        || existingUser.phone !== phone || existingUser.userStatus !== "active" || !existingUser.passwordHash
      )) {
        throw new OperatorClientInvitationError(409, "This email or phone is already registered. Use the matching active client login or resolve the existing invitation first.");
      }

      let user = existingUser;
      if (!user) {
        const [createdUser] = await User.create([{
          firstName: input.data.firstName,
          lastName: input.data.lastName,
          name: `${input.data.firstName} ${input.data.lastName}`.trim(),
          email: input.data.email.toLowerCase(),
          phone,
          role: "client",
          userStatus: "invited",
          isVerified: false,
          invitedBy: input.actorId
        }], { session });
        if (!createdUser) throw new Error("OPERATOR_CLIENT_USER_NOT_CREATED");
        user = createdUser;
      }

      const currentTenantMembership = await TenantMembership.findOne({
        tenantId: input.tenantId,
        userId: user._id
      }).session(session).exec();
      if (currentTenantMembership) {
        throw new OperatorClientInvitationError(409, "This user already has access or an invitation for this operator.");
      }

      const existingAccountMembership = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        BusinessAccountMember.findOne({
          tenantId: input.tenantId,
          businessAccount: account._id,
          user: user!._id,
          status: { $in: ["pending_approval", "invited", "active", "suspended"] }
        }).session(session).exec()
      );
      if (existingAccountMembership) {
        throw new OperatorClientInvitationError(409, "This user already has access to the business account.");
      }

      const [tenantMembership] = await TenantMembership.create([{
        tenantId: input.tenantId,
        userId: user._id,
        role: "CLIENT",
        status: "INVITED",
        assignedBranches: [account.assignedBranch]
      }], { session });
      if (!tenantMembership) throw new Error("OPERATOR_CLIENT_TENANT_MEMBERSHIP_NOT_CREATED");

      const [member] = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        BusinessAccountMember.create([{
          tenantId: input.tenantId,
          businessAccount: account._id,
          user: user!._id,
          role: input.data.role,
          assignedBranches: [account.assignedBranch!],
          status: "invited",
          invitedBy: input.actorId
        }], { session })
      );
      if (!member) throw new Error("OPERATOR_CLIENT_MEMBERSHIP_NOT_CREATED");

      return issueInvitation({
        tenantId: input.tenantId,
        businessAccountId: account._id as mongoose.Types.ObjectId,
        accountId: account.accountId,
        accountName: account.company.companyName,
        memberId: member._id as mongoose.Types.ObjectId,
        user,
        tenantMembershipId: tenantMembership._id as mongoose.Types.ObjectId,
        invitedBy: input.actorId,
        session
      });
    }) ?? null;
  } catch (error) {
    if (error instanceof OperatorClientInvitationError) throw error;
    if (isDuplicateKey(error)) {
      throw new OperatorClientInvitationError(409, "This user already has an invitation or account access for the operator.");
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (!issued) throw new Error("OPERATOR_CLIENT_INVITATION_NOT_CREATED");
  let emailDelivery = { sent: false, skipped: !input.data.sendInvitationEmail };
  let emailError = "";
  if (input.data.sendInvitationEmail) {
    try {
      emailDelivery = await sendClientInvitationEmail({
        to: issued.user.email,
        name: issued.user.name || `${issued.user.firstName ?? ""} ${issued.user.lastName ?? ""}`.trim(),
        companyName: issued.accountName,
        activationUrl: issued.activationUrl,
        expiresAt: issued.expiresAt,
        requiresSignIn: issued.requiresSignIn
      });
    } catch (error) {
      emailError = error instanceof Error ? error.message : "Invitation email could not be sent.";
    }
  }

  const member = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
    BusinessAccountMember.findById(issued!.memberId)
      .populate("user", "firstName lastName name email phone userStatus lastLogin")
      .populate("assignedBranches", "name code")
      .exec()
  );
  return {
    member: member ? toMemberResponse(member) : null,
    emailSent: emailDelivery.sent,
    emailSkipped: emailDelivery.skipped,
    emailError: emailError || undefined,
    requiresSignIn: issued.requiresSignIn
  };
}

export async function reissueOperatorClientInvitation(input: {
  tenantId: mongoose.Types.ObjectId;
  accountId: string;
  memberId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  exposeUrl: boolean;
}) {
  const session = await mongoose.startSession();
  let issued: IssuedInvitation | null = null;
  try {
    issued = await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR", status: "ACTIVE" }).session(session).exec();
      if (!tenant) throw new OperatorClientInvitationError(409, "The operator portal is not active.");
      const account = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        BusinessAccount.findOne({ tenantId: input.tenantId, accountId: input.accountId }).session(session).exec()
      );
      if (!account) throw new OperatorClientInvitationError(404, "Business account not found.");
      const member = await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
        BusinessAccountMember.findOne({
          _id: input.memberId,
          businessAccount: account._id,
          tenantId: input.tenantId,
          status: "invited"
        }).session(session).populate("user", "firstName lastName name email userStatus").exec()
      );
      if (!member) throw new OperatorClientInvitationError(404, "Pending client access invitation not found.");
      const user = member.user as unknown as IUser;
      const tenantMembership = await TenantMembership.findOne({
        tenantId: input.tenantId,
        userId: user._id,
        role: "CLIENT",
        status: "INVITED"
      }).session(session).exec();
      if (!tenantMembership) throw new OperatorClientInvitationError(409, "This client operator membership is no longer pending.");
      if (!(account.status === "approved" || account.status === "active") || account.kycReview?.overallStatus !== "verified") {
        throw new OperatorClientInvitationError(409, "Client access is no longer available for this business account.");
      }
      return issueInvitation({
        tenantId: input.tenantId,
        businessAccountId: account._id as mongoose.Types.ObjectId,
        accountId: account.accountId,
        accountName: account.company.companyName,
        memberId: member._id as mongoose.Types.ObjectId,
        user,
        tenantMembershipId: tenantMembership._id as mongoose.Types.ObjectId,
        invitedBy: input.actorId,
        session
      });
    }) ?? null;
  } catch (error) {
    if (error instanceof OperatorClientInvitationError) throw error;
    if (isDuplicateKey(error)) throw new OperatorClientInvitationError(409, "Unable to issue another invitation for this user.");
    throw error;
  } finally {
    await session.endSession();
  }
  if (!issued) throw new Error("OPERATOR_CLIENT_INVITATION_NOT_CREATED");
  if (input.exposeUrl) return { activationUrl: issued.activationUrl, expiresAt: issued.expiresAt };
  try {
    const delivery = await sendClientInvitationEmail({
      to: issued.user.email,
      name: issued.user.name || `${issued.user.firstName ?? ""} ${issued.user.lastName ?? ""}`.trim(),
      companyName: issued.accountName,
      activationUrl: issued.activationUrl,
      expiresAt: issued.expiresAt,
      requiresSignIn: issued.requiresSignIn
    });
    return { emailSent: delivery.sent, emailSkipped: delivery.skipped };
  } catch (error) {
    return { emailSent: false, emailSkipped: false, emailError: error instanceof Error ? error.message : "Invitation email could not be sent." };
  }
}

export async function lookupOperatorClientInvitation(token: string) {
  const invitation = await OperatorClientInvitation.findOne({ tokenHash: hashOperatorClientInvitationToken(token) })
    .lean()
    .exec();
  if (!invitation) return { matched: false as const };
  if (invitation.status !== "PENDING" || invitation.revokedAt) {
    return { matched: true as const, invitation: null, message: "This invitation is no longer valid." };
  }
  if (invitation.expiresAt <= new Date()) {
    return { matched: true as const, invitation: null, message: "This invitation has expired." };
  }
  const tenant = await Tenant.findOne({ _id: invitation.tenantId, kind: "OPERATOR", status: "ACTIVE" }).select("slug companyName").lean().exec();
  if (!tenant) return { matched: true as const, invitation: null, message: "This operator invitation is no longer valid." };
  const { user, account } = await runWithTenantContext({ tenantId: invitation.tenantId, kind: "OPERATOR" }, async () => {
    const [user, account] = await Promise.all([
      User.findById(invitation.userId)
        .select("email firstName lastName name userStatus")
        .lean()
        .exec(),
      BusinessAccount.findOne({ _id: invitation.businessAccountId, tenantId: invitation.tenantId })
        .select("accountId company.companyName")
        .lean()
        .exec()
    ]);
    return { user, account };
  });
  if (!user || !account) return { matched: true as const, invitation: null, message: "This operator invitation is no longer valid." };
  return {
    matched: true as const,
    invitation: {
      tenantId: invitation.tenantId,
      tenantSlug: tenant.slug,
      companyName: account.company?.companyName ?? tenant.companyName,
      userId: new mongoose.Types.ObjectId(String(invitation.userId)),
      email: user.email,
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      businessAccountId: account.accountId ?? "",
      expiresAt: invitation.expiresAt,
      requiresSignIn: user.userStatus === "active"
    }
  };
}

async function loadPendingInvitation(session: mongoose.ClientSession, token: string) {
  const invitation = await OperatorClientInvitation.findOne({
    tokenHash: hashOperatorClientInvitationToken(token),
    status: "PENDING",
    expiresAt: { $gt: new Date() }
  }).session(session).exec();
  if (!invitation) throw new OperatorClientInvitationError(400, "Operator client invitation is invalid, expired or already accepted.");
  return invitation;
}

async function activateOperatorClientInvitation(input: {
  token: string;
  userId?: mongoose.Types.ObjectId;
  passwordHash?: string;
}) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const invitation = await loadPendingInvitation(session, input.token);
      if (input.userId && !invitation.userId.equals(input.userId)) {
        throw new OperatorClientInvitationError(404, "Operator invitation not found.");
      }
      const tenant = await Tenant.findOne({ _id: invitation.tenantId, kind: "OPERATOR", status: "ACTIVE" }).session(session).exec();
      if (!tenant) throw new OperatorClientInvitationError(409, "This operator portal is not active.");
      return runWithTenantContext({ tenantId: tenant._id as mongoose.Types.ObjectId, kind: "OPERATOR" }, async () => {
        const [user, tenantMembership, member, account] = await Promise.all([
          User.findOne({ _id: invitation.userId, role: "client" }).session(session).exec(),
          TenantMembership.findOne({ tenantId: tenant._id, userId: invitation.userId, role: "CLIENT", status: "INVITED" }).session(session).exec(),
          BusinessAccountMember.findOne({
            _id: invitation.memberId,
            tenantId: tenant._id,
            businessAccount: invitation.businessAccountId,
            user: invitation.userId,
            status: "invited"
          }).session(session).exec(),
          BusinessAccount.findOne({
            _id: invitation.businessAccountId,
            tenantId: tenant._id,
            status: { $in: ["approved", "active"] },
            "kycReview.overallStatus": "verified"
          }).session(session).exec()
        ]);
        if (!user || !tenantMembership || !member || !account) {
          throw new OperatorClientInvitationError(409, "The business account or its invitation access is no longer active.");
        }
        const now = new Date();
        if (input.passwordHash) {
          if (user.userStatus !== "invited" || user.passwordHash) {
            throw new OperatorClientInvitationError(409, "Sign in with this existing client account to accept operator access.", "SIGN_IN_REQUIRED");
          }
          user.passwordHash = input.passwordHash;
          user.userStatus = "active";
          user.isVerified = true;
          user.emailVerifiedAt = now;
          user.failedLoginAttempts = 0;
          user.lockedUntil = null;
        } else if (!input.userId || user.userStatus !== "active" || !user.passwordHash) {
          throw new OperatorClientInvitationError(403, "Sign in to the invited client account to accept this invitation.");
        }
        tenantMembership.status = "ACTIVE";
        member.status = "active";
        member.joinedAt = now;
        invitation.status = "ACCEPTED";
        invitation.acceptedAt = now;
        await Promise.all([
          user.save({ session }),
          tenantMembership.save({ session }),
          member.save({ session }),
          invitation.save({ session }),
          AuditLog.create([{
            action: "OPERATOR_CLIENT_ACCESS_ACTIVATED",
            entityType: "TENANT_MEMBERSHIP",
            entityId: tenantMembership._id,
            performedBy: user._id,
            performedAt: now,
            metadata: { accountId: account.accountId, tenantId: String(tenant._id) }
          }], { session })
        ]);
        return { tenantSlug: tenant.slug, companyName: tenant.companyName };
      });
    });
  } finally {
    await session.endSession();
  }
}

export function activateNewOperatorClientInvitation(input: { token: string; passwordHash: string }) {
  return activateOperatorClientInvitation(input);
}

export function acceptExistingOperatorClientInvitation(input: { token: string; userId: mongoose.Types.ObjectId }) {
  return activateOperatorClientInvitation(input);
}
