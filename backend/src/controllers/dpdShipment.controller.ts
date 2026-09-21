import crypto from "crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import { AuditLog, type AuditEntityType } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { CarrierTrackingEvent } from "../models/carrierTrackingEvent.model.js";
import { allowedBranchIds, canAccessBranch } from "../middleware/branchAccess.middleware.js";
import { labelContentType, labelFileExtension } from "../services/labelStorage.service.js";
import {
  ShipmentEvent,
  shipmentEventStatusValues,
  shipmentHoldReasonValues,
  shipmentMilestoneKey,
  shipmentOperationalStatusValues,
  type IShipmentEvent
} from "../models/shipmentEvent.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { counterPaymentMethodValues } from "../models/counterPayment.model.js";
import { recordCounterCollection } from "../services/individualCustomer.service.js";

// Present only on walk-in bookings; business shipments ignore it entirely.
const counterCollectionSchema = z.object({
  method: z.enum(counterPaymentMethodValues),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional()
});
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { chargeFinalizingStatuses, markShipmentChargeFinalized } from "../services/shipmentInvoice.service.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import {
  buildDeliveryEstimate,
  buildTrackingAttention,
  buildTrackingSummary
} from "../services/shipmentTracking.service.js";
import {
  describeEventDateProblem,
  describeAlreadyRecorded,
  describeMissingPrerequisites,
  describeRecordedLaterMilestones,
  equivalentMilestoneStatuses,
  findMissingPrerequisites,
  findRecordedLaterMilestones,
  formatShipmentEventLabel
} from "../services/shipmentStatusSequence.service.js";
import {
  BulkStatusSelectionError,
  bulkRecordOperationalStatus
} from "../services/bulkShipmentStatus.service.js";
import { resolveShipmentEventNote } from "../services/shipmentEventCopy.service.js";
import {
  DpdLabelUnavailableError,
  DpdShipmentServiceError,
  createLabelForShipmentDraft,
  generateDpdLabelForExistingShipment,
  reconcileShipmentDocuments,
  resetBookingForDevelopment
} from "../services/dpdShipment.service.js";
import {
  readShipmentBookingSnapshot,
  serializeShipmentBookingConfirmation
} from "../services/shipmentBookingSnapshot.service.js";
import { objectExists, streamObjectToResponse } from "../services/storage/storage.service.js";
import { buildPricingHash, ShipmentPriceChangedError } from "../services/shipmentCostEstimate.service.js";
import { RateCardRequiredError } from "../services/shipmentPricing.service.js";
import {
  formatTrackingEventLabel,
  loadShipmentJourney,
  normalizeVisibleTrackingHistory,
  type TrackingJourney
} from "../services/shipmentJourney.service.js";
import { buildTrackingPosition } from "../services/shipmentPosition.service.js";
import { resolveTrackingGatewayCode } from "../services/shipmentGateway.service.js";
import {
  loadShipmentParcelActivities,
  loadShipmentParcelActivitiesByDraftIds,
  loadShipmentParcelProgress,
  loadShipmentParcelProgressByDraftIds
} from "../services/shipmentParcelActivity.service.js";
import {
  AlsTrackingServiceError,
  refreshAlsTrackingForShipment
} from "../services/als/alsTracking.service.js";
import {
  recordShipmentOperationsScan,
  ShipmentOperationsScanError
} from "../services/shipmentOperationsScan.service.js";

// Where the scan happened. Optional on every action: Operations records it when
// they know it, and an event without one is still a valid event.
const eventLocationSchema = z.string().trim().max(120).optional().default("");

const holdShipmentSchema = z.object({
  reason: z.enum(shipmentHoldReasonValues),
  note: z.string().trim().min(3).max(500),
  location: eventLocationSchema
});

const releaseShipmentSchema = z.object({
  note: z.string().trim().min(3).max(500),
  location: eventLocationSchema
});

/**
 * When the scan actually happened, as Operations states it.
 *
 * Optional everywhere: left out, the event is stamped with the moment it was
 * recorded, exactly as it always has been. Supplied, that is what the customer's
 * timeline shows- see describeEventDateProblem for the two limits on it.
 */
const eventAtSchema = z.coerce.date().optional();
const gatewayCodeSchema = z.string().trim().toUpperCase().max(3).optional().default("");
const eventPartnerNameSchema = z.string().trim().max(120).optional().default("");
const eventPartnerCodeSchema = z.string().trim().toUpperCase().max(30).optional().default("");

const updateShipmentStatusSchema = z.object({
  status: z.enum(shipmentOperationalStatusValues),
  note: z.string().trim().max(500).optional().default(""),
  location: eventLocationSchema,
  eventAt: eventAtSchema,
  gatewayCode: gatewayCodeSchema,
  partnerName: eventPartnerNameSchema,
  partnerCode: eventPartnerCodeSchema
});

const bulkStatusUpdateSchema = z.object({
  shipmentDraftIds: z.array(
    z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select valid shipments.")
  ).min(1, "Select at least one shipment.").max(200, "A bulk update can cover up to 200 shipments."),
  expectedStatuses: z.array(z.object({
    shipmentDraftId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select valid shipments."),
    status: z.enum(shipmentEventStatusValues)
  })).max(200).optional().default([]),
  status: z.enum(shipmentOperationalStatusValues),
  note: z.string().trim().max(500).optional().default(""),
  location: eventLocationSchema,
  eventAt: eventAtSchema,
  gatewayCode: gatewayCodeSchema,
  partnerName: eventPartnerNameSchema,
  partnerCode: eventPartnerCodeSchema
});

const correctShipmentGatewaySchema = z.object({ gatewayCode: gatewayCodeSchema });
const operationsScanSchema = z.object({
  action: z.enum(["RECEIVE", "PROCESS"]),
  barcode: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120).optional().default(""),
  deviceId: z.string().trim().max(120).optional().default(""),
  scanRequestId: z.string().uuid()
});

// The price the customer accepted, as returned by the cost estimate endpoint.
// Optional: booking paths that were never quoted through the estimator have no
// accepted price to check against.
const acceptedPricingSchema = z.object({
  acceptedPricingHash: z.string().trim().min(1).max(128).optional(),
  // Set only after the booker has been shown a DPD failure and chosen to go
  // ahead without the carrier label. Never defaulted true.
  skipDpdLabel: z.boolean().optional()
});

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

