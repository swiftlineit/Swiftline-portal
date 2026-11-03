import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentCancellation, shipmentCancellationStatusValues, type ShipmentCancellationStatus } from "../models/shipmentCancellation.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import {
  operatorCancellationActionAllowed,
  operatorCancellationBranchAllowed
} from "../middleware/operatorShipmentCancellationAccess.middleware.js";
import {
  getOperatorCancellationEligibility,
  terminalOperatorShipmentStatuses
} from "../services/operatorShipmentCancellationPolicy.service.js";
import { clientCanAccessShipmentDraft } from "../services/shipmentDraftPolicy.service.js";
import {
  approveShipmentCancellation,
  getShipmentCancellation,
  rejectShipmentCancellation,
  requestShipmentCancellation,
  serializeShipmentCancellation,
  ShipmentCancellationError
} from "../services/shipmentCancellation.service.js";
import {
  getCancellationCreditNotePdf,
  getCancellationFeeInvoicePdf
} from "./shipmentCancellation.controller.js";

const requestSchema = z.object({
  reason: z.string().trim().min(5, "Enter a clear reason for cancellation.").max(500)
}).strict();

const approveSchema = z.object({
  feeBaseMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  feeReason: z.string().trim().max(500).optional().default(""),
  settlementConfirmed: z.literal(true, { error: "Confirm the credit settlement before approval." }),
  reviewNote: z.string().trim().max(500).optional().default("")
}).strict();

const rejectSchema = z.object({
  reviewNote: z.string().trim().min(5, "Enter a reason for rejection.").max(500)
}).strict();

const listSchema = z.object({
  status: z.enum(shipmentCancellationStatusValues).optional().default("REQUESTED"),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25)
}).strict();

