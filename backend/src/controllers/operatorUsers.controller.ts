import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount, type IBusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, type IBusinessAccountMember } from "../models/businessAccountMember.model.js";
import { TenantMembership, type ITenantMembership } from "../models/tenantMembership.model.js";
import { User, type IUser } from "../models/user.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";

const usersQuerySchema = z.object({
  teamPage: z.coerce.number().int().min(1).max(10_000).default(1),
  clientPage: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional()
}).strict();

type UserDirectoryRow = {
  _id: string;
  role: string;
  membershipStatus: string;
  createdAt: Date;
  user: {
    _id: string;
    firstName: string;
    lastName: string;
    name: string;
    email: string;
    phone: string;
    designation: string;
    userStatus: string;
    lastLogin: Date | null;
  };
  account?: {
    accountId: string;
    companyName: string;
  };
};

type UserRecord = Pick<IUser, "_id" | "firstName" | "lastName" | "name" | "email" | "phone" | "staffProfile" | "userStatus" | "lastLogin">;
type TeamMembershipRecord = Pick<ITenantMembership, "_id" | "userId" | "role" | "status" | "createdAt">;
type ClientMembershipRecord = Pick<IBusinessAccountMember, "_id" | "businessAccount" | "user" | "role" | "status" | "createdAt">;
type AccountRecord = Pick<IBusinessAccount, "_id" | "accountId" | "company" | "contact">;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

function userSearchConditions(search: RegExp): Record<string, RegExp>[] {
  return [
    { firstName: search },
    { lastName: search },
    { name: search },
    { email: search },
    { phone: search },
    { "staffProfile.designation": search }
  ];
}

function directoryUser(user: UserRecord) {
  return {
    _id: String(user._id),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    name: user.name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    designation: user.staffProfile?.designation ?? "",
    userStatus: user.userStatus ?? "unavailable",
    lastLogin: user.lastLogin ?? null
  };
}

function businessAccountDisplayName(account: AccountRecord): string {
  const companyName = account.company?.companyName?.trim();
  const contactName = [account.contact?.firstName, account.contact?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return companyName || contactName || account.accountId;
}

export async function listOperatorUsers(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = usersQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid user directory filters." });
  }

  const { teamPage, clientPage, pageSize, search } = parsed.data;
  const tenantId = context.tenantId;
  const searchRegex = search ? new RegExp(escapeRegExp(search), "i") : null;
  const matchingUsers = searchRegex
    ? await User.find({ $or: userSearchConditions(searchRegex) }).select("_id").lean().exec()
    : [];
  const matchingUserIds = matchingUsers.map(({ _id }) => _id);

  const teamClauses: Record<string, unknown>[] = [
    { tenantId },
    { role: { $ne: "CLIENT" } },
    { status: { $in: ["ACTIVE", "INVITED", "SUSPENDED"] } }
  ];
  const clientClauses: Record<string, unknown>[] = [
    { tenantId },
    { status: { $in: ["active", "invited", "suspended"] } }
  ];

  if (searchRegex) {
    teamClauses.push({ $or: [
      { userId: { $in: matchingUserIds } },
      { role: searchRegex },
      { status: searchRegex }
    ] });

    const matchingAccounts = await BusinessAccount.find({
      tenantId,
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" },
      $or: [
        { accountId: searchRegex },
        { "company.companyName": searchRegex },
        { "contact.firstName": searchRegex },
        { "contact.lastName": searchRegex }
      ]
    }).select("_id").lean().exec();

    clientClauses.push({ $or: [
      { user: { $in: matchingUserIds } },
      { businessAccount: { $in: matchingAccounts.map(({ _id }) => _id) } },
      { role: searchRegex },
      { status: searchRegex }
    ] });
  }

  const teamFilter = { $and: teamClauses };
  const clientFilter = { $and: clientClauses };

  const [teamTotalCandidates, clientTotalCandidates, teamRecords, clientRecords] = await Promise.all([
    TenantMembership.countDocuments(teamFilter).exec(),
    BusinessAccountMember.countDocuments(clientFilter).exec(),
    TenantMembership.find(teamFilter)
      .select("userId role status createdAt")
      .sort({ userId: 1, _id: 1 })
      .skip((teamPage - 1) * pageSize)
      .limit(pageSize)
      .lean()
      .exec() as Promise<TeamMembershipRecord[]>,
    BusinessAccountMember.find(clientFilter)
      .select("businessAccount user role status createdAt")
      .sort({ user: 1, _id: 1 })
      .skip((clientPage - 1) * pageSize)
      .limit(pageSize)
      .lean()
      .exec() as Promise<ClientMembershipRecord[]>
  ]);

  const teamUserIds = teamRecords.map(({ userId }) => userId);
  const clientUserIds = clientRecords.map(({ user }) => user);
  const clientAccountIds = clientRecords.map(({ businessAccount }) => businessAccount);
  const [teamUsers, clientUsers, clientAccounts] = await Promise.all([
    User.find({ _id: { $in: teamUserIds } })
      .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
      .lean()
      .exec() as Promise<UserRecord[]>,
    User.find({ _id: { $in: clientUserIds } })
      .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
      .lean()
      .exec() as Promise<UserRecord[]>,
    BusinessAccount.find({
      tenantId,
      _id: { $in: clientAccountIds },
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
    })
      .select("accountId company.companyName contact.firstName contact.lastName contact.jobTitle")
      .lean()
      .exec() as Promise<AccountRecord[]>
  ]);

  const teamUserById = new Map(teamUsers.map((user) => [String(user._id), user]));
  const clientUserById = new Map(clientUsers.map((user) => [String(user._id), user]));
  const accountById = new Map(clientAccounts.map((account) => [String(account._id), account]));

  const teamItems: UserDirectoryRow[] = [];
  for (const membership of teamRecords) {
    const user = teamUserById.get(String(membership.userId));
    if (!user) continue;
    teamItems.push({
      _id: String(membership._id),
      role: membership.role,
      membershipStatus: membership.status,
      createdAt: membership.createdAt,
      user: directoryUser(user)
    });
  }

  const clientItems: UserDirectoryRow[] = [];
  for (const membership of clientRecords) {
    const user = clientUserById.get(String(membership.user));
    const account = accountById.get(String(membership.businessAccount));
    // A membership must never expose a login or account from another tenant,
    // even if a stale or malformed reference bypassed the normal write path.
    if (!user || !account) continue;
    clientItems.push({
      _id: String(membership._id),
      role: membership.role,
      membershipStatus: membership.status,
      createdAt: membership.createdAt,
      user: {
        ...directoryUser(user),
        designation: user.staffProfile?.designation || account.contact?.jobTitle || ""
      },
      account: {
        accountId: account.accountId,
        companyName: businessAccountDisplayName(account)
      }
    });
  }

  const missingTeamUsers = teamRecords.length - teamItems.length;
  const missingClientReferences = clientRecords.length - clientItems.length;
  const exactClientPage = Boolean(searchRegex) && (clientPage - 1) * pageSize === 0 && clientTotalCandidates <= pageSize;
  const teamTotal = Math.max(0, teamTotalCandidates - missingTeamUsers);
  const clientTotal = exactClientPage
    ? clientItems.length
    : Math.max(0, clientTotalCandidates - missingClientReferences);

  return response.status(200).json({
    success: true,
    teamUsers: teamItems,
    teamPagination: pagination(teamPage, pageSize, teamTotal),
    clientUsers: clientItems,
    clientPagination: pagination(clientPage, pageSize, clientTotal)
  });
}