export async function scanShipmentOperationsMilestone(request: Request, response: Response) {
  const actorId = getAuthenticatedUserId(request);
  if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = operationsScanSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Check the scan details."
    });
  }
  try {
    const result = await recordShipmentOperationsScan({
      ...parsed.data,
      userId: actorId,
      allowedBranchIds: allowedBranchIds(request)
    });
    const scanProgress = result.progress;
    const progressText = `${scanProgress.scannedParcels} of ${scanProgress.totalParcels} parcel${scanProgress.totalParcels === 1 ? "" : "s"} scanned.`;
    return response.status(result.alreadyRecorded ? 200 : 201).json({
      success: true,
      message: result.alreadyRecorded
        ? `${scanProgress.parcelNumber} was already scanned for ${result.statusLabel}. ${scanProgress.milestoneRecorded ? "No duplicate timeline event was created." : progressText}`
        : scanProgress.milestoneRecorded
          ? `${result.statusLabel} recorded for ${result.swiftlineTrackingNumber || parsed.data.barcode}.`
          : `${scanProgress.parcelNumber} scanned. ${progressText} Scan the remaining parcels before the shipment milestone is recorded.`,
      result
    });
  } catch (error) {
    if (error instanceof ShipmentOperationsScanError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function refreshCarrierTracking(request: Request, response: Response) {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!mongoose.Types.ObjectId.isValid(String(request.params.id ?? ""))) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  const shipment = await DpdShipment.findById(String(request.params.id)).select("shipmentDraftId").lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found." });
  const draft = await ShipmentDraft.findById(shipment.shipmentDraftId).select("branchId").lean().exec();
  if (!draft || !canAccessBranch(request, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }
  try {
    const result = await refreshAlsTrackingForShipment({ shipmentDraftId: shipment.shipmentDraftId, userId });
    await AuditLog.create({
      action: "CARRIER_TRACKING_REFRESHED",
      entityType: "DPD_SHIPMENT",
      entityId: shipment._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: {
        provider: "ALS",
        carrierAwbNumber: result.carrierAwbNumber,
        appliedEvents: result.applied,
        reviewRequired: result.reviewRequired
      }
    });
    return response.json({ success: true, message: "ALS tracking refreshed.", result });
  } catch (error) {
    if (error instanceof AlsTrackingServiceError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

function serializeDpdShipment(shipment: {
  _id: unknown;
  shipmentDraftId: unknown;
  idempotencyKey: string;
  dpdShipmentId?: string;
  dpdTransactionId?: string;
  forwardingNumber?: string;
  entryNumber?: string;
  swiftlineTrackingNumber?: string;
  parcelNumbers: string[];
  serviceCode: string;
  status: string;
  snapshotRevision?: number;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: shipment._id,
    shipmentDraftId: shipment.shipmentDraftId,
    idempotencyKey: shipment.idempotencyKey,
    dpdShipmentId: shipment.dpdShipmentId ?? "",
    dpdTransactionId: shipment.dpdTransactionId ?? "",
    forwardingNumber: shipment.forwardingNumber ?? "",
    entryNumber: shipment.entryNumber ?? "",
    swiftlineTrackingNumber: shipment.swiftlineTrackingNumber ?? "",
    parcelNumbers: shipment.parcelNumbers,
    serviceCode: shipment.serviceCode,
    status: shipment.status,
    snapshotRevision: shipment.snapshotRevision ?? 1,
    createdAt: shipment.createdAt,
    updatedAt: shipment.updatedAt
  };
}

function serializeLabel(label: {
  _id: unknown;
  dpdShipmentId: unknown;
  parcelNumber: string;
  labelType?: string;
  format: string;
  labelSize: string;
  fileChecksum: string;
  generatedAt: Date;
  downloadCount: number;
  lastDownloadedAt?: Date | null;
}) {
  return {
    id: label._id,
    dpdShipmentId: label.dpdShipmentId,
    parcelNumber: label.parcelNumber,
    labelType: label.labelType ?? "SWIFTLINE",
    format: label.format,
    labelSize: label.labelSize,
    fileChecksum: label.fileChecksum,
    generatedAt: label.generatedAt,
    downloadCount: label.downloadCount,
    lastDownloadedAt: label.lastDownloadedAt ?? null
  };
}

function serializeShipmentDraftSummary(draft: {
  _id: unknown;
  branchId: unknown;
  consigneeEnteredAddress: {
    companyName?: string;
    contactName?: string;
    postcode: string;
    townOrCity?: string;
  };
  status: string;
  addressValidationStatus: string;
} | null | undefined, snapshotValue?: unknown) {
  if (!draft) return null;
  const bookingSnapshot = readShipmentBookingSnapshot(snapshotValue);
  const consignee = bookingSnapshot?.consignee as Record<string, unknown> | undefined;

  return {
    id: draft._id,
    branchId: draft.branchId,
    consigneeName: typeof consignee?.companyName === "string"
      ? consignee.companyName
      : draft.consigneeEnteredAddress.companyName || draft.consigneeEnteredAddress.contactName || "",
    consigneeTownOrCity: typeof consignee?.townOrCity === "string"
      ? consignee.townOrCity
      : draft.consigneeEnteredAddress.townOrCity ?? "",
    deliveryPostcode: typeof consignee?.postcode === "string"
      ? consignee.postcode
      : draft.consigneeEnteredAddress.postcode,
    status: draft.status,
    addressValidationStatus: draft.addressValidationStatus
  };
}

function serializeBranchSummary(branch: {
  _id: unknown;
  name: string;
  code: string;
  address?: {
    city?: string;
  };
} | null | undefined) {
  if (!branch) return null;

  return {
    id: branch._id,
    name: branch.name,
    code: branch.code,
    city: branch.address?.city ?? ""
  };
}

function serializeShipmentEvent(event: {
  _id: unknown;
  shipmentDraftId: unknown;
  dpdShipmentId?: unknown;
  status: string;
  holdReason?: string | null;
  note?: string;
  location?: string;
  customerVisible: boolean;
  eventAt: Date;
  createdBy: unknown;
  source?: string;
  sourceReference?: string;
  gatewayCode?: string;
  gatewayName?: string;
  partnerName?: string;
  partnerCode?: string;
}, journey?: TrackingJourney) {
  return {
    id: event._id,
    shipmentDraftId: event.shipmentDraftId,
    dpdShipmentId: event.dpdShipmentId ?? null,
    status: event.status,
    statusLabel: journey
      ? formatTrackingEventLabel(event.status, journey)
      : formatShipmentEventLabel(event.status),
    holdReason: event.holdReason ?? null,
    note: resolveShipmentEventNote(event.note, event.status),
    location: event.location ?? "",
    customerVisible: event.customerVisible,
    eventAt: event.eventAt,
    createdBy: event.createdBy,
    source: event.source ?? "MANUAL",
    sourceReference: event.sourceReference ?? "",
    gatewayCode: event.gatewayCode ?? "",
    gatewayName: event.gatewayName ?? "",
    partnerName: event.partnerName ?? "",
    partnerCode: event.partnerCode ?? ""
  };
}

function getCurrentShipmentEvent<T extends { eventAt: Date; status: string }>(events: T[]) {
  return events.length ? events[0] : null;
}

async function ensureShipmentBookedEvent(params: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  eventAt?: Date;
}) {
  await ShipmentEvent.findOneAndUpdate(
    {
      shipmentDraftId: params.shipmentDraftId,
      status: "SHIPMENT_BOOKED"
    },
    {
      $setOnInsert: {
        shipmentDraftId: params.shipmentDraftId,
        dpdShipmentId: params.dpdShipmentId,
        status: "SHIPMENT_BOOKED",
        note: "Shipment booked with carrier.",
        customerVisible: true,
        createdBy: params.userId,
        eventAt: params.eventAt ?? new Date()
      }
    },
    { upsert: true }
  ).exec();
}

async function getShipmentEventsByDraftIds(draftIds: mongoose.Types.ObjectId[]) {
  if (!draftIds.length) return new Map<string, IShipmentEvent[]>();

  const events = await ShipmentEvent.find({ shipmentDraftId: { $in: draftIds } })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean<IShipmentEvent[]>()
    .exec();
  const eventsByDraftId = new Map<string, IShipmentEvent[]>();

  for (const event of events) {
    const key = String(event.shipmentDraftId);
    eventsByDraftId.set(key, [...(eventsByDraftId.get(key) ?? []), event]);
  }

  return eventsByDraftId;
}

function serializeAuditLog(log: {
  _id: unknown;
  action: string;
  entityType: string;
  entityId: unknown;
  performedBy: unknown;
  performedAt: Date;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: log._id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    performedBy: log.performedBy,
    performedAt: log.performedAt,
    metadata: log.metadata ?? {}
  };
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signLabelAccessPayload(payload: string) {
  return crypto.createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
}

function createLabelAccessToken(params: {
  dpdShipmentId: string;
  labelId: string;
  userId: string;
  expiresAt: Date;
}) {
  const payload = encodeBase64Url(JSON.stringify({
    dpdShipmentId: params.dpdShipmentId,
    labelId: params.labelId,
    userId: params.userId,
    expiresAt: params.expiresAt.toISOString()
  }));
  const signature = signLabelAccessPayload(payload);

  return `${payload}.${signature}`;
}

function verifyLabelAccessToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = signLabelAccessPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      dpdShipmentId?: unknown;
      labelId?: unknown;
      userId?: unknown;
      expiresAt?: unknown;
    };
    const expiresAt = typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt) : null;

    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
    if (typeof parsed.dpdShipmentId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.dpdShipmentId)) return null;
    if (typeof parsed.labelId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.labelId)) return null;
    if (typeof parsed.userId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.userId)) return null;

    return {
      dpdShipmentId: parsed.dpdShipmentId,
      labelId: parsed.labelId,
      userId: new mongoose.Types.ObjectId(parsed.userId),
      expiresAt
    };
  } catch {
    return null;
  }
}

