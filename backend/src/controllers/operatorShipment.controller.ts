import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountMember, shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft, shipmentDraftStatusValues } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, shipmentEventStatusValues, shipmentMilestoneKey } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { buildStoredLabelAccess } from "./dpdShipment.controller.js";
import { createBlankShipmentDraft, ManualShipmentDraftError } from "../services/manualShipmentDraft.service.js";
import {
  createLabelForShipmentDraft,
  DpdShipmentServiceError,
  reconcileShipmentDocuments
} from "../services/dpdShipment.service.js";
import { markShipmentChargeFinalized } from "../services/shipmentInvoice.service.js";
import { ensureShipmentBookedEvent } from "../services/shipmentBookingEvent.service.js";
import { notifyOperatorShipmentBooked } from "../services/operatorShipmentBookedNotification.service.js";
import { buildPricingHash, ShipmentPriceChangedError } from "../services/shipmentCostEstimate.service.js";
import { RateCardRequiredError } from "../services/shipmentPricing.service.js";
import { resolveShipmentEventNote } from "../services/shipmentEventCopy.service.js";
import { readShipmentBookingSnapshot, serializeShipmentBookingConfirmation } from "../services/shipmentBookingSnapshot.service.js";
import { shipmentManifestAssignmentAvailability } from "../services/shipmentManifestMembership.service.js";
import { equivalentCurrentStatusValues } from "../services/shipmentStatusSequence.service.js";
import {
  isOperatorBusinessAccountBookable,
  getOperatorTrackingTransitionError,
  operatorTrackingStatusValues
} from "../services/operatorShipmentPolicy.service.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const operatorManualDraftSchema = z.object({
  businessAccountId: objectIdSchema,
  branchId: objectIdSchema
}).strict();

const operatorBookingSchema = z.object({
  acceptedPricingHash: z.string().trim().min(1).max(128)
}).strict();

const operatorTrackingSchema = z.object({
  status: z.enum(operatorTrackingStatusValues),
  note: z.string().trim().max(500).optional().default(""),
  location: z.string().trim().max(120).optional().default(""),
  eventAt: z.coerce.date().optional()
}).strict();

const operatorShipmentListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  branchId: objectIdSchema.optional(),
  businessAccountId: objectIdSchema.optional(),
  status: z.string().trim().refine((status) => (shipmentEventStatusValues as readonly string[]).includes(status), "Choose a valid shipment status.").optional(),
  search: z.string().trim().max(100).optional()
}).strict();

const operatorDraftListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  branchId: objectIdSchema.optional(),
  businessAccountId: objectIdSchema.optional(),
  status: z.enum(shipmentDraftStatusValues).optional(),
  search: z.string().trim().max(100).optional()
}).strict();

function authenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function formatBusinessAccountName(account: {
  company?: { companyName?: string };
  contact?: { firstName?: string; lastName?: string };
}) {
  const companyName = account.company?.companyName?.trim();
  const contactName = [account.contact?.firstName, account.contact?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return companyName || contactName || "Business account name unavailable";
}

async function loadBusinessAccountNames(
  tenantId: mongoose.Types.ObjectId,
  businessAccountIds: unknown[]
) {
  const ids = [...new Set(businessAccountIds.map(String))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return new Map<string, string>();

  const accounts = await BusinessAccount.find({ tenantId, _id: { $in: ids } })
    .select("company.companyName contact.firstName contact.lastName")
    .lean()
    .exec();
  return new Map(accounts.map((account) => [String(account._id), formatBusinessAccountName(account)]));
}

function canStaffAccessBranch(context: NonNullable<ReturnType<typeof getOperatorContext>>, branchId: unknown) {
  return context.role === "OPERATOR_ADMIN"
    || context.assignedBranches.some((assigned) => String(assigned) === String(branchId));
}

function draftIdFromRequest(request: Request) {
  const id = request.params.id ?? request.params.draftId ?? request.params.shipmentDraftId ?? "";
  return typeof id === "string" && mongoose.Types.ObjectId.isValid(id) ? id : "";
}

/** Creates drafts for operator staff. Client drafts use the existing membership-aware client handler. */
export async function createOperatorManualShipmentDraft(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = operatorManualDraftSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Select a business account and sender branch." });
  }

  try {
    const shipmentDraft = await createBlankShipmentDraft({
      ...parsed.data,
      createdBy: userId,
      allowedBranchIds: context.role === "OPERATOR_ADMIN" ? null : context.assignedBranches.map(String)
    });
    return response.status(201).json({ success: true, shipmentDraft });
  } catch (error) {
    if (error instanceof ManualShipmentDraftError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

/** Operator clients choose the account explicitly so a login with multiple accounts cannot draft against the wrong one. */
export async function createOperatorClientManualShipmentDraft(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  if (!context || context.role !== "CLIENT" || !userId) {
    return response.status(403).json({ success: false, message: "Only operator clients can use this booking route." });
  }

  const parsed = operatorManualDraftSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Select a business account and sender branch." });
  }

  const membership = await BusinessAccountMember.findOne({
    tenantId: context.tenantId,
    user: userId,
    businessAccount: new mongoose.Types.ObjectId(parsed.data.businessAccountId),
    status: "active",
    role: { $in: shipmentBookingRoles }
  }).select("_id").lean().exec();
  if (!membership) return response.status(404).json({ success: false, message: "Business account access is not available." });

  const account = await BusinessAccount.findOne({
    _id: new mongoose.Types.ObjectId(parsed.data.businessAccountId),
    tenantId: context.tenantId
  }).select("status kycReview.overallStatus assignedBranch rateCardBand privateRateCardVersion privateRateCardReady")
    .lean().exec();
  if (!account || !isOperatorBusinessAccountBookable({
    status: account.status,
    kycStatus: account.kycReview?.overallStatus
  })) {
    return response.status(409).json({
      success: false,
      message: "This business account must be approved and its KYC verified before booking."
    });
  }
  const hasRateCard = account.privateRateCardVersion != null ? account.privateRateCardReady : Boolean(account.rateCardBand);
  if (!hasRateCard) {
    return response.status(409).json({
      success: false,
      code: "RATE_CARD_REQUIRED",
      message: "Shipment booking is paused until your operator assigns a rate card. Contact your operator administrator."
    });
  }
  if (String(account.assignedBranch ?? "") !== parsed.data.branchId) {
    return response.status(404).json({ success: false, message: "The selected branch is not assigned to this business account." });
  }
  const branch = await Branch.findOne({
    _id: new mongoose.Types.ObjectId(parsed.data.branchId),
    tenantId: context.tenantId,
    status: "ACTIVE"
  }).select("_id").lean().exec();
  if (!branch) return response.status(404).json({ success: false, message: "The selected branch is not available." });

  try {
    const shipmentDraft = await createBlankShipmentDraft({
      ...parsed.data,
      createdBy: userId,
      allowedBranchIds: [parsed.data.branchId]
    });
    return response.status(201).json({ success: true, shipmentDraft });
  } catch (error) {
    if (error instanceof ManualShipmentDraftError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

/** Branch scoped guard for operator staff detail and draft routes. */
export async function requireOperatorShipmentDraftAccess(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const id = draftIdFromRequest(request);
  if (!context || !id) return response.status(404).json({ success: false, message: "Shipment not found." });

  const draft = await ShipmentDraft.findOne({ _id: id, tenantId: context.tenantId, deletedAt: null })
    .select("branchId")
    .lean()
    .exec();
  if (!draft || !canStaffAccessBranch(context, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  return next();
}

export async function createOperatorShipment(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  const id = draftIdFromRequest(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!id) return response.status(404).json({ success: false, message: "Shipment draft not found." });

  const parsed = operatorBookingSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Review and accept the current shipment price before booking." });
  }

  const draft = await ShipmentDraft.findOne({ _id: id, tenantId: context.tenantId, deletedAt: null })
    .select("businessAccountId branchId")
    .lean()
    .exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found." });

  if (context.role === "CLIENT") {
    const membership = await BusinessAccountMember.findOne({
      user: userId,
      tenantId: context.tenantId,
      businessAccount: draft.businessAccountId,
      status: "active",
      role: { $in: ["account_owner", "account_admin", "operations", "booking_user"] }
    }).select("assignedBranches").lean().exec();
    const allowedBranches = (membership?.assignedBranches ?? []).map(String);
    const branchAllowed = allowedBranches.length
      ? allowedBranches.includes(String(draft.branchId))
      : Boolean(await BusinessAccount.exists({
        _id: draft.businessAccountId,
        tenantId: context.tenantId,
        assignedBranch: draft.branchId
      }));
    if (!membership || !branchAllowed) {
      return response.status(404).json({ success: false, message: "Shipment draft not found." });
    }
  } else if (!canStaffAccessBranch(context, draft.branchId) || !["OPERATOR_ADMIN", "OPERATIONS"].includes(context.role)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found." });
  }

  try {
    const result = await createLabelForShipmentDraft(id, userId, {
      actor: "operator",
      paymentSource: "BUSINESS_ACCOUNT",
      acceptedPricingHash: parsed.data.acceptedPricingHash,
      skipDpdLabel: true
    });
    await ensureShipmentBookedEvent({
      shipmentDraftId: new mongoose.Types.ObjectId(id),
      dpdShipmentId: result.dpdShipment._id as mongoose.Types.ObjectId,
      userId,
      eventAt: result.dpdShipment.createdAt,
      note: "Shipment booked with operator internal labels."
    });
    await markShipmentChargeFinalized({
      shipmentDraftId: new mongoose.Types.ObjectId(id),
      finalizedAt: result.dpdShipment.createdAt
    });
    await notifyOperatorShipmentBooked({
      shipmentDraftId: new mongoose.Types.ObjectId(id),
      dpdShipment: result.dpdShipment,
      shipmentInvoice: result.shipmentInvoice,
      bookedBy: userId
    });

    return response.status(result.reused ? 200 : 201).json({
      success: true,
      reused: result.reused,
      shipment: {
        id: String(result.dpdShipment._id),
        shipmentDraftId: String(result.dpdShipment.shipmentDraftId),
        trackingNumber: result.dpdShipment.swiftlineTrackingNumber,
        parcelNumbers: result.dpdShipment.parcelNumbers,
        status: result.dpdShipment.status,
        createdAt: result.dpdShipment.createdAt
      },
      labels: result.labels.map((label) => ({
        id: String(label._id),
        labelType: label.labelType,
        parcelNumber: label.parcelNumber,
        format: label.format,
        labelSize: label.labelSize
      })),
      bookingConfirmation: serializeShipmentBookingConfirmation(result.dpdShipment.bookingSnapshot),
      taxInvoice: {
        id: String(result.shipmentInvoice._id),
        invoiceNumber: result.shipmentInvoice.invoiceNumber,
        currency: result.shipmentInvoice.currency,
        totalAmountMinor: result.shipmentInvoice.totalAmountMinor,
        status: result.shipmentInvoice.status,
        paymentStatus: result.shipmentInvoice.paymentStatus
      }
    });
  } catch (error) {
    if (error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof ShipmentPriceChangedError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
        pricing: error.currentPricing,
        pricingHash: buildPricingHash(error.currentPricing)
      });
    }
    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({ success: false, message: error.message, ...error.details });
    }
    console.error("Operator shipment booking failed.", error);
    return response.status(502).json({ success: false, message: "The operator shipment could not be booked." });
  }
}

/** Mints the existing short-lived signed label URL after checking operator and branch ownership. */
export async function createOperatorShipmentLabelAccess(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  const draftId = draftIdFromRequest(request);
  const labelId = typeof request.params.labelId === "string" ? request.params.labelId : "";
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!draftId || !mongoose.Types.ObjectId.isValid(labelId)) {
    return response.status(404).json({ success: false, message: "Shipment label not found." });
  }

  const draft = await ShipmentDraft.findOne({ _id: draftId, tenantId: context.tenantId, deletedAt: null })
    .select("branchId")
    .lean()
    .exec();
  if (!draft || !canStaffAccessBranch(context, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Shipment label not found." });
  }

  const shipment = await DpdShipment.findOne({ tenantId: context.tenantId, shipmentDraftId: draft._id })
    .select("_id snapshotRevision")
    .lean()
    .exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment label not found." });

  const label = await LabelDocument.findOne({
    _id: new mongoose.Types.ObjectId(labelId),
    tenantId: context.tenantId,
    dpdShipmentId: shipment._id,
    labelType: "INTERNAL",
    labelVersion: shipment.snapshotRevision || 1,
    voidedAt: null
  }).select("_id").lean().exec();
  if (!label) return response.status(404).json({ success: false, message: "Shipment label not found." });

  const access = await buildStoredLabelAccess({
    request,
    dpdShipmentId: String(shipment._id),
    labelId,
    userId,
    disposition: request.query.disposition === "attachment" ? "attachment" : "inline"
  });
  if (!access) return response.status(404).json({ success: false, message: "Shipment label not found." });
  return response.status(200).json({ success: true, ...access });
}

/** Repairs only the current operator booking's internal labels, charge, and invoice. */
export async function reconcileOperatorShipmentDocuments(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  const shipmentId = typeof request.params.shipmentId === "string" ? request.params.shipmentId : "";
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!mongoose.Types.ObjectId.isValid(shipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment booking not found." });
  }

  const booking = await DpdShipment.findOne({ _id: shipmentId, tenantId: context.tenantId })
    .select("shipmentDraftId createdAt")
    .lean()
    .exec();
  if (!booking) return response.status(404).json({ success: false, message: "Shipment booking not found." });
  const draft = await ShipmentDraft.findOne({
    _id: booking.shipmentDraftId,
    tenantId: context.tenantId,
    deletedAt: null
  }).select("branchId").lean().exec();
  if (!draft || !canStaffAccessBranch(context, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Shipment booking not found." });
  }

  try {
    const result = await reconcileShipmentDocuments(shipmentId, userId);
    await ensureShipmentBookedEvent({
      shipmentDraftId: result.dpdShipment.shipmentDraftId as mongoose.Types.ObjectId,
      dpdShipmentId: result.dpdShipment._id as mongoose.Types.ObjectId,
      userId,
      eventAt: result.dpdShipment.createdAt,
      note: "Shipment booked with operator internal labels."
    });
    await markShipmentChargeFinalized({
      shipmentDraftId: result.dpdShipment.shipmentDraftId as mongoose.Types.ObjectId,
      finalizedAt: result.dpdShipment.createdAt ?? booking.createdAt ?? new Date()
    });

    return response.status(200).json({
      success: true,
      message: result.reused ? "Operator shipment documents are already complete." : "Operator shipment documents reconciled.",
      shipment: {
        id: String(result.dpdShipment._id),
        shipmentDraftId: String(result.dpdShipment.shipmentDraftId),
        trackingNumber: result.dpdShipment.swiftlineTrackingNumber,
        parcelNumbers: result.dpdShipment.parcelNumbers,
        status: result.dpdShipment.status
      },
      labels: result.labels.map((label) => ({
        id: String(label._id),
        labelType: label.labelType,
        parcelNumber: label.parcelNumber,
        format: label.format,
        labelSize: label.labelSize
      })),
      taxInvoice: {
        id: String(result.shipmentInvoice._id),
        invoiceNumber: result.shipmentInvoice.invoiceNumber,
        currency: result.shipmentInvoice.currency,
        totalAmountMinor: result.shipmentInvoice.totalAmountMinor,
        revision: result.shipmentInvoice.revision,
        status: result.shipmentInvoice.status
      }
    });
  } catch (error) {
    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({ success: false, message: error.message, ...error.details });
    }
    return response.status(502).json({ success: false, message: "Operator shipment documents could not be reconciled." });
  }
}

export async function listOperatorShipments(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (context.role === "CLIENT") return response.status(403).json({ success: false, message: "Use the client shipment list." });

  const parsed = operatorShipmentListSchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid shipment filters.", errors: parsed.error.flatten() });
  }

  const clauses: Record<string, unknown>[] = [{
    tenantId: context.tenantId,
    deletedAt: null,
    bookingState: { $in: ["BOOKED", "REVIEW_REQUIRED"] }
  }];
  if (context.role !== "OPERATOR_ADMIN") {
    if (!context.assignedBranches.length) {
      return response.status(200).json({ success: true, shipments: [], pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total: 0, totalPages: 0 } });
    }
    clauses.push({ branchId: { $in: context.assignedBranches } });
  }
  if (parsed.data.branchId) {
    if (!canStaffAccessBranch(context, parsed.data.branchId)) {
      return response.status(200).json({ success: true, shipments: [], pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total: 0, totalPages: 0 } });
    }
    clauses.push({ branchId: new mongoose.Types.ObjectId(parsed.data.branchId) });
  }
  if (parsed.data.businessAccountId) clauses.push({ businessAccountId: new mongoose.Types.ObjectId(parsed.data.businessAccountId) });

  if (parsed.data.status) {
    const candidateDraftIds = await ShipmentDraft.distinct("_id", { $and: clauses }).exec() as mongoose.Types.ObjectId[];
    if (!candidateDraftIds.length) {
      return response.status(200).json({ success: true, shipments: [], pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total: 0, totalPages: 0 } });
    }
    const latestEvents = await ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
      { $match: { tenantId: context.tenantId, shipmentDraftId: { $in: candidateDraftIds } } },
      { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
      { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
    ]).exec();
    const latestEventDraftIds = new Set(latestEvents.map((event) => String(event._id)));
    const acceptedStatuses = new Set(equivalentCurrentStatusValues(parsed.data.status));
    const matchingDraftIds = latestEvents
      .filter((event) => acceptedStatuses.has(event.status))
      .map((event) => event._id);

    // Older completed bookings can predate their first tracking event. Keep
    // them discoverable as Booking Confirmed, matching the list's fallback.
    if (parsed.data.status === "SHIPMENT_BOOKED") {
      const legacyBookings = await DpdShipment.find({
        tenantId: context.tenantId,
        shipmentDraftId: { $in: candidateDraftIds },
        status: "LABEL_RECEIVED"
      }).select("shipmentDraftId").lean().exec();
      matchingDraftIds.push(...legacyBookings
        .map((booking) => booking.shipmentDraftId as mongoose.Types.ObjectId)
        .filter((id) => !latestEventDraftIds.has(String(id))));
    }
    clauses.push({ _id: { $in: matchingDraftIds } });
  }

  if (parsed.data.search) {
    const escaped = parsed.data.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");
    const matchingTrackingDraftIds = (await DpdShipment.find({
      tenantId: context.tenantId,
      $or: [{ swiftlineTrackingNumber: pattern }, { parcelNumbers: pattern }]
    }).select("shipmentDraftId").lean().exec()).map((booking) => booking.shipmentDraftId as mongoose.Types.ObjectId);
    clauses.push({ $or: [
      { _id: { $in: matchingTrackingDraftIds } },
      { "consigneeEnteredAddress.companyName": pattern },
      { "consigneeEnteredAddress.contactName": pattern },
      { "consigneeEnteredAddress.townOrCity": pattern },
      { "consignorAddress.companyName": pattern },
      { "consignorAddress.contactName": pattern },
      { "parcelList.shipmentReference1": pattern }
    ] });
  }

  const filter = { $and: clauses };
  const skip = (parsed.data.page - 1) * parsed.data.pageSize;
  const [total, drafts] = await Promise.all([
    ShipmentDraft.countDocuments(filter).exec(),
    ShipmentDraft.find(filter)
      .select("businessAccountId branchId consigneeEnteredAddress parcelList parcelCount bookingState shipmentManifestAssignments createdAt updatedAt")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);
  const draftIds = drafts.map((draft) => draft._id);
  const [bookings, invoices, events, businessAccounts] = draftIds.length
    ? await Promise.all([
      DpdShipment.find({ tenantId: context.tenantId, shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId swiftlineTrackingNumber parcelNumbers status currentShipmentSnapshot bookingSnapshot createdAt").lean().exec(),
      ShipmentInvoice.find({ tenantId: context.tenantId, shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId invoiceNumber currency totalAmountMinor status paymentStatus").lean().exec(),
      ShipmentEvent.find({ tenantId: context.tenantId, shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId status note location eventAt customerVisible").sort({ eventAt: -1, createdAt: -1 }).lean().exec(),
      BusinessAccount.find({ tenantId: context.tenantId, _id: { $in: [...new Set(drafts.map((draft) => String(draft.businessAccountId)))].map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("company.companyName contact.firstName contact.lastName")
        .lean()
        .exec()
    ])
    : [[], [], [], []];
  const businessAccountNameById = new Map(businessAccounts.map((account) => [String(account._id), formatBusinessAccountName(account)]));
  const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
  const invoiceByDraft = new Map(invoices.map((invoice) => [String(invoice.shipmentDraftId), invoice]));
  const eventByDraft = new Map<string, typeof events[number]>();
  for (const event of events) {
    const id = String(event.shipmentDraftId);
    if (!eventByDraft.has(id)) eventByDraft.set(id, event);
  }
  const cancelledDraftIds = new Set(events
    .filter((event) => event.status === "SHIPMENT_CANCELLED")
    .map((event) => String(event.shipmentDraftId)));

  return response.status(200).json({
    success: true,
    shipments: drafts.map((draft) => {
      const booking = bookingByDraft.get(String(draft._id)) ?? null;
      const manifestAvailability = shipmentManifestAssignmentAvailability(draft.shipmentManifestAssignments, "admin");
      const hasBookingSnapshot = Boolean(booking && (
        readShipmentBookingSnapshot(booking.currentShipmentSnapshot)
        ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
      ));
      const completedLabel = booking?.status === "LABEL_RECEIVED" && hasBookingSnapshot;
      const notCancelled = !cancelledDraftIds.has(String(draft._id));
      return {
        draft,
        businessAccountName: businessAccountNameById.get(String(draft.businessAccountId)) ?? "Business account name unavailable",
        shipment: booking,
        taxInvoice: invoiceByDraft.get(String(draft._id)) ?? null,
        currentEvent: eventByDraft.get(String(draft._id)) ?? null,
        manifestEligible: completedLabel && notCancelled && manifestAvailability.canCreateAccount,
        combinedManifestEligible: completedLabel && notCancelled && manifestAvailability.canCreateCombined
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

/** Lists editable operator drafts for staff; clients use their account-scoped workspace endpoint. */
export async function listOperatorShipmentDrafts(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!["OPERATOR_ADMIN", "OPERATIONS", "FINANCE"].includes(context.role)) {
    return response.status(403).json({ success: false, message: "Use the client shipment workspace." });
  }

  const parsed = operatorDraftListSchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid shipment draft filters.", errors: parsed.error.flatten() });
  }

  const clauses: Record<string, unknown>[] = [{
    tenantId: context.tenantId,
    deletedAt: null,
    bookingState: { $in: ["EDITABLE", "BOOKING", "REVIEW_REQUIRED"] }
  }];
  if (context.role !== "OPERATOR_ADMIN") {
    if (!context.assignedBranches.length) {
      return response.status(200).json({ success: true, drafts: [], pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total: 0, totalPages: 0 } });
    }
    clauses.push({ branchId: { $in: context.assignedBranches } });
  }
  if (parsed.data.branchId) {
    if (!canStaffAccessBranch(context, parsed.data.branchId)) {
      return response.status(200).json({ success: true, drafts: [], pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total: 0, totalPages: 0 } });
    }
    clauses.push({ branchId: new mongoose.Types.ObjectId(parsed.data.branchId) });
  }
  if (parsed.data.businessAccountId) {
    clauses.push({ businessAccountId: new mongoose.Types.ObjectId(parsed.data.businessAccountId) });
  }
  if (parsed.data.status) clauses.push({ status: parsed.data.status });

  if (parsed.data.search) {
    const escaped = parsed.data.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");
    const matchingDraftIds = (await DpdShipment.find({
      tenantId: context.tenantId,
      $or: [{ swiftlineTrackingNumber: pattern }, { parcelNumbers: pattern }]
    }).select("shipmentDraftId").lean().exec()).map((booking) => booking.shipmentDraftId as mongoose.Types.ObjectId);
    clauses.push({ $or: [
      { _id: { $in: matchingDraftIds } },
      { "consigneeEnteredAddress.companyName": pattern },
      { "consigneeEnteredAddress.contactName": pattern },
      { "consigneeEnteredAddress.townOrCity": pattern },
      { "consignorAddress.companyName": pattern },
      { "consignorAddress.contactName": pattern },
      { "parcelList.shipmentReference1": pattern }
    ] });
  }

  const filter = { $and: clauses };
  const skip = (parsed.data.page - 1) * parsed.data.pageSize;
  const [total, drafts] = await Promise.all([
    ShipmentDraft.countDocuments(filter).exec(),
    ShipmentDraft.find(filter)
      .select("businessAccountId branchId consigneeEnteredAddress parcelList parcelCount status bookingState createdAt updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);
  const businessAccountNameById = await loadBusinessAccountNames(context.tenantId, drafts.map((draft) => draft.businessAccountId));
  return response.status(200).json({
    success: true,
    drafts: drafts.map((draft) => ({
      id: String(draft._id),
      businessAccountId: String(draft.businessAccountId),
      businessAccountName: businessAccountNameById.get(String(draft.businessAccountId)) ?? "Business account name unavailable",
      branchId: String(draft.branchId),
      destination: draft.consigneeEnteredAddress,
      shipmentReference: draft.parcelList?.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 ?? "",
      parcelCount: draft.parcelCount,
      parcelWeightsKg: draft.parcelList?.map((parcel) => typeof parcel.weightKg === "number" ? parcel.weightKg : null) ?? [],
      status: draft.status,
      bookingState: draft.bookingState,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    })),
    pagination: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.data.pageSize)
    }
  });
}

class OperatorTrackingError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export async function updateOperatorShipmentTracking(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = authenticatedUserId(request);
  const id = draftIdFromRequest(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!id) return response.status(404).json({ success: false, message: "Shipment not found." });
  if (!["OPERATOR_ADMIN", "OPERATIONS"].includes(context.role)) {
    return response.status(403).json({ success: false, message: "Only operator operations staff can update tracking." });
  }

  const parsed = operatorTrackingSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Enter a valid tracking update.", errors: parsed.error.flatten() });
  }

  const draft = await ShipmentDraft.findOne({ _id: id, tenantId: context.tenantId, deletedAt: null }).select("branchId").lean().exec();
  if (!draft || !canStaffAccessBranch(context, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }

  const proposedAt = parsed.data.eventAt ?? new Date();
  if (proposedAt.getTime() > Date.now() + 5 * 60_000) {
    return response.status(400).json({ success: false, message: "A tracking update cannot be dated in the future." });
  }

  const session = await mongoose.startSession();
  const createdEventHolder: { event: InstanceType<typeof ShipmentEvent> | null } = { event: null };
  try {
    await session.withTransaction(async () => {
      const shipment = await DpdShipment.findOne({
        tenantId: context.tenantId,
        shipmentDraftId: new mongoose.Types.ObjectId(id),
        status: "LABEL_RECEIVED"
      })
        .session(session)
        .exec();
      if (!shipment) throw new OperatorTrackingError(409, "This shipment is not ready for tracking updates.");

      const lockedShipment = await DpdShipment.findOneAndUpdate(
        { _id: shipment._id, tenantId: context.tenantId },
        { $inc: { operatorTrackingRevision: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!lockedShipment) throw new OperatorTrackingError(404, "Shipment not found.");

      const latestEvent = await ShipmentEvent.findOne({ tenantId: context.tenantId, shipmentDraftId: new mongoose.Types.ObjectId(id) })
        .sort({ eventAt: -1, createdAt: -1 })
        .session(session)
        .exec();
      const transitionError = getOperatorTrackingTransitionError({
        currentStatus: latestEvent?.status,
        currentEventAt: latestEvent?.eventAt,
        nextStatus: parsed.data.status,
        nextEventAt: proposedAt
      });
      if (transitionError) throw new OperatorTrackingError(409, transitionError);

      const [event] = await ShipmentEvent.create([{
        shipmentDraftId: new mongoose.Types.ObjectId(id),
        dpdShipmentId: shipment._id,
        status: parsed.data.status,
        milestoneKey: shipmentMilestoneKey(parsed.data.status),
        note: resolveShipmentEventNote(parsed.data.note, parsed.data.status),
        location: parsed.data.location,
        source: "MANUAL",
        customerVisible: true,
        createdBy: userId,
        eventAt: proposedAt
      }], { session });
      if (!event) throw new Error("OPERATOR_TRACKING_EVENT_NOT_CREATED");
      await AuditLog.create([{
        action: "OPERATOR_SHIPMENT_TRACKING_UPDATED",
        entityType: "SHIPMENT",
        entityId: shipment._id,
        performedBy: userId,
        performedAt: new Date(),
        metadata: { shipmentDraftId: id, status: event.status, eventAt: event.eventAt, location: event.location }
      }], { session });
      createdEventHolder.event = event;
    });
  } catch (error) {
    if (error instanceof OperatorTrackingError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return response.status(409).json({ success: false, message: "This tracking milestone has already been recorded." });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const createdEvent = createdEventHolder.event;
  if (!createdEvent) throw new Error("OPERATOR_TRACKING_EVENT_NOT_CREATED");

  return response.status(201).json({
    success: true,
    event: {
      id: String(createdEvent._id),
      status: createdEvent.status,
      note: createdEvent.note,
      location: createdEvent.location,
      eventAt: createdEvent.eventAt,
      customerVisible: createdEvent.customerVisible
    }
  });
}
