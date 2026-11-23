import type { Request, Response } from "express";
import mongoose, { type QueryFilter } from "mongoose";
import { z } from "zod";
import { canAccessBranch, allowedBranchIds } from "../middleware/branchAccess.middleware.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import type { ICashReceipt } from "../models/cashReceipt.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { renderCashReceiptPdf } from "../services/cashReceiptPdf.service.js";
import { createStandaloneCashReceipt } from "../services/prepaid/standaloneCashReceipts.service.js";
import { getTenantContext, getTenantIdForWrite } from "../services/tenantScope.service.js";
import { serializeCashReceipt } from "./cashReceipt.controller.js";

type CashReceiptFilter = QueryFilter<ICashReceipt>;

const createSchema = z.object({
  businessAccountId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid business account."),
  branchId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid branch."),
  customerName: z.string().trim().min(1).max(200),
  receiptDate: z.iso.date(),
  amountMinor: z.number().int().positive(),
  paymentReference: z.string().trim().min(2).max(160),
  customerReference: z.string().trim().max(160).optional().default(""),
  destination: z.string().trim().max(500).optional().default(""),
  service: z.enum(["COURIER", "CARGO"]).optional(),
  pieces: z.number().int().min(1).max(1000).optional(),
  weightKg: z.number().min(0).max(100_000).optional()
});

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

async function currentTenantId() {
  return getTenantContext()?.tenantId ?? await getTenantIdForWrite();
}

function scopedBranchFilter(request: Request): CashReceiptFilter {
  const branchIds = allowedBranchIds(request);
  if (branchIds === null) return {};
  return { branchId: { $in: branchIds.filter(mongoose.Types.ObjectId.isValid).map((id) => new mongoose.Types.ObjectId(id)) } };
}

