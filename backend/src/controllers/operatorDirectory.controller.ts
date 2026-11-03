import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessAccount, businessAccountStatuses } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { Branch, branchStatusValues } from "../models/branch.model.js";
import { getCreditBalances } from "../services/creditAccount.service.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { resolveClientAccountBranchScopes } from "../utils/clientScope.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import {
  buildOperatorAccountAccessFilter,
  buildOperatorBranchAccessFilter,
  buildOperatorBranchRecordAccessFilter
} from "../services/operatorDirectory.service.js";

const objectIdQuery = z.string().regex(/^[a-f\d]{24}$/i, "Enter a valid branch ID.");
const directoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(businessAccountStatuses).optional(),
  branchId: objectIdQuery.optional()
}).strict();

const branchDirectoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(branchStatusValues).optional()
}).strict();

const branchUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional()
}).strict();

function getUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDirectoryQuery(request: Request, response: Response) {
  const parsed = directoryQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ success: false, message: "Invalid directory filters.", errors: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

export async function listOperatorBusinessAccounts(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = getUserId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const filters = parseDirectoryQuery(request, response);
  if (!filters) return response;

  let clientAccountIds: mongoose.Types.ObjectId[] = [];
  if (context.role === "CLIENT") {
    const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
      .select("businessAccount")
      .lean()
      .exec();
    clientAccountIds = memberships.map((membership) => membership.businessAccount as mongoose.Types.ObjectId);
  }

  const clauses: Record<string, unknown>[] = [
    { accountKind: { $ne: "INDIVIDUAL_SENTINEL" } },
    buildOperatorAccountAccessFilter({
      role: context.role,
      assignedBranches: context.assignedBranches,
      clientAccountIds
    })
  ];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.branchId) clauses.push({ assignedBranch: new mongoose.Types.ObjectId(filters.branchId) });
  if (filters.search) {
    const pattern = new RegExp(escapeRegExp(filters.search), "i");
    clauses.push({ $or: [
      { accountId: pattern },
      { "company.companyName": pattern },
      { "contact.firstName": pattern },
      { "contact.lastName": pattern },
      { "contact.email": pattern }
    ] });
  }

  const query = { $and: clauses };
  const skip = (filters.page - 1) * filters.pageSize;
  const [total, accounts] = await Promise.all([
    BusinessAccount.countDocuments(query).exec(),
    BusinessAccount.find(query)
      .select("accountId accountKind status contact.firstName contact.lastName contact.email company.companyName assignedBranch kycReview.overallStatus createdAt updatedAt")
      .populate("assignedBranch", "name code status")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(filters.pageSize)
      .lean()
      .exec()
  ]);
  const creditAccounts = context.role !== "CLIENT" && accounts.length
    ? await BusinessCreditAccount.find({ businessAccountId: { $in: accounts.map(({ _id }) => _id) } })
      .select("businessAccountId status validFrom validUntil approvedCreditLimitMinor reservedCreditMinor unbilledCreditMinor invoicedOutstandingMinor customerAdvanceBalanceMinor reservedAdvanceMinor")
      .lean().exec()
    : [];
  const creditByAccountId = new Map(creditAccounts.map((credit) => [String(credit.businessAccountId), getCreditBalances(credit)]));

  return response.status(200).json({
    success: true,
    accounts: accounts.map((account) => ({
      ...account,
      creditSummary: creditByAccountId.get(String(account._id))
        ? {
            availableCreditMinor: creditByAccountId.get(String(account._id))!.availableCreditMinor,
            outstandingMinor: creditByAccountId.get(String(account._id))!.totalOwedMinor
          }
        : null
    })),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize)
    }
  });
}

