import { BusinessAccount } from "../models/businessAccount.model.js";
import { listClientPods, loadClientPodsByIds } from "../services/pod/podCentre.service.js";
import { buildPodPdf } from "../services/pod/podPdf.service.js";
import { podExportColumns } from "../services/export/exportColumns.js";
import { EXPORT_ROW_CAP, describeFilters, exportFormat, sendTableExport } from "../services/export/tableExportHttp.js";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DeliveryPartner } from "../models/deliveryPartner.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { DriverProfile } from "../models/driverProfile.model.js";
import { DeliveryAssignment, DeliveryAttempt, PodDispute, PodRevision, deliveryAssignmentStatusValues, deliveryFailureReasonValues, podRecipientRelationshipValues } from "../models/pod.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, shipmentMilestoneKey } from "../models/shipmentEvent.model.js";
import { User } from "../models/user.model.js";
import { matchesDeclaredType } from "../services/storage/fileSignature.js";
import {
  StorageObjectNotFoundError,
  checksumOf,
  deleteObject,
  podEvidenceKey,
  putObject,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import { resolveEvidenceKey } from "../services/storage/legacyKeys.js";
import { emailValidationMessage, isValidBusinessContactEmail } from "../services/businessAccountRules.js";
import { notifyBusinessShipmentMembers, notifyOperationsStaff, notifyPortalUsers } from "../services/portalNotification.service.js";
import {
  describeMissingPrerequisites,
  findMissingPrerequisites,
  type ShipmentOperationalStatus
} from "../services/shipmentStatusSequence.service.js";

type Actor = { id: mongoose.Types.ObjectId; role: string; branches: string[] };
function actor(request: Request): Actor | null {
  const user = (request as Request & { user?: { _id?: unknown; role?: string; assignedBranches?: unknown[] } }).user;
  if (!user?._id || !mongoose.Types.ObjectId.isValid(String(user._id))) return null;
  return { id: new mongoose.Types.ObjectId(String(user._id)), role: String(user.role ?? ""), branches: (user.assignedBranches ?? []).map(String) };
}
function branchFilter(user: Actor) { return user.role === "admin" ? {} : { branchId: { $in: user.branches } }; }
function handle(error: unknown, response: Response, next: NextFunction) {
  if (error instanceof z.ZodError) return response.status(400).json({ success: false, message: error.issues[0]?.message ?? "Check the POD details." });
  if (error instanceof Error && error.message.startsWith("POD:")) { const [, code, message] = error.message.split(":"); return response.status(Number(code)).json({ success: false, message }); }
  if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
    const duplicate = error as { keyPattern?: Record<string, number> };
    const field = Object.keys(duplicate.keyPattern ?? {})[0] ?? "record";
    const message = field === "code"
      ? "A delivery partner already uses this code. Choose a different partner code."
      : field === "partnerReference"
        ? "This partner delivery reference is already in use."
        : "This record already exists. Refresh the page instead of submitting it again.";
    return response.status(409).json({ success: false, message });
  }
  return next(error);
}
function fail(status: number, message: string): never { throw new Error(`POD:${status}:${message}`); }

function statusesForDeliveryValidation(recorded: readonly string[]): string[] {
  const statuses = [...recorded];
  const legacyCustomsComplete = !statuses.some((value) => [
    "ORIGIN_HUB_PROCESSED",
    "READY_FOR_EXPORT",
    "ORIGIN_HUB_DISPATCHED",
    "IMPORT_CUSTOMS_CLEARED"
  ].includes(value)) && statuses.includes("IMPORT_CUSTOMS_CLEARANCE");
  if (legacyCustomsComplete) statuses.push("IMPORT_CUSTOMS_CLEARED");
  return statuses;
}

async function requireDeliveryMilestoneReady(
  shipmentDraftId: mongoose.Types.ObjectId,
  target: ShipmentOperationalStatus
) {
  const recorded = await ShipmentEvent.distinct("status", { shipmentDraftId });
  const missing = findMissingPrerequisites(target, statusesForDeliveryValidation(recorded));
  if (missing.length) fail(409, describeMissingPrerequisites(target, missing));
  return recorded;
}

const partnerSchema = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(2).max(24), countries: z.array(z.string().trim().length(2)).min(1), contactName: z.string().trim().max(120).default(""), email: z.union([z.literal(""), z.string().trim().email().refine(isValidBusinessContactEmail, emailValidationMessage)]), phone: z.string().trim().max(30).default(""), contractReference: z.string().trim().max(80).default(""), podSlaHours: z.coerce.number().int().min(1).max(720).default(48) });
const assignmentSchema = z.object({ shipmentDraftId: z.string(), deliveryPersonProfileId: z.string(), deliveryPartnerId: z.string().nullable().optional(), parcelNumbers: z.array(z.string().trim().min(1)).min(1), partnerReference: z.string().trim().min(2).max(120), expectedDeliveryAt: z.coerce.date().nullable().optional() });
const podSchema = z.object({ parcelNumbers: z.array(z.string().trim().min(1)).min(1), recipientName: z.string().trim().min(2).max(120), recipientRelationship: z.enum(podRecipientRelationshipValues), deliveredAt: z.coerce.date(), destinationTimeZone: z.string().trim().min(1).max(80), partnerReference: z.string().trim().min(2).max(120), notes: z.string().trim().max(1000).default(""), location: z.object({ latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).optional(), captureStatus: z.enum(["CAPTURED", "UNAVAILABLE", "DENIED"]) }).optional() });

async function profileForUser(userId: mongoose.Types.ObjectId) { return DriverProfile.findOne({ userId, status: "ACTIVE" }).lean().exec(); }
async function requireManager(request: Request, response: Response, next: NextFunction) {
  const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (["admin", "operations"].includes(user.role)) return next();
  if (user.role === "delivery" && await DriverProfile.exists({ userId: user.id, deliverySubrole: "SUPERVISOR", status: "ACTIVE" })) return next();
  return response.status(403).json({ success: false, message: "POD supervisor access is required." });
}
export { requireManager as requirePodManager };

