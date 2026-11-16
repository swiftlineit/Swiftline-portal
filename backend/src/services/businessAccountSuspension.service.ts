import mongoose from "mongoose";
import { env } from "../config/env.js";
import { BusinessAccount, type BusinessAccountSuspensionMode } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";

export const suspensionMessage = "Business account activity is paused. Contact your account manager for assistance.";
export const securityLockMessage = "This business account is locked. Contact your account manager for assistance.";

/** Legacy suspended records predate modes and are operational holds. */
export function suspensionMode(account: { status?: string; suspension?: { mode?: BusinessAccountSuspensionMode } | null }) {
  return account.status === "suspended" ? account.suspension?.mode ?? "OPERATIONAL_HOLD" : null;
}

/** A second readable account must keep a shared client identity signed in. */
export function isUsableClientAccountWorkspace(account: { status?: string; suspension?: { mode?: BusinessAccountSuspensionMode } | null }) {
  return account.status === "active" || account.status === "approved" || suspensionMode(account) === "OPERATIONAL_HOLD";
}

export function suspensionRestorationStatus(account: { status: string; suspension?: { previousStatus?: "active" | "approved" } | null }) {
  return account.suspension?.previousStatus ?? (account.status === "approved" ? "approved" : "active");
}

export async function getAccountSuspension(accountId: mongoose.Types.ObjectId | string) {
  const account = await BusinessAccount.findById(accountId).select("status suspension.mode").lean().exec();
  return account ? suspensionMode(account) : null;
}

export async function availableClientAccountIds(accountIds: mongoose.Types.ObjectId[]) {
  const accounts = await BusinessAccount.find({ _id: { $in: accountIds } })
    .select("status suspension.mode").lean().exec();
  return accounts.filter((account) => suspensionMode(account) !== "SECURITY_LOCK")
    .map((account) => account._id as mongoose.Types.ObjectId);
}

export async function securityLockedClientAccountIds(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: { $in: ["active", "suspended"] } })
    .select("businessAccount").lean().exec();
  if (!memberships.length) return [];
  const accounts = await BusinessAccount.find({
    _id: { $in: memberships.map((member) => member.businessAccount) },
    status: "suspended",
    "suspension.mode": "SECURITY_LOCK"
  }).select("_id").lean().exec();
  return accounts.map((account) => account._id as mongoose.Types.ObjectId);
}

export async function hasUsableClientWorkspace(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount").lean().exec();
  if (memberships.length) {
    const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((member) => member.businessAccount) } })
      .select("status suspension.mode").lean().exec();
    if (accounts.some(isUsableClientAccountWorkspace)) return true;
  }

  if (!env.OPERATOR_PORTAL_ENABLED) return false;
  const operatorMemberships = await TenantMembership.find({ userId, status: "ACTIVE" })
    .select("tenantId").lean().exec();
  if (!operatorMemberships.length) return false;
  return Boolean(await Tenant.exists({
    _id: { $in: operatorMemberships.map((member) => member.tenantId) },
    kind: "OPERATOR",
    status: "ACTIVE"
  }));
}

export async function isSoleSecurityLockedClient(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount").lean().exec();
  if (!memberships.length) return false;
  const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((member) => member.businessAccount) } })
    .select("status suspension.mode").lean().exec();
  if (!accounts.some((account) => suspensionMode(account) === "SECURITY_LOCK")) return false;
  return !await hasUsableClientWorkspace(userId);
}