export async function listOperatorBranches(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = getUserId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = branchDirectoryQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid directory filters.", errors: parsed.error.flatten() });
  }

  let clientBranchIds: mongoose.Types.ObjectId[] = [];
  if (context.role === "CLIENT") {
    const accountScopes = await resolveClientAccountBranchScopes(userId);
    clientBranchIds = [...new Set(accountScopes.flatMap((scope) => scope.branchIds.map(String)))]
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
  }

  const clauses: Record<string, unknown>[] = [buildOperatorBranchAccessFilter({
    role: context.role,
    assignedBranches: context.assignedBranches,
    clientBranchIds
  })];
  if (parsed.data.status) clauses.push({ status: parsed.data.status });
  if (parsed.data.search) {
    const pattern = new RegExp(escapeRegExp(parsed.data.search), "i");
    clauses.push({ $or: [
      { name: pattern },
      { code: pattern },
      { "address.city": pattern }
    ] });
  }

  const query = { $and: clauses };
  const skip = (parsed.data.page - 1) * parsed.data.pageSize;
  const [total, branches] = await Promise.all([
    Branch.countDocuments(query).exec(),
    Branch.find(query)
      .select("name code labelCode address.countryCode address.countryName address.city address.stateOrProvince contact.email contact.phone openingDate status operations.supportedServices")
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);

  return response.status(200).json({
    success: true,
    branches,
    pagination: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.data.pageSize)
    }
  });
}

/** Return branch profile data to staff with access to that operator branch.
 *  Storage keys and internal user ids are intentionally excluded from the response. */
export async function getOperatorBranchDetails(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!context || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(context ? 404 : 401).json({ success: false, message: context ? "Branch not found" : "Unauthorized" });
  }
  if (context.role === "CLIENT") return response.status(403).json({ success: false, message: "Forbidden" });

  const accessFilter = buildOperatorBranchRecordAccessFilter({
    tenantId: context.tenantId,
    branchId: new mongoose.Types.ObjectId(branchId),
    role: context.role,
    assignedBranches: context.assignedBranches
  });
  const branch = await Branch.findOne(accessFilter)
    .select("_id name code labelCode openingDate description address.countryCode address.countryName address.city address.stateOrProvince address.postalCode address.address contact.email contact.phone operations.supportedServices operations.shipmentCoverage operations.operatingCountries operations.workingDays baseCurrency gstin invoiceSacCode status activatedAt phoneNumbers.label phoneNumbers.number documents.type documents.title documents.fileName documents.mimeType documents.uploadedAt createdAt updatedAt")
    .lean()
    .exec();

  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });
  return response.status(200).json({ success: true, branch });
}

/** Apply the same branch assignment guard to document bytes as to branch details. */
export async function requireOperatorBranchDocumentAccess(request: Request, response: Response, next: NextFunction): Promise<void> {
  const context = getOperatorContext(request);
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!context || !mongoose.Types.ObjectId.isValid(branchId)) {
    response.status(404).json({ success: false, message: "Branch not found" });
    return;
  }
  const branch = await Branch.exists(buildOperatorBranchRecordAccessFilter({
    tenantId: context.tenantId,
    branchId: new mongoose.Types.ObjectId(branchId),
    role: context.role,
    assignedBranches: context.assignedBranches
  })).exec();
  if (!branch) {
    response.status(404).json({ success: false, message: "Branch not found" });
    return;
  }
  next();
}


