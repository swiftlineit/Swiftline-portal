import crypto from "crypto";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { DriverProfile } from "../models/driverProfile.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { PickupAttempt } from "../models/pickupAttempt.model.js";
import { PickupCounter } from "../models/pickupCounter.model.js";
import { PickupCourierAddress } from "../models/pickupCourierAddress.model.js";
import { PickupProof, PickupScan } from "../models/pickupEvidence.model.js";
import { PickupRequest, pickupArrivalWindowValues, reschedulablePickupStatuses, type IPickupRequest, type PickupArrivalWindow } from "../models/pickupRequest.model.js";
import { PickupRequestShipment } from "../models/pickupRequestShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, type ShipmentEventStatus } from "../models/shipmentEvent.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { User } from "../models/user.model.js";
import { sendPickupOtpEmail } from "./mail.service.js";
import { markShipmentChargeFinalized } from "./shipmentInvoice.service.js";
import { resolveOperationsScanParcelNumbers } from "./shipmentOperationsScan.service.js";
import { findRecordedLaterMilestones } from "./shipmentStatusSequence.service.js";
import { notifyAssignedPickupBranchStaff, notifyPortalUsers } from "./portalNotification.service.js";
import { deleteObject, pickupRequestDocumentKey, putObject } from "./storage/storage.service.js";
import { matchesDeclaredType } from "./storage/fileSignature.js";

const pickupBlockedStatuses: ShipmentEventStatus[] = [
  "SHIPMENT_CANCELLED", "PARCEL_COLLECTED", "WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED",
  "READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED", "EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED",
  "FLIGHT_DEPARTED", "DESTINATION_ARRIVED", "IMPORT_CUSTOMS_CLEARANCE", "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED", "DELIVERY_HUB_ARRIVED", "IN_TRANSIT", "OUT_FOR_DELIVERY",
  "DELIVERED", "RETURNED", "LOST", "DAMAGED"
];

export class PickupServiceError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "PickupServiceError";
  }
}

async function notifyPickupSafely(task: () => Promise<void>) {
  try { await task(); }
  catch (error) { console.error("Pickup notification failed.", { message: error instanceof Error ? error.message : "Unknown error" }); }
}

function asObjectId(value: string, label: string) {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new PickupServiceError(`${label} was not found.`, 404);
  return new mongoose.Types.ObjectId(value);
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

type PickupAddressInput = {
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  postcode: string;
  countryCode: string;
  countryName?: string;
  googlePlaceId?: string;
};

async function loadClientPickupAccess(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({
    user: userId,
    status: "active",
    role: { $in: shipmentBookingRoles }
  }).select("businessAccount assignedBranches").lean().exec();
  const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((membership) => membership.businessAccount) } })
    .select("assignedBranch")
    .lean()
    .exec();
  const defaultBranchByAccount = new Map(accounts.map((account) => [String(account._id), account.assignedBranch ? String(account.assignedBranch) : ""]));
  const branchesByAccount = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const explicitBranches = (membership.assignedBranches ?? []).map(String);
    const branchIds = explicitBranches.length ? explicitBranches : [defaultBranchByAccount.get(String(membership.businessAccount)) ?? ""];
    branchesByAccount.set(String(membership.businessAccount), new Set(branchIds.filter(Boolean)));
  }
  return (draft: { businessAccountId: unknown; branchId: unknown }) => branchesByAccount.get(String(draft.businessAccountId))?.has(String(draft.branchId)) ?? false;
}

export async function getClientPickupFormContext(userId: mongoose.Types.ObjectId) {
  const [memberships, user] = await Promise.all([
    BusinessAccountMember.find({ user: userId, status: "active", role: { $in: shipmentBookingRoles } })
      .select("businessAccount assignedBranches")
      .lean()
      .exec(),
    User.findById(userId).select("firstName lastName name email phone").lean().exec()
  ]);
  const accountIds = memberships.map((membership) => membership.businessAccount);
  const accounts = await BusinessAccount.find({
    _id: { $in: accountIds },
    status: "active",
    assignedBranch: { $ne: null }
  })
    .select("accountId company.companyName assignedBranch contact")
    .populate("assignedBranch", "name code")
    .lean()
    .exec();
  const membershipsByAccount = new Map<string, typeof memberships>();
  for (const membership of memberships) {
    const key = String(membership.businessAccount);
    const current = membershipsByAccount.get(key) ?? [];
    current.push(membership);
    membershipsByAccount.set(key, current);
  }
  const businesses = accounts.flatMap((account) => {
    const branch = account.assignedBranch as unknown as { _id: mongoose.Types.ObjectId; name?: string; code?: string } | null;
    const accountMemberships = membershipsByAccount.get(String(account._id)) ?? [];
    if (!branch || !accountMemberships.length) return [];
    const canRequestStandalone = accountMemberships.some((membership) => {
      const assignedBranches = (membership.assignedBranches ?? []).map(String);
      return assignedBranches.length === 0 || assignedBranches.includes(String(branch._id));
    });
    return [{
      businessAccountId: String(account._id),
      accountId: account.accountId,
      companyName: account.company?.companyName?.trim() || account.accountId,
      branchId: String(branch._id),
      branchName: canRequestStandalone ? branch.name ?? "Assigned branch" : "Branch from linked shipment",
      branchCode: canRequestStandalone ? branch.code ?? "" : "",
      canRequestStandalone,
      contact: {
        name: `${account.contact?.firstName ?? ""} ${account.contact?.lastName ?? ""}`.trim(),
        email: account.contact?.email ?? "",
        phone: `${account.contact?.countryCode ?? ""}${account.contact?.mobileNumber ?? ""}`
      }
    }];
  });
  const activeAccountIds = new Set(accounts.map((account) => String(account._id)));
  const allowedBranchIds = new Set<string>();
  for (const membership of memberships) {
    if (!activeAccountIds.has(String(membership.businessAccount))) continue;
    const account = accounts.find((item) => String(item._id) === String(membership.businessAccount));
    const branches = membership.assignedBranches?.length
      ? membership.assignedBranches
      : account?.assignedBranch ? [(account.assignedBranch as unknown as { _id: mongoose.Types.ObjectId })._id] : [];
    for (const branch of branches) allowedBranchIds.add(String(branch));
  }
  const courierAddresses = await PickupCourierAddress.find({ branchId: { $in: [...allowedBranchIds] } })
    .select("branchId companyName address contact")
    .sort({ companyName: 1 })
    .lean().exec();
  return {
    businesses,
    courierAddresses: courierAddresses.map((profile) => ({
      id: String(profile._id), branchId: String(profile.branchId), companyName: profile.companyName,
      address: profile.address, contact: profile.contact
    })),
    requester: user ? {
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      email: user.email ?? "",
      phone: user.phone ?? ""
    } : { name: "", email: "", phone: "" }
  };
}

export function pickupAddressFingerprint(address: Record<string, unknown>) {
  return ["countryCode", "postcode", "addressLine1", "addressLine2", "townOrCity", "county"]
    .map((field) => normalized(address[field]))
    .join("|");
}

export function pickupArrivalWindowBounds(window: PickupArrivalWindow) {
  switch (window) {
    case "MORNING": return { startMinute: 6 * 60, endMinute: 12 * 60 };
    case "AFTERNOON": return { startMinute: 12 * 60, endMinute: 17 * 60 };
    case "EVENING": return { startMinute: 17 * 60, endMinute: 22 * 60 };
    case "EXACT": return null;
  }
}

export function parsePickupDateInIndia(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PickupServiceError("Choose a valid Delhi arrival date.");
  const date = new Date(`${value}T00:00:00+05:30`);
  if (!Number.isFinite(date.getTime())) throw new PickupServiceError("Choose a valid Delhi arrival date.");
  const actual = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
  if (actual !== value) throw new PickupServiceError("Choose a valid Delhi arrival date.");
  return date;
}

export function parsePickupDateTimeInIndia(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new PickupServiceError("Choose a valid date and time in India.");
  }
  const parsed = new Date(`${date}T${time}:00+05:30`);
  if (!Number.isFinite(parsed.getTime())) throw new PickupServiceError("Choose a valid date and time in India.");
  const actualDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(parsed);
  const actualTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(parsed);
  if (actualDate !== date || actualTime !== time) {
    throw new PickupServiceError("Choose a valid date and time in India.");
  }
  return parsed;
}

function referenceId(value: unknown) {
  return String((value as { _id?: unknown } | null)?._id ?? value ?? "");
}

function safePickupDocuments(documents: IPickupRequest["documents"]) {
  return documents.map((document) => ({
    id: String(document._id),
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size,
    uploadedAt: document.uploadedAt
  }));
}

function arrivalWindowEnd(date: Date, window: PickupArrivalWindow) {
  const { endMinute } = pickupArrivalWindowBounds(window) ?? { endMinute: 0 };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
  const hour = String(Math.floor(endMinute / 60)).padStart(2, "0");
  const minute = String(endMinute % 60).padStart(2, "0");
  return parsePickupDateTimeInIndia(day, `${hour}:${minute}`);
}

function indiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { display: `${value("day")}${value("month")}${value("year")}`, key: `${value("year")}${value("month")}${value("day")}` };
}

async function allocatePickupNumber(branchId: mongoose.Types.ObjectId, session: mongoose.ClientSession) {
  const branch = await Branch.findById(branchId).select("labelCode code").session(session).lean().exec();
  if (!branch) throw new PickupServiceError("Pickup branch was not found.", 409);
  const stationCode = normalized(branch.labelCode || branch.code).slice(0, 4);
  if (!stationCode) throw new PickupServiceError("Configure the branch station code before creating pickups.", 409);
  const date = indiaDateParts();
  const counter = await PickupCounter.findOneAndUpdate(
    { stationCode, dateKey: date.key },
    { $inc: { sequence: 1 }, $setOnInsert: { stationCode, dateKey: date.key } },
    { upsert: true, returnDocument: "after", session }
  ).exec();
  return `SLP${stationCode}${date.display}${String(counter?.sequence ?? 1).padStart(3, "0")}`;
}

