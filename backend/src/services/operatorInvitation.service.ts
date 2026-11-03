import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { OperatorInvitation } from "../models/operatorInvitation.model.js";
import { Tenant, type ITenant } from "../models/tenant.model.js";
import { TenantMembership, type ITenantMembership } from "../models/tenantMembership.model.js";
import { User, type IUser } from "../models/user.model.js";
import { runWithTenantContext } from "./tenantScope.service.js";

const invitationLifetimeMs = 24 * 60 * 60 * 1000;
const usableTenantStatuses = ["DRAFT", "ACTIVE"] as const;

export class OperatorInvitationError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "OperatorInvitationError";
  }
}

export function hashOperatorInvitationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildActivationUrl(token: string) {
  const url = new URL("/auth/activate", env.CLIENT_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

type IssuedInvitation = {
  tenantId: mongoose.Types.ObjectId;
  tenantSlug: string;
  companyName: string;
  userId: mongoose.Types.ObjectId;
  email: string;
  name: string;
  expiresAt: Date;
  activationUrl: string;
  requiresSignIn: boolean;
};

type InvitationAuditAction = "OPERATOR_ADMIN_INVITED" | "OPERATOR_ADMIN_INVITATION_REISSUED" | "OPERATOR_MEMBERSHIP_ACTIVATED";

async function writeInvitationAudit(input: {
  tenantId: mongoose.Types.ObjectId;
  membership: ITenantMembership;
  actorId: mongoose.Types.ObjectId;
  action: InvitationAuditAction;
  session: mongoose.ClientSession;
}) {
  await runWithTenantContext({ tenantId: input.tenantId, kind: "OPERATOR" }, () =>
    AuditLog.create([{
      action: input.action,
      entityType: "TENANT_MEMBERSHIP",
      entityId: input.membership._id,
      performedBy: input.actorId,
      performedAt: new Date(),
      metadata: { role: input.membership.role }
    }], { session: input.session })
  );
}

async function issueInvitationRecord(input: {
  tenant: ITenant;
  user: IUser;
  membership: ITenantMembership;
  actorId: mongoose.Types.ObjectId;
  action: InvitationAuditAction;
  session: mongoose.ClientSession;
}): Promise<IssuedInvitation> {
  const now = new Date();
  await OperatorInvitation.updateMany(
    { tenantId: input.tenant._id, userId: input.user._id, status: "PENDING" },
    { $set: { status: "REVOKED", revokedAt: now } },
    { session: input.session }
  ).exec();

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
  await OperatorInvitation.create([{
    tenantId: input.tenant._id,
    userId: input.user._id,
    role: "OPERATOR_ADMIN",
    tokenHash: hashOperatorInvitationToken(token),
    status: "PENDING",
    expiresAt,
    invitedBy: input.actorId
  }], { session: input.session });

  await writeInvitationAudit({
    tenantId: input.tenant._id,
    membership: input.membership,
    actorId: input.actorId,
    action: input.action,
    session: input.session
  });

  return {
    tenantId: input.tenant._id,
    tenantSlug: input.tenant.slug,
    companyName: input.tenant.companyName,
    userId: input.user._id,
    email: input.user.email,
    name: input.user.name || `${input.user.firstName ?? ""} ${input.user.lastName ?? ""}`.trim(),
    expiresAt,
    activationUrl: buildActivationUrl(token),
    requiresSignIn: input.user.userStatus === "active"
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

/**
 * Creates or reissues the first OPERATOR_ADMIN invitation for a draft tenant.
 * User credentials remain global, while this new authority is held only in
 * TenantMembership. Existing active client logins keep their password and must
 * authenticate before accepting the membership.
 */
export async function inviteInitialOperatorAdmin(input: {
  tenantId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}): Promise<IssuedInvitation> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName || !lastName || !email) {
    throw new OperatorInvitationError(400, "Enter the administrator's name and email address.");
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR" }).session(session).exec();
      if (!tenant) throw new OperatorInvitationError(404, "Operator not found.");
      if (tenant.status !== "DRAFT") {
        throw new OperatorInvitationError(409, "The initial administrator can only be invited while the operator is in draft.");
      }

      let user = await User.findOne({ email }).session(session).exec();
      if (user) {
        if (user.role !== "client") {
          throw new OperatorInvitationError(409, "Swiftline staff identities cannot be used as operator accounts.");
        }
        if (user.userStatus !== "active") {
          throw new OperatorInvitationError(409, "This email already has an account awaiting activation or review. Activate it first, then invite it to the operator.");
        }
      } else {
        const [created] = await User.create([{
          firstName,
          lastName,
          name: `${firstName} ${lastName}`,
          email,
          role: "client",
          userStatus: "invited",
          isVerified: false,
          invitedBy: input.actorId
        }], { session });
        if (!created) throw new Error("OPERATOR_ADMIN_USER_NOT_CREATED");
        user = created;
      }

      let membership = await TenantMembership.findOne({ tenantId: tenant._id, userId: user._id }).session(session).exec();
      if (membership && ["ACTIVE", "SUSPENDED"].includes(membership.status)) {
        throw new OperatorInvitationError(409, "This user already has operator access or has been suspended.");
      }
      const anotherInitialAdmin = await TenantMembership.findOne({
        tenantId: tenant._id,
        role: "OPERATOR_ADMIN",
        status: { $in: ["INVITED", "ACTIVE", "SUSPENDED"] },
        userId: { $ne: user._id }
      }).session(session).lean().exec();
      if (anotherInitialAdmin) {
        throw new OperatorInvitationError(409, "An initial operator administrator has already been invited. Reissue that administrator's link or finish the current setup first.");
      }
      if (membership && membership.status === "INVITED" && membership.role !== "OPERATOR_ADMIN") {
        throw new OperatorInvitationError(409, "This user already has a different pending operator role.");
      }

      if (membership) {
        membership.role = "OPERATOR_ADMIN";
        membership.status = "INVITED";
        membership.assignedBranches = [];
        await membership.save({ session });
      } else {
        const [created] = await TenantMembership.create([{
          tenantId: tenant._id,
          userId: user._id,
          role: "OPERATOR_ADMIN",
          status: "INVITED",
          assignedBranches: []
        }], { session });
        if (!created) throw new Error("OPERATOR_ADMIN_MEMBERSHIP_NOT_CREATED");
        membership = created;
      }

      return issueInvitationRecord({
        tenant,
        user,
        membership,
        actorId: input.actorId,
        action: "OPERATOR_ADMIN_INVITED",
        session
      });
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new OperatorInvitationError(409, "An account or invitation already exists for this operator and email.");
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Generates a replacement link only after an explicit platform-admin action. */
export async function reissueInitialOperatorAdminLink(input: {
  tenantId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
}): Promise<IssuedInvitation> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR", status: "DRAFT" }).session(session).exec();
      if (!tenant) throw new OperatorInvitationError(404, "Draft operator not found.");
      const [user, membership] = await Promise.all([
        User.findOne({ _id: input.userId, role: "client", userStatus: { $in: ["active", "invited"] } }).session(session).exec(),
        TenantMembership.findOne({ tenantId: tenant._id, userId: input.userId, role: "OPERATOR_ADMIN", status: "INVITED" }).session(session).exec()
      ]);
      if (!user || !membership) throw new OperatorInvitationError(404, "Pending operator administrator invitation not found.");

      return issueInvitationRecord({
        tenant,
        user,
        membership,
        actorId: input.actorId,
        action: "OPERATOR_ADMIN_INVITATION_REISSUED",
        session
      });
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new OperatorInvitationError(409, "A new invitation could not be issued because another request changed this invitation. Refresh and try again.");
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export type OperatorInvitationLookup =
  | { matched: false }
  | { matched: true; invitation: null; message: string }
  | {
    matched: true;
    invitation: {
      tenantId: mongoose.Types.ObjectId;
      tenantSlug: string;
      companyName: string;
      userId: mongoose.Types.ObjectId;
      email: string;
      name: string;
      role: "OPERATOR_ADMIN";
      expiresAt: Date;
      requiresSignIn: boolean;
    };
  };

export async function lookupOperatorInvitation(token: string): Promise<OperatorInvitationLookup> {
  const invitation = await OperatorInvitation.findOne({ tokenHash: hashOperatorInvitationToken(token) }).exec();
  if (!invitation) return { matched: false };
  if (invitation.status !== "PENDING") {
    return { matched: true, invitation: null, message: "This operator invitation is no longer active." };
  }
  if (invitation.expiresAt <= new Date()) {
    return { matched: true, invitation: null, message: "This operator invitation has expired." };
  }

  const [tenant, user, membership] = await Promise.all([
    Tenant.findOne({ _id: invitation.tenantId, kind: "OPERATOR", status: { $in: usableTenantStatuses } }).lean().exec(),
    User.findById(invitation.userId).select("firstName lastName name email role userStatus passwordHash").lean().exec(),
    TenantMembership.findOne({
      tenantId: invitation.tenantId,
      userId: invitation.userId,
      role: invitation.role,
      status: "INVITED"
    }).lean().exec()
  ]);

  if (!tenant || !user || !membership || user.role !== "client" || !["active", "invited"].includes(user.userStatus)) {
    return { matched: true, invitation: null, message: "This operator invitation is no longer valid." };
  }
  if (user.userStatus === "invited" && user.passwordHash) {
    return { matched: true, invitation: null, message: "This account must be reviewed before the invitation can be accepted." };
  }

  return {
    matched: true,
    invitation: {
      tenantId: tenant._id,
      tenantSlug: tenant.slug,
      companyName: tenant.companyName,
      userId: user._id,
      email: user.email,
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      requiresSignIn: user.userStatus === "active"
    }
  };
}

async function loadPendingInvitation(session: mongoose.ClientSession, token: string) {
  const invitation = await OperatorInvitation.findOne({
    tokenHash: hashOperatorInvitationToken(token),
    status: "PENDING",
    expiresAt: { $gt: new Date() }
  }).session(session).exec();
  if (!invitation) throw new OperatorInvitationError(400, "Operator invitation is invalid, expired or already accepted.");
  return invitation;
}

async function loadTenantMembership(
  session: mongoose.ClientSession,
  invitation: InstanceType<typeof OperatorInvitation>
) {
  const tenant = await Tenant.findOne({
    _id: invitation.tenantId,
    kind: "OPERATOR",
    status: { $in: usableTenantStatuses }
  }).session(session).exec();
  const membership = await TenantMembership.findOne({
    tenantId: invitation.tenantId,
    userId: invitation.userId,
    role: invitation.role,
    status: "INVITED"
  }).session(session).exec();
  if (!tenant || !membership) throw new OperatorInvitationError(409, "Operator access is no longer available.");
  return { tenant, membership };
}

/** Activates the shared login and operator membership for a newly invited user. */
export async function activateNewOperatorAdmin(input: {
  token: string;
  passwordHash: string;
}) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const invitation = await loadPendingInvitation(session, input.token);
      const { tenant, membership } = await loadTenantMembership(session, invitation);
      const user = await User.findOne({
        _id: invitation.userId,
        role: "client",
        userStatus: "invited",
        passwordHash: ""
      }).session(session).exec();
      if (!user) throw new OperatorInvitationError(409, "This account must sign in to accept the operator invitation.", "LOGIN_REQUIRED");

      const now = new Date();
      user.passwordHash = input.passwordHash;
      user.userStatus = "active";
      user.isVerified = true;
      user.emailVerifiedAt = now;
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      membership.status = "ACTIVE";
      membership.updatedAt = now;
      invitation.status = "ACCEPTED";
      invitation.acceptedAt = now;
      await Promise.all([
        user.save({ session }),
        membership.save({ session }),
        invitation.save({ session })
      ]);
      await writeInvitationAudit({
        tenantId: tenant._id,
        membership,
        actorId: user._id as mongoose.Types.ObjectId,
        action: "OPERATOR_MEMBERSHIP_ACTIVATED",
        session
      });
      return { tenantId: tenant._id, tenantSlug: tenant.slug };
    });
  } finally {
    await session.endSession();
  }
}

/** Existing global client users accept without resetting their credentials. */
export async function acceptExistingOperatorAdminInvitation(input: {
  token: string;
  userId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const invitation = await loadPendingInvitation(session, input.token);
      if (!invitation.userId.equals(input.userId)) {
        throw new OperatorInvitationError(404, "Operator invitation not found.");
      }
      const { tenant, membership } = await loadTenantMembership(session, invitation);
      const user = await User.findOne({ _id: input.userId, role: "client", userStatus: "active" }).session(session).exec();
      if (!user) throw new OperatorInvitationError(403, "Sign in to the invited client account to accept this invitation.");

      const now = new Date();
      membership.status = "ACTIVE";
      membership.updatedAt = now;
      invitation.status = "ACCEPTED";
      invitation.acceptedAt = now;
      await Promise.all([membership.save({ session }), invitation.save({ session })]);
      await writeInvitationAudit({
        tenantId: tenant._id,
        membership,
        actorId: user._id as mongoose.Types.ObjectId,
        action: "OPERATOR_MEMBERSHIP_ACTIVATED",
        session
      });
      return { tenantId: tenant._id, tenantSlug: tenant.slug };
    });
  } finally {
    await session.endSession();
  }
}
