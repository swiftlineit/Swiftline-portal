import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentAmendment, shipmentAmendmentStatusValues } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { getOperatorContext, type OperatorContext } from "../middleware/operatorContext.middleware.js";
import {
  getOperatorShipmentAmendmentEligibility,
  operatorAmendmentBlockedTrackingStatuses,
  operatorAmendmentActionAllowed,
  operatorAmendmentBranchAllowed
} from "../services/operatorShipmentAmendmentPolicy.service.js";
import { clientCanAccessShipmentDraft } from "../services/shipmentDraftPolicy.service.js";
import {
  approveShipmentAmendment,
  createShipmentAmendment,
  previewShipmentAmendment,
  rejectShipmentAmendment
} from "./shipmentAmendment.controller.js";

const queueQuerySchema = z.object({
  status: z.enum(shipmentAmendmentStatusValues).optional().default("REQUESTED"),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25)
}).strict();

const rejectionSchema = z.object({ note: z.string().trim().min(5).max(500) }).strict();

type OperatorAmendmentAccess = {
  context: OperatorContext;
  userId: mongoose.Types.ObjectId;
  draft: { businessAccountId: mongoose.Types.ObjectId; branchId: mongoose.Types.ObjectId };
  canRequest: boolean;
};

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

async function authorizeDraft(
  request: Request,
  draftId: mongoose.Types.ObjectId,
  action: "read" | "request"
): Promise<OperatorAmendmentAccess | null> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId || !operatorAmendmentActionAllowed(context.role, action)) return null;

  const draft = await ShipmentDraft.findOne({
    _id: draftId,
    tenantId: context.tenantId,
    deletedAt: null
  }).select("businessAccountId branchId").lean().exec();
  if (!draft) return null;

  if (context.role !== "CLIENT") {
    if (!operatorAmendmentBranchAllowed(context, draft.branchId)) return null;
    return {
      context,
      userId,
      draft,
      canRequest: operatorAmendmentActionAllowed(context.role, "request")
    };
  }

  const membership = await BusinessAccountMember.findOne({
    tenantId: context.tenantId,
    user: userId,
    businessAccount: draft.businessAccountId,
    status: "active"
  }).select("role").lean().exec();
  if (!membership || !await clientCanAccessShipmentDraft({ userId, draft })) return null;

  return {
    context,
    userId,
    draft,
    canRequest: shipmentBookingRoles.includes(membership.role)
  };
}

async function currentEligibility(
  context: OperatorContext,
  draftId: mongoose.Types.ObjectId
) {
  const [booking, latestEvent, progressedEvent, cancellation, pendingAmendment] = await Promise.all([
    DpdShipment.findOne({ tenantId: context.tenantId, shipmentDraftId: draftId })
      .select("status").lean().exec(),
    ShipmentEvent.findOne({ tenantId: context.tenantId, shipmentDraftId: draftId })
      .select("status eventAt createdAt").sort({ eventAt: -1, createdAt: -1 }).lean().exec(),
    ShipmentEvent.findOne({
      tenantId: context.tenantId,
      shipmentDraftId: draftId,
      status: { $in: operatorAmendmentBlockedTrackingStatuses }
    }).select("status").lean().exec(),
    ShipmentCancellation.findOne({ tenantId: context.tenantId, shipmentDraftId: draftId, status: "REQUESTED" })
      .select("_id").lean().exec(),
    ShipmentAmendment.findOne({ tenantId: context.tenantId, shipmentDraftId: draftId, status: "REQUESTED" })
      .select("_id").lean().exec()
  ]);
  const completedCancellation = !cancellation && await ShipmentCancellation.exists({
    tenantId: context.tenantId,
    shipmentDraftId: draftId,
    status: "COMPLETED"
  });
  return getOperatorShipmentAmendmentEligibility({
    booked: booking?.status === "LABEL_RECEIVED",
    latestTrackingStatus: progressedEvent?.status ?? latestEvent?.status,
    hasCancellationRequest: Boolean(cancellation),
    hasCompletedCancellation: Boolean(completedCancellation),
    hasPendingAmendment: Boolean(pendingAmendment)
  });
}