function actorId(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function objectId(value: unknown): mongoose.Types.ObjectId | null {
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

function sendServiceError(error: unknown, response: Response) {
  if (error instanceof ShipmentCancellationError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

async function authorizeDraft(
  request: Request,
  draftId: mongoose.Types.ObjectId,
  action: "read" | "request"
) {
  const context = getOperatorContext(request);
  const currentUserId = actorId(request);
  if (!context || !currentUserId) return null;
  if (!operatorCancellationActionAllowed(context.role, action)) return null;

  const draft = await ShipmentDraft.findOne({
    _id: draftId,
    tenantId: context.tenantId,
    deletedAt: null
  }).select("businessAccountId branchId").lean().exec();
  if (!draft) return null;

  if (context.role !== "CLIENT") {
    if (!operatorCancellationBranchAllowed(context, draft.branchId)) return null;
    return { context, currentUserId, draft, canRequest: action === "request" };
  }

  const membership = await BusinessAccountMember.findOne({
    tenantId: context.tenantId,
    user: currentUserId,
    businessAccount: draft.businessAccountId,
    status: "active"
  }).select("role assignedBranches").lean().exec();
  if (!membership) return null;
  if (!await clientCanAccessShipmentDraft({ userId: currentUserId, draft })) return null;

  return {
    context,
    currentUserId,
    draft,
    canRequest: shipmentBookingRoles.includes(membership.role)
  };
}

async function currentEligibility(draftId: mongoose.Types.ObjectId) {
  const [booking, events, cancellation] = await Promise.all([
    DpdShipment.exists({ shipmentDraftId: draftId }),
    ShipmentEvent.find({ shipmentDraftId: draftId }).select("status eventAt createdAt").lean().exec(),
    getShipmentCancellation(draftId)
  ]);
  const latestEvent = [...events].sort((left, right) => (
    new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime()
    || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  ))[0];
  const eligibility = getOperatorCancellationEligibility({
    hasBooked: Boolean(booking),
    latestStatus: latestEvent?.status,
    hasTerminalStatus: events.some((event) => terminalOperatorShipmentStatuses.includes(event.status)),
    alreadyCancelled: events.some((event) => event.status === "SHIPMENT_CANCELLED")
  });
  return {
    eligibility,
    cancellation,
    requestPending: cancellation?.status === "REQUESTED"
  };
}

export async function getOperatorShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const draftId = objectId(request.params.draftId);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found." });
  const access = await authorizeDraft(request, draftId, "read");
  if (!access) return response.status(404).json({ success: false, message: "Shipment not found." });

  const { eligibility, cancellation, requestPending } = await currentEligibility(draftId);
  return response.status(200).json({
    success: true,
    canRequest: access.canRequest && eligibility.allowed && !requestPending,
    eligibilityMessage: eligibility.message,
    cancellation
  });
}

export async function requestOperatorShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const currentUserId = actorId(request);
  const draftId = objectId(request.params.draftId);
  if (!context || !currentUserId || !draftId) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  const access = await authorizeDraft(request, draftId, "request");
  if (!access) return response.status(404).json({ success: false, message: "Shipment not found." });
  if (!access.canRequest) {
    return response.status(403).json({ success: false, message: "Your business-account role cannot request shipment cancellation." });
  }

  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Cancellation reason is invalid." });
  }

  try {
    const cancellation = await requestShipmentCancellation({
      shipmentDraftId: draftId,
      requestedBy: currentUserId,
      requesterType: context.role === "CLIENT" ? "CLIENT" : "ADMIN",
      requesterRole: context.role,
      reason: parsed.data.reason,
      portalSlug: context.slug
    });
    return response.status(201).json({ success: true, cancellation: serializeShipmentCancellation(cancellation) });
  } catch (error) {
    return sendServiceError(error, response);
  }
}

export async function listOperatorShipmentCancellations(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context || !operatorCancellationActionAllowed(context.role, "read") || context.role === "CLIENT") {
    return response.status(403).json({ success: false, message: "Cancellation review is available to operator staff." });
  }
  const parsed = listSchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid cancellation filters.", errors: parsed.error.flatten() });
  }

  const filter: Record<string, unknown> = { tenantId: context.tenantId, status: parsed.data.status };
  if (context.role !== "OPERATOR_ADMIN") {
    filter.branchId = { $in: context.assignedBranches };
  }
  const skip = (parsed.data.page - 1) * parsed.data.pageSize;
  const [total, cancellations] = await Promise.all([
    ShipmentCancellation.countDocuments(filter).exec(),
    ShipmentCancellation.find(filter)
      .sort({ requestedAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);

  const ids = cancellations.map((item) => item.shipmentDraftId);
  const [drafts, shipments, accounts, branches, events] = ids.length
    ? await Promise.all([
      ShipmentDraft.find({ tenantId: context.tenantId, _id: { $in: ids } })
        .select("businessAccountId branchId consigneeEnteredAddress")
        .lean().exec(),
      DpdShipment.find({ tenantId: context.tenantId, shipmentDraftId: { $in: ids } })
        .select("shipmentDraftId swiftlineTrackingNumber")
        .lean().exec(),
      BusinessAccount.find({ tenantId: context.tenantId, _id: { $in: cancellations.map((item) => item.businessAccountId) } })
        .select("company.companyName accountId")
        .lean().exec(),
      Branch.find({ tenantId: context.tenantId, _id: { $in: cancellations.map((item) => item.branchId) } })
        .select("name code")
        .lean().exec(),
      ShipmentEvent.find({ tenantId: context.tenantId, shipmentDraftId: { $in: ids } })
        .select("shipmentDraftId status eventAt createdAt")
        .sort({ eventAt: -1, createdAt: -1 })
        .lean().exec()
    ])
    : [[], [], [], [], []] as const;

  const draftById = new Map(drafts.map((item) => [String(item._id), item]));
  const shipmentByDraftId = new Map(shipments.map((item) => [String(item.shipmentDraftId), item]));
  const accountById = new Map(accounts.map((item) => [String(item._id), item]));
  const branchById = new Map(branches.map((item) => [String(item._id), item]));
  const latestEventByDraftId = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    if (!latestEventByDraftId.has(key)) latestEventByDraftId.set(key, event);
  }

  return response.status(200).json({
    success: true,
    cancellations: cancellations.map((item) => {
      const draft = draftById.get(String(item.shipmentDraftId));
      const shipment = shipmentByDraftId.get(String(item.shipmentDraftId));
      const account = accountById.get(String(item.businessAccountId));
      const branch = branchById.get(String(item.branchId));
      const latestEvent = latestEventByDraftId.get(String(item.shipmentDraftId));
      const consignee = draft?.consigneeEnteredAddress;
      return {
        ...serializeShipmentCancellation(item as unknown as InstanceType<typeof ShipmentCancellation>),
        trackingNumber: shipment?.swiftlineTrackingNumber ?? "",
        accountName: account?.company?.companyName ?? "Business account",
        accountId: account?.accountId ?? "",
        branch: branch ? { id: String(branch._id), name: branch.name, code: branch.code } : null,
        destination: consignee?.companyName || consignee?.contactName || "Not provided",
        currentStatus: latestEvent?.status ?? item.shipmentStatusAtRequest
      };
    }),
    pagination: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.data.pageSize)
    }
  });
}