export function buildAbsoluteUrl(
  request: Pick<Request, "protocol" | "host">,
  path: string,
) {
  // `request.host` is proxy-aware in Express: when the configured reverse
  // proxy is trusted it uses X-Forwarded-Host, while request.get("host") reads
  // the internal localhost address. This keeps signed label links on the
  // public HTTPS origin behind nginx and VS Code development tunnels.
  return `${request.protocol}://${request.host}${path}`;
}

export async function buildStoredLabelAccess(params: {
  request: Request;
  dpdShipmentId: string;
  labelId: string;
  userId: mongoose.Types.ObjectId;
  disposition: "inline" | "attachment";
}) {
  if (!mongoose.Types.ObjectId.isValid(params.dpdShipmentId) || !mongoose.Types.ObjectId.isValid(params.labelId)) {
    return null;
  }

  const label = await LabelDocument.findOne({
    _id: new mongoose.Types.ObjectId(params.labelId),
    dpdShipmentId: new mongoose.Types.ObjectId(params.dpdShipmentId)
  }).lean().exec();
  if (!label) return null;

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const token = createLabelAccessToken({
    dpdShipmentId: params.dpdShipmentId,
    labelId: params.labelId,
    userId: String(params.userId),
    expiresAt
  });
  const path = `/api/v1/dpd-shipments/${params.dpdShipmentId}/label-file?token=${encodeURIComponent(token)}&disposition=${params.disposition}`;

  return {
    url: buildAbsoluteUrl(params.request, path),
    expiresAt,
    label: serializeLabel(label)
  };
}

async function sendStoredLabel(params: {
  label: InstanceType<typeof LabelDocument>;
  userId: mongoose.Types.ObjectId;
  response: Response;
  dpdShipmentId: string;
  accessMode: "authenticated" | "signed";
  disposition?: "inline" | "attachment";
}): Promise<Response | void> {
  const { label, userId, response, dpdShipmentId, accessMode } = params;

  if (!(await objectExists(label.storageKey))) {
    return response.status(404).json({
      success: false,
      message: "The shipment was created, but the label could not be stored. Contact an administrator."
    });
  }

  label.downloadCount += 1;
  label.lastDownloadedAt = new Date();
  await label.save();

  await AuditLog.create({
    action: "LABEL_DOWNLOADED",
    entityType: "LABEL_DOCUMENT",
    entityId: label._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      dpdShipmentId,
      parcelNumber: label.parcelNumber,
      labelType: label.labelType,
      downloadCount: label.downloadCount,
      accessMode
    }
  });

  const extension = labelFileExtension(label.format);

  if (label.format === "HTML") {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox allow-same-origin"
    );
  }

  return streamObjectToResponse({
    response,
    key: label.storageKey,
    contentType: labelContentType(label.format),
    filename: label.labelType === "SWIFTLINE" && label.labelSize === "A4"
      ? `swiftline-labels-${label.parcelNumber.replace(/-\d+$/, "")}.${extension}`
      : `${label.labelType.toLowerCase()}-label-${label.parcelNumber}.${extension}`,
    disposition: params.disposition ?? "inline"
  });
}

export async function createShipment(
  request: Request,
  response: Response
): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const shipmentDraftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(shipmentDraftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  // A walk-in has already paid into a company account, so how that happened is
  // captured at booking. The draft decides the payment source: it cannot be
  // chosen by the caller, so a business shipment can never be booked as a counter
  // sale and skip its credit reservation.
  const draft = await ShipmentDraft.findById(shipmentDraftId).select("customerType branchId").lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  // Booking is the heaviest write on a draft, so it is held to the same branch
  // scope as editing one. Admin is unrestricted; operations books only for the
  // branches it is assigned to.
  if (!canAccessBranch(request, draft.branchId)) {
    return response.status(403).json({ success: false, message: "You do not have access to this branch." });
  }
  const isIndividual = draft.customerType === "INDIVIDUAL";

  const collection = counterCollectionSchema.safeParse(request.body ?? {});
  if (isIndividual && !collection.success) {
    return response.status(400).json({
      success: false,
      message: "Record how the customer paid before booking this shipment."
    });
  }

  const acceptedPricing = acceptedPricingSchema.safeParse(request.body ?? {});

  try {
    const result = await createLabelForShipmentDraft(shipmentDraftId, userId, {
      actor: "admin",
      paymentSource: isIndividual ? "ADMIN_DIRECT" : "BUSINESS_ACCOUNT",
      acceptedPricingHash: acceptedPricing.success ? acceptedPricing.data.acceptedPricingHash : undefined,
      skipDpdLabel: acceptedPricing.success ? acceptedPricing.data.skipDpdLabel : undefined
    });

    if (isIndividual && collection.success) {
      // Written after the booking succeeds: a failed booking must not leave a
      // record of money the branch never took.
      await recordCounterCollection({
        shipmentDraftId: new mongoose.Types.ObjectId(shipmentDraftId),
        branchId: draft.branchId,
        amountMinor: result.shipmentInvoice.totalAmountMinor,
        payment: collection.data,
        recordedBy: userId
      });
    }
    await ensureShipmentBookedEvent({
      shipmentDraftId: new mongoose.Types.ObjectId(shipmentDraftId),
      dpdShipmentId: result.dpdShipment._id as mongoose.Types.ObjectId,
      userId,
      eventAt: result.dpdShipment.createdAt
    });

    return response.status(result.reused ? 200 : 201).json({
      success: true,
      reused: result.reused,
      dpdShipment: serializeDpdShipment(result.dpdShipment),
      labels: result.labels.map(serializeLabel),
      bookingConfirmation: serializeShipmentBookingConfirmation(result.dpdShipment.bookingSnapshot),
      shipmentInvoice: {
        id: String(result.shipmentInvoice._id),
        invoiceNumber: result.shipmentInvoice.invoiceNumber,
        currency: result.shipmentInvoice.currency,
        totalAmountMinor: result.shipmentInvoice.totalAmountMinor,
        revision: result.shipmentInvoice.revision,
        status: result.shipmentInvoice.status
      }
    });
  } catch (error) {
    if (error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    // The price moved between the estimate the booker accepted and this booking.
    // Nothing has been reserved or sent to the carrier; the updated breakdown goes
    // back so the panel can show what changed and ask for an explicit re-accept.
    if (error instanceof ShipmentPriceChangedError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
        pricing: error.currentPricing,
        pricingHash: buildPricingHash(error.currentPricing)
      });
    }

    // Nothing was booked, so the form can offer to continue without the
    // carrier label. Staff see the carrier's own wording; the client route
    // deliberately does not.
    if (error instanceof DpdLabelUnavailableError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.carrierErrors.length ? { carrierErrors: error.carrierErrors } : {})
      });
    }

    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...error.details
      });
    }

    return response.status(502).json({
      success: false,
      message: "The shipment could not be created."
    });
  }
}