function serializeAmendment(amendment: Record<string, unknown>) {
  const pricingImpact = amendment.pricingImpact && typeof amendment.pricingImpact === "object"
    ? amendment.pricingImpact as { current?: { totalAmount?: number }; requested?: { totalAmount?: number } }
    : null;
  return {
    id: String(amendment._id),
    shipmentDraftId: String(amendment.shipmentDraftId),
    dpdShipmentId: String(amendment.dpdShipmentId),
    businessAccountId: String(amendment.businessAccountId),
    branchId: String(amendment.branchId),
    requestedBy: String(amendment.requestedBy),
    actorRole: amendment.actorRole,
    status: amendment.status,
    reason: amendment.reason,
    requestedChanges: amendment.requestedChanges,
    changePreview: amendment.changePreview,
    pricingImpact: amendment.pricingImpact ?? null,
    fundingPreview: amendment.fundingPreview ?? null,
    billingAdjustment: amendment.billingAdjustment ?? null,
    reviewNote: amendment.reviewNote ?? "",
    requestedAt: amendment.requestedAt,
    reviewedAt: amendment.reviewedAt ?? null,
    appliedAt: amendment.appliedAt ?? null,
    currentAmountMinor: pricingImpact?.current?.totalAmount != null
      ? Math.round(pricingImpact.current.totalAmount * 100)
      : null,
    requestedAmountMinor: pricingImpact?.requested?.totalAmount != null
      ? Math.round(pricingImpact.requested.totalAmount * 100)
      : null
  };
}

export async function getOperatorShipmentAmendments(request: Request, response: Response): Promise<Response> {
  const draftId = objectId(request.params.id);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found." });
  const access = await authorizeDraft(request, draftId, "read");
  if (!access) return response.status(404).json({ success: false, message: "Shipment not found." });

  const [eligibility, amendments] = await Promise.all([
    currentEligibility(access.context, draftId),
    ShipmentAmendment.find({ tenantId: access.context.tenantId, shipmentDraftId: draftId })
      .select("shipmentDraftId dpdShipmentId businessAccountId branchId requestedBy actorRole status reason requestedChanges changePreview pricingImpact fundingPreview billingAdjustment reviewNote requestedAt reviewedAt appliedAt")
      .sort({ requestedAt: -1, _id: -1 }).limit(10).lean().exec()
  ]);

  return response.status(200).json({
    success: true,
    canRequest: access.canRequest && eligibility.allowed,
    eligibilityMessage: eligibility.message,
    amendments: amendments.map((amendment) => serializeAmendment(amendment as unknown as Record<string, unknown>))
  });
}

async function authorizeRequest(
  request: Request,
  response: Response
): Promise<OperatorAmendmentAccess | null> {
  const context = getOperatorContext(request);
  if (!context || !operatorAmendmentActionAllowed(context.role, "request")) {
    response.status(403).json({ success: false, message: "This operator role cannot request shipment amendments." });
    return null;
  }
  const draftId = objectId(request.params.id);
  if (!draftId) {
    response.status(404).json({ success: false, message: "Shipment not found." });
    return null;
  }
  const access = await authorizeDraft(request, draftId, "request");
  if (!access) {
    response.status(404).json({ success: false, message: "Shipment not found." });
    return null;
  }
  if (!access.canRequest) {
    response.status(403).json({ success: false, message: "Your business-account role cannot request shipment amendments." });
    return null;
  }
  const eligibility = await currentEligibility(context, draftId);
  if (!eligibility.allowed) {
    response.status(409).json({ success: false, message: eligibility.message });
    return null;
  }
  return access;
}

export async function previewOperatorShipmentAmendment(request: Request, response: Response): Promise<Response> {
  if (!await authorizeRequest(request, response)) return response;
  return previewShipmentAmendment(request, response);
}

export async function createOperatorShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const access = await authorizeRequest(request, response);
  if (!access) return response;
  return createShipmentAmendment(request, response, access.context.role === "CLIENT" ? "client" : "admin");
}