async function authorizeCancellationReview(
  request: Request,
  cancellationId: mongoose.Types.ObjectId
) {
  const context = getOperatorContext(request);
  const currentUserId = actorId(request);
  if (!context || !currentUserId || !operatorCancellationActionAllowed(context.role, "review")) return null;

  const cancellation = await ShipmentCancellation.findOne({
    _id: cancellationId,
    tenantId: context.tenantId
  }).select("branchId").lean().exec();
  if (!cancellation || !operatorCancellationBranchAllowed(context, cancellation.branchId)) return null;
  return { context, currentUserId };
}

export async function approveOperatorShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const cancellationId = objectId(request.params.id);
  if (!cancellationId) return response.status(404).json({ success: false, message: "Cancellation request not found." });
  const access = await authorizeCancellationReview(request, cancellationId);
  if (!access) return response.status(404).json({ success: false, message: "Cancellation request not found." });

  const parsed = approveSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Cancellation approval details are invalid." });
  }
  try {
    const cancellation = await approveShipmentCancellation({
      cancellationId,
      reviewedBy: access.currentUserId,
      ...parsed.data,
      carrierConfirmed: false,
      carrierReference: "",
      portalSlug: access.context.slug
    });
    return response.status(200).json({
      success: true,
      message: "Cancellation completed and credit settlement recorded.",
      cancellation: serializeShipmentCancellation(cancellation)
    });
  } catch (error) {
    return sendServiceError(error, response);
  }
}

export async function rejectOperatorShipmentCancellation(request: Request, response: Response): Promise<Response> {
  const cancellationId = objectId(request.params.id);
  if (!cancellationId) return response.status(404).json({ success: false, message: "Cancellation request not found." });
  const access = await authorizeCancellationReview(request, cancellationId);
  if (!access) return response.status(404).json({ success: false, message: "Cancellation request not found." });

  const parsed = rejectSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Cancellation rejection reason is invalid." });
  }
  try {
    const cancellation = await rejectShipmentCancellation({
      cancellationId,
      reviewedBy: access.currentUserId,
      reviewNote: parsed.data.reviewNote,
      portalSlug: access.context.slug
    });
    return response.status(200).json({ success: true, cancellation: serializeShipmentCancellation(cancellation) });
  } catch (error) {
    return sendServiceError(error, response);
  }
}

export async function getOperatorCancellationCreditNotePdf(request: Request, response: Response) {
  const context = getOperatorContext(request);
  const currentUserId = actorId(request);
  const cancellationId = objectId(request.params.id);
  if (!context || !currentUserId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!cancellationId) return response.status(404).json({ success: false, message: "Credit note not found." });
  if (context.role === "CLIENT") return getCancellationCreditNotePdf(request, response, true);

  const cancellation = await ShipmentCancellation.findOne({
    _id: cancellationId,
    tenantId: context.tenantId
  }).select("branchId").lean().exec();
  if (!cancellation || !operatorCancellationBranchAllowed(context, cancellation.branchId)) {
    return response.status(404).json({ success: false, message: "Credit note not found." });
  }
  return getCancellationCreditNotePdf(request, response, false);
}

export async function getOperatorCancellationFeeInvoicePdf(request: Request, response: Response) {
  const context = getOperatorContext(request);
  const currentUserId = actorId(request);
  const cancellationId = objectId(request.params.id);
  if (!context || !currentUserId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!cancellationId) return response.status(404).json({ success: false, message: "Cancellation fee invoice not found." });
  if (context.role === "CLIENT") return getCancellationFeeInvoicePdf(request, response, true);

  const cancellation = await ShipmentCancellation.findOne({
    _id: cancellationId,
    tenantId: context.tenantId
  }).select("branchId").lean().exec();
  if (!cancellation || !operatorCancellationBranchAllowed(context, cancellation.branchId)) {
    return response.status(404).json({ success: false, message: "Cancellation fee invoice not found." });
  }
  return getCancellationFeeInvoicePdf(request, response, false);
}