async function latestBlockingEvents(draftIds: mongoose.Types.ObjectId[]) {
  const events = await ShipmentEvent.find({ shipmentDraftId: { $in: draftIds } })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean()
    .exec();
  const byDraft = new Map<string, ShipmentEventStatus[]>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    byDraft.set(key, [...(byDraft.get(key) ?? []), event.status]);
  }
  return byDraft;
}

export async function listEligiblePickupShipments(userId: mongoose.Types.ObjectId) {
  const bookings = await DpdShipment.find({ status: "LABEL_RECEIVED" }).select("shipmentDraftId swiftlineTrackingNumber dpdShipmentId parcelNumbers snapshotRevision createdAt").lean().exec();
  if (!bookings.length) return [];
  const drafts = await ShipmentDraft.find({ _id: { $in: bookings.map((booking) => booking.shipmentDraftId) }, bookingState: "BOOKED" })
    .select("businessAccountId branchId consignorAddress parcelList parcelCount createdAt")
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  const [activeLinks, events, canAccess] = await Promise.all([
    PickupRequestShipment.find({ shipmentDraftId: { $in: drafts.map((draft) => draft._id) }, $or: [{ active: true }, { hubReceiptRecordedAt: { $ne: null } }] }).select("shipmentDraftId").lean().exec(),
    latestBlockingEvents(drafts.map((draft) => draft._id)),
    loadClientPickupAccess(userId)
  ]);
  const activeIds = new Set(activeLinks.map((link) => String(link.shipmentDraftId)));
  const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
  const result = [];
  for (const draft of drafts) {
    if (!canAccess(draft)) continue;
    const statuses = events.get(String(draft._id)) ?? [];
    if (activeIds.has(String(draft._id)) || statuses.some((status) => pickupBlockedStatuses.includes(status)) || statuses[0] === "ON_HOLD") continue;
    const booking = bookingByDraft.get(String(draft._id));
    const parcelNumbers = Array.isArray(booking?.parcelNumbers)
      ? booking.parcelNumbers.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const parcelList = Array.isArray(draft.parcelList) ? draft.parcelList : [];
    const pickupAddress = draft.consignorAddress && typeof draft.consignorAddress === "object"
      ? draft.consignorAddress as unknown as Record<string, unknown>
      : null;
    if (!booking || !parcelNumbers.length || !pickupAddress) continue;
    result.push({
      shipmentDraftId: String(draft._id),
      businessAccountId: String(draft.businessAccountId),
      branchId: String(draft.branchId),
      trackingNumber: booking.swiftlineTrackingNumber || booking.dpdShipmentId || String(booking._id),
      parcelNumbers,
      parcelCount: parcelNumbers.length,
      totalWeightKg: parcelList.reduce((sum, parcel) => sum + Number(parcel.weightKg || 0), 0),
      pickupAddress,
      addressFingerprint: pickupAddressFingerprint(pickupAddress),
      bookedAt: booking.createdAt
    });
  }
  return result;
}

type PickupDocumentUpload = { originalName: string; mimetype: string; size: number; buffer: Buffer };

export async function createClientPickup(input: {
  userId: mongoose.Types.ObjectId;
  businessAccountId: string;
  shipmentDraftIds: string[];
  dispatchAt: Date;
  expectedDelhiArrival: { date: Date; window: PickupArrivalWindow; exactAt?: Date | null };
  transportCompany: string;
  contact: { name: string; phone: string };
  pickupAddress: PickupAddressInput;
  totalBoxes?: number;
  totalWeightKg?: number;
  handlingRemarks?: string;
  documents?: PickupDocumentUpload[];
}) {
  const uniqueIds = [...new Set(input.shipmentDraftIds)];
  if (uniqueIds.length > 100) throw new PickupServiceError("Select no more than 100 booked shipments.");
  if (!mongoose.Types.ObjectId.isValid(input.businessAccountId)) throw new PickupServiceError("Select an active business account.");
  if (uniqueIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw new PickupServiceError("One or more selected shipments are invalid.");
  if (!Number.isFinite(input.dispatchAt.getTime()) || !Number.isFinite(input.expectedDelhiArrival.date.getTime()) ||
    (input.expectedDelhiArrival.exactAt && !Number.isFinite(input.expectedDelhiArrival.exactAt.getTime()))) {
    throw new PickupServiceError("Choose valid dispatch and Delhi arrival dates and times.");
  }
  if (input.dispatchAt <= new Date()) throw new PickupServiceError("Choose a dispatch date and time in the future.");
  if (!input.transportCompany.trim()) throw new PickupServiceError("Choose or enter a transport or courier company.");
  if (!pickupArrivalWindowValues.includes(input.expectedDelhiArrival.window)) throw new PickupServiceError("Choose an expected Delhi arrival window.");
  if (input.expectedDelhiArrival.window === "EXACT" && !input.expectedDelhiArrival.exactAt) throw new PickupServiceError("Choose the exact Delhi arrival time.");
  if (input.expectedDelhiArrival.window !== "EXACT" && input.expectedDelhiArrival.exactAt) throw new PickupServiceError("An exact time is only used with the exact arrival option.");
  const arrivalLatest = input.expectedDelhiArrival.window === "EXACT"
    ? input.expectedDelhiArrival.exactAt!
    : arrivalWindowEnd(input.expectedDelhiArrival.date, input.expectedDelhiArrival.window);
  if (arrivalLatest <= input.dispatchAt) throw new PickupServiceError("Expected Delhi arrival must be after dispatch.");
  if (input.documents && (input.documents.length > 5 || input.documents.some((file) =>
    !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ||
    file.size > 8 * 1024 * 1024 || !matchesDeclaredType(file.buffer, file.mimetype)
  ))) throw new PickupServiceError("Documents must be valid PDF, JPG, PNG, or WebP files, no larger than 8 MB each.");

  const context = await getClientPickupFormContext(input.userId);
  const verificationEmail = context.requester.email.trim().toLowerCase();
  if (!verificationEmail) {
    throw new PickupServiceError("Your account needs an email address for pickup verification.", 409);
  }
  const business = context.businesses.find((item) => item.businessAccountId === input.businessAccountId);
  if (!business) throw new PickupServiceError("The selected business account is not available to your login.", 403);
  const ids = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0 && !business.canRequestStandalone) {
    throw new PickupServiceError("Your account access does not include the business account's assigned branch. Link an eligible booked shipment to request pickup.", 403);
  }
  let drafts: Array<InstanceType<typeof ShipmentDraft>> = [];
  let bookings: Array<InstanceType<typeof DpdShipment>> = [];
  if (ids.length) {
    drafts = await ShipmentDraft.find({ _id: { $in: ids }, bookingState: "BOOKED" }).exec();
    if (drafts.length !== ids.length) throw new PickupServiceError("Every selected shipment must be fully booked before pickup can be requested.", 409);
    const canAccess = await loadClientPickupAccess(input.userId);
    if (drafts.some((draft) => !canAccess(draft) || String(draft.businessAccountId) !== input.businessAccountId)) {
      throw new PickupServiceError("One or more selected shipments are not available for this business account.", 403);
    }
    const branchIds = new Set(drafts.map((draft) => String(draft.branchId)));
    if (branchIds.size !== 1) throw new PickupServiceError("A pickup request can contain shipments from one branch only.");
    const branch = await Branch.findById(drafts[0]!.branchId).select("name code").lean().exec();
    if (!branch) throw new PickupServiceError("The pickup branch was not found.", 409);
    business.branchId = String(drafts[0]!.branchId);
    business.branchName = branch.name ?? business.branchName;
    business.branchCode = branch.code ?? business.branchCode;

    bookings = await DpdShipment.find({ shipmentDraftId: { $in: ids }, status: "LABEL_RECEIVED" }).exec();
    if (bookings.length !== ids.length || bookings.some((booking) => !booking.parcelNumbers.length)) {
      throw new PickupServiceError("Every selected shipment needs current parcel labels before pickup can be requested.", 409);
    }
    const events = await latestBlockingEvents(ids);
    if (ids.some((id) => {
      const statuses = events.get(String(id)) ?? [];
      return statuses.some((status) => pickupBlockedStatuses.includes(status)) || statuses[0] === "ON_HOLD";
    })) throw new PickupServiceError("A selected shipment is cancelled, on hold, or has already entered operations.", 409);
  }

  const shipmentCount = drafts.length;
  const parcelCount = bookings.reduce((sum, booking) => sum + booking.parcelNumbers.length, 0);
  const totalBoxes = ids.length ? parcelCount : Number(input.totalBoxes ?? 0);
  const totalWeightKg = ids.length
    ? drafts.reduce((sum, draft) => sum + draft.parcelList.reduce((parcelSum, parcel) => parcelSum + Number(parcel.weightKg || 0), 0), 0)
    : Number(input.totalWeightKg ?? 0);
  if (!Number.isInteger(totalBoxes) || totalBoxes < 1 || totalBoxes > 10000) throw new PickupServiceError("Enter a valid total number of boxes.");
  if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0 || totalWeightKg > 100000) throw new PickupServiceError("Enter a valid total gross weight in kilograms.");

  const pickupId = new mongoose.Types.ObjectId();
  const storedKeys: string[] = [];
  try {
    const documents: IPickupRequest["documents"] = [];
    for (const file of input.documents ?? []) {
      const storageKey = pickupRequestDocumentKey(String(pickupId), file.originalName);
      await putObject({ key: storageKey, body: file.buffer, contentType: file.mimetype, originalName: file.originalName });
      storedKeys.push(storageKey);
      documents.push({
        _id: new mongoose.Types.ObjectId(),
        originalName: file.originalName.slice(0, 200), storageKey, mimeType: file.mimetype, size: file.size,
        uploadedAt: new Date(), uploadedBy: input.userId
      });
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (ids.length && await PickupRequestShipment.exists({ shipmentDraftId: { $in: ids }, $or: [{ active: true }, { hubReceiptRecordedAt: { $ne: null } }] }).session(session)) {
          throw new PickupServiceError("A selected shipment already has a pickup or a recorded hub receipt. Ask your branch to review any parcels still outstanding.", 409);
        }
        const branchId = new mongoose.Types.ObjectId(business.branchId);
        const requestNumber = await allocatePickupNumber(branchId, session);
        const dispatchWindow = { startAt: input.dispatchAt, endAt: new Date(input.dispatchAt.getTime() + 2 * 60 * 60 * 1000), timezone: "Asia/Kolkata" };
        const pickup = new PickupRequest({
          _id: pickupId,
          requestNumber,
          businessAccountId: new mongoose.Types.ObjectId(input.businessAccountId),
          businessAccountName: business.companyName,
          branchId,
          requestedBy: input.userId,
          source: "CLIENT_PORTAL",
          status: "REQUESTED",
          addressFingerprint: pickupAddressFingerprint(input.pickupAddress),
          pickupAddress: input.pickupAddress,
          pickupContact: { ...input.contact, email: verificationEmail },
          requestedWindow: dispatchWindow,
          dispatchAt: input.dispatchAt,
          expectedDelhiArrival: { ...input.expectedDelhiArrival, timezone: "Asia/Kolkata" },
          transportCompany: input.transportCompany.trim(),
          handlingRemarks: input.handlingRemarks?.trim() ?? "",
          documents,
          instructions: input.handlingRemarks?.trim() ?? "",
          shipmentCount,
          totalBoxes,
          parcelCount,
          totalWeightKg
        });
        await pickup.save({ session });
        if (drafts.length) {
          const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
          await PickupRequestShipment.insertMany(drafts.map((draft) => {
            const booking = bookingByDraft.get(String(draft._id))!;
            return {
              pickupRequestId: pickup._id,
              shipmentDraftId: draft._id,
              dpdShipmentId: booking._id,
              trackingNumber: booking.swiftlineTrackingNumber || booking.dpdShipmentId || String(booking._id),
              snapshotRevision: booking.snapshotRevision || 1,
              shipmentSnapshot: { consignorAddress: draft.consignorAddress, parcelList: draft.parcelList },
              parcels: booking.parcelNumbers.map((parcelNumber, index) => ({
                parcelNumber,
                weightKg: Number(draft.parcelList[index]?.weightKg || 0),
                status: "PENDING"
              })),
              status: "PENDING",
              active: true
            };
          }), { session });
        }
        await AuditLog.create([{
          action: "PICKUP_REQUEST_CREATED", entityType: "PICKUP_REQUEST", entityId: pickup._id,
          performedBy: input.userId, performedAt: new Date(), metadata: { requestNumber, shipmentCount, parcelCount, totalBoxes, documentCount: documents.length }
        }], { session });
      });
    } finally {
      await session.endSession();
    }
  } catch (error) {
    await Promise.all(storedKeys.map(async (key) => { try { await deleteObject(key); } catch (cleanupError) { console.error("Pickup document cleanup failed.", { message: cleanupError instanceof Error ? cleanupError.message : "Unknown error" }); } }));
    throw error;
  }

  const detail = await getPickupDetail(String(pickupId));
  const emailPayload = pickupEmailPayload(detail);
  const attachmentRefs = detail.documents.map((document) => ({
    kind: "PICKUP_DOCUMENT" as const,
    refId: pickupId,
    documentId: new mongoose.Types.ObjectId(document.id)
  }));
  await notifyPickupSafely(() => notifyPortalUsers([input.userId], {
    type: "PICKUP_REQUESTED",
    title: "Pickup request received",
    message: `${detail.requestNumber} has been submitted for review.`,
    href: "/client/pickups",
    idempotencyKey: `PICKUP_REQUESTED:${String(pickupId)}:CLIENT`,
    businessAccountId: detail.businessAccountId,
    metadata: { pickupRequestId: pickupId, branchId: detail.branchId },
    email: { templateKey: "PICKUP_REQUESTED_CLIENT", payload: emailPayload, attachmentRefs }
  }));
  await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(new mongoose.Types.ObjectId(business.branchId), {
    type: "PICKUP_REQUESTED",
    title: "New pickup request",
    message: `${detail.requestNumber} from ${detail.businessAccountName} is awaiting review.`,
    href: "/dashboard/pickups",
    idempotencyKey: `PICKUP_REQUESTED:${String(pickupId)}:STAFF`,
    businessAccountId: detail.businessAccountId,
    metadata: { pickupRequestId: pickupId, branchId: detail.branchId },
    email: { templateKey: "PICKUP_REQUESTED_STAFF", payload: emailPayload, attachmentRefs }
  }));
  return detail;
}