export async function listOperatorShipmentAmendments(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context || context.role === "CLIENT" || !operatorAmendmentActionAllowed(context.role, "read")) {
    return response.status(403).json({ success: false, message: "Amendment review is available to operator staff." });
  }
  const parsed = queueQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid amendment filters." });

  const filter: Record<string, unknown> = {
    tenantId: context.tenantId,
    status: parsed.data.status,
    ...(context.role === "OPERATOR_ADMIN" ? {} : { branchId: { $in: context.assignedBranches } })
  };
  const total = await ShipmentAmendment.countDocuments(filter).exec();
  const totalPages = Math.max(1, Math.ceil(total / parsed.data.pageSize));
  const page = Math.min(parsed.data.page, totalPages);
  const skip = (page - 1) * parsed.data.pageSize;
  const amendments = await ShipmentAmendment.find(filter)
      .select("shipmentDraftId dpdShipmentId businessAccountId branchId requestedBy actorRole status reason requestedChanges changePreview pricingImpact fundingPreview billingAdjustment reviewNote requestedAt reviewedAt appliedAt")
      .sort({ requestedAt: -1, _id: -1 }).skip(skip).limit(parsed.data.pageSize).lean().exec();

  const draftIds = amendments.map((item) => item.shipmentDraftId);
  const [drafts, shipments, accounts, branches] = draftIds.length
    ? await Promise.all([
      ShipmentDraft.find({ tenantId: context.tenantId, _id: { $in: draftIds } })
        .select("consigneeEnteredAddress").lean().exec(),
      DpdShipment.find({ tenantId: context.tenantId, shipmentDraftId: { $in: draftIds } })
        .select("shipmentDraftId swiftlineTrackingNumber").lean().exec(),
      BusinessAccount.find({ tenantId: context.tenantId, _id: { $in: amendments.map((item) => item.businessAccountId) } })
        .select("company.companyName accountId").lean().exec(),
      Branch.find({ tenantId: context.tenantId, _id: { $in: amendments.map((item) => item.branchId) } })
        .select("name code").lean().exec()
    ])
    : [[], [], [], []] as const;
  const draftById = new Map(drafts.map((item) => [String(item._id), item]));
  const shipmentByDraftId = new Map(shipments.map((item) => [String(item.shipmentDraftId), item]));
  const accountById = new Map(accounts.map((item) => [String(item._id), item]));
  const branchById = new Map(branches.map((item) => [String(item._id), item]));

  return response.status(200).json({
    success: true,
    amendments: amendments.map((amendment) => {
      const draft = draftById.get(String(amendment.shipmentDraftId));
      const shipment = shipmentByDraftId.get(String(amendment.shipmentDraftId));
      const account = accountById.get(String(amendment.businessAccountId));
      const branch = branchById.get(String(amendment.branchId));
      const amendmentRecord = serializeAmendment(amendment as unknown as Record<string, unknown>);
      return {
        ...amendmentRecord,
        trackingNumber: shipment?.swiftlineTrackingNumber ?? "",
        accountName: account?.company?.companyName ?? "Business account",
        accountId: account?.accountId ?? "",
        consignee: draft?.consigneeEnteredAddress?.companyName || draft?.consigneeEnteredAddress?.contactName || "Not provided",
        branch: branch ? { id: String(branch._id), name: branch.name, code: branch.code } : null
      };
    }),
    pagination: {
      page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages
    }
  });
}

async function authorizeReview(request: Request, response: Response, id: mongoose.Types.ObjectId) {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId || !operatorAmendmentActionAllowed(context.role, "review")) {
    response.status(403).json({ success: false, message: "This operator role cannot review shipment amendments." });
    return null;
  }
  const amendment = await ShipmentAmendment.findOne({ _id: id, tenantId: context.tenantId })
    .select("branchId").lean().exec();
  if (!amendment || !operatorAmendmentBranchAllowed(context, amendment.branchId)) {
    response.status(404).json({ success: false, message: "Amendment not found." });
    return null;
  }
  return { context, userId };
}

export async function approveOperatorShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const id = objectId(request.params.id);
  if (!id) return response.status(404).json({ success: false, message: "Amendment not found." });
  if (!await authorizeReview(request, response, id)) return response;
  return approveShipmentAmendment(request, response);
}

export async function rejectOperatorShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const id = objectId(request.params.id);
  if (!id) return response.status(404).json({ success: false, message: "Amendment not found." });
  if (!await authorizeReview(request, response, id)) return response;
  const parsed = rejectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Enter a rejection reason with at least five characters." });
  }
  request.body = parsed.data;
  return rejectShipmentAmendment(request, response);
}