/** List operator team members and clients whose account membership grants branch access. */
export async function listOperatorBranchUsers(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (context.role === "CLIENT") return response.status(403).json({ success: false, message: "Forbidden" });
  if (!mongoose.Types.ObjectId.isValid(branchId)) return response.status(404).json({ success: false, message: "Branch not found" });

  const parsed = branchUsersQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid branch user filters." });
  }

  const branchObjectId = new mongoose.Types.ObjectId(branchId);
  const branchAccessFilter = buildOperatorBranchRecordAccessFilter({
    tenantId: context.tenantId,
    branchId: branchObjectId,
    role: context.role,
    assignedBranches: context.assignedBranches
  });
  const branch = await Branch.exists(branchAccessFilter).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  const { page, pageSize, search } = parsed.data;
  const teamClauses: Record<string, unknown>[] = [
    { tenantId: context.tenantId },
    { role: { $ne: "CLIENT" } },
    { status: { $in: ["ACTIVE", "INVITED", "SUSPENDED"] } },
    { $or: [{ role: "OPERATOR_ADMIN" }, { assignedBranches: branchObjectId }] }
  ];
  const assignedAccounts = await BusinessAccount.find({
    assignedBranch: branchObjectId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  }).select("_id").lean().exec();
  const clientClauses: Record<string, unknown>[] = [
    { tenantId: context.tenantId },
    { status: { $in: ["active", "invited", "suspended"] } },
    { $or: [
      { assignedBranches: branchObjectId },
      {
        $or: [{ assignedBranches: { $size: 0 } }, { assignedBranches: { $exists: false } }],
        businessAccount: { $in: assignedAccounts.map(({ _id }) => _id) }
      }
    ] }
  ];
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    const matchingUsers = await User.find({ $or: [
      { firstName: pattern },
      { lastName: pattern },
      { name: pattern },
      { email: pattern },
      { phone: pattern },
      { "staffProfile.designation": pattern }
    ] }).select("_id").lean().exec();
    const matchingUserIds = matchingUsers.map(({ _id }) => _id);
    teamClauses.push({ $or: [
      { userId: { $in: matchingUserIds } },
      { role: pattern },
      { status: pattern }
    ] });
    clientClauses.push({ $or: [
      { user: { $in: matchingUserIds } },
      { role: pattern },
      { status: pattern }
    ] });
  }

  const teamQuery = { $and: teamClauses };
  const clientQuery = { $and: clientClauses };
  const [teamTotal, clientTotal] = await Promise.all([
    TenantMembership.countDocuments(teamQuery).exec(),
    BusinessAccountMember.countDocuments(clientQuery).exec()
  ]);
  const skip = (page - 1) * pageSize;
  const teamCount = Math.max(0, Math.min(pageSize, teamTotal - skip));
  const memberships = teamCount
    ? await TenantMembership.find(teamQuery)
      .select("userId role status createdAt")
      .sort({ userId: 1, _id: 1 })
      .skip(skip)
      .limit(teamCount)
      .lean().exec()
    : [];
  const clientCount = pageSize - memberships.length;
  const clientMemberships = clientCount && skip + memberships.length >= teamTotal
    ? await BusinessAccountMember.find(clientQuery)
      .select("businessAccount user role status createdAt")
      .sort({ user: 1, _id: 1 })
      .skip(Math.max(0, skip - teamTotal))
      .limit(clientCount)
      .lean().exec()
    : [];
  const [users, accounts] = await Promise.all([
    User.find({ _id: { $in: [
      ...memberships.map(({ userId }) => userId),
      ...clientMemberships.map(({ user }) => user)
    ] } }).select("firstName lastName name email phone staffProfile.designation userStatus lastLogin").lean().exec(),
    BusinessAccount.find({
      _id: { $in: clientMemberships.map(({ businessAccount }) => businessAccount) },
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
    }).select("company.companyName accountId contact.jobTitle").lean().exec()
  ]);
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  const accountsById = new Map(accounts.map((account) => [String(account._id), account]));
  const userDetails = (user: (typeof users)[number]) => ({
    _id: String(user._id),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    name: user.name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    designation: user.staffProfile?.designation ?? "",
    userStatus: user.userStatus ?? "unavailable",
    lastLogin: user.lastLogin ?? null
  });
  const teamRows = memberships.flatMap((membership) => {
    const user = usersById.get(String(membership.userId));
    return user ? [{
      _id: String(membership._id),
      role: membership.role,
      membershipStatus: membership.status,
      createdAt: membership.createdAt,
      user: userDetails(user),
      account: null
    }] : [];
  });
  const clientRows = clientMemberships.flatMap((membership) => {
    const user = usersById.get(String(membership.user));
    const account = accountsById.get(String(membership.businessAccount));
    if (!user || !account) return [];
    return [{
      _id: String(membership._id),
      role: membership.role,
      membershipStatus: membership.status,
      createdAt: membership.createdAt,
      user: { ...userDetails(user), designation: user.staffProfile?.designation || account.contact?.jobTitle || "" },
      account: { accountId: account.accountId, companyName: account.company?.companyName ?? "" }
    }];
  });

  return response.status(200).json({
    success: true,
    users: [...teamRows, ...clientRows],
    pagination: { page, pageSize, total: teamTotal + clientTotal, totalPages: Math.ceil((teamTotal + clientTotal) / pageSize) }
  });
}

