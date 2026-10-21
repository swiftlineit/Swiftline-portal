import { shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, type BusinessAccountMemberRole } from "../models/businessAccountMember.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { counterPaymentMethodValues } from "../models/counterPayment.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import {
  ShipmentCancellation,
  shipmentCancellationStatusValues,
  type ShipmentCancellationStatus
} from "../models/shipmentCancellation.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { dateRangeCondition, dateRangeParams } from "../utils/dateRangeFilter.js";
import {
  approveShipmentCancellation,
  getShipmentCancellation,
  rejectShipmentCancellation,
  requestShipmentCancellation,
  serializeShipmentCancellation,
  ShipmentCancellationError
} from "../services/shipmentCancellation.service.js";
import {
  createCancellationFeeInvoicePdf,
  createShipmentCreditNotePdf
} from "../services/cancellationDocumentPdf.service.js";

const requestSchema = z.object({
  reason: z.string().trim().min(5, "Enter a clear reason for cancellation.").max(500)
});
const reviewSchema = z.object({
  feeBaseMinor: z.number().int().min(0, "The cancellation fee cannot be negative."),
  feeReason: z.string().trim().max(500).optional().default(""),
  carrierConfirmed: z.literal(true, { error: "Confirm carrier cancellation before approval." }),
  settlementConfirmed: z.literal(true, { error: "Confirm the cancellation settlement before approval." }),
  carrierReference: z.string().trim().max(120).optional().default(""),
  reviewNote: z.string().trim().max(500).optional().default(""),
  // Only sent for walk-in shipments, where the refund is paid back outside the
  // portal. The service decides whether it was required and rejects the approval
  // when a counter sale is refundable but no payout was recorded.
  refundPayout: z.object({
    method: z.enum(counterPaymentMethodValues),
    reference: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional()
  }).optional()
});
const rejectSchema = z.object({
  reviewNote: z.string().trim().min(5, "Enter a reason for rejection.").max(500)
});
const clientCancellationRoles: BusinessAccountMemberRole[] = shipmentBookingRoles;

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function objectId(value: unknown) {
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

async function clientMembershipForDraft(currentUserId: mongoose.Types.ObjectId, draftId: mongoose.Types.ObjectId) {
  const draft = await ShipmentDraft.findById(draftId).select("businessAccountId branchId").lean().exec();
  if (!draft) return null;
  const membership = await BusinessAccountMember.findOne({
    user: currentUserId,
    businessAccount: draft.businessAccountId,
    status: "active"
  }).exec();
  if (!membership) return null;
  const assignedBranches = membership.assignedBranches.map(String);
  if (assignedBranches.length && !assignedBranches.includes(String(draft.branchId))) return null;
  return { membership, draft };
}

function sendError(error: unknown, response: Response) {
  if (error instanceof ShipmentCancellationError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

export async function getClientShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const draftId = objectId(request.params.draftId);
  const access = currentUserId && draftId ? await clientMembershipForDraft(currentUserId, draftId) : null;
  if (!currentUserId || !draftId || !access) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  return response.status(200).json({
    success: true,
    canRequest: clientCancellationRoles.includes(access.membership.role),
    cancellation: await getShipmentCancellation(draftId)
  });
}

export async function getAdminShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const draftId = objectId(request.params.draftId);
  if (!draftId || !await ShipmentDraft.exists({ _id: draftId })) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  return response.status(200).json({ success: true, canRequest: true, cancellation: await getShipmentCancellation(draftId) });
}

export async function requestClientShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const draftId = objectId(request.params.draftId);
  if (!currentUserId || !draftId) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  const access = await clientMembershipForDraft(currentUserId, draftId);
  if (!access) return response.status(404).json({ success: false, message: "Shipment not found." });
  if (!clientCancellationRoles.includes(access.membership.role)) {
    return response.status(403).json({
      success: false,
      message: "Your business-account role cannot request shipment cancellation."
    });
  }
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Cancellation reason is invalid." });
  }
  try {
    const cancellation = await requestShipmentCancellation({
      shipmentDraftId: draftId,
      requestedBy: currentUserId,
      requesterType: "CLIENT",
      requesterRole: access.membership.role,
      reason: parsed.data.reason
    });
    return response.status(201).json({ success: true, cancellation: serializeShipmentCancellation(cancellation) });
  } catch (error) {
    return sendError(error, response);
  }
}