export async function getPickupDetail(id: string) {
  const request = await PickupRequest.findById(asObjectId(id, "Pickup request"))
    .populate("branchId", "name code labelCode")
    .populate("cancelledBy", "firstName lastName name role")
    .lean()
    .exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  const [shipments, attempts, proofs, requester] = await Promise.all([
    PickupRequestShipment.find({ pickupRequestId: request._id }).sort({ createdAt: 1 }).lean().exec(),
    PickupAttempt.find({ pickupRequestId: request._id }).sort({ sequence: -1 })
      .populate("assignedDriverProfileId", "deliverySubrole engagementType status")
      .populate("assignedDriverUserId", "firstName lastName name phone profileImage")
      .lean().exec(),
    PickupProof.find({ pickupRequestId: request._id }).select("pickupAttemptId type source originalName size capturedAt").lean().exec(),
    User.findById(request.requestedBy).select("name firstName lastName email").lean().exec()
  ]);
  const receiveScans = shipments.length
    ? await ShipmentOperationsParcelScan.find({ shipmentDraftId: { $in: shipments.map((item) => item.shipmentDraftId) }, action: "RECEIVE" })
      .select("shipmentDraftId parcelNumber scannedAt").lean().exec()
    : [];
  const receivedAtByParcel = new Map(receiveScans.map((scan) => [`${scan.shipmentDraftId}:${scan.parcelNumber}`, scan.scannedAt]));
  const proofsByAttempt = new Map<string, Array<{ id: string; type: string; source?: string; originalName: string; size: number; capturedAt: Date }>>();
  for (const proof of proofs) {
    const key = String(proof.pickupAttemptId);
    proofsByAttempt.set(key, [...(proofsByAttempt.get(key) ?? []), { id: String(proof._id), type: proof.type, source: proof.source, originalName: proof.originalName, size: proof.size, capturedAt: proof.capturedAt }]);
  }
  return {
    ...request,
    id: String(request._id),
    requester: requester ? { name: requester.name || `${requester.firstName ?? ""} ${requester.lastName ?? ""}`.trim(), email: requester.email ?? "" } : null,
    documents: safePickupDocuments(request.documents ?? []),
    shipments: shipments.map((shipment) => ({
      ...shipment,
      parcels: shipment.parcels.map((parcel) => ({
        ...parcel,
        hubReceivedAt: receivedAtByParcel.get(`${shipment.shipmentDraftId}:${normalized(parcel.parcelNumber)}`) ?? null
      }))
    })),
    attempts: attempts.map((attempt) => ({ ...attempt, proofs: proofsByAttempt.get(String(attempt._id)) ?? [] }))
  };
}

function pickupEmailPayload(detail: Awaited<ReturnType<typeof getPickupDetail>>) {
  const address = detail.pickupAddress ?? {};
  const collectionAddress = ["addressLine1", "addressLine2", "townOrCity", "county", "postcode", "countryCode"]
    .map((key) => address[key]).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(", ");
  const branch = detail.branchId as unknown as { name?: string };
  const shipments = detail.shipments.map((shipment) => ({
    trackingNumber: shipment.trackingNumber,
    parcels: shipment.parcels.map((parcel) => ({
      parcelNumber: parcel.parcelNumber,
      hubReceiptOutcome: parcel.hubReceiptOutcome ?? null
    }))
  }));
  const parcels = shipments.flatMap((shipment) => shipment.parcels);
  return {
    requestNumber: detail.requestNumber,
    companyName: detail.businessAccountName,
    branchName: branch.name ?? "Assigned branch",
    transportCompany: detail.transportCompany ?? "",
    dispatchAt: detail.dispatchAt ?? detail.requestedWindow.startAt,
    arrivalDate: detail.expectedDelhiArrival?.date ?? null,
    arrivalWindow: detail.expectedDelhiArrival?.window ?? "",
    arrivalExactAt: detail.expectedDelhiArrival?.exactAt ?? null,
    collectionAddress,
    contactName: detail.pickupContact.name,
    contactPhone: detail.pickupContact.phone,
    requesterName: detail.requester?.name ?? "",
    requesterEmail: detail.pickupContact.email ?? detail.requester?.email ?? "",
    totalBoxes: detail.totalBoxes,
    totalWeightKg: detail.totalWeightKg,
    shipmentCount: detail.shipmentCount,
    documentCount: detail.documents.length,
    documentNames: detail.documents.map((document) => document.originalName),
    handlingRemarks: detail.handlingRemarks || detail.instructions || "",
    pickupPartnerInfo: detail.pickupPartnerInfo ?? "",
    receivedAt: detail.receivedAtDelhiHubAt ?? null,
    receivedParcelCount: parcels.filter((parcel) => parcel.hubReceiptOutcome === "RECEIVED").length,
    missingParcelCount: parcels.filter((parcel) => parcel.hubReceiptOutcome === "NOT_RECEIVED").length,
    shipments
  };
}