export async function reconcileDpdShipmentDocuments(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  try {
    const result = await reconcileShipmentDocuments(String(request.params.id ?? ""), userId);
    return response.status(200).json({
      success: true,
      message: result.reused ? "Shipment documents are already complete." : "Shipment documents reconciled successfully.",
      dpdShipment: serializeDpdShipment(result.dpdShipment),
      labels: result.labels.map(serializeLabel),
      bookingConfirmation: serializeShipmentBookingConfirmation(result.dpdShipment.bookingSnapshot),
      shipmentInvoice: {
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
    return response.status(500).json({ success: false, message: "Shipment documents could not be reconciled." });
  }
}

export async function generateExistingDpdLabel(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment booking not found." });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).select("shipmentDraftId").lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment booking not found." });
  const draft = await ShipmentDraft.findById(shipment.shipmentDraftId).select("branchId").lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found." });
  if (!canAccessBranch(request, draft.branchId)) {
    return response.status(403).json({ success: false, message: "You do not have access to this branch." });
  }

  try {
    const result = await generateDpdLabelForExistingShipment(dpdShipmentId, userId);
    return response.status(result.reused ? 200 : 201).json({
      success: true,
      reused: result.reused,
      message: result.reused
        ? "The existing DPD label is already available."
        : "The DPD carrier label was generated for the existing shipment.",
      dpdShipment: serializeDpdShipment(result.dpdShipment),
      labels: result.labels.map(serializeLabel)
    });
  } catch (error) {
    if (error instanceof DpdLabelUnavailableError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.carrierErrors.length ? { carrierErrors: error.carrierErrors } : {})
      });
    }
    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({ success: false, message: error.message, ...error.details });
    }
    return response.status(502).json({
      success: false,
      message: "The DPD carrier label could not be generated. Check the shipment audit history before retrying."
    });
  }
}

export async function resetDevelopmentShipmentBooking(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  try {
    await resetBookingForDevelopment(String(request.params.draftId ?? ""), userId);
    return response.status(200).json({
      success: true,
      message: "The simulated booking attempt was released. This draft can be booked again."
    });
  } catch (error) {
    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({ success: false, message: error.message, ...error.details });
    }
    return response.status(500).json({ success: false, message: "The simulated booking attempt could not be reset." });
  }
}

export async function createDpdLabelAccessUrl(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  const labelId = typeof request.query.labelId === "string" ? request.query.labelId : "";
  const access = await buildStoredLabelAccess({
    request,
    dpdShipmentId,
    labelId,
    userId,
    disposition: request.query.disposition === "attachment" ? "attachment" : "inline"
  });
  if (!access) return response.status(404).json({ success: false, message: "Label not found" });

  return response.status(200).json({
    success: true,
    ...access
  });
}

