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
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { suspensionMode } from "../services/businessAccountSuspension.service.js";
import { getTenantContext } from "../services/tenantScope.service.js";
import { dateRangeCondition, dateRangeParams } from "../utils/dateRangeFilter.js";
import { canAccessBranch } from "../middleware/branchAccess.middleware.js";
import {
  approveShipmentCancellation,
  cancelShipmentDirectly,
  getShipmentCancellation,
  getShipmentCancellationPreview,
  isLegacyCreditOnlyFunding,
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
  // Sent when a refund is paid outside the portal. The service decides whether
  // it was required and rejects approval when an offline refund is refundable
  // but no payout was recorded.
  refundPayout: z.object({
    method: z.enum(counterPaymentMethodValues),
    reference: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional()
  }).optional()
});
const directCancellationSchema = z.object({
  reason: z.string().trim().min(5, "Enter a clear reason for cancellation.").max(500),
  feeBaseMinor: z.number().int().min(0, "The cancellation fee cannot be negative."),
  feeReason: z.string().trim().max(500).optional().default(""),
  carrierConfirmed: z.literal(true, { error: "Confirm cancellation with the carrier before completing this action." }),
  settlementConfirmed: z.literal(true, { error: "Review and confirm the cancellation settlement before completing this action." }),
  carrierReference: z.string().trim().max(120).optional().default(""),
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

async function loadStaffShipmentDraft(request: Request, draftId: mongoose.Types.ObjectId) {
  const tenantContext = getTenantContext();
  const draft = await ShipmentDraft.findOne({
    _id: draftId,
    ...(tenantContext ? { tenantId: tenantContext.tenantId } : {})
  }).select("branchId").lean().exec();
  if (!draft) return null;
  const role = (request as Request & { user?: { role?: string } }).user?.role;
  if (role !== "admin" && !canAccessBranch(request, draft.branchId)) return null;
  return draft;
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
  const account = await BusinessAccount.findById(draft.businessAccountId)
    .select("status suspension.mode")
    .lean()
    .exec();
  if (!account || suspensionMode(account) === "SECURITY_LOCK") return null;
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
  if (!draftId || !await loadStaffShipmentDraft(request, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  return response.status(200).json({ success: true, canRequest: true, cancellation: await getShipmentCancellation(draftId) });
}

export async function getAdminShipmentCancellationPreview(request: Request, response: Response): Promise<Response> {
  const draftId = objectId(request.params.draftId);
  if (!draftId || !await loadStaffShipmentDraft(request, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  try {
    const preview = await getShipmentCancellationPreview(draftId);
    return response.status(200).json({ success: true, preview });
  } catch (error) {
    return sendError(error, response);
  }
}

export async function requestClientShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const draftId = objectId(request.params.draftId);
  if (!currentUserId || !draftId) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  const access = await clientMembershipForDraft(currentUserId, draftId);
  if (!access) return response.status(404).json({ success: false, message: "Shipment not found." });
  const account = await BusinessAccount.findById(access.draft.businessAccountId).select("status").lean().exec();
  if (account?.status === "suspended") {
    return response.status(423).json({ success: false, message: "Cancellation requests are paused while this account is suspended." });
  }
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
  if (!currentUserId || !draftId || !await loadStaffShipmentDraft(request, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
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

export async function cancelAdminShipmentDirectly(request: Request, response: Response): Promise<Response> {
  const currentUserId = userId(request);
  const draftId = objectId(request.params.draftId);
  const requesterRole = (request as Request & { user?: { role?: unknown } }).user?.role;
  if (
    !currentUserId
    || !draftId
    || (requesterRole !== "admin" && requesterRole !== "operations")
    || !await loadStaffShipmentDraft(request, draftId)
  ) return response.status(404).json({ success: false, message: "Shipment not found." });
  const parsed = directCancellationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Cancellation details are invalid."
    });
  }
  try {
    const result = await cancelShipmentDirectly({
      shipmentDraftId: draftId,
      requestedBy: currentUserId,
      requesterRole,
      ...parsed.data
    });
    return response.status(result.completed ? 200 : 202).json({
      success: true,
      completed: result.completed,
      message: result.message,
      cancellation: serializeShipmentCancellation(result.cancellation)
    });
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
  const [drafts, shipments, branches, accounts, charges, fundings] = await Promise.all([
    ShipmentDraft.find({ _id: { $in: draftIds } })
      .select("consigneeEnteredAddress businessAccountId branchId customerType consignorAddress.contactName")
      .lean()
      .exec(),
    DpdShipment.find({ shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId dpdShipmentId swiftlineTrackingNumber paymentSource").lean().exec(),
    Branch.find({ _id: { $in: cancellations.map((item) => item.branchId) } }).select("name code").lean().exec(),
    BusinessAccount.find({ _id: { $in: cancellations.map((item) => item.businessAccountId) } }).select("accountId company.companyName").lean().exec(),
    ShipmentCharge.find({ shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId paymentSource").lean().exec(),
    ShipmentFunding.find({ shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId source").lean().exec()
  ]);
  const draftMap = new Map(drafts.map((item) => [String(item._id), item]));
  const shipmentMap = new Map(shipments.map((item) => [String(item.shipmentDraftId), item]));
  const branchMap = new Map(branches.map((item) => [String(item._id), item]));
  const accountMap = new Map(accounts.map((item) => [String(item._id), item]));
  const chargeMap = new Map(charges.map((item) => [String(item.shipmentDraftId), item]));
  const fundingMap = new Map(fundings.map((item) => [String(item.shipmentDraftId), item]));
  const tenantContext = getTenantContext();
  return response.status(200).json({
    success: true,
    cancellations: cancellations.map((item) => {
      const draft = draftMap.get(String(item.shipmentDraftId));
      const shipment = shipmentMap.get(String(item.shipmentDraftId));
      const branch = branchMap.get(String(item.branchId));
      const account = accountMap.get(String(item.businessAccountId));
      const charge = chargeMap.get(String(item.shipmentDraftId));
      const funding = fundingMap.get(String(item.shipmentDraftId));
      const isIndividual = draft?.customerType === "INDIVIDUAL";
      return {
        ...serializeShipmentCancellation(item, isLegacyCreditOnlyFunding({
          tenantKind: tenantContext?.kind,
          chargePaymentSource: charge?.paymentSource,
          fundingSource: funding?.source
        }) ? "LEGACY_CREDIT_NO_SETTLEMENT" : item.financialTreatment),
        customerType: draft?.customerType ?? "BUSINESS",
        paymentSource: shipment?.paymentSource ?? "",
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
      message: cancellation.financialTreatment === "LEGACY_CREDIT_NO_SETTLEMENT"
        ? "Legacy credit shipment cancelled without refund, credit, fee, or financial-document changes."
        : "Shipment cancellation completed and financial documents generated.",
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