function parseDateRange(request: Request) {
  const from = typeof request.query.from === "string" ? request.query.from : "";
  const to = typeof request.query.to === "string" ? request.query.to : "";
  if ((from && !z.iso.date().safeParse(from).success) || (to && !z.iso.date().safeParse(to).success)) return null;
  if (from && to && from > to) return null;
  return {
    ...(from ? { $gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {})
  };
}

export async function listStandaloneCashReceipts(request: Request, response: Response): Promise<Response> {
  if (!userId(request)) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (getTenantContext()?.kind === "OPERATOR") return response.status(404).json({ success: false, message: "Cash receipts were not found." });
  const dateRange = parseDateRange(request);
  if (!dateRange) return response.status(400).json({ success: false, message: "Choose a valid receipt date range." });
  const tenantId = await currentTenantId();
  const limitValue = Number(request.query.limit ?? 20);
  const pageValue = Number(request.query.page ?? 1);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 100) : 20;
  const requestedPage = Number.isFinite(pageValue) ? Math.max(Math.trunc(pageValue), 1) : 1;
  const filters: CashReceiptFilter = {
    tenantId,
    receiptType: "STANDALONE",
    ...scopedBranchFilter(request),
    ...(Object.keys(dateRange).length ? { receiptDate: dateRange as CashReceiptFilter["receiptDate"] } : {})
  };
  const total = await CashReceipt.countDocuments(filters).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const receipts = await CashReceipt.find(filters)
    .sort({ receiptDate: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .exec();
  return response.status(200).json({
    success: true,
    receipts: receipts.map((receipt) => serializeCashReceipt(receipt as InstanceType<typeof CashReceipt>)),
    pagination: { page, limit, total, totalPages }
  });
}

export async function createStandaloneCashReceiptHandler(request: Request, response: Response): Promise<Response> {
  const staffUserId = userId(request);
  if (!staffUserId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (getTenantContext()?.kind === "OPERATOR") return response.status(404).json({ success: false, message: "Cash receipts were not found." });
  const parsed = createSchema.safeParse(request.body ?? {});
  if (!parsed.success) return response.status(400).json({ success: false, message: "Receipt details are invalid.", errors: parsed.error.format() });
  const idempotencyKey = request.header("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) return response.status(400).json({ success: false, message: "A valid receipt request reference is required." });

  const businessAccountId = new mongoose.Types.ObjectId(parsed.data.businessAccountId);
  const branchId = new mongoose.Types.ObjectId(parsed.data.branchId);
  if (!canAccessBranch(request, branchId)) return response.status(404).json({ success: false, message: "Business account was not found." });
  const tenantId = await currentTenantId();
  const account = await BusinessAccount.findOne({ _id: businessAccountId, tenantId, assignedBranch: branchId })
    .select("_id")
    .lean()
    .exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account was not found." });

  try {
    const result = await createStandaloneCashReceipt({
      idempotencyKey,
      businessAccountId,
      branchId,
      staffUserId,
      customerName: parsed.data.customerName,
      receiptDate: new Date(`${parsed.data.receiptDate}T12:00:00+05:30`),
      amountMinor: parsed.data.amountMinor,
      paymentReference: parsed.data.paymentReference,
      customerReference: parsed.data.customerReference,
      destination: parsed.data.destination,
      service: parsed.data.service,
      pieces: parsed.data.pieces,
      weightKg: parsed.data.weightKg
    });
    return response.status(result.created ? 201 : 200).json({ success: true, duplicate: !result.created, receipt: serializeCashReceipt(result.receipt) });
  } catch (error) {
    const duplicateKey = error && typeof error === "object" && "code" in error && error.code === 11000;
    return response.status(duplicateKey ? 409 : 400).json({
      success: false,
      message: error instanceof Error ? error.message : "Cash receipt could not be created."
    });
  }
}

export async function downloadStandaloneCashReceiptPdf(request: Request, response: Response): Promise<Response> {
  if (!userId(request)) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (getTenantContext()?.kind === "OPERATOR") return response.status(404).json({ success: false, message: "Cash receipt not found." });
  const receiptId = String(request.params.receiptId ?? "");
  if (!mongoose.Types.ObjectId.isValid(receiptId)) return response.status(404).json({ success: false, message: "Cash receipt not found." });
  const receipt = await CashReceipt.findOne({
    _id: receiptId,
    tenantId: await currentTenantId(),
    receiptType: "STANDALONE",
    ...scopedBranchFilter(request)
  }).exec();
  if (!receipt || !canAccessBranch(request, receipt.branchId)) return response.status(404).json({ success: false, message: "Cash receipt not found." });
  const pdf = await renderCashReceiptPdf(receipt);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `inline; filename="cash-receipt-${receipt.receiptNumber}.pdf"`);
  response.setHeader("Cache-Control", "private, no-store");
  return response.status(200).send(pdf);
}

export async function exportStandaloneCashReceipts(request: Request, response: Response): Promise<Response> {
  if (!userId(request)) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (getTenantContext()?.kind === "OPERATOR") return response.status(404).json({ success: false, message: "Cash receipts were not found." });
  const dateRange = parseDateRange(request);
  if (!dateRange) return response.status(400).json({ success: false, message: "Choose a valid receipt date range." });
  const filters: CashReceiptFilter = {
    tenantId: await currentTenantId(),
    receiptType: "STANDALONE",
    ...scopedBranchFilter(request),
    ...(Object.keys(dateRange).length ? { receiptDate: dateRange as CashReceiptFilter["receiptDate"] } : {})
  };
  const receipts = await CashReceipt.find(filters).sort({ receiptDate: -1, createdAt: -1 }).limit(10_000).lean().exec();
  const fields = ["Receipt", "Date", "Business account", "Received from", "Amount INR", "Payment reference", "Destination", "Service", "Pieces", "Weight kg", "Recorded by"];
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = receipts.map((receipt) => [
    receipt.receiptNumber,
    receipt.receiptDate?.toISOString().slice(0, 10),
    receipt.accountIdSnapshot,
    receipt.customerNameSnapshot,
    (receipt.totalReceivedMinor / 100).toFixed(2),
    receipt.cashCustodyReference,
    receipt.destinationSnapshot,
    receipt.serviceSnapshot,
    receipt.piecesSnapshot,
    receipt.weightKgSnapshot,
    receipt.createdByNameSnapshot
  ]);
  const csv = [fields, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", "attachment; filename=swiftline-cash-receipts.csv");
  response.setHeader("Cache-Control", "private, no-store");
  return response.status(200).send(`\uFEFF${csv}`);
}
