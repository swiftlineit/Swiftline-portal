import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccountMember, financialRoles } from "../models/businessAccountMember.model.js";
import { listAccountLedger } from "../services/prepaid/accountLedger.service.js";
import { getTenantIdForWrite } from "../services/tenantScope.service.js";

function getAuthenticatedUserId(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  return user?._id && mongoose.Types.ObjectId.isValid(String(user._id))
    ? new mongoose.Types.ObjectId(String(user._id))
    : null;
}

async function getClientBusinessAccount(userId: mongoose.Types.ObjectId, businessAccountId?: string) {
  const filters: Record<string, unknown> = {
    user: userId,
    status: "active"
  };

  if (businessAccountId) {
    if (!mongoose.Types.ObjectId.isValid(businessAccountId)) return null;
    filters.businessAccount = new mongoose.Types.ObjectId(businessAccountId);
  }

  const membership = await BusinessAccountMember.findOne(filters)
    .populate("businessAccount", "accountId company.companyName status suspension.mode")
    .sort({ createdAt: -1 })
    .exec();

  if (!membership?.businessAccount) return null;
  if (!financialRoles.includes(membership.role)) return null;

  const account = membership.businessAccount as unknown as {
    _id?: mongoose.Types.ObjectId;
    status?: string;
    suspension?: { mode?: string } | null;
  };

  if (account.status === "suspended" && account.suspension?.mode === "SECURITY_LOCK") return null;
  return account._id ?? null;
}

function parseDateRange(request: Request) {
  const from = typeof request.query.from === "string" ? request.query.from : "";
  const to = typeof request.query.to === "string" ? request.query.to : "";
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return null;
  if (from && to && from > to) return null;
  const condition: Record<string, Date> = {};
  if (from) condition.$gte = new Date(`${from}T00:00:00.000Z`);
  if (to) condition.$lte = new Date(`${to}T23:59:59.999Z`);
  if (Object.values(condition).some((date) => !Number.isFinite(date.getTime()))) return null;
  return condition;
}

/** Client-facing read model: verified online payments and receipted cash only. */
export async function getClientAccountLedger(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const businessAccountId = await getClientBusinessAccount(userId, typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : undefined);
  if (!businessAccountId) return response.status(404).json({ success: false, message: "Business account not found" });

  const dateRange = parseDateRange(request);
  if (!dateRange) return response.status(400).json({ success: false, message: "Choose a valid ledger date range." });

  const pageValue = Number(request.query.page ?? 1);
  const limitValue = Number(request.query.limit ?? 20);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 100) : 20;
  const page = Number.isFinite(pageValue) ? Math.max(Math.trunc(pageValue), 1) : 1;

  const ledger = await listAccountLedger({
    tenantId: await getTenantIdForWrite(),
    businessAccountId,
    page,
    limit,
    from: dateRange.$gte,
    to: dateRange.$lte
  });
  return response.status(200).json({ success: true, ...ledger });
}
