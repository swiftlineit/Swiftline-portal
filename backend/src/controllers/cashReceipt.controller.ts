import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { canAccessBranch } from "../middleware/branchAccess.middleware.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { CashReceiptRead } from "../models/cashReceiptRead.model.js";
import { BusinessAccountMember, financialRoles } from "../models/businessAccountMember.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { saveCashReceiptDraft } from "../services/prepaid/cashReceipts.service.js";
import { renderCashReceiptPdf } from "../services/cashReceiptPdf.service.js";
import { resolveClientScope } from "../utils/clientScope.js";
import { User } from "../models/user.model.js";

const cashReceiptDraftSchema = z.object({
  acceptedPricingHash: z.string().trim().min(1).max(128),
  totalReceivedMinor: z.number().int().positive(),
  customerName: z.string().trim().min(1).max(200),
  receiptDate: z.iso.date(),
  cashCustodyReference: z.string().trim().min(2).max(160),
  customerReference: z.string().trim().max(160).optional(),
  note: z.string().trim().max(500).optional(),
  historicalAllocations: z.array(z.object({
    statementId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid statement."),
    amountMinor: z.number().int().positive()
  })).max(100).optional().default([])
});

function authenticatedUserId(request: Request) {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

export function serializeCashReceipt(receipt: InstanceType<typeof CashReceipt>) {
  return {
    id: String(receipt._id),
    receiptNumber: receipt.receiptNumber,
    receiptType: receipt.receiptType ?? "SHIPMENT",
    status: receipt.status,
    customerType: receipt.customerType,
    // Manual standalone receipts have no linked account.
    businessAccountId: receipt.businessAccountId ? String(receipt.businessAccountId) : null,
    branchId: String(receipt.branchId),
    shipmentDraftId: receipt.shipmentDraftId ? String(receipt.shipmentDraftId) : null,
    pricingHash: receipt.pricingHash,
    totalReceivedMinor: receipt.totalReceivedMinor,
    currency: receipt.currency,
    allocations: receipt.allocations.map((allocation) => ({
      allocationType: allocation.allocationType,
      targetId: allocation.targetId ? String(allocation.targetId) : null,
      amountMinor: allocation.amountMinor,
      reference: allocation.reference
    })),
    unappliedAmountMinor: receipt.unappliedAmountMinor,
    customerName: receipt.customerNameSnapshot,
    gstin: receipt.gstinSnapshot || "",
    address: receipt.addressSnapshot || "",
    mobileNumber: receipt.businessMobileNumberSnapshot || "",
    receiptDate: (receipt.receiptDate ?? receipt.issuedAt ?? receipt.createdAt).toISOString(),
    accountId: receipt.accountIdSnapshot,
    destination: receipt.destinationSnapshot,
    service: receipt.serviceSnapshot || undefined,
    pieces: receipt.piecesSnapshot ?? undefined,
    weightKg: receipt.weightKgSnapshot ?? undefined,
    customerReference: receipt.customerReference,
    cashCustodyReference: receipt.cashCustodyReference,
    note: receipt.note,
    createdByName: receipt.createdByNameSnapshot,
    cashRecordedByName: receipt.cashRecordedByNameSnapshot,
    bookedByName: receipt.bookedByNameSnapshot,
    issuedAt: receipt.issuedAt,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt
  };
}

async function loadAuthorizedDraft(request: Request) {
  const draftId = String(request.params.id ?? "");
  if (!mongoose.Types.ObjectId.isValid(draftId)) return null;
  const draft = await ShipmentDraft.findById(draftId).select("branchId businessAccountId").lean().exec();
  if (!draft || !canAccessBranch(request, draft.branchId)) return null;
  return draft;
}

export async function saveStaffCashReceiptDraft(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const draft = await loadAuthorizedDraft(request);
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  const parsed = cashReceiptDraftSchema.safeParse(request.body ?? {});
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  try {
    const receipt = await saveCashReceiptDraft({
      shipmentDraftId: draft._id as mongoose.Types.ObjectId,
      staffUserId: userId,
      acceptedPricingHash: parsed.data.acceptedPricingHash,
      totalReceivedMinor: parsed.data.totalReceivedMinor,
      customerName: parsed.data.customerName,
      receiptDate: new Date(`${parsed.data.receiptDate}T12:00:00+05:30`),
      cashCustodyReference: parsed.data.cashCustodyReference,
      customerReference: parsed.data.customerReference,
      note: parsed.data.note,
      historicalAllocations: parsed.data.historicalAllocations.map((allocation) => ({
        statementId: new mongoose.Types.ObjectId(allocation.statementId),
        amountMinor: allocation.amountMinor
      }))
    });
    return response.status(receipt.createdAt.getTime() === receipt.updatedAt.getTime() ? 201 : 200).json({
      success: true,
      receipt: serializeCashReceipt(receipt)
    });
  } catch (error) {
    return response.status(409).json({ success: false, message: error instanceof Error ? error.message : "Cash receipt could not be saved." });
  }
}

export async function getStaffCashReceipt(request: Request, response: Response): Promise<Response> {
  const draft = await loadAuthorizedDraft(request);
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  const [receipt, account, staff] = await Promise.all([
    CashReceipt.findOne({ shipmentDraftId: draft._id, status: { $in: ["DRAFT", "FINALIZED"] } }).sort({ issuedAt: -1, updatedAt: -1 }).exec(),
    BusinessAccount.findById(draft.businessAccountId).select("accountId company.companyName contact.firstName contact.lastName").lean().exec(),
    User.findById(authenticatedUserId(request)).select("name firstName lastName email").lean().exec()
  ]);
  const customerName = account?.company?.companyName?.trim()
    || [account?.contact?.firstName, account?.contact?.lastName].filter(Boolean).join(" ").trim()
    || account?.accountId
    || "";
  const receiptDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return response.status(200).json({
    success: true,
    receipt: receipt ? serializeCashReceipt(receipt) : null,
    defaults: { customerName, receiptDate, recordedByName: staff?.name?.trim() || [staff?.firstName, staff?.lastName].filter(Boolean).join(" ").trim() || staff?.email || "Swiftline staff" }
  });
}

export async function getClientShipmentCashReceipt(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const scope = await resolveClientScope(request);
  if (!scope.ok) return response.status(scope.status).json({ success: false, message: scope.message });
  if (!scope.canViewFinancials) return response.status(403).json({ success: false, message: "Financial document access is not available for this login." });
  const draftId = String(request.params.draftId ?? "");
  if (!mongoose.Types.ObjectId.isValid(draftId)) return response.status(404).json({ success: false, message: "Shipment not found" });
  const draft = await ShipmentDraft.findOne({
    _id: draftId,
    businessAccountId: scope.businessAccountId,
    branchId: { $in: scope.branchIds }
  }).select("_id businessAccountId branchId").lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment not found" });
  const receipt = await CashReceipt.findOne({
    shipmentDraftId: draft._id,
    businessAccountId: scope.businessAccountId,
    branchId: draft.branchId,
    status: "FINALIZED"
  }).exec();
  return response.status(200).json({ success: true, receipt: receipt ? serializeCashReceipt(receipt) : null });
}

async function sendReceiptPdf(response: Response, receipt: InstanceType<typeof CashReceipt>) {
  const pdf = await renderCashReceiptPdf(receipt);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `inline; filename="cash-receipt-${receipt.receiptNumber}.pdf"`);
  response.setHeader("Cache-Control", "private, no-store");
  return response.status(200).send(pdf);
}