async function canManage(user: Actor, assignment: { branchId: unknown }) { return user.role === "admin" || user.branches.includes(String(assignment.branchId)); }
async function canClientAccess(userId: mongoose.Types.ObjectId, assignment: { businessAccountId: unknown }) {
  return Boolean(await BusinessAccountMember.exists({ user: userId, businessAccount: assignment.businessAccountId as mongoose.Types.ObjectId, status: "active" }));
}
async function loadDetail(id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) fail(404, "Delivery assignment was not found.");
  const assignment = await DeliveryAssignment.findById(id).populate("deliveryPartnerId", "name code countries").populate({ path: "currentDeliveryPersonProfileId", populate: { path: "userId", select: "firstName lastName name phone email profileImage" } }).lean().exec();
  if (!assignment) fail(404, "Delivery assignment was not found.");
  const [shipment, booking, revisions, attempts, disputes] = await Promise.all([
    ShipmentDraft.findById(assignment.shipmentDraftId).select("consigneeEnteredAddress consigneeSelectedAddress consigneeValidatedAddress parcelList parcelCount serviceCode customerType").lean().exec(),
    DpdShipment.findById(assignment.dpdShipmentId).select("swiftlineTrackingNumber dpdShipmentId parcelNumbers serviceCode bookingProvider").lean().exec(),
    PodRevision.find({ assignmentId: assignment._id }).sort({ revisionNumber: -1 }).populate("submittedBy", "firstName lastName name").populate("reviewedBy", "firstName lastName name").lean().exec(),
    DeliveryAttempt.find({ assignmentId: assignment._id }).sort({ attemptedAt: -1 }).lean().exec(),
    PodDispute.find({ assignmentId: assignment._id }).sort({ createdAt: -1 }).populate("reportedBy", "firstName lastName name").lean().exec()
  ]);
  return { ...assignment, id: String(assignment._id), shipment, booking, revisions: revisions.map((revision) => ({ ...revision, id: String(revision._id), evidence: revision.evidence.map((item: any) => ({ id: String(item._id), type: item.type, originalName: item.originalName, mimeType: item.mimeType, size: item.size, capturedAt: item.capturedAt })) })), attempts, disputes };
}

export async function createDeliveryPartner(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const data = partnerSchema.parse(request.body); const partner = await DeliveryPartner.create({ ...data, code: data.code.toUpperCase(), countries: data.countries.map((value) => value.toUpperCase()), createdBy: user.id }); await AuditLog.create({ action: "DELIVERY_PARTNER_CREATED", entityType: "DELIVERY_PARTNER", entityId: partner._id, performedBy: user.id, performedAt: new Date(), metadata: {} }); return response.status(201).json({ success: true, message: "Delivery partner created.", partner }); } catch (error) { return handle(error, response, next); } }
export async function listDeliveryPartners(_request: Request, response: Response, next: NextFunction) { try { return response.json({ success: true, partners: await DeliveryPartner.find({ status: "ACTIVE" }).sort({ name: 1 }).lean().exec() }); } catch (error) { return next(error); } }

export async function listPodEligibleShipments(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assigned = await DeliveryAssignment.distinct("shipmentDraftId"); const drafts = await ShipmentDraft.find({ _id: { $nin: assigned }, bookingState: "BOOKED", deletedAt: null, customerType: "BUSINESS", ...branchFilter(user), "consigneeEnteredAddress.countryCode": { $ne: "IN" } }).select("businessAccountId branchId consigneeEnteredAddress parcelCount serviceCode createdAt").sort({ createdAt: -1 }).limit(100).lean().exec(); const bookings = await DpdShipment.find({ shipmentDraftId: { $in: drafts.map((item) => item._id) }, status: "LABEL_RECEIVED" }).select("shipmentDraftId swiftlineTrackingNumber dpdShipmentId parcelNumbers").lean().exec(); const byDraft = new Map(bookings.map((item) => [String(item.shipmentDraftId), item])); return response.json({ success: true, shipments: drafts.flatMap((draft) => { const booking = byDraft.get(String(draft._id)); return booking ? [{ id: String(draft._id), businessAccountId: String(draft.businessAccountId), branchId: String(draft.branchId), consignee: draft.consigneeEnteredAddress, parcelCount: draft.parcelCount, serviceCode: draft.serviceCode, trackingNumber: booking.swiftlineTrackingNumber || booking.dpdShipmentId, parcelNumbers: booking.parcelNumbers }] : []; }) }); } catch (error) { return next(error); } }

export async function listAvailableDeliveryPeople(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const users = await User.find({ role: "delivery", userStatus: "active", ...(user.role === "admin" ? {} : { assignedBranches: { $in: user.branches } }) }).select("firstName lastName name phone assignedBranches").lean().exec(); const profiles = await DriverProfile.find({ userId: { $in: users.map((item) => item._id) }, deliverySubrole: "DELIVERY_PERSON", status: "ACTIVE" }).populate("deliveryPartnerId", "name code").lean().exec(); const byId = new Map(users.map((item) => [String(item._id), item])); return response.json({ success: true, deliveryPeople: profiles.map((profile) => ({ ...profile, id: String(profile._id), user: byId.get(String(profile.userId)) })) }); } catch (error) { return next(error); } }