export async function listPickupRequests(filter: Record<string, unknown>) {
  const items = await PickupRequest.find(filter).sort({ createdAt: -1 }).limit(200)
    .populate("branchId", "name code labelCode")
    .populate("cancelledBy", "firstName lastName name role")
    .lean().exec();
  return items.map((item) => ({ ...item, id: String(item._id), documents: safePickupDocuments(item.documents ?? []) }));
}

export async function cancelPickup(input: {
  pickupId: string;
  actorId: mongoose.Types.ObjectId;
  source: "CLIENT" | "ADMIN";
  reason: string;
}) {
  const requestId = asObjectId(input.pickupId, "Pickup request");
  const request = await PickupRequest.findById(requestId).exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  // A driver being assigned, or a pickup being missed, is still before any
  // collection work- both remain cancellable.
  if (!["REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED", "MISSED"].includes(request.status)) {
    throw new PickupServiceError("This pickup can no longer be cancelled because collection work has started.", 409);
  }
  const attempt = request.currentAttemptId ? await PickupAttempt.findById(request.currentAttemptId).exec() : null;
  if (attempt && !["SCHEDULED", "ASSIGNED"].includes(attempt.status)) {
    throw new PickupServiceError("This pickup can no longer be cancelled because the driver has started the assignment.", 409);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      request.status = "CANCELLED";
      request.cancelledBy = input.actorId;
      request.cancelledAt = now;
      request.cancellationReason = input.reason.trim();
      request.cancellationSource = input.source;
      request.version += 1;
      await request.save({ session });
      if (attempt) {
        attempt.status = "CANCELLED";
        await attempt.save({ session });
      }
      await PickupRequestShipment.updateMany({ pickupRequestId: request._id, active: true }, { $set: { active: false, status: "CANCELLED" } }, { session }).exec();
      await AuditLog.create([{
        action: "PICKUP_REQUEST_UPDATED",
        entityType: "PICKUP_REQUEST",
        entityId: request._id,
        performedBy: input.actorId,
        performedAt: now,
        metadata: { status: "CANCELLED", cancellationSource: input.source, reason: request.cancellationReason }
      }], { session });
    });
  } finally { await session.endSession(); }

  if (input.source === "CLIENT") {
    await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(request.branchId, {
      type: "PICKUP_CANCELLED",
      title: "Pickup cancelled by client",
      message: `${request.requestNumber} was cancelled by the client.`,
      href: "/dashboard/pickups",
      idempotencyKey: `PICKUP_CANCELLED:${String(request._id)}:STAFF`,
      businessAccountId: request.businessAccountId,
      metadata: { pickupRequestId: request._id, cancellationSource: input.source }
    }));
  } else {
    await notifyPickupSafely(() => notifyPortalUsers([request.requestedBy], {
      type: "PICKUP_CANCELLED",
      title: "Pickup cancelled",
      message: `${request.requestNumber} was cancelled by Swiftline.`,
      href: "/client/pickups",
      idempotencyKey: `PICKUP_CANCELLED:${String(request._id)}:CLIENT`,
      businessAccountId: request.businessAccountId,
      metadata: { pickupRequestId: request._id, cancellationSource: input.source }
    }));
  }
  if (attempt?.assignedDriverUserId) await notifyPickupSafely(() => notifyPortalUsers([attempt.assignedDriverUserId as mongoose.Types.ObjectId], {
    type: "PICKUP_CANCELLED",
    title: "Assigned pickup cancelled",
    message: `${request.requestNumber} is no longer scheduled for collection.`,
    href: "/driver",
    idempotencyKey: `PICKUP_CANCELLED:${String(request._id)}:DRIVER`,
    businessAccountId: request.businessAccountId,
    metadata: { pickupRequestId: request._id }
  }));
  return getPickupDetail(input.pickupId);
}

/**
 * Records that nobody collected.
 *
 * Staff-only and deliberately not terminal: the request stays alive so it can
 * be rescheduled, which is what a customer wants after a missed collection.
 * Ending it instead would force them to raise the whole request again.
 */
export async function markPickupMissed(input: {
  pickupId: string;
  actorId: mongoose.Types.ObjectId;
  reason: string;
}) {
  const request = await PickupRequest.findById(asObjectId(input.pickupId, "Pickup request")).exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  if (!["REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED"].includes(request.status)) {
    throw new PickupServiceError("Only a pickup still awaiting collection can be marked missed.", 409);
  }

  request.status = "MISSED";
  request.version += 1;
  await request.save();

  // The attempt is closed off too, or the driver keeps an assignment for a
  // collection everyone agrees did not happen.
  if (request.currentAttemptId) {
    await PickupAttempt.findByIdAndUpdate(request.currentAttemptId, { $set: { status: "FAILED" } }).exec();
  }

  await AuditLog.create({
    action: "PICKUP_REQUEST_UPDATED",
    entityType: "PICKUP_REQUEST",
    entityId: request._id,
    performedBy: input.actorId,
    performedAt: new Date(),
    metadata: { status: "MISSED", reason: input.reason.trim() }
  });

  await notifyPickupSafely(() => notifyPortalUsers([request.requestedBy], {
    type: "PICKUP_MISSED",
    title: "Pickup missed",
    message: `${request.requestNumber} was not collected. ${input.reason.trim()}`,
    href: "/client/pickups",
    idempotencyKey: `PICKUP_MISSED:${String(request._id)}:${request.version}`,
    businessAccountId: request.businessAccountId
  }));

  return getPickupDetail(input.pickupId);
}

/**
 * Moves a pickup to a new window.
 *
 * Reschedule replaces the requested window and returns the request to
 * REQUESTED, because a new window has not been confirmed by anyone yet-
 * leaving it CONFIRMED would assert an agreement to a time nobody agreed to.
 * Any existing attempt is cancelled: it was scheduled against the old window.
 */
export async function reschedulePickup(input: {
  pickupId: string;
  actorId: mongoose.Types.ObjectId;
  source: "CLIENT" | "ADMIN";
  startAt: Date;
  endAt: Date;
  timezone: string;
}) {
  const request = await PickupRequest.findById(asObjectId(input.pickupId, "Pickup request")).exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  if (!reschedulablePickupStatuses.includes(request.status)) {
    throw new PickupServiceError("This pickup can no longer be rescheduled.", 409);
  }
  if (input.endAt <= input.startAt) {
    throw new PickupServiceError("The pickup window must end after it starts.", 400);
  }
  if (input.startAt.getTime() < Date.now()) {
    throw new PickupServiceError("Choose a pickup window in the future.", 400);
  }
  if (request.expectedDelhiArrival) {
    const expectedAt = request.expectedDelhiArrival.window === "EXACT" && request.expectedDelhiArrival.exactAt
      ? request.expectedDelhiArrival.exactAt
      : arrivalWindowEnd(request.expectedDelhiArrival.date, request.expectedDelhiArrival.window);
    if (expectedAt <= input.startAt) throw new PickupServiceError("Expected Delhi arrival must be after dispatch.", 400);
  }

  const previous = { ...request.requestedWindow };
  const previousDispatchAt = request.dispatchAt;
  request.requestedWindow = { startAt: input.startAt, endAt: input.endAt, timezone: input.timezone };
  request.dispatchAt = input.startAt;
  request.dispatchReminderSentAt = null;
  request.pickupStartedAt = null;
  request.confirmedWindow = null;
  request.status = "REQUESTED";
  request.version += 1;
  await request.save();

  if (request.currentAttemptId) {
    await PickupAttempt.findByIdAndUpdate(
      request.currentAttemptId,
      { $set: { status: "CANCELLED" } }
    ).exec();
    request.currentAttemptId = null;
    await request.save();
  }

  await AuditLog.create({
    action: "PICKUP_REQUEST_UPDATED",
    entityType: "PICKUP_REQUEST",
    entityId: request._id,
    performedBy: input.actorId,
    performedAt: new Date(),
    metadata: {
      status: "RESCHEDULED",
      source: input.source,
      from: { startAt: previous.startAt, endAt: previous.endAt },
      to: { startAt: input.startAt, endAt: input.endAt }
    }
  });

  // A queued reminder for the old dispatch must not be delivered after the move.
  try {
    const pickupReminderPrefix = `PICKUP_DISPATCH_REMINDER:${String(request._id)}:`;
    const currentDispatchPrefix = `${pickupReminderPrefix}${input.startAt.getTime()}:`;
    const currentSchedulePrefix = previousDispatchAt?.getTime() === input.startAt.getTime()
      ? `${currentDispatchPrefix}${request.version}:`
      : currentDispatchPrefix;
    await EmailOutbox.updateMany({
      notificationType: "PICKUP_DISPATCH_REMINDER",
      idempotencyKey: { $regex: `^${pickupReminderPrefix}`, $not: new RegExp(`^${currentSchedulePrefix}`) },
      status: "PENDING"
    }, { $set: { status: "CANCELLED" } }).exec();
  } catch (error) {
    console.error("Pending pickup reminder email could not be cancelled.", error);
  }

  const recipients = input.source === "CLIENT" ? "STAFF" : "CLIENT";
  const notification = {
    type: "PICKUP_RESCHEDULED" as const,
    title: "Pickup rescheduled",
    message: `${request.requestNumber} has a new dispatch time.`,
    href: input.source === "CLIENT" ? "/dashboard/pickups" : "/client/pickups",
    idempotencyKey: `PICKUP_RESCHEDULED:${String(request._id)}:${request.version}:${recipients}`,
    businessAccountId: request.businessAccountId,
    metadata: { pickupRequestId: request._id, branchId: request.branchId }
  };
  if (input.source === "CLIENT") await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(request.branchId, notification));
  else await notifyPickupSafely(() => notifyPortalUsers([request.requestedBy], notification));

  return getPickupDetail(input.pickupId);
}