export async function requestAdminShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const draftId = objectId(request.params.draftId);
  if (!currentUserId || !draftId) return response.status(404).json({ success: false, message: "Shipment not found." });
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Cancellation reason is invalid." });
  }
  try {
    const cancellation = await requestShipmentCancellation({
      shipmentDraftId: draftId,
      requestedBy: currentUserId,
      requesterType: "ADMIN",
      requesterRole: "admin",
      reason: parsed.data.reason
    });
    return response.status(201).json({ success: true, cancellation: serializeShipmentCancellation(cancellation) });
  } catch (error) {
    return sendError(error, response);
  }
}

export async function listShipmentCancellations(request: Request, response: Response): Promise<Response> {
  const status = typeof request.query.status === "string" ? request.query.status.toUpperCase() : "";
  const filter: Record<string, unknown> = shipmentCancellationStatusValues.includes(status as ShipmentCancellationStatus)
    ? { status: status as ShipmentCancellationStatus }
    : {};
  const { dateFrom, dateTo } = dateRangeParams(request.query);
  const requestedAt = dateRangeCondition(dateFrom, dateTo);
  if (requestedAt) filter.requestedAt = requestedAt;

  const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "50"), 10) || 50));
  const requestedPage = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
  const total = await ShipmentCancellation.countDocuments(filter).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const cancellations = await ShipmentCancellation.find(filter)
    .sort({ requestedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .exec();
  const draftIds = cancellations.map((item) => item.shipmentDraftId);
  const [drafts, shipments, branches, accounts] = await Promise.all([
    ShipmentDraft.find({ _id: { $in: draftIds } })
      .select("consigneeEnteredAddress businessAccountId branchId customerType consignorAddress.contactName")
      .lean()
      .exec(),
    DpdShipment.find({ shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId dpdShipmentId swiftlineTrackingNumber").lean().exec(),
    Branch.find({ _id: { $in: cancellations.map((item) => item.branchId) } }).select("name code").lean().exec(),
    BusinessAccount.find({ _id: { $in: cancellations.map((item) => item.businessAccountId) } }).select("accountId company.companyName").lean().exec()
  ]);
  const draftMap = new Map(drafts.map((item) => [String(item._id), item]));
  const shipmentMap = new Map(shipments.map((item) => [String(item.shipmentDraftId), item]));
  const branchMap = new Map(branches.map((item) => [String(item._id), item]));
  const accountMap = new Map(accounts.map((item) => [String(item._id), item]));
  return response.status(200).json({
    success: true,
    cancellations: cancellations.map((item) => {
      const draft = draftMap.get(String(item.shipmentDraftId));
      const shipment = shipmentMap.get(String(item.shipmentDraftId));
      const branch = branchMap.get(String(item.branchId));
      const account = accountMap.get(String(item.businessAccountId));
      // A walk-in cancellation refunds money that left the portal, so the review
      // screen needs to know to ask how it was paid back.
      const isIndividual = draft?.customerType === "INDIVIDUAL";
      return {
        ...serializeShipmentCancellation(item),
        customerType: draft?.customerType ?? "BUSINESS",
        shipmentReference: shipment?.swiftlineTrackingNumber || "AWB Pending",
        consignee: draft?.consigneeEnteredAddress?.companyName
          || draft?.consigneeEnteredAddress?.contactName
          || "Not provided",
        branch: branch ? { id: String(branch._id), name: branch.name, code: branch.code } : null,
        businessAccount: account ? {
          id: String(account._id),
          accountId: isIndividual ? "INDIVIDUAL" : account.accountId,
          // The sentinel's name is bookkeeping; show the person who shipped.
          companyName: isIndividual
            ? draft?.consignorAddress?.contactName || "Individual customer"
            : account.company.companyName
        } : null
      };
    }),
    pagination: { page, limit, total, totalPages }
  });
}

export async function approveCancellationRequest(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const cancellationId = objectId(request.params.id);
  if (!currentUserId || !cancellationId) {
    return response.status(404).json({ success: false, message: "Cancellation request not found." });
  }
  const parsed = reviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Cancellation approval details are invalid."
    });
  }
  try {
    const cancellation = await approveShipmentCancellation({
      cancellationId,
      reviewedBy: currentUserId,
      ...parsed.data
    });
    return response.status(200).json({
      success: true,
      message: "Shipment cancellation completed and financial documents generated.",
      cancellation: serializeShipmentCancellation(cancellation)
    });
  } catch (error) {
    return sendError(error, response);
  }
}