export async function listDpdShipmentAudit(request: Request, response: Response): Promise<Response> {
  const shipmentDraftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!mongoose.Types.ObjectId.isValid(shipmentDraftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const draftObjectId = new mongoose.Types.ObjectId(shipmentDraftId);
  const draft = await ShipmentDraft.findById(draftObjectId).lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const dpdShipment = await DpdShipment.findOne({ shipmentDraftId: draftObjectId }).lean().exec();
  const labels = dpdShipment
    ? await LabelDocument.find({ dpdShipmentId: dpdShipment._id }).lean().exec()
    : [];

  const entityFilters: Array<{ entityType: AuditEntityType; entityId: mongoose.Types.ObjectId }> = [
    { entityType: "SHIPMENT_DRAFT", entityId: draft._id }
  ];

  if (dpdShipment) {
    entityFilters.push({ entityType: "DPD_SHIPMENT", entityId: dpdShipment._id });
  }

  for (const label of labels) {
    entityFilters.push({ entityType: "LABEL_DOCUMENT", entityId: label._id });
  }

  const auditLogs = await AuditLog.find({ $or: entityFilters })
    .sort({ performedAt: -1 })
    .limit(100)
    .lean()
    .exec();

  return response.status(200).json({
    success: true,
    auditLogs: auditLogs.map(serializeAuditLog)
  });
}

export async function listDpdShipments(request: Request, response: Response): Promise<Response> {
  const limitValue = typeof request.query.limit === "string" ? Number(request.query.limit) : 25;
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 25;
  const status = typeof request.query.status === "string" ? request.query.status : "";
  const trackingNumber = typeof request.query.trackingNumber === "string" ? request.query.trackingNumber.trim() : "";
  const summaryOnly = request.query.summary === "1";
  const filters: Record<string, unknown> = {};

  if (status) filters.status = status;
  if (trackingNumber) {
    const exact = new RegExp(`^${trackingNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const trackingFilters: Record<string, unknown>[] = [
      { dpdShipmentId: exact },
      { swiftlineTrackingNumber: exact },
      { parcelNumbers: exact }
    ];
    const matchingLabelShipmentIds = await LabelDocument.find({
      parcelNumber: exact,
      voidedAt: null
    }).distinct("dpdShipmentId").exec();
    if (matchingLabelShipmentIds.length) trackingFilters.push({ _id: { $in: matchingLabelShipmentIds } });
    filters.$or = trackingFilters;
  }

  const shipmentQuery = DpdShipment.find(filters).sort({ createdAt: -1 }).limit(limit);
  if (summaryOnly) {
    shipmentQuery.select([
      "shipmentDraftId",
      "idempotencyKey",
      "dpdShipmentId",
      "dpdTransactionId",
      "forwardingNumber",
      "entryNumber",
      "swiftlineTrackingNumber",
      "parcelNumbers",
      "serviceCode",
      "status",
      "snapshotRevision",
      "bookingSnapshot.consignee",
      "currentShipmentSnapshot.consignee",
      "createdAt",
      "updatedAt"
    ].join(" "));
  }
  const shipments = await shipmentQuery.lean().exec();
  const shipmentIds = shipments.map((shipment) => shipment._id);
  const draftIds = shipments.map((shipment) => shipment.shipmentDraftId);

  if (summaryOnly) {
    const [drafts, shipmentInvoices, latestEvents] = await Promise.all([
      ShipmentDraft.find({ _id: { $in: draftIds } })
        .select("branchId consigneeEnteredAddress status addressValidationStatus")
        .lean()
        .exec(),
      ShipmentInvoice.find({ shipmentDraftId: { $in: draftIds } })
        .select("shipmentDraftId invoiceNumber currency totalAmountMinor status revision")
        .lean()
        .exec(),
      ShipmentEvent.aggregate<{
        _id: mongoose.Types.ObjectId;
        event: {
          _id: mongoose.Types.ObjectId;
          shipmentDraftId: mongoose.Types.ObjectId;
          dpdShipmentId?: mongoose.Types.ObjectId;
          status: string;
          holdReason?: string | null;
          note?: string;
          location?: string;
          customerVisible: boolean;
          eventAt: Date;
          createdBy: mongoose.Types.ObjectId;
          source?: string;
          sourceReference?: string;
          gatewayCode?: string;
          gatewayName?: string;
          partnerName?: string;
          partnerCode?: string;
          statusLabel?: string;
        };
      }>([
        { $match: { shipmentDraftId: { $in: draftIds } } },
        { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
        { $group: { _id: "$shipmentDraftId", event: { $first: "$$ROOT" } } },
        {
          $project: {
            "event._id": 1,
            "event.shipmentDraftId": 1,
            "event.dpdShipmentId": 1,
            "event.status": 1,
            "event.holdReason": 1,
            "event.note": 1,
            "event.location": 1,
            "event.customerVisible": 1,
            "event.eventAt": 1,
            "event.createdBy": 1,
            "event.source": 1,
            "event.sourceReference": 1,
            "event.gatewayCode": 1,
            "event.gatewayName": 1,
            "event.partnerName": 1,
            "event.partnerCode": 1,
            "event.statusLabel": 1
          }
        }
      ]).exec()
    ]);
    const branches = await Branch.find({ _id: { $in: drafts.map((draft) => draft.branchId) } })
      .select("name code address.city")
      .lean()
      .exec();
    const draftsById = new Map(drafts.map((draft) => [String(draft._id), draft]));
    const branchesById = new Map(branches.map((branch) => [String(branch._id), branch]));
    const shipmentInvoicesByDraftId = new Map(shipmentInvoices.map((invoice) => [String(invoice.shipmentDraftId), invoice]));
    const latestEventByDraftId = new Map(latestEvents.map((item) => [String(item._id), item.event]));

    return response.status(200).json({
      success: true,
      shipments: shipments.map((shipment) => {
        const draft = draftsById.get(String(shipment.shipmentDraftId));
        const branch = draft ? branchesById.get(String(draft.branchId)) : null;
        const shipmentInvoice = shipmentInvoicesByDraftId.get(String(shipment.shipmentDraftId));
        const currentEvent = latestEventByDraftId.get(String(shipment.shipmentDraftId));
        const snapshotValue = shipmentInvoice
          && (shipmentInvoice.revision ?? 1) <= (shipment.snapshotRevision || 1)
          ? shipment.currentShipmentSnapshot || shipment.bookingSnapshot
          : null;
        const consigneeFromSnapshot = (value: unknown) => {
          if (!value || typeof value !== "object" || !("consignee" in value)) return null;
          const consignee = value.consignee;
          return consignee && typeof consignee === "object"
            ? consignee as Record<string, unknown>
            : null;
        };
        const snapshotConsignee = snapshotValue === shipment.currentShipmentSnapshot
          ? consigneeFromSnapshot(shipment.currentShipmentSnapshot) ?? consigneeFromSnapshot(shipment.bookingSnapshot)
          : consigneeFromSnapshot(snapshotValue);
        const draftForSummary = draft && snapshotConsignee
          ? {
            ...draft,
            consigneeEnteredAddress: {
              ...draft.consigneeEnteredAddress,
              ...snapshotConsignee
            }
          }
          : draft;

        return {
          dpdShipment: serializeDpdShipment(shipment),
          bookingConfirmation: null,
          shipmentDraft: serializeShipmentDraftSummary(draftForSummary, null),
          branch: serializeBranchSummary(branch),
          shipmentInvoice: shipmentInvoice ? {
            invoiceNumber: shipmentInvoice.invoiceNumber,
            currency: shipmentInvoice.currency,
            totalAmountMinor: shipmentInvoice.totalAmountMinor,
            chargeableAmountMinor: shipmentInvoice.totalAmountMinor,
            status: shipmentInvoice.status,
            revision: shipmentInvoice.revision
          } : null,
          labels: [],
          currentEvent: currentEvent ? serializeShipmentEvent(currentEvent) : null,
          events: [],
          trackingJourney: null,
          deliveryEstimate: null,
          trackingSummary: null,
          trackingAttention: null,
          parcelActivities: [],
          parcelProgress: null,
          trackingPosition: null
        };
      })
    });
  }

  const [labels, drafts] = await Promise.all([
    LabelDocument.find({ dpdShipmentId: { $in: shipmentIds } }).lean().exec(),
    ShipmentDraft.find({ _id: { $in: draftIds } }).lean().exec()
  ]);
  const branchIds = drafts.map((draft) => draft.branchId);
  const [branches, shipmentInvoices] = await Promise.all([
    Branch.find({ _id: { $in: branchIds } }).lean().exec(),
    ShipmentInvoice.find({ shipmentDraftId: { $in: draftIds } })
      .select("shipmentDraftId invoiceNumber currency totalAmountMinor status revision")
      .lean()
      .exec()
  ]);
  const [eventsByDraftId, parcelActivitiesByDraftId, parcelProgressByDraftId] = await Promise.all([
    getShipmentEventsByDraftIds(draftIds as mongoose.Types.ObjectId[]),
    loadShipmentParcelActivitiesByDraftIds(draftIds as mongoose.Types.ObjectId[]),
    loadShipmentParcelProgressByDraftIds(draftIds as mongoose.Types.ObjectId[])
  ]);
  const labelsByShipment = new Map<string, typeof labels>();
  const draftsById = new Map(drafts.map((draft) => [String(draft._id), draft]));
  const branchesById = new Map(branches.map((branch) => [String(branch._id), branch]));
  const shipmentInvoicesByDraftId = new Map(shipmentInvoices.map((invoice) => [String(invoice.shipmentDraftId), invoice]));

  for (const label of labels) {
    const key = String(label.dpdShipmentId);
    labelsByShipment.set(key, [...(labelsByShipment.get(key) ?? []), label]);
  }

  /**
   * Delivery estimates, only when the caller asks for them.
   *
   * Each one costs a route and holiday lookup, and this endpoint also backs the
   * dashboard's bulk shipment feed where nothing reads an estimate. Staff
   * tracking searches a single tracking number, so it pays for one.
   */
  const estimatesByDraftId = new Map<string, Awaited<ReturnType<typeof buildDeliveryEstimate>>>();
  const journeysByDraftId = new Map<string, TrackingJourney>();
  const includeJourney = request.query.withEstimate === "1" || request.query.withJourney === "1";
  if (includeJourney) {
    await Promise.all(shipments.map(async (shipment) => {
      const draft = draftsById.get(String(shipment.shipmentDraftId));
      if (!draft) return;
      const branch = branchesById.get(String(draft.branchId));
      const events = eventsByDraftId.get(String(shipment.shipmentDraftId)) ?? [];
      const journey = await loadShipmentJourney({
        shipmentDraftId: shipment.shipmentDraftId,
        destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
        destinationCountryName: draft.consigneeEnteredAddress?.countryName ?? "",
        service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
        events,
        originHubFallback: branch?.address?.city ? `${branch.address.city} Hub` : ""
      });
      journeysByDraftId.set(String(shipment.shipmentDraftId), journey);
      if (request.query.withEstimate === "1") {
        estimatesByDraftId.set(
          String(shipment.shipmentDraftId),
          await buildDeliveryEstimate({ draft, events })
        );
      }
    }));
  }

  return response.status(200).json({
    success: true,
    shipments: shipments.map((shipment) => {
      const draft = draftsById.get(String(shipment.shipmentDraftId));
      const branch = draft ? branchesById.get(String(draft.branchId)) : null;
      const events = eventsByDraftId.get(String(shipment.shipmentDraftId)) ?? [];
      const currentEvent = getCurrentShipmentEvent(events);
      const journey = journeysByDraftId.get(String(shipment.shipmentDraftId));
      const shipmentInvoice = shipmentInvoicesByDraftId.get(String(shipment.shipmentDraftId));

      return {
        dpdShipment: serializeDpdShipment(shipment),
        bookingConfirmation: serializeShipmentBookingConfirmation(shipment.bookingSnapshot),
        shipmentDraft: serializeShipmentDraftSummary(
          draft,
          (shipmentInvoice?.revision ?? 1) <= (shipment.snapshotRevision || 1)
            ? shipment.currentShipmentSnapshot || shipment.bookingSnapshot
            : null
        ),
        branch: serializeBranchSummary(branch),
        shipmentInvoice: shipmentInvoice ? {
          invoiceNumber: shipmentInvoice.invoiceNumber,
          currency: shipmentInvoice.currency,
          totalAmountMinor: shipmentInvoice.totalAmountMinor,
          chargeableAmountMinor: shipmentInvoice.totalAmountMinor,
          status: shipmentInvoice.status,
          revision: shipmentInvoice.revision
        } : null,
        labels: (labelsByShipment.get(String(shipment._id)) ?? [])
          .filter((label) => label.labelVersion === (shipment.snapshotRevision || 1))
          .map(serializeLabel),
        currentEvent: currentEvent ? serializeShipmentEvent(currentEvent, journey) : null,
        events: normalizeVisibleTrackingHistory(events, journey)
          .map((event) => serializeShipmentEvent(event, journey)),
        trackingJourney: journey ?? null,
        // Staff tracking shows the same schedule, weights and required action
        // the client sees, so Operations and the customer never read two
        // different accounts of the same shipment.
        deliveryEstimate: estimatesByDraftId.get(String(shipment.shipmentDraftId)) ?? null,
        trackingSummary: draft
          ? buildTrackingSummary({ draft, dpdShipment: shipment, events })
          : null,
        trackingAttention: buildTrackingAttention(events),
        parcelActivities: parcelActivitiesByDraftId.get(String(shipment.shipmentDraftId)) ?? [],
        parcelProgress: parcelProgressByDraftId.get(String(shipment.shipmentDraftId)) ?? null,
        trackingPosition: draft && journey
          ? buildTrackingPosition({
            events,
            journey,
            destinationCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
            audience: "AUTHENTICATED"
          })
          : null
      };
    })
  });
}

export async function getDpdShipment(request: Request, response: Response): Promise<Response> {
  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found" });

  const [labels, events, draft, parcelActivities] = await Promise.all([
    LabelDocument.find({
      dpdShipmentId: shipment._id,
      labelVersion: shipment.snapshotRevision || 1
    }).lean().exec(),
    ShipmentEvent.find({ shipmentDraftId: shipment.shipmentDraftId })
      .sort({ eventAt: -1, createdAt: -1 })
      .lean()
      .exec(),
    ShipmentDraft.findById(shipment.shipmentDraftId).lean().exec(),
    loadShipmentParcelActivities(shipment.shipmentDraftId)
  ]);
  const originBranch = draft?.branchId
    ? await Branch.findById(draft.branchId).select("address.city").lean().exec()
    : null;
  const currentEvent = getCurrentShipmentEvent(events);
  const journey = draft
    ? await loadShipmentJourney({
      shipmentDraftId: shipment.shipmentDraftId,
      destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
      destinationCountryName: draft.consigneeEnteredAddress?.countryName ?? "",
      service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
      events,
      originHubFallback: originBranch?.address?.city ? `${originBranch.address.city} Hub` : ""
    })
    : undefined;

  return response.status(200).json({
    success: true,
    dpdShipment: serializeDpdShipment(shipment),
    labels: labels.map(serializeLabel),
    currentEvent: currentEvent ? serializeShipmentEvent(currentEvent, journey) : null,
    events: normalizeVisibleTrackingHistory(events, journey)
      .map((event) => serializeShipmentEvent(event, journey)),
    trackingJourney: journey ?? null,
    parcelActivities,
    trackingPosition: draft && journey
      ? buildTrackingPosition({
        events,
        journey,
        destinationCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
        audience: "AUTHENTICATED"
      })
      : null
  });
}

/**
 * Loads the complete staff shipment detail by the identifier used by the
 * shipments table. The table is draft-backed, so the detail page must not
 * rediscover its booking by taking a capped slice of the DPD list.
 */
export async function getAdminShipmentDetails(request: Request, response: Response): Promise<Response> {
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const shipmentDraftId = new mongoose.Types.ObjectId(draftId);
  const [shipment, draft] = await Promise.all([
    DpdShipment.findOne({ shipmentDraftId }).lean().exec(),
    ShipmentDraft.findById(shipmentDraftId).lean().exec()
  ]);
  if (!draft || !shipment) {
    return response.status(404).json({ success: false, message: "Booked shipment not found" });
  }
  if (!canAccessBranch(request, draft.branchId)) {
    return response.status(404).json({ success: false, message: "Booked shipment not found" });
  }

  const [labels, events, branch, shipmentInvoice, parcelActivities, parcelProgress, carrierTrackingReviews] = await Promise.all([
    LabelDocument.find({
      dpdShipmentId: shipment._id,
      labelVersion: shipment.snapshotRevision || 1
    }).lean().exec(),
    ShipmentEvent.find({ shipmentDraftId })
      .sort({ eventAt: -1, createdAt: -1 })
      .lean()
      .exec(),
    Branch.findById(draft.branchId).lean().exec(),
    ShipmentInvoice.findOne({ shipmentDraftId })
      .select("invoiceNumber currency totalAmountMinor status revision")
      .lean()
      .exec(),
    loadShipmentParcelActivities(shipmentDraftId),
    loadShipmentParcelProgress(shipmentDraftId),
    CarrierTrackingEvent.find({ shipmentDraftId, processingStatus: "REVIEW_REQUIRED" })
      .select("carrierAwbNumber eventState description location eventAt processingNote receivedAt")
      .sort({ eventAt: -1, receivedAt: -1 })
      .limit(50)
      .lean()
      .exec()
  ]);

  const journey = await loadShipmentJourney({
    shipmentDraftId,
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
    destinationCountryName: draft.consigneeEnteredAddress?.countryName ?? "",
    service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
    events,
    originHubFallback: branch?.address?.city ? `${branch.address.city} Hub` : ""
  });
  const currentEvent = getCurrentShipmentEvent(events);

  return response.status(200).json({
    success: true,
    shipment: {
      dpdShipment: serializeDpdShipment(shipment),
      bookingConfirmation: serializeShipmentBookingConfirmation(shipment.bookingSnapshot),
      shipmentDraft: serializeShipmentDraftSummary(
        draft,
        (shipmentInvoice?.revision ?? 1) <= (shipment.snapshotRevision || 1)
          ? shipment.currentShipmentSnapshot || shipment.bookingSnapshot
          : null
      ),
      branch: serializeBranchSummary(branch),
      shipmentInvoice: shipmentInvoice ? {
        invoiceNumber: shipmentInvoice.invoiceNumber,
        currency: shipmentInvoice.currency,
        totalAmountMinor: shipmentInvoice.totalAmountMinor,
        chargeableAmountMinor: shipmentInvoice.totalAmountMinor,
        status: shipmentInvoice.status,
        revision: shipmentInvoice.revision
      } : null,
      labels: labels.map(serializeLabel),
      currentEvent: currentEvent ? serializeShipmentEvent(currentEvent, journey) : null,
      events: normalizeVisibleTrackingHistory(events, journey)
        .map((event) => serializeShipmentEvent(event, journey)),
      trackingJourney: journey,
      deliveryEstimate: await buildDeliveryEstimate({ draft, events }),
      trackingSummary: buildTrackingSummary({ draft, dpdShipment: shipment, events }),
      trackingAttention: buildTrackingAttention(events),
      parcelActivities,
      parcelProgress,
      carrierTrackingReviews: carrierTrackingReviews.map((event) => ({
        id: String(event._id),
        carrierAwbNumber: event.carrierAwbNumber,
        eventState: event.eventState,
        description: event.description,
        location: event.location,
        eventAt: event.eventAt,
        processingNote: event.processingNote,
        receivedAt: event.receivedAt
      })),
      trackingPosition: buildTrackingPosition({
        events,
        journey,
        destinationCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
        audience: "AUTHENTICATED"
      })
    }
  });
}

export async function holdDpdShipment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const parsed = holdShipmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Hold reason and note are required.",
      errors: parsed.error.format()
    });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found" });

  const cancellation = await ShipmentCancellation.findOne({
    shipmentDraftId: shipment.shipmentDraftId,
    status: { $in: ["REQUESTED", "COMPLETED"] }
  }).select("status").lean().exec();
  if (cancellation) {
    return response.status(409).json({
      success: false,
      message: cancellation.status === "COMPLETED"
        ? "This shipment has been cancelled and cannot be placed on hold."
        : "Resolve the pending shipment cancellation before placing the shipment on hold."
    });
  }

  const latestEvent = await ShipmentEvent.findOne({ shipmentDraftId: shipment.shipmentDraftId })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean()
    .exec();
  if (latestEvent?.status === "ON_HOLD") {
    return response.status(409).json({ success: false, message: "Shipment is already on hold." });
  }

  const event = await ShipmentEvent.create({
    shipmentDraftId: shipment.shipmentDraftId,
    dpdShipmentId: shipment._id,
    status: "ON_HOLD",
    holdReason: parsed.data.reason,
    note: parsed.data.note,
    location: parsed.data.location,
    source: "MANUAL",
    customerVisible: true,
    createdBy: userId,
    eventAt: new Date()
  });

  await AuditLog.create({
    action: "SHIPMENT_HELD",
    entityType: "DPD_SHIPMENT",
    entityId: shipment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: shipment.shipmentDraftId,
      reason: parsed.data.reason,
      note: parsed.data.note
    }
  });

  return response.status(201).json({
    success: true,
    message: "Shipment placed on hold.",
    event: serializeShipmentEvent(event)
  });
}

export async function releaseDpdShipment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const parsed = releaseShipmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Release note is required.",
      errors: parsed.error.format()
    });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found" });

  const cancellation = await ShipmentCancellation.findOne({
    shipmentDraftId: shipment.shipmentDraftId,
    status: { $in: ["REQUESTED", "COMPLETED"] }
  }).select("status").lean().exec();
  if (cancellation) {
    return response.status(409).json({
      success: false,
      message: cancellation.status === "COMPLETED"
        ? "This shipment has been cancelled and cannot be released from hold."
        : "Resolve the pending shipment cancellation before releasing the shipment."
    });
  }

  const latestEvent = await ShipmentEvent.findOne({ shipmentDraftId: shipment.shipmentDraftId })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean()
    .exec();
  if (latestEvent?.status !== "ON_HOLD") {
    return response.status(409).json({ success: false, message: "Shipment is not currently on hold." });
  }

  const event = await ShipmentEvent.create({
    shipmentDraftId: shipment.shipmentDraftId,
    dpdShipmentId: shipment._id,
    status: "RELEASED_FROM_HOLD",
    note: parsed.data.note,
    location: parsed.data.location,
    customerVisible: true,
    createdBy: userId,
    eventAt: new Date()
  });

  await AuditLog.create({
    action: "SHIPMENT_RELEASED",
    entityType: "DPD_SHIPMENT",
    entityId: shipment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: shipment.shipmentDraftId,
      note: parsed.data.note
    }
  });

  return response.status(201).json({
    success: true,
    message: "Shipment released from hold.",
    event: serializeShipmentEvent(event)
  });
}

export async function updateDpdShipmentOperationalStatus(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const parsed = updateShipmentStatusSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment status is invalid.",
      errors: parsed.error.format()
    });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found" });

  const [draft, cancellation] = await Promise.all([
    ShipmentDraft.findById(shipment.shipmentDraftId)
      .select("consigneeEnteredAddress.countryCode")
      .lean()
      .exec(),
    ShipmentCancellation.findOne({
      shipmentDraftId: shipment.shipmentDraftId,
      status: { $in: ["REQUESTED", "COMPLETED"] }
    }).select("status").lean().exec()
  ]);
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const gateway = resolveTrackingGatewayCode({
    status: parsed.data.status,
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode,
    gatewayCode: parsed.data.gatewayCode
  });
  if (gateway.error) {
    return response.status(400).json({ success: false, message: gateway.error });
  }
  if (cancellation) {
    return response.status(409).json({
      success: false,
      message: cancellation.status === "COMPLETED"
        ? "This shipment has been cancelled and its progress cannot be updated."
        : "Resolve the pending shipment cancellation before updating shipment progress."
    });
  }

  const latestEvent = await ShipmentEvent.findOne({ shipmentDraftId: shipment.shipmentDraftId })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean()
    .exec();
  if (latestEvent?.status === "ON_HOLD") {
    return response.status(409).json({ success: false, message: "Release the shipment before updating its status." });
  }

  // A stated date is held to the same order the statuses themselves are: it can
  // correct when a scan happened, but not move the shipment backwards in time.
  const eventDateProblem = parsed.data.eventAt
    ? describeEventDateProblem({
      eventAt: parsed.data.eventAt,
      previousEventAt: latestEvent?.eventAt ?? null
    })
    : null;
  if (eventDateProblem) {
    return response.status(409).json({ success: false, message: eventDateProblem });
  }

  /**
   * Progress is recorded in order, so the timeline can never claim a shipment
   * reached a stage it has no record of passing through.
   *
   * The last gate standing between Operations and a status update. The shipment
   * charge deliberately is not one: final weight verification is an optional
   * correction Operations reaches for when the parcel does not weigh what was
   * declared, and a parcel sitting at the hub must never be held up by it.
   *
   * The recorded set is deliberately not filtered on `customerVisible`- an
   * internal scan still happened, and hiding an event from customers must not
   * also hide it from this check.
   */
  const [recordedStatuses, recordedMilestone] = await Promise.all([
    ShipmentEvent.distinct("status", { shipmentDraftId: shipment.shipmentDraftId }),
    ShipmentEvent.findOne({
      shipmentDraftId: shipment.shipmentDraftId,
      status: { $in: equivalentMilestoneStatuses(parsed.data.status) }
    }).sort({ eventAt: 1, createdAt: 1 }).select("eventAt").lean().exec()
  ]);
  if (recordedMilestone) {
    return response.status(409).json({
      success: false,
      code: "STATUS_ALREADY_RECORDED",
      message: describeAlreadyRecorded(parsed.data.status, recordedMilestone.eventAt)
    });
  }
  const missingPrerequisites = findMissingPrerequisites(parsed.data.status, recordedStatuses);
  if (missingPrerequisites.length) {
    return response.status(409).json({
      success: false,
      message: describeMissingPrerequisites(parsed.data.status, missingPrerequisites),
      missingStatuses: missingPrerequisites
    });
  }
  const recordedLaterMilestones = findRecordedLaterMilestones(parsed.data.status, recordedStatuses);
  if (recordedLaterMilestones.length) {
    return response.status(409).json({
      success: false,
      code: "STATUS_ORDER_CONFLICT",
      message: describeRecordedLaterMilestones(parsed.data.status, recordedLaterMilestones),
      laterStatuses: recordedLaterMilestones
    });
  }

  let event;
  try {
    event = await ShipmentEvent.create({
      shipmentDraftId: shipment.shipmentDraftId,
      dpdShipmentId: shipment._id,
      status: parsed.data.status,
      milestoneKey: shipmentMilestoneKey(parsed.data.status),
      note: resolveShipmentEventNote(parsed.data.note, parsed.data.status),
      location: parsed.data.location,
      source: "MANUAL",
      gatewayCode: gateway.gatewayCode,
      partnerName: parsed.data.partnerName,
      partnerCode: parsed.data.partnerCode,
      customerVisible: true,
      createdBy: userId,
      // What the timeline shows. Falls back to now, which is what every update
      // that does not state a date has always been stamped with.
      eventAt: parsed.data.eventAt ?? new Date()
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return response.status(409).json({
        success: false,
        code: "STATUS_ALREADY_RECORDED",
        message: describeAlreadyRecorded(parsed.data.status)
      });
    }
    throw error;
  }

  // Collecting the parcel settles its charge- see chargeFinalizingStatuses.
  // Final weight verification may still follow- it is an optional correction,
  // not a precondition- and if it does, it revises the invoice this stamp has
  // already made billable.
  if ((chargeFinalizingStatuses as readonly string[]).includes(parsed.data.status)) {
    await markShipmentChargeFinalized({
      shipmentDraftId: shipment.shipmentDraftId,
      finalizedAt: event.eventAt
    });
  }

  await AuditLog.create({
    action: "SHIPMENT_STATUS_UPDATED",
    entityType: "DPD_SHIPMENT",
    entityId: shipment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: shipment.shipmentDraftId,
      status: parsed.data.status,
      note: parsed.data.note,
      gatewayCode: gateway.gatewayCode,
      // Kept apart from performedAt above, which stays the real moment: together
      // they show a backdated update for what it is.
      eventAt: event.eventAt
    }
  });

  return response.status(201).json({
    success: true,
    message: "Shipment status updated.",
    event: serializeShipmentEvent(event)
  });
}

/**
 * Corrects structured gateway metadata on an existing arrival milestone.
 * The event itself is retained: its status, time, note and location are audit
 * history and must not be duplicated or rewritten just to fix an IATA code.
 */
export async function correctDpdShipmentGateway(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const parsed = correctShipmentGatewaySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Enter a valid three-letter gateway IATA code." });
  }

  const shipment = await DpdShipment.findById(dpdShipmentId).lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment not found" });

  const [draft, arrivalEvent] = await Promise.all([
    ShipmentDraft.findById(shipment.shipmentDraftId)
      .select("consigneeEnteredAddress.countryCode")
      .lean()
      .exec(),
    ShipmentEvent.findOne({
      shipmentDraftId: shipment.shipmentDraftId,
      status: "DESTINATION_ARRIVED"
    }).sort({ eventAt: -1, createdAt: -1 }).exec()
  ]);
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });
  if (!arrivalEvent) {
    return response.status(409).json({
      success: false,
      message: "Record Arrived at Destination Gateway before setting its IATA code."
    });
  }

  const gateway = resolveTrackingGatewayCode({
    status: "DESTINATION_ARRIVED",
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode,
    gatewayCode: parsed.data.gatewayCode
  });
  if (gateway.error) return response.status(400).json({ success: false, message: gateway.error });

  const previousGatewayCode = arrivalEvent.gatewayCode ?? "";
  if (previousGatewayCode === gateway.gatewayCode && !arrivalEvent.gatewayName) {
    return response.status(200).json({
      success: true,
      message: `Gateway IATA is already ${gateway.gatewayCode}.`,
      event: serializeShipmentEvent(arrivalEvent)
    });
  }

  arrivalEvent.gatewayCode = gateway.gatewayCode;
  // A name saved for the previous code must not survive a correction. Known
  // codes are presented through the central IATA map; unknown ones stay honest.
  arrivalEvent.gatewayName = "";
  await arrivalEvent.save();

  await AuditLog.create({
    action: "SHIPMENT_GATEWAY_CORRECTED",
    entityType: "DPD_SHIPMENT",
    entityId: shipment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: shipment.shipmentDraftId,
      shipmentEventId: arrivalEvent._id,
      previousGatewayCode,
      gatewayCode: gateway.gatewayCode
    }
  });

  return response.status(200).json({
    success: true,
    message: `Gateway IATA updated to ${gateway.gatewayCode}.`,
    event: serializeShipmentEvent(arrivalEvent)
  });
}

export async function bulkUpdateDpdShipmentOperationalStatus(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = bulkStatusUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment status is invalid.",
      errors: parsed.error.format()
    });
  }

  try {
    const result = await bulkRecordOperationalStatus({
      shipmentDraftIds: parsed.data.shipmentDraftIds,
      status: parsed.data.status,
      note: parsed.data.note,
      location: parsed.data.location,
      eventAt: parsed.data.eventAt,
      gatewayCode: parsed.data.gatewayCode,
      partnerName: parsed.data.partnerName,
      partnerCode: parsed.data.partnerCode,
      expectedStatuses: parsed.data.expectedStatuses,
      userId
    });

    const statusLabel = formatShipmentEventLabel(parsed.data.status);
    const message = result.updatedCount
      ? `${result.updatedCount} ${result.updatedCount === 1 ? "shipment was" : "shipments were"} updated to ${statusLabel}.`
      : `No shipments could be updated to ${statusLabel}.`;

    return response.status(200).json({ success: true, message, ...result });
  } catch (error) {
    // A refused selection is the operator's to fix, not a fault: it is reported
    // with the reason so the toast can say which stages were mixed.
    if (error instanceof BulkStatusSelectionError) {
      return response.status(409).json({ success: false, message: error.message });
    }

    return response.status(500).json({ success: false, message: "The bulk status update could not be completed." });
  }
}

export async function downloadDpdLabel(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const labelId = typeof request.query.labelId === "string" ? request.query.labelId : "";
  // Without an explicit id this falls back to the Swiftline label, which every
  // shipment has; a DPD label is fetched by passing its id.
  const label = await LabelDocument.findOne({
    dpdShipmentId: new mongoose.Types.ObjectId(dpdShipmentId),
    ...(mongoose.Types.ObjectId.isValid(labelId)
      ? { _id: new mongoose.Types.ObjectId(labelId) }
      : { labelType: "SWIFTLINE" })
  }).exec();
  if (!label) return response.status(404).json({ success: false, message: "Label not found" });

  return sendStoredLabel({
    label,
    userId,
    response,
    dpdShipmentId,
    accessMode: "authenticated",
    disposition: "inline"
  });
}

export async function downloadDpdLabelWithToken(request: Request, response: Response): Promise<Response | void> {
  const dpdShipmentId = typeof request.params.id === "string" ? request.params.id : "";
  const token = typeof request.query.token === "string" ? request.query.token : "";
  const tokenPayload = verifyLabelAccessToken(token);

  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId) || !tokenPayload || tokenPayload.dpdShipmentId !== dpdShipmentId) {
    return response.status(401).json({ success: false, message: "Label link has expired or is invalid." });
  }

  const label = await LabelDocument.findOne({
    _id: new mongoose.Types.ObjectId(tokenPayload.labelId),
    dpdShipmentId: new mongoose.Types.ObjectId(dpdShipmentId)
  }).exec();
  if (!label) return response.status(404).json({ success: false, message: "Label not found" });

  return sendStoredLabel({
    label,
    userId: tokenPayload.userId,
    response,
    dpdShipmentId,
    accessMode: "signed",
    disposition: request.query.disposition === "attachment" ? "attachment" : "inline"
  });
}