export async function markPickupStarted(input: { pickupId: string; actorId: mongoose.Types.ObjectId; source: "ADMIN" | "DRIVER" }) {
  const request = await PickupRequest.findById(asObjectId(input.pickupId, "Pickup request")).exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  if (request.pickupStartedAt) return getPickupDetail(input.pickupId);
  if (!["CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED"].includes(request.status)) {
    throw new PickupServiceError("Approve or schedule the pickup before marking it started.", 409);
  }

  const now = new Date();
  request.status = "IN_PROGRESS";
  request.pickupStartedAt = now;
  request.version += 1;
  await request.save();
  await AuditLog.create({
    action: "PICKUP_REQUEST_UPDATED",
    entityType: "PICKUP_REQUEST",
    entityId: request._id,
    performedBy: input.actorId,
    performedAt: now,
    metadata: { status: "IN_PROGRESS", source: input.source }
  });
  const detail = await getPickupDetail(input.pickupId);
  const message = `${detail.requestNumber} pickup has started.`;
  const emailPayload = pickupEmailPayload(detail);
  await notifyPickupSafely(() => notifyPortalUsers([detail.requestedBy], {
    type: "PICKUP_EN_ROUTE",
    title: "Pickup started",
    message,
    href: "/client/pickups",
    idempotencyKey: `PICKUP_EN_ROUTE:${String(detail._id)}`,
    businessAccountId: detail.businessAccountId,
    metadata: { pickupRequestId: detail._id, branchId: detail.branchId },
    email: { templateKey: "PICKUP_STARTED_CLIENT", payload: emailPayload }
  }));
  await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(new mongoose.Types.ObjectId(referenceId(detail.branchId)), {
    type: "PICKUP_EN_ROUTE",
    title: "Pickup started",
    message,
    href: "/dashboard/pickups",
    idempotencyKey: `PICKUP_EN_ROUTE:${String(detail._id)}:STAFF`,
    businessAccountId: detail.businessAccountId,
    metadata: { pickupRequestId: detail._id, branchId: detail.branchId },
    email: { templateKey: "PICKUP_STARTED_STAFF", payload: emailPayload }
  }));
  return detail;
}