export async function downloadStaffCashReceiptPdf(request: Request, response: Response): Promise<Response> {
  const draft = await loadAuthorizedDraft(request);
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  const receipt = await CashReceipt.findOne({ shipmentDraftId: draft._id, status: { $in: ["DRAFT", "FINALIZED"] } }).exec();
  if (!receipt) return response.status(404).json({ success: false, message: "Cash receipt not found" });
  return sendReceiptPdf(response, receipt);
}

export async function downloadClientCashReceiptPdf(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const scope = await resolveClientScope(request);
  if (!scope.ok) return response.status(scope.status).json({ success: false, message: scope.message });
  if (!scope.canViewFinancials) return response.status(403).json({ success: false, message: "Financial document access is not available for this login." });
  const receiptId = String(request.params.receiptId ?? "");
  if (!mongoose.Types.ObjectId.isValid(receiptId)) return response.status(404).json({ success: false, message: "Cash receipt not found" });
  const receipt = await CashReceipt.findOne({
    _id: receiptId,
    businessAccountId: scope.businessAccountId,
    branchId: { $in: scope.branchIds },
    shipmentDraftId: { $ne: null },
    receiptType: { $ne: "STANDALONE" },
    status: "FINALIZED"
  }).exec();
  if (!receipt) return response.status(404).json({ success: false, message: "Cash receipt not found" });

  const pdf = await renderCashReceiptPdf(receipt);
  await CashReceiptRead.findOneAndUpdate(
    { cashReceiptId: receipt._id, userId },
    { $set: { readAt: new Date() } },
    { upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).exec();
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `inline; filename="cash-receipt-${receipt.receiptNumber}.pdf"`);
  response.setHeader("Cache-Control", "private, no-store");
  return response.status(200).send(pdf);
}

export async function getClientCashReceiptUnreadCount(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const memberships = await BusinessAccountMember.find({
    user: userId,
    status: "active",
    role: { $in: financialRoles }
  }).select("businessAccount assignedBranches").lean().exec();
  if (!memberships.length) return response.status(200).json({ success: true, unreadCount: 0 });
  const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((membership) => membership.businessAccount) } })
    .select("assignedBranch").lean().exec();
  const defaultBranch = new Map(accounts.map((account) => [String(account._id), account.assignedBranch]));
  const scopes = memberships.map((membership) => ({
    businessAccountId: membership.businessAccount,
    branchId: {
      $in: membership.assignedBranches.length
        ? membership.assignedBranches
        : defaultBranch.get(String(membership.businessAccount)) ? [defaultBranch.get(String(membership.businessAccount))] : []
    }
  }));
  const receiptIds = await CashReceipt.find({ status: "FINALIZED", issuedAt: { $ne: null }, shipmentDraftId: { $ne: null }, receiptType: { $ne: "STANDALONE" }, $or: scopes }).distinct("_id").exec();
  if (!receiptIds.length) return response.status(200).json({ success: true, unreadCount: 0 });
  const readIds = await CashReceiptRead.find({ userId, cashReceiptId: { $in: receiptIds } }).distinct("cashReceiptId").exec();
  return response.status(200).json({ success: true, unreadCount: Math.max(receiptIds.length - readIds.length, 0) });
}