/** Return one read-only user profile only when its membership grants this branch access. */
export async function getOperatorBranchUser(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  const membershipId = typeof request.params.membershipId === "string" ? request.params.membershipId : "";
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (context.role === "CLIENT") return response.status(403).json({ success: false, message: "Forbidden" });
  if (!mongoose.Types.ObjectId.isValid(branchId) || !mongoose.Types.ObjectId.isValid(membershipId)) {
    return response.status(404).json({ success: false, message: "User profile not found" });
  }

  const branchObjectId = new mongoose.Types.ObjectId(branchId);
  const membershipObjectId = new mongoose.Types.ObjectId(membershipId);
  const branchFilter = buildOperatorBranchRecordAccessFilter({
    tenantId: context.tenantId,
    branchId: branchObjectId,
    role: context.role,
    assignedBranches: context.assignedBranches
  });
  const branch = await Branch.findOne(branchFilter).select("_id name").lean().exec();
  if (!branch) return response.status(404).json({ success: false, message: "User profile not found" });

  const teamMembership = await TenantMembership.findOne({
    _id: membershipObjectId,
    tenantId: context.tenantId,
    role: { $ne: "CLIENT" },
    status: { $in: ["ACTIVE", "INVITED", "SUSPENDED"] },
    $or: [{ role: "OPERATOR_ADMIN" }, { assignedBranches: branchObjectId }]
  }).select("userId role status createdAt").lean().exec();

  if (teamMembership) {
    const user = await User.findById(teamMembership.userId)
      .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
      .lean()
      .exec();
    if (!user) return response.status(404).json({ success: false, message: "User profile not found" });
    return response.status(200).json({
      success: true,
      branch: { _id: String(branch._id), name: branch.name },
      user: {
        _id: String(teamMembership._id),
        role: teamMembership.role,
        membershipStatus: teamMembership.status,
        createdAt: teamMembership.createdAt,
        user: {
          _id: String(user._id),
          firstName: user.firstName ?? "",
          lastName: user.lastName ?? "",
          name: user.name ?? "",
          email: user.email ?? "",
          phone: user.phone ?? "",
          designation: user.staffProfile?.designation ?? "",
          userStatus: user.userStatus ?? "unavailable",
          lastLogin: user.lastLogin ?? null
        },
        account: null
      }
    });
  }

  const clientMembership = await BusinessAccountMember.findOne({
    _id: membershipObjectId,
    tenantId: context.tenantId,
    status: { $in: ["active", "invited", "suspended"] }
  }).select("businessAccount user role status createdAt assignedBranches").lean().exec();
  if (!clientMembership) return response.status(404).json({ success: false, message: "User profile not found" });

  const account = await BusinessAccount.findOne({
    _id: clientMembership.businessAccount,
    tenantId: context.tenantId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  }).select("accountId company.companyName contact.jobTitle assignedBranch").lean().exec();
  const membershipBranches = clientMembership.assignedBranches ?? [];
  const directlyAssigned = membershipBranches.some((assignedBranch) => String(assignedBranch) === String(branchObjectId));
  const inheritsAccountBranch = membershipBranches.length === 0 && String(account?.assignedBranch ?? "") === String(branchObjectId);
  if (!account || (!directlyAssigned && !inheritsAccountBranch)) {
    return response.status(404).json({ success: false, message: "User profile not found" });
  }

  const user = await User.findById(clientMembership.user)
    .select("firstName lastName name email phone staffProfile.designation userStatus lastLogin")
    .lean()
    .exec();
  if (!user) return response.status(404).json({ success: false, message: "User profile not found" });

  return response.status(200).json({
    success: true,
    branch: { _id: String(branch._id), name: branch.name },
    user: {
      _id: String(clientMembership._id),
      role: clientMembership.role,
      membershipStatus: clientMembership.status,
      createdAt: clientMembership.createdAt,
      user: {
        _id: String(user._id),
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        name: user.name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        designation: user.staffProfile?.designation || account.contact?.jobTitle || "",
        userStatus: user.userStatus ?? "unavailable",
        lastLogin: user.lastLogin ?? null
      },
      account: { accountId: account.accountId, companyName: account.company?.companyName ?? "" }
    }
  });
}