export async function markPickupReceivedAtDelhiHub(input: {
  pickupId: string;
  actorId: mongoose.Types.ObjectId;
  receivedParcels: Array<{ shipmentDraftId: string; parcelNumber: string }>;
}) {
  const requestId = asObjectId(input.pickupId, "Pickup request");
  const session = await mongoose.startSession();
  let branchId: mongoose.Types.ObjectId | null = null;
  let businessAccountId: mongoose.Types.ObjectId | null = null;
  let receivedAt = new Date();
  let missingParcelNumbers: string[] = [];
  let receivedParcelCount = 0;
  try {
    await session.withTransaction(async () => {
      branchId = null;
      businessAccountId = null;
      missingParcelNumbers = [];
      receivedParcelCount = 0;
      const request = await PickupRequest.findById(requestId).session(session).exec();
      if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
      if (["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(request.status)) return;
      if (!["IN_PROGRESS", "COLLECTED", "PARTIALLY_COLLECTED"].includes(request.status)) {
        throw new PickupServiceError("Start the pickup before recording Delhi hub receipt.", 409);
      }
      const activeAttempt = request.currentAttemptId
        ? await PickupAttempt.findById(request.currentAttemptId).session(session).exec()
        : null;
      if (activeAttempt && ["EN_ROUTE", "ARRIVED", "COLLECTING"].includes(activeAttempt.status)) {
        throw new PickupServiceError("The assigned driver must finish the active collection before hub receipt can be recorded.", 409);
      }
      if (activeAttempt && ["SCHEDULED", "ASSIGNED"].includes(activeAttempt.status)) {
        activeAttempt.status = "CANCELLED";
        await activeAttempt.save({ session });
      }

      receivedAt = new Date();
      const links = await PickupRequestShipment.find({ pickupRequestId: request._id }).session(session).exec();
      const expected = new Set(links.flatMap((link) => link.parcels.map((parcel) => `${link.shipmentDraftId}:${normalized(parcel.parcelNumber)}`)));
      const selected = new Set(input.receivedParcels.map((parcel) => `${parcel.shipmentDraftId}:${normalized(parcel.parcelNumber)}`));
      if (selected.size !== input.receivedParcels.length || [...selected].some((key) => !expected.has(key))) {
        throw new PickupServiceError("The selected parcels do not match this pickup. Refresh and review the parcel list.", 409);
      }
      const draftIds = links.map((link) => link.shipmentDraftId);
      const [bookings, scans, events] = await Promise.all([
        DpdShipment.find({ _id: { $in: links.map((link) => link.dpdShipmentId) } }).session(session).exec(),
        ShipmentOperationsParcelScan.find({ shipmentDraftId: { $in: draftIds }, action: "RECEIVE" }).session(session).exec(),
        ShipmentEvent.find({ shipmentDraftId: { $in: draftIds } }).select("shipmentDraftId status eventAt").sort({ eventAt: -1, createdAt: -1 }).session(session).lean().exec()
      ]);
      const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
      const alreadyReceived = new Set(scans.map((scan) => `${scan.shipmentDraftId}:${normalized(scan.parcelNumber)}`));
      const eventsByDraft = new Map<string, Set<string>>();
      const latestStatusByDraft = new Map<string, string>();
      for (const event of events) {
        const key = String(event.shipmentDraftId);
        if (!latestStatusByDraft.has(key)) latestStatusByDraft.set(key, event.status);
        const statuses = eventsByDraft.get(key) ?? new Set<string>();
        statuses.add(event.status);
        eventsByDraft.set(key, statuses);
      }
      const newScans: Array<{
        shipmentDraftId: mongoose.Types.ObjectId; dpdShipmentId: mongoose.Types.ObjectId;
        action: "RECEIVE"; parcelNumber: string; location: string; deviceId: string;
        scanRequestId: string; scannedBy: mongoose.Types.ObjectId; scannedAt: Date;
      }> = [];
      const newEvents: Array<{
        shipmentDraftId: mongoose.Types.ObjectId; dpdShipmentId: mongoose.Types.ObjectId;
        status: "PARCEL_COLLECTED" | "WAREHOUSE_SCAN_IN"; note: string; location?: string;
        customerVisible: true; source: "PICKUP"; sourceReference: string;
        createdBy: mongoose.Types.ObjectId; eventAt: Date;
      }> = [];
      const finalizedDraftIds = new Set<string>();
      for (const link of links) {
        const draftId = String(link.shipmentDraftId);
        const booking = bookingById.get(String(link.dpdShipmentId));
        if (!booking || String(booking.shipmentDraftId) !== draftId || booking.status !== "LABEL_RECEIVED") {
          throw new PickupServiceError("A linked shipment has changed. Ask Operations to review it before closing the pickup.", 409);
        }
        const expectedNumbers = resolveOperationsScanParcelNumbers({
          currentShipmentSnapshot: booking.currentShipmentSnapshot,
          bookingSnapshot: booking.bookingSnapshot,
          parcelNumbers: booking.parcelNumbers
        });
        const linkedNumbers = link.parcels.map((parcel) => normalized(parcel.parcelNumber));
        if (expectedNumbers.length !== linkedNumbers.length || expectedNumbers.some((number) => !linkedNumbers.includes(number))) {
          throw new PickupServiceError("A linked shipment's parcel labels have changed. Ask Operations to review it before closing the pickup.", 409);
        }
        const statuses = eventsByDraft.get(draftId) ?? new Set<string>();
        if (statuses.has("SHIPMENT_CANCELLED") || latestStatusByDraft.get(draftId) === "ON_HOLD") {
          throw new PickupServiceError("Resolve the linked shipment's cancellation or hold before recording hub receipt.", 409);
        }
        const selectedForShipment = linkedNumbers.filter((number) => selected.has(`${draftId}:${number}`));
        const allReceived = selectedForShipment.length === linkedNumbers.length;
        if (!allReceived && statuses.has("WAREHOUSE_SCAN_IN")) {
          throw new PickupServiceError("A linked shipment is already marked received at origin. Review its parcel scans before reporting a parcel missing.", 409);
        }
        if (allReceived && !statuses.has("WAREHOUSE_SCAN_IN") && findRecordedLaterMilestones("WAREHOUSE_SCAN_IN", statuses).length) {
          throw new PickupServiceError("A linked shipment has already moved beyond origin receipt. Ask Operations to reconcile its history before closing the pickup.", 409);
        }
        link.parcels.forEach((parcel, index) => {
          const number = normalized(parcel.parcelNumber);
          const key = `${draftId}:${number}`;
          const atHub = selected.has(key);
          if (!atHub && alreadyReceived.has(key)) {
            throw new PickupServiceError(`${number} was already received at the origin facility. Keep it selected.`, 409);
          }
          parcel.hubReceiptOutcome = atHub ? "RECEIVED" : "NOT_RECEIVED";
          if (atHub) {
            receivedParcelCount += 1;
            if (parcel.status !== "COLLECTED") {
              parcel.status = "COLLECTED";
              parcel.collectedAt = receivedAt;
            }
            if (!alreadyReceived.has(key)) {
              newScans.push({
                shipmentDraftId: link.shipmentDraftId, dpdShipmentId: link.dpdShipmentId,
                action: "RECEIVE", parcelNumber: number, location: "Delhi hub",
                deviceId: "PICKUP_HUB_RECEIPT", scanRequestId: `PICKUP:${link._id}:${index}`,
                scannedBy: input.actorId, scannedAt: receivedAt
              });
              alreadyReceived.add(key);
            }
          } else {
            missingParcelNumbers.push(number);
          }
        });
        link.status = link.parcels.every((parcel) => parcel.status === "COLLECTED")
          ? "COLLECTED" : link.parcels.some((parcel) => parcel.status === "COLLECTED") ? "PARTIAL" : link.status;
        link.hubReceiptRecordedAt = receivedAt;
        link.active = false;
        await link.save({ session });
        if (allReceived && link.parcels.every((parcel) => parcel.status === "COLLECTED") && !statuses.has("PARCEL_COLLECTED")) {
          newEvents.push({
            shipmentDraftId: link.shipmentDraftId, dpdShipmentId: link.dpdShipmentId,
            status: "PARCEL_COLLECTED", note: `Collected under pickup ${request.requestNumber}.`,
            customerVisible: true, source: "PICKUP", sourceReference: String(request._id),
            createdBy: input.actorId, eventAt: receivedAt
          });
          finalizedDraftIds.add(draftId);
        }
        if (allReceived && !statuses.has("WAREHOUSE_SCAN_IN")) {
          newEvents.push({
            shipmentDraftId: link.shipmentDraftId, dpdShipmentId: link.dpdShipmentId,
            status: "WAREHOUSE_SCAN_IN", note: `All parcels received at Delhi hub under pickup ${request.requestNumber}.`,
            location: "Delhi hub", customerVisible: true, source: "PICKUP",
            sourceReference: String(request._id), createdBy: input.actorId, eventAt: receivedAt
          });
          finalizedDraftIds.add(draftId);
        }
      }
      if (newScans.length) await ShipmentOperationsParcelScan.insertMany(newScans, { session });
      if (newEvents.length) await ShipmentEvent.insertMany(newEvents, { session });
      for (const draftId of finalizedDraftIds) {
        await markShipmentChargeFinalized({ shipmentDraftId: new mongoose.Types.ObjectId(draftId), finalizedAt: receivedAt, session });
      }
      request.status = missingParcelNumbers.length ? "COMPLETED_WITH_MISSING_PARCELS" : "RECEIVED_AT_DELHI_HUB";
      request.receivedAtDelhiHubAt = receivedAt;
      request.version += 1;
      await request.save({ session });
      branchId = request.branchId;
      businessAccountId = request.businessAccountId;
      await AuditLog.create([{
        action: "PICKUP_RECEIVED_AT_DELHI_HUB",
        entityType: "PICKUP_REQUEST",
        entityId: request._id,
        performedBy: input.actorId,
        performedAt: receivedAt,
        metadata: { status: request.status, receivedParcels: receivedParcelCount, notReceivedParcels: missingParcelNumbers.length, attemptId: request.currentAttemptId ?? null }
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  const detail = await getPickupDetail(input.pickupId);
  if (["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(detail.status) && branchId && businessAccountId) {
    const emailPayload = pickupEmailPayload(detail);
    const branch = await Branch.findById(branchId).select("name").lean().exec();
    const missingList = missingParcelNumbers.slice(0, 30).join(", ");
    const remaining = missingParcelNumbers.length - 30;
    const message = missingParcelNumbers.length
      ? `${detail.requestNumber} is completed at ${branch?.name ?? "the Delhi hub"}. ${receivedParcelCount} parcels received; ${missingParcelNumbers.length} not received at the hub: ${missingList}${remaining > 0 ? `, and ${remaining} more` : ""}. Open the pickup for the full list.`
      : `${detail.requestNumber} has been received at ${branch?.name ?? "the Delhi hub"}.`;
    const title = missingParcelNumbers.length ? "Pickup completed - parcels not received" : "Pickup received at Delhi hub";
    await notifyPickupSafely(() => notifyPortalUsers([detail.requestedBy], {
      type: "PICKUP_COMPLETED",
      title,
      message,
      href: "/client/pickups",
      idempotencyKey: `PICKUP_COMPLETED:${String(detail._id)}`,
      businessAccountId,
      metadata: { pickupRequestId: detail._id, branchId, receivedAtDelhiHubAt: receivedAt },
      email: { templateKey: "PICKUP_COMPLETED_CLIENT", payload: emailPayload }
    }));
    await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(branchId!, {
      type: "PICKUP_COMPLETED",
      title,
      message,
      href: "/dashboard/pickups",
      idempotencyKey: `PICKUP_COMPLETED:${String(detail._id)}:STAFF`,
      businessAccountId,
      metadata: { pickupRequestId: detail._id, branchId, receivedAtDelhiHubAt: receivedAt },
      email: { templateKey: "PICKUP_COMPLETED_STAFF", payload: emailPayload }
    }));
  }
  return detail;
}

export async function updatePickupPartnerInfo(input: { pickupId: string; actorId: mongoose.Types.ObjectId; information: string }) {
  const request = await PickupRequest.findById(asObjectId(input.pickupId, "Pickup request")).exec();
  if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
  const before = request.pickupPartnerInfo ?? "";
  request.pickupPartnerInfo = input.information.trim();
  request.version += 1;
  await request.save();
  await AuditLog.create({
    action: "PICKUP_REQUEST_UPDATED",
    entityType: "PICKUP_REQUEST",
    entityId: request._id,
    performedBy: input.actorId,
    performedAt: new Date(),
    metadata: { field: "pickupPartnerInfo", previousValue: before, value: request.pickupPartnerInfo }
  });
  return getPickupDetail(input.pickupId);
}

export function pendingPickupReminderEmailFilter(reminderKey: string) {
  return { idempotencyKey: { $regex: `^${reminderKey}:` }, status: "PENDING" as const };
}

export async function runPickupDispatchReminderSweep(now = new Date()) {
  const upcomingUntil = new Date(now.getTime() + 10 * 60 * 1000);
  const due = await PickupRequest.find({
    dispatchAt: { $lte: upcomingUntil },
    dispatchReminderSentAt: null,
    status: { $in: ["REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED", "IN_PROGRESS"] }
  }).select("_id requestNumber businessAccountId branchId dispatchAt").sort({ dispatchAt: 1 }).limit(500).lean().exec();

  let sent = 0;
  const notifiedPickupIds: string[] = [];
  const notifiedReminderKeys: string[] = [];
  for (const candidate of due) {
    const session = await mongoose.startSession();
    try {
      const notified = await session.withTransaction(async () => {
        const request = await PickupRequest.findOneAndUpdate({
          _id: candidate._id,
          dispatchReminderSentAt: null,
          dispatchAt: candidate.dispatchAt,
          status: { $in: ["REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED", "IN_PROGRESS"] }
        }, { $set: { dispatchReminderSentAt: now } }, { returnDocument: "after", session }).lean().exec();
        if (!request) return false;
        if (!request.dispatchAt) throw new Error("Claimed pickup reminder has no dispatch time.");
        const upcoming = request.dispatchAt > now;
        const reminderKey = `PICKUP_DISPATCH_REMINDER:${String(request._id)}:${request.dispatchAt.getTime()}:${request.version}`;
        await notifyAssignedPickupBranchStaff(request.branchId, {
          type: "PICKUP_DISPATCH_REMINDER",
          title: upcoming ? "Pickup dispatch coming up" : "Pickup dispatch follow-up",
          message: upcoming
            ? `${request.requestNumber} is scheduled to dispatch within the next 10 minutes.`
            : `${request.requestNumber}'s scheduled dispatch time has passed. Check its status.`,
          href: "/dashboard/pickups",
          idempotencyKey: reminderKey,
          businessAccountId: request.businessAccountId,
          metadata: { pickupRequestId: request._id, branchId: request.branchId, dispatchAt: request.dispatchAt }
        }, session);
        return reminderKey;
      });
      if (notified) {
        sent += 1;
        notifiedPickupIds.push(String(candidate._id));
        notifiedReminderKeys.push(notified);
      }
    } finally {
      await session.endSession();
    }
  }
  return { due: due.length, sent, notifiedPickupIds, notifiedReminderKeys };
}

export async function confirmPickup(input: {
  pickupId: string; actorId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  let attemptId: mongoose.Types.ObjectId | null = null;
  try {
    await session.withTransaction(async () => {
      const request = await PickupRequest.findOne({ _id: asObjectId(input.pickupId, "Pickup request"), status: { $in: ["REQUESTED", "ACTION_REQUIRED", "PARTIALLY_COLLECTED"] } }).session(session).exec();
      if (!request) throw new PickupServiceError("This pickup cannot be scheduled in its current status.", 409);
      const scheduledStart = request.dispatchAt ?? request.requestedWindow.startAt;
      const scheduledWindow = {
        startAt: scheduledStart,
        endAt: request.dispatchAt ? new Date(scheduledStart.getTime() + 2 * 60 * 60 * 1000) : request.requestedWindow.endAt,
        timezone: "Asia/Kolkata"
      };
      if (request.status === "PARTIALLY_COLLECTED") {
        const remainingLinks = await PickupRequestShipment.find({ pickupRequestId: request._id, active: true }).session(session).exec();
        for (const link of remainingLinks) {
          for (const parcel of link.parcels) {
            if (parcel.status !== "COLLECTED") {
              parcel.status = "PENDING";
              parcel.exceptionReason = "";
            }
          }
          link.status = link.parcels.some((parcel) => parcel.status === "COLLECTED") ? "PARTIAL" : "PENDING";
          await link.save({ session });
        }
      }
      const sequence = await PickupAttempt.countDocuments({ pickupRequestId: request._id }).session(session) + 1;
      const [attempt] = await PickupAttempt.create([{
        pickupRequestId: request._id, sequence, status: "SCHEDULED", scheduledWindow
      }], { session });
      if (!attempt) throw new PickupServiceError("Pickup attempt could not be scheduled.", 500);
      attemptId = attempt._id as mongoose.Types.ObjectId;
      request.confirmedWindow = scheduledWindow;
      request.currentAttemptId = attempt._id as mongoose.Types.ObjectId;
      request.status = "CONFIRMED";
      request.version += 1;
      await request.save({ session });
      await AuditLog.create([{ action: "PICKUP_ATTEMPT_CREATED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id, performedBy: input.actorId, performedAt: new Date(), metadata: { pickupRequestId: request._id, sequence } }], { session });
    });
  } finally { await session.endSession(); }
  const detail = await getPickupDetail(input.pickupId);
  await notifyPickupSafely(() => notifyPortalUsers([detail.requestedBy], {
    type: "PICKUP_CONFIRMED",
    title: "Pickup confirmed",
    message: `${detail.requestNumber} is approved for dispatch at ${(detail.dispatchAt ?? detail.requestedWindow.startAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
    href: "/client/pickups",
    idempotencyKey: `PICKUP_CONFIRMED:${String(detail._id)}:${detail.version}`,
    businessAccountId: detail.businessAccountId,
    metadata: { pickupRequestId: detail._id, attemptId }
  }));
  return { detail, attemptId: String(attemptId) };
}

export async function assignPickupDriver(input: { pickupId: string; attemptId: string; driverProfileId: string; actorId: mongoose.Types.ObjectId; vehicle: Record<string, string> }) {
  const request = await PickupRequest.findById(asObjectId(input.pickupId, "Pickup request")).exec();
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), pickupRequestId: request?._id, status: { $in: ["SCHEDULED", "ASSIGNED"] } }).exec();
  if (!request || !attempt) throw new PickupServiceError("Pickup attempt was not found or cannot be assigned.", 409);
  const profile = await DriverProfile.findOne({ _id: asObjectId(input.driverProfileId, "Driver"), status: "ACTIVE", deliverySubrole: "DRIVER" }).exec();
  if (!profile) throw new PickupServiceError("Select an active approved driver.", 409);
  const user = await User.findOne({ _id: profile.userId, role: "delivery", userStatus: "active", assignedBranches: request.branchId }).exec();
  if (!user) throw new PickupServiceError("The selected driver is not active for this pickup branch.", 409);
  attempt.assignedDriverProfileId = profile._id as mongoose.Types.ObjectId;
  attempt.assignedDriverUserId = user._id as mongoose.Types.ObjectId;
  attempt.assignedBy = input.actorId;
  attempt.vehicle = input.vehicle;
  attempt.status = "ASSIGNED";
  await attempt.save();
  /**
   * The request follows the attempt.
   *
   * Assignment used to be visible only on the attempt, so a customer watching
   * the request saw "Scheduled" while a driver was already on the way. Guarded
   * so a pickup already in progress is not dragged backwards by a reassignment.
   */
  if (["REQUESTED", "CONFIRMED", "ACTION_REQUIRED", "MISSED"].includes(request.status)) {
    request.status = "DRIVER_ASSIGNED";
    request.version += 1;
    await request.save();
  }
  await AuditLog.create({ action: "PICKUP_ATTEMPT_ASSIGNED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id, performedBy: input.actorId, performedAt: new Date(), metadata: { pickupRequestId: request._id, driverProfileId: profile._id, engagementType: profile.engagementType } });
  await notifyPickupSafely(() => notifyPortalUsers([user._id as mongoose.Types.ObjectId], {
    type: "PICKUP_ASSIGNED",
    title: "Pickup assigned",
    message: `${request.requestNumber} has been assigned to you.`,
    href: "/driver",
    idempotencyKey: `PICKUP_ASSIGNED:${String(attempt._id)}:${String(user._id)}`,
    businessAccountId: request.businessAccountId,
    metadata: { pickupRequestId: request._id, attemptId: attempt._id }
  }));
  return getPickupDetail(input.pickupId);
}

const allowedAttemptTransitions: Record<string, string[]> = {
  ASSIGNED: ["ACCEPTED"], ACCEPTED: ["EN_ROUTE"], EN_ROUTE: ["ARRIVED"], ARRIVED: ["COLLECTING"]
};

type PickupLocation = { latitude: number; longitude: number; accuracy?: number | null };

export async function transitionDriverAttempt(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; status: string; location?: PickupLocation }) {
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId }).exec();
  if (!attempt) throw new PickupServiceError("Assigned pickup attempt was not found.", 404);
  if (!(allowedAttemptTransitions[attempt.status] ?? []).includes(input.status)) throw new PickupServiceError(`Pickup cannot move from ${attempt.status} to ${input.status}.`, 409);
  const now = new Date();
  attempt.status = input.status as typeof attempt.status;
  if (input.status === "ACCEPTED") attempt.acceptedAt = now;
  if (input.status === "EN_ROUTE") attempt.enRouteAt = now;
  if (input.status === "ARRIVED") {
    attempt.arrivedAt = now;
    if (input.location) attempt.arrivalLocation = { ...input.location, capturedAt: now };
  }
  if (input.status === "COLLECTING") attempt.collectionStartedAt = now;
  await attempt.save();
  if (input.status === "EN_ROUTE") {
    await markPickupStarted({ pickupId: String(attempt.pickupRequestId), actorId: input.driverUserId, source: "DRIVER" });
  } else if (["ARRIVED", "COLLECTING"].includes(input.status)) {
    await PickupRequest.findOneAndUpdate(
      { _id: attempt.pickupRequestId, status: { $nin: ["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS", "CANCELLED", "CLOSED_UNSUCCESSFUL"] } },
      { $set: { status: "IN_PROGRESS" }, $inc: { version: 1 } }
    ).exec();
  }
  await AuditLog.create({ action: "PICKUP_ATTEMPT_STATUS_UPDATED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id, performedBy: input.driverUserId, performedAt: now, metadata: { status: input.status } });
  if (input.status === "EN_ROUTE") {
  }
  return getPickupDetail(String(attempt.pickupRequestId));
}

export async function sendPickupOtp(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId }) {
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId, status: { $in: ["ARRIVED", "COLLECTING"] } }).select("+otpHash +otpExpiresAt +otpAttempts +otpSentAt").exec();
  if (!attempt) throw new PickupServiceError("Arrive at the assigned pickup before requesting the verification code.", 409);
  if (attempt.otpSentAt && Date.now() - attempt.otpSentAt.getTime() < 60_000) throw new PickupServiceError("Wait one minute before requesting another code.", 429);
  const request = await PickupRequest.findById(attempt.pickupRequestId).exec();
  if (!request?.pickupContact.email) throw new PickupServiceError("The pickup requester does not have an account email for verification. Request a supervisor-approved OTP exception.", 409);
  const requester = await User.findById(request.requestedBy).select("name firstName lastName").lean().exec();
  const recipientName = requester?.name?.trim() ||
    [requester?.firstName, requester?.lastName].filter(Boolean).join(" ") ||
    "Client";
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  attempt.otpHash = crypto.createHash("sha256").update(code).digest("hex");
  attempt.otpExpiresAt = expiresAt;
  attempt.otpAttempts = 0;
  attempt.otpSentAt = new Date();
  await attempt.save();
  const delivery = await sendPickupOtpEmail({ to: request.pickupContact.email, name: recipientName, code, requestNumber: request.requestNumber, expiresAt });
  return { sent: delivery.sent, skipped: delivery.skipped, expiresAt };
}

export async function verifyPickupOtp(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; code: string }) {
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId }).select("+otpHash +otpExpiresAt +otpAttempts").exec();
  if (!attempt?.otpHash || !attempt.otpExpiresAt) throw new PickupServiceError("Request a pickup verification code first.", 409);
  if (attempt.otpExpiresAt <= new Date()) throw new PickupServiceError("The verification code has expired. Request a new one.", 409);
  if (attempt.otpAttempts >= 5) throw new PickupServiceError("Too many incorrect attempts. Request a new code.", 429);
  attempt.otpAttempts += 1;
  const supplied = crypto.createHash("sha256").update(input.code).digest();
  const expected = Buffer.from(attempt.otpHash, "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    await attempt.save();
    throw new PickupServiceError("The verification code is incorrect.", 400);
  }
  attempt.otpVerifiedAt = new Date();
  attempt.otpHash = "";
  attempt.otpExpiresAt = null;
  await attempt.save();
  return { verifiedAt: attempt.otpVerifiedAt };
}

export async function requestPickupOtpException(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; reason: string }) {
  const attempt = await PickupAttempt.findOne({
    _id: asObjectId(input.attemptId, "Pickup attempt"),
    assignedDriverUserId: input.driverUserId,
    status: { $in: ["ARRIVED", "COLLECTING"] }
  }).exec();
  if (!attempt) throw new PickupServiceError("Arrive at the assigned pickup before requesting an OTP exception.", 409);
  const now = new Date();
  attempt.otpExceptionReason = input.reason.trim();
  attempt.otpExceptionRequestedAt = now;
  attempt.otpExceptionApprovedBy = null;
  attempt.otpExceptionApprovedAt = null;
  attempt.otpExceptionRejectedBy = null;
  attempt.otpExceptionRejectedAt = null;
  attempt.otpExceptionReviewNote = "";
  await attempt.save();
  await PickupRequest.findByIdAndUpdate(attempt.pickupRequestId, { $set: { status: "ACTION_REQUIRED" }, $inc: { version: 1 } }).exec();
  await AuditLog.create({
    action: "PICKUP_ATTEMPT_STATUS_UPDATED",
    entityType: "PICKUP_ATTEMPT",
    entityId: attempt._id,
    performedBy: input.driverUserId,
    performedAt: now,
    metadata: { status: attempt.status, otpExceptionRequested: true, reason: attempt.otpExceptionReason }
  });
  const request = await PickupRequest.findById(attempt.pickupRequestId).select("businessAccountId branchId requestNumber").lean().exec();
  if (request) await notifyPickupSafely(() => notifyAssignedPickupBranchStaff(request.branchId, {
    type: "PICKUP_ACTION_REQUIRED",
    title: "Pickup OTP exception",
    message: `${request.requestNumber} needs an OTP exception decision.`,
    href: "/dashboard/pickups",
    idempotencyKey: `PICKUP_OTP_EXCEPTION:${String(attempt._id)}:${now.getTime()}`,
    businessAccountId: request.businessAccountId,
    metadata: { pickupRequestId: request._id, attemptId: attempt._id }
  }));
  return getPickupDetail(String(attempt.pickupRequestId));
}

export async function reviewPickupOtpException(input: {
  pickupId: string;
  attemptId: string;
  actorId: mongoose.Types.ObjectId;
  approved: boolean;
  reviewNote?: string;
}) {
  const attempt = await PickupAttempt.findOne({
    _id: asObjectId(input.attemptId, "Pickup attempt"),
    pickupRequestId: asObjectId(input.pickupId, "Pickup request"),
    otpExceptionRequestedAt: { $ne: null },
    status: { $in: ["ARRIVED", "COLLECTING"] }
  }).exec();
  if (!attempt) throw new PickupServiceError("A pending OTP exception was not found for this pickup.", 409);
  const now = new Date();
  attempt.otpExceptionReviewNote = input.reviewNote?.trim() ?? "";
  if (input.approved) {
    attempt.otpExceptionApprovedBy = input.actorId;
    attempt.otpExceptionApprovedAt = now;
    attempt.otpExceptionRejectedBy = null;
    attempt.otpExceptionRejectedAt = null;
  } else {
    attempt.otpExceptionApprovedBy = null;
    attempt.otpExceptionApprovedAt = null;
    attempt.otpExceptionRejectedBy = input.actorId;
    attempt.otpExceptionRejectedAt = now;
  }
  await attempt.save();
  await PickupRequest.findByIdAndUpdate(attempt.pickupRequestId, { $set: { status: "IN_PROGRESS" }, $inc: { version: 1 } }).exec();
  await AuditLog.create({
    action: "PICKUP_ATTEMPT_STATUS_UPDATED",
    entityType: "PICKUP_ATTEMPT",
    entityId: attempt._id,
    performedBy: input.actorId,
    performedAt: now,
    metadata: { status: attempt.status, otpExceptionApproved: input.approved, reviewNote: attempt.otpExceptionReviewNote }
  });
  return getPickupDetail(input.pickupId);
}

export async function scanPickupParcel(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; parcelNumber: string; scanRequestId: string }) {
  const existing = await PickupScan.findOne({ scanRequestId: input.scanRequestId }).lean().exec();
  if (existing) return getPickupDetail(String(existing.pickupRequestId));
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId, status: "COLLECTING" }).exec();
  if (!attempt) throw new PickupServiceError("Start collection before scanning parcels.", 409);
  const parcelNumber = normalized(input.parcelNumber);
  const link = await PickupRequestShipment.findOne({ pickupRequestId: attempt.pickupRequestId, "parcels.parcelNumber": parcelNumber, active: true }).exec();
  if (!link) {
    await PickupScan.create({ pickupRequestId: attempt.pickupRequestId, pickupAttemptId: attempt._id, shipmentDraftId: null, parcelNumber, scanRequestId: input.scanRequestId, status: "REJECTED", message: "This parcel is not expected for the assigned pickup.", scannedBy: input.driverUserId });
    throw new PickupServiceError("This parcel is not expected for the assigned pickup.", 409);
  }
  const duplicate = await PickupScan.exists({ parcelNumber, status: "ACCEPTED" });
  if (duplicate) throw new PickupServiceError("This parcel has already been collected.", 409);
  const parcel = link.parcels.find((item) => normalized(item.parcelNumber) === parcelNumber);
  if (!parcel || parcel.status === "COLLECTED") throw new PickupServiceError("This parcel has already been collected.", 409);
  parcel.status = "COLLECTED";
  parcel.collectedAt = new Date();
  link.status = link.parcels.every((item) => item.status === "COLLECTED") ? "COLLECTED" : "PARTIAL";
  await Promise.all([
    link.save(),
    PickupScan.create({ pickupRequestId: attempt.pickupRequestId, pickupAttemptId: attempt._id, shipmentDraftId: link.shipmentDraftId, parcelNumber, scanRequestId: input.scanRequestId, status: "ACCEPTED", message: "Parcel collected.", scannedBy: input.driverUserId }),
    AuditLog.create({ action: "PICKUP_PARCEL_SCANNED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id, performedBy: input.driverUserId, performedAt: new Date(), metadata: { parcelNumber, shipmentDraftId: link.shipmentDraftId } })
  ]);
  return getPickupDetail(String(attempt.pickupRequestId));
}

export async function recordPickupParcelException(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; parcelNumber: string; status: string; reason: string }) {
  const allowed = ["NOT_READY", "NOT_FOUND", "DAMAGED_AT_HANDOVER", "LABEL_INVALID", "CUSTOMER_REFUSED"];
  if (!allowed.includes(input.status) || !input.reason.trim()) throw new PickupServiceError("Select an exception and enter the reason.");
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId, status: "COLLECTING" }).exec();
  if (!attempt) throw new PickupServiceError("Start collection before recording exceptions.", 409);
  const link = await PickupRequestShipment.findOne({ pickupRequestId: attempt.pickupRequestId, "parcels.parcelNumber": normalized(input.parcelNumber), active: true }).exec();
  const parcel = link?.parcels.find((item) => normalized(item.parcelNumber) === normalized(input.parcelNumber));
  if (!link || !parcel || parcel.status === "COLLECTED") throw new PickupServiceError("The parcel is not available for an exception.", 409);
  parcel.status = input.status as typeof parcel.status;
  parcel.exceptionReason = input.reason.trim();
  link.status = "PARTIAL";
  await link.save();
  return getPickupDetail(String(attempt.pickupRequestId));
}

export async function completePickupAttempt(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId; location?: PickupLocation }) {
  const attempt = await PickupAttempt.findOne({ _id: asObjectId(input.attemptId, "Pickup attempt"), assignedDriverUserId: input.driverUserId, status: "COLLECTING" }).exec();
  if (!attempt) throw new PickupServiceError("Active pickup attempt was not found.", 409);
  if (!attempt.otpVerifiedAt && !attempt.otpExceptionApprovedBy) throw new PickupServiceError("Verify the pickup OTP before completing collection.", 409);
  const proofs = await PickupProof.find({ pickupAttemptId: attempt._id, source: { $ne: "STAFF" } }).select("type").lean().exec();
  const proofTypes = new Set(proofs.map((proof) => proof.type));
  if (!proofTypes.has("SIGNATURE")) throw new PickupServiceError("Capture the customer signature before completing pickup.", 409);
  if (!proofTypes.has("PHOTO")) throw new PickupServiceError("Capture at least one pickup photograph before completing pickup.", 409);
  const links = await PickupRequestShipment.find({ pickupRequestId: attempt.pickupRequestId, active: true }).exec();
  if (links.some((link) => link.parcels.some((parcel) => parcel.status === "PENDING"))) throw new PickupServiceError("Scan every expected parcel or record an exception.", 409);
  const collectedLinks = links.filter((link) => link.parcels.every((parcel) => parcel.status === "COLLECTED"));
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      attempt.status = "COMPLETED";
      attempt.completedAt = now;
      if (input.location) attempt.completionLocation = { ...input.location, capturedAt: now };
      await attempt.save({ session });
      const request = await PickupRequest.findById(attempt.pickupRequestId).session(session).exec();
      if (!request) throw new PickupServiceError("Pickup request was not found.", 404);
      request.status = collectedLinks.length === links.length ? "COLLECTED" : "PARTIALLY_COLLECTED";
      request.version += 1;
      await request.save({ session });
      for (const link of links) {
        link.active = !link.parcels.every((parcel) => parcel.status === "COLLECTED");
        await link.save({ session });
      }
      if (collectedLinks.length) {
        await ShipmentEvent.insertMany(collectedLinks.map((link) => ({
          shipmentDraftId: link.shipmentDraftId,
          dpdShipmentId: link.dpdShipmentId,
          status: "PARCEL_COLLECTED",
          note: `Collected under pickup ${request.requestNumber}.`,
          customerVisible: true,
          source: "PICKUP",
          sourceReference: String(request._id),
          createdBy: input.driverUserId,
          eventAt: now
        })), { session });
        // The driver handing the parcel over settles its charge, exactly as a
        // manually recorded collection does- see chargeFinalizingStatuses. Most
        // collections arrive through this path, so a stamp only on the status
        // endpoint would miss them.
        for (const link of collectedLinks) {
          await markShipmentChargeFinalized({
            shipmentDraftId: link.shipmentDraftId,
            finalizedAt: now,
            session
          });
        }
      }
      await AuditLog.create([{ action: "PICKUP_COMPLETED", entityType: "PICKUP_REQUEST", entityId: request._id, performedBy: input.driverUserId, performedAt: now, metadata: { attemptId: attempt._id, collectedShipments: collectedLinks.length, totalShipments: links.length } }], { session });
    });
  } finally { await session.endSession(); }
  return getPickupDetail(String(attempt.pickupRequestId));
}

export async function driverPickupAttempts(driverUserId: mongoose.Types.ObjectId) {
  const attempts = await PickupAttempt.find({ assignedDriverUserId: driverUserId, status: { $nin: ["CANCELLED"] } }).sort({ "scheduledWindow.startAt": 1 }).lean().exec();
  const requests = await PickupRequest.find({ _id: { $in: attempts.map((attempt) => attempt.pickupRequestId) } }).lean().exec();
  const requestById = new Map(requests.map((request) => [String(request._id), request]));
  return attempts.map((attempt) => ({ ...attempt, id: String(attempt._id), pickup: requestById.get(String(attempt.pickupRequestId)) ?? null }));
}

export async function getDriverPickupAttempt(input: { attemptId: string; driverUserId: mongoose.Types.ObjectId }) {
  const attempt = await PickupAttempt.findOne({
    _id: asObjectId(input.attemptId, "Pickup attempt"),
    assignedDriverUserId: input.driverUserId
  }).select("pickupRequestId").lean().exec();
  if (!attempt) throw new PickupServiceError("Assigned pickup attempt was not found.", 404);
  return getPickupDetail(String(attempt.pickupRequestId));
}
