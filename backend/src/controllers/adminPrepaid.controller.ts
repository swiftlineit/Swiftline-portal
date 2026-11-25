import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { listAccountLedger } from "../services/prepaid/accountLedger.service.js";
import { canAccessBranch } from "../middleware/branchAccess.middleware.js";
import { getTenantContext, getTenantIdForWrite } from "../services/tenantScope.service.js";

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
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

async function loadAccount(request: Request) {
  const businessAccountId = String(request.params.businessAccountId ?? "");
  if (!mongoose.Types.ObjectId.isValid(businessAccountId)) return null;
  if (getTenantContext()?.kind === "OPERATOR") return null;
  const tenantId = getTenantContext()?.tenantId ?? await getTenantIdForWrite();
  const account = await BusinessAccount.findOne({ _id: businessAccountId, tenantId })
    .select("accountId company.companyName assignedBranch")
    .lean()
    .exec();
  if (!account || !account.assignedBranch || !canAccessBranch(request, account.assignedBranch)) return null;
  return { account, businessAccountId: new mongoose.Types.ObjectId(businessAccountId), tenantId };
}

export async function getBusinessAccountPaymentsLedger(request: Request, response: Response): Promise<Response> {
  if (!userId(request)) return response.status(401).json({ success: false, message: "Unauthorized" });
  const loaded = await loadAccount(request);
  if (!loaded) return response.status(404).json({ success: false, message: "Business account was not found." });
  const dateRange = parseDateRange(request);
  if (!dateRange) return response.status(400).json({ success: false, message: "Choose a valid ledger date range." });
  const pageValue = Number(request.query.page ?? 1);
  const limitValue = Number(request.query.limit ?? 20);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 100) : 20;
  const requestedPage = Number.isFinite(pageValue) ? Math.max(Math.trunc(pageValue), 1) : 1;
  const ledger = await listAccountLedger({
    tenantId: loaded.tenantId,
    businessAccountId: loaded.businessAccountId,
    page: requestedPage,
    limit,
    from: dateRange.$gte,
    to: dateRange.$lte
  });
  return response.status(200).json({
    success: true,
    account: {
      id: String(loaded.account._id),
      accountId: loaded.account.accountId,
      companyName: loaded.account.company?.companyName || loaded.account.accountId,
      branchId: String(loaded.account.assignedBranch)
    },
    ...ledger
  });
}

function csv(value: unknown) {
  if (/^[=+@\t\r-]/.test(String(value ?? ""))) value = "\'" + String(value);
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function exportBusinessAccountPaymentsLedger(request: Request, response: Response): Promise<Response> {
  if (!userId(request)) return response.status(401).json({ success: false, message: "Unauthorized" });
  const loaded = await loadAccount(request);
  if (!loaded) return response.status(404).json({ success: false, message: "Business account was not found." });
  const dateRange = parseDateRange(request);
  if (!dateRange) return response.status(400).json({ success: false, message: "Choose a valid ledger date range." });
  const filename = 'payments-ledger-' + loaded.account.accountId.replace(/[^A-Za-z0-9_-]/g, '-') + '.csv';
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  response.setHeader('Cache-Control', 'private, no-store');
  response.write('\uFEFFDate,Activity,Method,Status,Direction,Amount INR,Shipment,Reference,Description\r\n');
  let page = 1;
  let totalPages = 1;
  do {
    const ledger = await listAccountLedger({
      tenantId: loaded.tenantId,
      businessAccountId: loaded.businessAccountId,
      page,
      limit: 100,
      from: dateRange.$gte,
      to: dateRange.$lte
    });
    totalPages = ledger.pagination.totalPages;
    for (const row of ledger.transactions) {
      const values = [row.createdAt.toISOString(), row.transactionType.replaceAll('_', ' '), row.paymentSource, row.status, row.direction, (row.amountMinor / 100).toFixed(2), row.shipmentNumber ?? '', row.reference, row.description];
      if (!response.write(values.map(csv).join(',') + '\r\n')) await new Promise<void>((resolve) => response.once('drain', resolve));
    }
    page += 1;
  } while (page <= totalPages && !response.destroyed);
  return response.end();
}