export async function createPodAssignment(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false });
    const data = assignmentSchema.parse(request.body);
    if (![data.shipmentDraftId, data.deliveryPersonProfileId].every(mongoose.Types.ObjectId.isValid)) {
      fail(400, "Select a valid shipment and delivery person.");
    }

    const [draft, booking, profile] = await Promise.all([
      ShipmentDraft.findById(data.shipmentDraftId).lean().exec(),
      DpdShipment.findOne({ shipmentDraftId: data.shipmentDraftId, status: "LABEL_RECEIVED" }).lean().exec(),
      DriverProfile.findOne({ _id: data.deliveryPersonProfileId, deliverySubrole: "DELIVERY_PERSON", status: "ACTIVE" }).lean().exec()
    ]);
    if (!draft || !booking || !profile) fail(400, "The shipment or delivery person is not eligible.");
    if (!await canManage(user, draft)) fail(403, "This shipment is outside your assigned branches.");

    const allowedParcels = new Set(booking.parcelNumbers);
    if (data.parcelNumbers.some((item) => !allowedParcels.has(item))) {
      fail(400, "Every selected parcel must belong to the same shipment.");
    }

    const assignment = await DeliveryAssignment.create({
      shipmentDraftId: draft._id,
      dpdShipmentId: booking._id,
      businessAccountId: draft.businessAccountId,
      branchId: draft.branchId,
      deliveryPartnerId: data.deliveryPartnerId || profile.deliveryPartnerId || null,
      currentDeliveryPersonProfileId: profile._id,
      parcelNumbers: [...new Set(data.parcelNumbers)],
      partnerReference: data.partnerReference,
      expectedDeliveryAt: data.expectedDeliveryAt ?? null,
      assignmentHistory: [{ deliveryPersonProfileId: profile._id, assignedBy: user.id, assignedAt: new Date() }],
      createdBy: user.id
    });

    await AuditLog.create({
      action: "POD_ASSIGNMENT_CREATED",
      entityType: "POD_ASSIGNMENT",
      entityId: assignment._id,
      performedBy: user.id,
      performedAt: new Date(),
      metadata: { parcelNumbers: assignment.parcelNumbers }
    });
    await notifyPortalUsers([profile.userId], {
      type: "DELIVERY_ASSIGNED",
      title: "New delivery assigned",
      message: `Delivery ${assignment.partnerReference} is ready in your portal.`,
      href: "/driver/deliveries",
      idempotencyKey: `delivery-assigned:${assignment._id}:${assignment.updatedAt.toISOString()}`
    });
    return response.status(201).json({
      success: true,
      message: "Delivery assigned.",
      assignment: await loadDetail(String(assignment._id))
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function listManagedPodAssignments(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const filter: Record<string, unknown> = branchFilter(user); if (typeof request.query.status === "string" && deliveryAssignmentStatusValues.includes(request.query.status as any)) filter.status = request.query.status; const rows = await DeliveryAssignment.find(filter).sort({ updatedAt: -1 }).populate("deliveryPartnerId", "name code").populate({ path: "currentDeliveryPersonProfileId", populate: { path: "userId", select: "firstName lastName name" } }).lean().exec(); return response.json({ success: true, assignments: rows.map((item) => ({ ...item, id: String(item._id) })) }); } catch (error) { return next(error); } }
export async function getManagedPodAssignment(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const row = await DeliveryAssignment.findById(request.params.assignmentId).lean().exec(); if (!row || !await canManage(user, row)) fail(404, "Delivery assignment was not found."); return response.json({ success: true, assignment: await loadDetail(String(row._id)) }); } catch (error) { return handle(error, response, next); } }
export async function reassignPodDelivery(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findById(request.params.assignmentId).exec(); if (!assignment || !await canManage(user, assignment)) fail(404, "Delivery assignment was not found."); if (["DELIVERED", "CANCELLED", "RETURNED"].includes(assignment.status)) fail(409, "Completed or closed delivery work cannot be reassigned."); const data = z.object({ deliveryPersonProfileId: z.string(), reason: z.string().trim().min(3).max(500) }).parse(request.body); const profile = await DriverProfile.findOne({ _id: data.deliveryPersonProfileId, deliverySubrole: "DELIVERY_PERSON", status: "ACTIVE" }).lean().exec(); if (!profile) fail(400, "Select an active delivery person."); const previous = assignment.assignmentHistory[assignment.assignmentHistory.length - 1] as any; if (previous) { previous.endedAt = new Date(); previous.reason = data.reason; } assignment.currentDeliveryPersonProfileId = profile._id; assignment.deliveryPartnerId = profile.deliveryPartnerId ?? assignment.deliveryPartnerId; assignment.status = "ASSIGNED"; assignment.acceptedAt = null; assignment.outForDeliveryAt = null; assignment.assignmentHistory.push({ deliveryPersonProfileId: profile._id, assignedBy: user.id, assignedAt: new Date(), endedAt: null, reason: "" }); await assignment.save(); await AuditLog.create({ action: "POD_ASSIGNMENT_UPDATED", entityType: "POD_ASSIGNMENT", entityId: assignment._id, performedBy: user.id, performedAt: new Date(), metadata: { reassignedTo: profile._id, reason: data.reason } }); await notifyPortalUsers([profile.userId], { type: "DELIVERY_ASSIGNED", title: "Delivery reassigned to you", message: `Delivery ${assignment.partnerReference} is ready in your portal.`, href: `/driver/deliveries/${assignment._id}`, idempotencyKey: `delivery-reassigned:${assignment._id}:${assignment.updatedAt.toISOString()}` }); return response.json({ success: true, message: "Delivery reassigned with its original history preserved.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }

export async function listMyDeliveries(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false });
    const profile = await profileForUser(user.id);
    if (!profile || profile.deliverySubrole !== "DELIVERY_PERSON") fail(403, "Delivery-person access is required.");

    const rows = await DeliveryAssignment.find({
      currentDeliveryPersonProfileId: profile._id,
      status: { $nin: ["CANCELLED"] }
    })
      .sort({ expectedDeliveryAt: 1, updatedAt: -1 })
      .populate("deliveryPartnerId", "name code")
      .lean()
      .exec();

    const revisions = await PodRevision.find({ assignmentId: { $in: rows.map((item) => item._id) } })
      .select("assignmentId status revisionNumber")
      .sort({ revisionNumber: -1 })
      .lean()
      .exec();
    const latestStatus = new Map<string, string>();
    for (const revision of revisions) {
      const assignmentId = String(revision.assignmentId);
      if (!latestStatus.has(assignmentId)) latestStatus.set(assignmentId, revision.status);
    }

    return response.json({
      success: true,
      assignments: rows.map((item) => ({
        ...item,
        id: String(item._id),
        latestPodStatus: latestStatus.get(String(item._id)) ?? null
      }))
    });
  } catch (error) {
    return handle(error, response, next);
  }
}
async function myAssignment(userId: mongoose.Types.ObjectId, assignmentId: string) { const profile = await profileForUser(userId); if (!profile || profile.deliverySubrole !== "DELIVERY_PERSON") fail(403, "Delivery-person access is required."); const row = await DeliveryAssignment.findOne({ _id: assignmentId, currentDeliveryPersonProfileId: profile._id }).lean().exec(); if (!row) fail(404, "Delivery assignment was not found."); return row; }
export async function getMyDelivery(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const row = await myAssignment(user.id, String(request.params.assignmentId)); return response.json({ success: true, assignment: await loadDetail(String(row._id)) }); } catch (error) { return handle(error, response, next); } }
export async function updateMyDeliveryStatus(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false });

    const row = await myAssignment(user.id, String(request.params.assignmentId));
    const status = z.enum(["ACCEPTED", "OUT_FOR_DELIVERY"]).parse(request.body?.status);
    const allowed: Record<string, string> = { ASSIGNED: "ACCEPTED", ACCEPTED: "OUT_FOR_DELIVERY" };
    if (allowed[row.status] !== status) fail(409, "Complete the delivery steps in order.");

    const trackingStatus = status === "ACCEPTED" ? "DELIVERY_PARTNER_TRANSFERRED" : "OUT_FOR_DELIVERY";
    // Partner handover is supporting activity rather than a required customer
    // rung. Both driver actions still require the shipment to have reached the
    // destination and be eligible for the next public milestone.
    await requireDeliveryMilestoneReady(row.shipmentDraftId, "OUT_FOR_DELIVERY");

    const [partner, now] = await Promise.all([
      row.deliveryPartnerId
        ? DeliveryPartner.findById(row.deliveryPartnerId).select("name code").lean().exec()
        : Promise.resolve(null),
      Promise.resolve(new Date())
    ]);
    await DeliveryAssignment.updateOne(
      { _id: row._id },
      { $set: { status, ...(status === "ACCEPTED" ? { acceptedAt: now } : { outForDeliveryAt: now }) } }
    ).exec();

    await ShipmentEvent.findOneAndUpdate(
      {
        shipmentDraftId: row.shipmentDraftId,
        $or: [
          { milestoneKey: shipmentMilestoneKey(trackingStatus) },
          { status: trackingStatus }
        ]
      },
      {
        $setOnInsert: {
          shipmentDraftId: row.shipmentDraftId,
          dpdShipmentId: row.dpdShipmentId,
          status: trackingStatus,
          milestoneKey: shipmentMilestoneKey(trackingStatus),
          note: status === "ACCEPTED"
            ? "Shipment transferred to the destination delivery network."
            : "Shipment is out for delivery.",
          customerVisible: true,
          source: "DELIVERY",
          sourceReference: `${row._id}:${status}`,
          partnerName: partner?.name ?? "",
          partnerCode: partner?.code ?? "",
          createdBy: user.id,
          eventAt: now
        }
      },
      { upsert: true }
    ).exec();

    await AuditLog.create({
      action: "POD_ASSIGNMENT_UPDATED",
      entityType: "POD_ASSIGNMENT",
      entityId: row._id,
      performedBy: user.id,
      performedAt: now,
      metadata: { status, trackingStatus }
    });
    return response.json({
      success: true,
      message: "Delivery status updated.",
      assignment: await loadDetail(String(row._id))
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

async function writableRevision(assignment: any, userId: mongoose.Types.ObjectId, source: "DELIVERY_PERSON" | "OPERATIONS_UPLOAD") {
  const latest = await PodRevision.findOne({ assignmentId: assignment._id }).sort({ revisionNumber: -1 }).exec();
  if (latest?.status === "DRAFT") return latest;

  // A rejected submission is immutable. The correction starts as a new draft
  // with the previous values/evidence copied forward so the delivery person can
  // change only what the reviewer requested without losing the audit trail.
  const correction = latest?.status === "ACTION_REQUIRED" ? latest : null;
  return PodRevision.create({
    assignmentId: assignment._id,
    shipmentDraftId: assignment.shipmentDraftId,
    revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    parcelNumbers: correction?.parcelNumbers ?? [],
    recipientName: correction?.recipientName ?? "",
    recipientRelationship: correction?.recipientRelationship ?? "CONSIGNEE",
    ...(correction?.deliveredAt ? { deliveredAt: correction.deliveredAt } : {}),
    destinationTimeZone: correction?.destinationTimeZone ?? "UTC",
    partnerReference: correction?.partnerReference ?? assignment.partnerReference,
    location: correction?.location ?? { captureStatus: "UNAVAILABLE" },
    notes: correction?.notes ?? "",
    signatureExceptionReason: correction?.signatureExceptionReason ?? "",
    signatureExceptionStatus: correction?.signatureExceptionStatus === "APPROVED" ? "APPROVED" : "NONE",
    evidence: correction?.evidence.map((item: any) => ({
      type: item.type,
      originalName: item.originalName,
      mimeType: item.mimeType,
      size: item.size,
      storageKey: item.storageKey,
      sha256: item.sha256,
      capturedBy: item.capturedBy,
      capturedAt: item.capturedAt
    })) ?? [],
    submissionSource: source,
    submittedBy: userId
  });
}
export async function uploadPodEvidence(request: Request, response: Response, next: NextFunction) {
  // Set once the object is written, so a later failure can unwind it. Every
  // rejection before that point is just a dropped buffer.
  let storedKey = "";
  try {
    const user = actor(request); const file = request.file;
    if (!user || !file) fail(400, "Choose an evidence file.");
    const assignmentId = String(request.params.assignmentId);
    let assignment = await DeliveryAssignment.findById(assignmentId).lean().exec();
    if (!assignment) fail(404, "Delivery assignment was not found.");
    const isManager = ["admin", "operations"].includes(user.role) || (user.role === "delivery" && (await profileForUser(user.id))?.deliverySubrole === "SUPERVISOR");
    if (isManager) { if (!await canManage(user, assignment)) fail(404, "Delivery assignment was not found."); } else assignment = await myAssignment(user.id, assignmentId);
    const type = z.enum(["PHOTO", "SIGNATURE", "PARTNER_DOCUMENT"]).parse(String(request.params.type).toUpperCase());
    if (type !== "PARTNER_DOCUMENT" && file.mimetype === "application/pdf") fail(400, "Photo and signature evidence must be an image.");
    if (!matchesDeclaredType(file.buffer, file.mimetype)) fail(400, "The uploaded evidence file is invalid.");

    storedKey = podEvidenceKey(assignmentId, file.originalname);
    await putObject({ key: storedKey, body: file.buffer, contentType: file.mimetype, originalName: file.originalname });

    const revision = await writableRevision(assignment, user.id, isManager ? "OPERATIONS_UPLOAD" : "DELIVERY_PERSON");
    revision.evidence.push({ type, originalName: file.originalname, mimeType: file.mimetype, size: file.size, storageKey: storedKey, sha256: checksumOf(file.buffer), capturedBy: user.id, capturedAt: new Date() } as any);
    await revision.save();
    await AuditLog.create({ action: "POD_EVIDENCE_CAPTURED", entityType: "POD_REVISION", entityId: revision._id, performedBy: user.id, performedAt: new Date(), metadata: { type } });
    return response.status(201).json({ success: true, message: `${type.replace(/_/g, " ")} saved.`, assignment: await loadDetail(assignmentId) });
  } catch (error) {
    if (storedKey) await deleteObject(storedKey).catch(() => undefined);
    return handle(error, response, next);
  }
}

export async function savePodDraft(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await myAssignment(user.id, String(request.params.assignmentId)); const data = podSchema.parse(request.body); if (data.parcelNumbers.some((item) => !assignment.parcelNumbers.includes(item))) fail(400, "Every parcel must belong to this shipment assignment."); const revision = await writableRevision(assignment, user.id, "DELIVERY_PERSON"); Object.assign(revision, data); await revision.save(); return response.json({ success: true, message: "POD draft saved.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }
export async function requestSignatureException(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await myAssignment(user.id, String(request.params.assignmentId)); const reason = z.string().trim().min(5).max(500).parse(request.body?.reason); const revision = await writableRevision(assignment, user.id, "DELIVERY_PERSON"); if (!revision.evidence.some((item: any) => item.type === "PHOTO")) fail(409, "Upload the required delivery photo before requesting a signature exception."); revision.signatureExceptionReason = reason; revision.signatureExceptionStatus = "PENDING"; await revision.save(); return response.json({ success: true, message: "Signature exception sent for supervisor approval.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }
export async function reviewSignatureException(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findById(request.params.assignmentId).lean().exec(); if (!assignment || !await canManage(user, assignment)) fail(404, "Delivery assignment was not found."); const approved = z.boolean().parse(request.body?.approved); const revision = await PodRevision.findOne({ assignmentId: assignment._id, signatureExceptionStatus: "PENDING" }).sort({ revisionNumber: -1 }).exec(); if (!revision) fail(404, "No signature exception is awaiting review."); revision.signatureExceptionStatus = approved ? "APPROVED" : "REJECTED"; revision.reviewedBy = user.id; revision.reviewedAt = new Date(); revision.reviewReason = z.string().trim().max(1000).parse(request.body?.reason ?? ""); await revision.save(); return response.json({ success: true, message: approved ? "Signature exception approved." : "Signature exception rejected.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }

export async function submitPod(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false });
    const assignment = await myAssignment(user.id, String(request.params.assignmentId));
    const correctionExists = Boolean(await PodRevision.exists({ assignmentId: assignment._id, status: "ACTION_REQUIRED" }));
    const normalStatus = ["OUT_FOR_DELIVERY", "DELIVERY_FAILED", "PARTIALLY_DELIVERED"].includes(assignment.status);
    if (!normalStatus && !(assignment.status === "DELIVERED" && correctionExists)) {
      fail(409, "Mark the delivery out for delivery before submitting POD.");
    }
    await requireDeliveryMilestoneReady(assignment.shipmentDraftId, "DELIVERED");

    const revision = await PodRevision.findOne({ assignmentId: assignment._id, status: "DRAFT" })
      .sort({ revisionNumber: -1 })
      .exec();
    if (!revision || !revision.recipientName || !revision.parcelNumbers.length || !revision.deliveredAt) {
      fail(409, "Complete and save the POD details first.");
    }
    if (!revision.evidence.some((item: any) => item.type === "PHOTO")) fail(409, "At least one delivery photo is required.");
    if (!revision.evidence.some((item: any) => item.type === "SIGNATURE") && revision.signatureExceptionStatus !== "APPROVED") {
      fail(409, "Recipient signature or an approved signature exception is required.");
    }

    revision.status = "SUBMITTED";
    revision.submittedAt = new Date();
    await revision.save();

    const delivered = [...new Set([...assignment.deliveredParcelNumbers, ...revision.parcelNumbers])];
    const complete = assignment.parcelNumbers.every((item) => delivered.includes(item));
    await DeliveryAssignment.updateOne({ _id: assignment._id }, {
      $set: {
        deliveredParcelNumbers: delivered,
        status: complete ? "DELIVERED" : "PARTIALLY_DELIVERED",
        ...(complete ? { deliveredAt: revision.deliveredAt } : {})
      }
    });
    if (complete) {
      const partner = assignment.deliveryPartnerId
        ? await DeliveryPartner.findById(assignment.deliveryPartnerId).select("name code").lean().exec()
        : null;
      await ShipmentEvent.findOneAndUpdate(
        {
          shipmentDraftId: assignment.shipmentDraftId,
          $or: [{ milestoneKey: "DELIVERED" }, { status: "DELIVERED" }]
        },
        {
          $setOnInsert: {
            shipmentDraftId: assignment.shipmentDraftId,
            dpdShipmentId: assignment.dpdShipmentId,
            status: "DELIVERED",
            milestoneKey: "DELIVERED",
            note: "Destination delivery completed; POD is under Swiftline review.",
            customerVisible: true,
            source: "DELIVERY",
            sourceReference: `${assignment._id}:DELIVERED`,
            partnerName: partner?.name ?? "",
            partnerCode: partner?.code ?? "",
            createdBy: user.id,
            eventAt: revision.deliveredAt
          }
        },
        { upsert: true }
      ).exec();
    }
    await AuditLog.create({ action: "POD_SUBMITTED", entityType: "POD_REVISION", entityId: revision._id, performedBy: user.id, performedAt: new Date(), metadata: { parcelNumbers: revision.parcelNumbers, correction: correctionExists } });
    await notifyBusinessShipmentMembers(assignment.businessAccountId, { type: "DELIVERY_COMPLETED", title: complete ? "Shipment delivered" : "Shipment partially delivered", message: "Proof of delivery has been submitted and is under review.", href: `/client/shipments/${assignment.shipmentDraftId}`, idempotencyKey: `pod-submitted-client:${revision._id}`, businessAccountId: assignment.businessAccountId });
    await notifyOperationsStaff({ type: "POD_SUBMITTED", title: "POD awaiting review", message: `POD ${assignment.partnerReference} was submitted.`, href: `/dashboard/pod?assignment=${assignment._id}`, idempotencyKey: `pod-submitted-ops:${revision._id}` });
    return response.json({ success: true, message: correctionExists ? "Corrected POD submitted for review." : "POD submitted for review.", assignment: await loadDetail(String(assignment._id)) });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function recordFailedDelivery(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await myAssignment(user.id, String(request.params.assignmentId)); const data = z.object({ reason: z.enum(deliveryFailureReasonValues), notes: z.string().trim().min(3).max(1000), nextActionAt: z.coerce.date() }).parse(request.body); const revision = await PodRevision.findOne({ assignmentId: assignment._id, status: "DRAFT" }).sort({ revisionNumber: -1 }).exec(); const photo = revision?.evidence.find((item: any) => item.type === "PHOTO") as any; if (!photo) fail(409, "Upload a failed-delivery photo first."); const attempt = await DeliveryAttempt.create({ assignmentId: assignment._id, outcome: "FAILED", ...data, photoEvidenceId: photo._id as mongoose.Types.ObjectId, recordedBy: user.id }); await DeliveryAssignment.updateOne({ _id: assignment._id }, { $set: { status: "DELIVERY_FAILED" } }); await AuditLog.create({ action: "POD_ATTEMPT_RECORDED", entityType: "POD_ASSIGNMENT", entityId: assignment._id, performedBy: user.id, performedAt: new Date(), metadata: { attemptId: attempt._id, reason: data.reason } }); return response.json({ success: true, message: "Failed delivery attempt recorded.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }

export async function reviewPod(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findById(request.params.assignmentId).lean().exec(); if (!assignment || !await canManage(user, assignment)) fail(404, "Delivery assignment was not found."); const data = z.object({ approved: z.boolean(), reason: z.string().trim().max(1000).default("") }).parse(request.body); if (!data.approved && data.reason.length < 3) fail(400, "Enter the reason the POD needs correction."); const revision = await PodRevision.findOne({ assignmentId: assignment._id, status: { $in: ["SUBMITTED", "UNDER_REVIEW"] } }).sort({ revisionNumber: -1 }).exec(); if (!revision) fail(404, "No POD is awaiting review."); if (String(revision.submittedBy) === String(user.id)) fail(409, "A different authorized user must review this POD."); revision.status = data.approved ? "VERIFIED" : "ACTION_REQUIRED"; revision.reviewedBy = user.id; revision.reviewedAt = new Date(); revision.reviewReason = data.reason; if (data.approved) { const retention = new Date(); retention.setUTCFullYear(retention.getUTCFullYear() + 8); revision.retentionUntil = retention; } await revision.save(); if (data.approved) await PodRevision.updateMany({ assignmentId: assignment._id, _id: { $ne: revision._id }, status: "VERIFIED" }, { $set: { status: "SUPERSEDED" } }); await AuditLog.create({ action: "POD_REVIEWED", entityType: "POD_REVISION", entityId: revision._id, performedBy: user.id, performedAt: new Date(), metadata: { approved: data.approved, reason: data.reason, retentionUntil: revision.retentionUntil } }); const deliveryProfile = await DriverProfile.findById(assignment.currentDeliveryPersonProfileId).lean().exec(); if (deliveryProfile) await notifyPortalUsers([deliveryProfile.userId], { type: data.approved ? "POD_VERIFIED" : "POD_ACTION_REQUIRED", title: data.approved ? "POD verified" : "POD correction required", message: data.approved ? "Your proof of delivery was verified." : data.reason, href: `/driver/deliveries/${assignment._id}`, idempotencyKey: `pod-review-person:${revision._id}:${data.approved}` }); if (data.approved) await notifyBusinessShipmentMembers(assignment.businessAccountId, { type: "POD_VERIFIED", title: "Verified POD available", message: "Verified proof of delivery is now available for your shipment.", href: `/client/shipments/${assignment.shipmentDraftId}`, idempotencyKey: `pod-verified-client:${revision._id}`, businessAccountId: assignment.businessAccountId }); return response.json({ success: true, message: data.approved ? "POD verified." : "POD returned for correction.", assignment: await loadDetail(String(assignment._id)) }); } catch (error) { return handle(error, response, next); } }

export async function submitManagedPod(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false });
    const assignment = await DeliveryAssignment.findById(request.params.assignmentId).lean().exec();
    if (!assignment || !await canManage(user, assignment)) fail(404, "Delivery assignment was not found.");
    const data = podSchema.extend({
      manualSourceNote: z.string().trim().min(3).max(500),
      originalReceivedAt: z.coerce.date()
    }).parse(request.body);
    if (data.parcelNumbers.some((item) => !assignment.parcelNumbers.includes(item))) {
      fail(400, "Every parcel must belong to this shipment assignment.");
    }
    await requireDeliveryMilestoneReady(assignment.shipmentDraftId, "DELIVERED");

    const revision = await writableRevision(assignment, user.id, "OPERATIONS_UPLOAD");
    Object.assign(revision, data);
    revision.submissionSource = "OPERATIONS_UPLOAD";
    revision.submittedBy = user.id;
    if (!revision.evidence.some((item: any) => item.type === "PHOTO")) fail(409, "Upload the required delivery photo.");
    if (!revision.evidence.some((item: any) => item.type === "SIGNATURE") && revision.signatureExceptionStatus !== "APPROVED") {
      fail(409, "Upload the recipient signature or approve a signature exception.");
    }
    revision.status = "SUBMITTED";
    revision.submittedAt = new Date();
    await revision.save();

    const delivered = [...new Set([...assignment.deliveredParcelNumbers, ...revision.parcelNumbers])];
    const complete = assignment.parcelNumbers.every((item) => delivered.includes(item));
    await DeliveryAssignment.updateOne({ _id: assignment._id }, {
      $set: {
        deliveredParcelNumbers: delivered,
        status: complete ? "DELIVERED" : "PARTIALLY_DELIVERED",
        ...(complete ? { deliveredAt: revision.deliveredAt } : {})
      }
    });
    if (complete) {
      const partner = assignment.deliveryPartnerId
        ? await DeliveryPartner.findById(assignment.deliveryPartnerId).select("name code").lean().exec()
        : null;
      await ShipmentEvent.findOneAndUpdate(
        { shipmentDraftId: assignment.shipmentDraftId, $or: [{ milestoneKey: "DELIVERED" }, { status: "DELIVERED" }] },
        { $setOnInsert: {
          shipmentDraftId: assignment.shipmentDraftId,
          dpdShipmentId: assignment.dpdShipmentId,
          status: "DELIVERED",
          milestoneKey: "DELIVERED",
          note: "Destination delivery completed; POD uploaded by Swiftline Operations and is under review.",
          customerVisible: true,
          source: "DELIVERY",
          sourceReference: `${assignment._id}:DELIVERED`,
          partnerName: partner?.name ?? "",
          partnerCode: partner?.code ?? "",
          createdBy: user.id,
          eventAt: revision.deliveredAt
        } },
        { upsert: true }
      ).exec();
    }
    await AuditLog.create({
      action: "POD_SUBMITTED",
      entityType: "POD_REVISION",
      entityId: revision._id,
      performedBy: user.id,
      performedAt: new Date(),
      metadata: { source: "OPERATIONS_UPLOAD", manualSourceNote: data.manualSourceNote }
    });
    await notifyBusinessShipmentMembers(assignment.businessAccountId, {
      type: "DELIVERY_COMPLETED",
      title: complete ? "Shipment delivered" : "Shipment partially delivered",
      message: "Proof of delivery is under Swiftline review.",
      href: `/client/shipments/${assignment.shipmentDraftId}`,
      idempotencyKey: `pod-manual-submitted-client:${revision._id}`,
      businessAccountId: assignment.businessAccountId
    });
    return response.json({
      success: true,
      message: "Partner POD recorded and submitted for independent review.",
      assignment: await loadDetail(String(assignment._id))
    });
  } catch (error) {
    return handle(error, response, next);
  }
}

export async function getClientPod(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findOne({ shipmentDraftId: request.params.shipmentId }).populate("deliveryPartnerId", "name code").lean().exec(); if (!assignment || !await canClientAccess(user.id, assignment)) fail(404, "POD was not found."); const [booking, revisions] = await Promise.all([DpdShipment.findById(assignment.dpdShipmentId).select("swiftlineTrackingNumber dpdShipmentId").lean().exec(), PodRevision.find({ assignmentId: assignment._id, status: "VERIFIED" }).sort({ revisionNumber: -1 }).lean().exec()]); return response.json({ success: true, pod: { id: String(assignment._id), shipmentDraftId: String(assignment.shipmentDraftId), status: assignment.status, partnerReference: assignment.partnerReference, parcelNumbers: assignment.parcelNumbers, deliveredParcelNumbers: assignment.deliveredParcelNumbers, deliveryPartnerId: assignment.deliveryPartnerId, booking, revisions: revisions.map((revision: any) => ({ id: String(revision._id), revisionNumber: revision.revisionNumber, status: revision.status, parcelNumbers: revision.parcelNumbers, recipientName: revision.recipientName, recipientRelationship: revision.recipientRelationship, deliveredAt: revision.deliveredAt, destinationTimeZone: revision.destinationTimeZone, partnerReference: revision.partnerReference, evidence: revision.evidence.map((item: any) => ({ id: String(item._id), type: item.type, originalName: item.originalName, mimeType: item.mimeType, size: item.size, capturedAt: item.capturedAt })) })) } }); } catch (error) { return handle(error, response, next); } }
export async function createPodDispute(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findOne({ shipmentDraftId: request.params.shipmentId }).lean().exec(); if (!assignment || !await canClientAccess(user.id, assignment)) fail(404, "POD was not found."); const revision = await PodRevision.findOne({ assignmentId: assignment._id, status: "VERIFIED" }).sort({ revisionNumber: -1 }).lean().exec(); if (!revision) fail(409, "A verified POD is required before reporting an issue."); const data = z.object({ category: z.enum(["WRONG_RECIPIENT", "MISSING_PARCEL", "DAMAGED_PARCEL", "INCORRECT_LOCATION", "SIGNATURE_CONCERN", "PHOTO_CONCERN", "NOT_RECEIVED", "OTHER"]), details: z.string().trim().min(5).max(2000) }).parse(request.body); const dispute = await PodDispute.create({ assignmentId: assignment._id, podRevisionId: revision._id, shipmentDraftId: assignment.shipmentDraftId, businessAccountId: assignment.businessAccountId, ...data, reportedBy: user.id }); await AuditLog.create({ action: "POD_DISPUTED", entityType: "POD_DISPUTE", entityId: dispute._id, performedBy: user.id, performedAt: new Date(), metadata: { category: data.category } }); await notifyOperationsStaff({ type: "POD_DISPUTED", title: "POD issue reported", message: data.details, href: `/dashboard/pod?assignment=${assignment._id}`, idempotencyKey: `pod-dispute:${dispute._id}` }); return response.status(201).json({ success: true, message: "POD issue reported to Swiftline.", dispute }); } catch (error) { return handle(error, response, next); } }

async function sendEvidence(response: Response, revision: any, evidenceId: string) {
  const evidence = revision.evidence.id(evidenceId);
  if (!evidence) fail(404, "POD evidence was not found.");
  // Resolved rather than read straight from `storageKey`. Evidence captured
  // before storage keys existed still holds an absolute path, and rows written
  // by an early version of the backfill hold a key under the wrong prefix-
  // both of which surfaced to the customer as a missing file.
  const key = await resolveEvidenceKey(evidence);
  if (!key) fail(404, "POD evidence file was not found.");
  try {
    return await streamObjectToResponse({ response, key, contentType: evidence.mimeType, filename: evidence.originalName, disposition: "inline" });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) fail(404, "POD evidence file was not found.");
    throw error;
  }
}
export async function viewPodEvidence(request: Request, response: Response, next: NextFunction) { try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); const assignment = await DeliveryAssignment.findById(request.params.assignmentId).lean().exec(); if (!assignment) fail(404, "POD evidence was not found."); const profile = user.role === "delivery" ? await profileForUser(user.id) : null; const isAssigned = profile?.deliverySubrole === "DELIVERY_PERSON" && String(assignment.currentDeliveryPersonProfileId) === String(profile._id); const isManager = ["admin", "operations"].includes(user.role) || profile?.deliverySubrole === "SUPERVISOR"; const isClient = user.role === "client" && await canClientAccess(user.id, assignment); if (!isAssigned && !(isManager && await canManage(user, assignment)) && !isClient) fail(404, "POD evidence was not found."); const revision = await PodRevision.findOne({ _id: request.params.revisionId, assignmentId: assignment._id }).exec(); if (!revision || (isClient && revision.status !== "VERIFIED")) fail(404, "POD evidence was not found."); return await sendEvidence(response, revision, String(request.params.evidenceId)); } catch (error) { return handle(error, response, next); } }

/**
 * POD Centre: every verified proof of delivery for the caller's accounts.
 *
 * Scope comes from the caller's active memberships, so an account id cannot be
 * supplied to widen it.
 */
async function clientPodScope(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount")
    .lean()
    .exec();
  return memberships.map((membership) => membership.businessAccount as mongoose.Types.ObjectId);
}

export async function listClientPodCentre(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const businessAccountIds = await clientPodScope(user.id);
    if (!businessAccountIds.length) return response.json({ success: true, pods: [] });

    const pods = await listClientPods({
      businessAccountIds,
      search: typeof request.query.search === "string" ? request.query.search.slice(0, 80) : "",
      dateFrom: typeof request.query.dateFrom === "string" ? request.query.dateFrom : "",
      dateTo: typeof request.query.dateTo === "string" ? request.query.dateTo : "",
      limit: exportFormat(request) ? EXPORT_ROW_CAP : 200
    });

    const format = exportFormat(request);
    if (format) {
      return sendTableExport(response, format, {
        title: "Proof of Delivery",
        columns: podExportColumns,
        rows: pods as never[],
        appliedFilters: describeFilters({
          Search: request.query.search,
          From: request.query.dateFrom,
          To: request.query.dateTo
        })
      });
    }
    // The storage keys are internal plumbing and never leave the server.
    return response.json({
      success: true,
      pods: pods.map(({ evidence, ...row }) => ({ ...row, evidenceCount: evidence.length }))
    });
  } catch (error) { return handle(error, response, next); }
}

/**
 * One merged PDF for the selected PODs, or for everything matching the filters
 * when nothing is selected- which is what "bulk download" means on a list the
 * customer has just filtered.
 */
export async function downloadClientPodPdf(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const businessAccountIds = await clientPodScope(user.id);
    if (!businessAccountIds.length) fail(404, "No proof of delivery was found.");

    const requested = String(request.query.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const pods = requested.length
      ? await loadClientPodsByIds({ businessAccountIds, assignmentIds: requested })
      : await listClientPods({
        businessAccountIds,
        search: typeof request.query.search === "string" ? request.query.search.slice(0, 80) : "",
        dateFrom: typeof request.query.dateFrom === "string" ? request.query.dateFrom : "",
        dateTo: typeof request.query.dateTo === "string" ? request.query.dateTo : "",
        limit: 100
      });

    if (!pods.length) fail(404, "No proof of delivery was found for that selection.");

    const account = await BusinessAccount.findById(businessAccountIds[0]).select("accountId company.companyName").lean().exec();
    const label = account ? `${account.company?.companyName ?? ""} (${account.accountId})` : "Swiftline";
    const pdf = await buildPodPdf(pods, label);

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="swiftline-pod-${new Date().toISOString().slice(0, 10)}.pdf"`);
    response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    return response.status(200).send(pdf);
  } catch (error) { return handle(error, response, next); }
}

/**
 * Emails the selected PODs to the account's own people.
 *
 * Deliberately not to a typed address. A POD names a recipient and carries a
 * signature, and letting anyone mail one anywhere turns this into a way to
 * leak delivery records; it goes to the account owners, admins and operations
 * members already entitled to open it in the portal.
 */
export async function emailClientPod(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const businessAccountIds = await clientPodScope(user.id);
    const requested = z.object({ assignmentIds: z.array(z.string()).min(1).max(50) }).parse(request.body);
    const pods = await loadClientPodsByIds({ businessAccountIds, assignmentIds: requested.assignmentIds });
    if (!pods.length) fail(404, "No proof of delivery was found for that selection.");

    const businessAccountId = businessAccountIds[0] as mongoose.Types.ObjectId;
    const recipients = await BusinessAccountMember.find({
      businessAccount: businessAccountId,
      status: "active",
      role: { $in: ["account_owner", "account_admin", "operations"] }
    }).select("user").lean().exec();

    await notifyPortalUsers(recipients.map((member) => member.user as mongoose.Types.ObjectId), {
      type: "POD_AVAILABLE",
      title: pods.length === 1 ? `Proof of delivery- ${pods[0]?.awb}` : `Proof of delivery- ${pods.length} shipments`,
      message: pods.map((pod) => `${pod.awb || pod.carrierReference} received by ${pod.recipientName || "recipient"}`).join("; "),
      href: "/client/pods",
      // Keyed on the selection so pressing the button twice does not send twice.
      idempotencyKey: `pod-email:${pods.map((pod) => pod.assignmentId).sort().join(",")}`,
      businessAccountId
    });

    return response.json({
      success: true,
      message: `Proof of delivery sent to ${recipients.length} account contact${recipients.length === 1 ? "" : "s"}.`
    });
  } catch (error) { return handle(error, response, next); }
}