export async function rejectCancellationRequest(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const cancellationId = objectId(request.params.id);
  if (!currentUserId || !cancellationId) {
    return response.status(404).json({ success: false, message: "Cancellation request not found." });
  }
  const parsed = rejectSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Cancellation rejection reason is invalid."
    });
  }
  try {
    const cancellation = await rejectShipmentCancellation({
      cancellationId,
      reviewedBy: currentUserId,
      reviewNote: parsed.data.reviewNote
    });
    return response.status(200).json({
      success: true,
      message: "Cancellation request rejected.",
      cancellation: serializeShipmentCancellation(cancellation)
    });
  } catch (error) {
    return sendError(error, response);
  }
}

async function canClientAccessCancellation(
  currentUserId: mongoose.Types.ObjectId,
  cancellationId: mongoose.Types.ObjectId
) {
  const cancellation = await ShipmentCancellation.findById(cancellationId)
    .select("shipmentDraftId")
    .lean()
    .exec();
  if (!cancellation) return false;
  return Boolean(await clientMembershipForDraft(currentUserId, cancellation.shipmentDraftId));
}

function streamPdf(response: Response, document: PDFKit.PDFDocument, filename: string, download: boolean) {
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${filename}"`);
  document.pipe(response);
  document.end();
}

export async function getCancellationCreditNotePdf(
  request: Request,
  response: Response,
  clientAccess = false
): Promise<Response | void> {
  const currentUserId = userId(request);
  const cancellationId = objectId(request.params.id);
  if (!currentUserId || !cancellationId) {
    return response.status(404).json({ success: false, message: "Credit note not found." });
  }
  if (clientAccess && !await canClientAccessCancellation(currentUserId, cancellationId)) {
    return response.status(404).json({ success: false, message: "Credit note not found." });
  }
  const note = await ShipmentCreditNote.findOne({ cancellationId }).exec();
  if (!note) return response.status(404).json({ success: false, message: "Credit note is not available yet." });
  streamPdf(
    response,
    createShipmentCreditNotePdf(note),
    `${note.creditNoteNumber.replaceAll("/", "-")}.pdf`,
    request.query.download === "1"
  );
}

export async function getCancellationFeeInvoicePdf(
  request: Request,
  response: Response,
  clientAccess = false
): Promise<Response | void> {
  const currentUserId = userId(request);
  const cancellationId = objectId(request.params.id);
  if (!currentUserId || !cancellationId) {
    return response.status(404).json({ success: false, message: "Cancellation fee invoice not found." });
  }
  if (clientAccess && !await canClientAccessCancellation(currentUserId, cancellationId)) {
    return response.status(404).json({ success: false, message: "Cancellation fee invoice not found." });
  }
  const invoice = await CancellationFeeInvoice.findOne({ cancellationId }).exec();
  if (!invoice) {
    return response.status(404).json({ success: false, message: "Cancellation fee invoice is not available yet." });
  }
  streamPdf(
    response,
    createCancellationFeeInvoicePdf(invoice),
    `${invoice.invoiceNumber.replaceAll("/", "-")}.pdf`,
    request.query.download === "1"
  );
}

export async function getClientCancellationCreditNotePdf(request: Request, response: Response) {
  return getCancellationCreditNotePdf(request, response, true);
}

export async function getClientCancellationFeeInvoicePdf(request: Request, response: Response) {
  return getCancellationFeeInvoicePdf(request, response, true);
}

export async function getAdminCancellationCreditNotePdf(request: Request, response: Response) {
  return getCancellationCreditNotePdf(request, response, false);
}

export async function getAdminCancellationFeeInvoicePdf(request: Request, response: Response) {
  return getCancellationFeeInvoicePdf(request, response, false);
}