/** Return a read-only user profile for an operator administrator's own tenant. */
export async function getOperatorUserProfile(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const audience = typeof request.params.audience === "string" ? request.params.audience : "";
  const membershipId = typeof request.params.membershipId === "string" ? request.params.membershipId : "";
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if ((audience !== "team" && audience !== "clients") || !mongoose.Types.ObjectId.isValid(membershipId)) {
    return response.status(404).json({ success: false, message: "User profile not found" });
  }

  const membershipObjectId = new mongoose.Types.ObjectId(membershipId);
  if (audience === "team") {
    const membership = await TenantMembership.findOne({
      _id: membershipObjectId,
      tenantId: context.tenantId,
      role: { $ne: "CLIENT" },
      status: { $in: ["ACTIVE", "INVITED", "SUSPENDED"] }
    }).select("userId role status createdAt assignedBranches").lean().exec();
    if (!membership) return response.status(404).json({ success: false, message: "User profile not found" });

    const user = await User.findById(membership.userId)
      .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
      .lean()
      .exec();
    if (!user) return response.status(404).json({ success: false, message: "User profile not found" });

    const branchIds = membership.assignedBranches ?? [];
    const branches = branchIds.length
      ? await Branch.find({ tenantId: context.tenantId, _id: { $in: branchIds } })
        .select("_id name code")
        .sort({ name: 1 })
        .lean()
        .exec()
      : [];

    return response.status(200).json({
      success: true,
      profile: {
        audience,
        membership: {
          id: String(membership._id),
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt
        },
        user: {
          id: String(user._id),
          firstName: user.firstName ?? "",
          lastName: user.lastName ?? "",
          name: user.name ?? "",
          email: user.email ?? "",
          phone: user.phone ?? "",
          designation: user.staffProfile?.designation ?? "",
          userStatus: user.userStatus ?? "unavailable",
          lastLogin: user.lastLogin ?? null
        },
        account: null,
        branches: branches.map((branch) => ({ id: String(branch._id), name: branch.name, code: branch.code })),
        allBranchesAccess: membership.role === "OPERATOR_ADMIN"
      }
    });
  }

  const membership = await BusinessAccountMember.findOne({
    _id: membershipObjectId,
    tenantId: context.tenantId,
    status: { $in: ["active", "invited", "suspended"] }
  }).select("businessAccount user role status createdAt assignedBranches").lean().exec();
  if (!membership) return response.status(404).json({ success: false, message: "User profile not found" });

  const [account, user] = await Promise.all([
    BusinessAccount.findOne({
      _id: membership.businessAccount,
      tenantId: context.tenantId,
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
    }).select("accountId company.companyName contact.firstName contact.lastName contact.jobTitle assignedBranch").lean().exec(),
    User.findById(membership.user)
      .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
      .lean()
      .exec()
  ]);
  if (!account || !user) return response.status(404).json({ success: false, message: "User profile not found" });

  const assignedBranchIds = membership.assignedBranches ?? [];
  const branchIds = assignedBranchIds.length
    ? assignedBranchIds
    : account.assignedBranch ? [account.assignedBranch] : [];
  const branches = branchIds.length
    ? await Branch.find({ tenantId: context.tenantId, _id: { $in: branchIds } })
      .select("_id name code")
      .sort({ name: 1 })
      .lean()
      .exec()
    : [];

  return response.status(200).json({
    success: true,
    profile: {
      audience,
      membership: {
        id: String(membership._id),
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt
      },
      user: {
        id: String(user._id),
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        name: user.name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        designation: user.staffProfile?.designation || account.contact?.jobTitle || "",
        userStatus: user.userStatus ?? "unavailable",
        lastLogin: user.lastLogin ?? null
      },
      account: {
        accountId: account.accountId,
        companyName: businessAccountDisplayName(account)
      },
      branches: branches.map((branch) => ({ id: String(branch._id), name: branch.name, code: branch.code })),
      allBranchesAccess: false
    }
  });
}
