import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DriverProfile } from "../models/driverProfile.model.js";
import { PickupAttempt } from "../models/pickupAttempt.model.js";
import { PickupCourierAddress } from "../models/pickupCourierAddress.model.js";
import { PickupProof, pickupProofTypeValues } from "../models/pickupEvidence.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { User } from "../models/user.model.js";
import { isSupportedImage, matchesDeclaredType } from "../services/storage/fileSignature.js";
import {
  StorageObjectNotFoundError,
  deleteObject,
  pickupProofKey,
  putObject,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import { resolveEvidenceKey } from "../services/storage/legacyKeys.js";
import {
  PickupServiceError, assignPickupDriver, cancelPickup, completePickupAttempt, confirmPickup,
  createClientPickup, driverPickupAttempts, getClientPickupFormContext, getDriverPickupAttempt, getPickupDetail, listEligiblePickupShipments,
  listPickupRequests, markPickupMissed, markPickupReceivedAtDelhiHub, markPickupStarted, recordPickupParcelException, reschedulePickup, scanPickupParcel, sendPickupOtp,
  requestPickupOtpException, reviewPickupOtpException, transitionDriverAttempt, updatePickupPartnerInfo, verifyPickupOtp
} from "../services/pickup.service.js";
import { parsePickupDateInIndia, parsePickupDateTimeInIndia } from "../services/pickup.service.js";
import { operationsBranchIds } from "../middleware/operationsBranchAccess.middleware.js";
import { pickupRequestStatusValues } from "../models/pickupRequest.model.js";
import { pickupExportColumns } from "../services/export/exportColumns.js";
import { describeFilters, exportFormat, sendTableExport, type TableExportFormat } from "../services/export/tableExportHttp.js";

const pickupAddressSchema = z.object({
    addressLine1: z.string().trim().min(3).max(180),
    addressLine2: z.string().trim().max(180).optional().default(""),
    townOrCity: z.string().trim().min(2).max(100),
    county: z.string().trim().max(100).optional().default(""),
    postcode: z.string().trim().min(3).max(20),
    countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    countryName: z.string().trim().max(100).optional().default(""),
    googlePlaceId: z.string().trim().max(300).optional().default("")
  });
const createSchema = z.object({
  businessAccountId: z.string().min(1),
  shipmentDraftIds: z.array(z.string()).max(100).default([]),
  dispatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dispatchTime: z.string().regex(/^\d{2}:\d{2}$/),
  expectedDelhiArrival: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    window: z.enum(["MORNING", "AFTERNOON", "EVENING", "EXACT"]),
    exactTime: z.string().optional().default("").refine((value) => !value || /^\d{2}:\d{2}$/.test(value))
  }).superRefine((value, context) => {
    if (value.window === "EXACT" && !value.exactTime) context.addIssue({ code: "custom", path: ["exactTime"], message: "Choose the exact Delhi arrival time." });
    if (value.window !== "EXACT" && value.exactTime) context.addIssue({ code: "custom", path: ["exactTime"], message: "Clear the exact time or choose Exact time." });
  }),
  transportCompany: z.string().trim().min(1).max(120),
  contact: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().regex(/^\d{6,30}$/, "Enter a phone number using 6 to 30 digits only.")
  }),
  pickupAddress: pickupAddressSchema,
  totalBoxes: z.coerce.number().int().positive().max(10000).optional(),
  totalWeightKg: z.coerce.number().positive().max(100000).optional(),
  handlingRemarks: z.string().trim().max(500).optional().default("")
});
const courierAddressSchema = z.object({
  branchId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value)),
  companyName: z.string().trim().min(2).max(120).refine((value) => value.toUpperCase() !== "OTHER", "Enter the courier's actual company name."),
  address: pickupAddressSchema,
  contact: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().regex(/^\d{6,30}$/, "Enter a phone number using 6 to 30 digits only.")
  })
});
const cancellationSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const confirmSchema = z.object({});
const assignSchema = z.object({
  attemptId: z.string(), driverProfileId: z.string(),
  vehicle: z.object({ source: z.enum(["COMPANY_OWNED", "DRIVER_OWNED", "HIRED", "VENDOR_OWNED"]).optional(), type: z.string().trim().max(60).optional(), registrationNumber: z.string().trim().max(30).optional() }).default({})
});
const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).nullable().optional()
});

function actor(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown; role?: string; assignedBranches?: mongoose.Types.ObjectId[] } }).user;
  return user?._id && mongoose.Types.ObjectId.isValid(String(user._id))
    ? { id: new mongoose.Types.ObjectId(String(user._id)), role: user.role ?? "", assignedBranches: user.assignedBranches ?? [] }
    : null;
}

/**
 * The id behind a reference, whether or not it was populated. `getPickupDetail`
 * populates `branchId` into a branch document, so comparing it directly would
 * stringify to "[object Object]" and silently fail every branch check.
 */
function refId(value: unknown) {
  return String((value as { _id?: unknown } | null)?._id ?? value);
}

async function loadClientPickupBranchAccess(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount assignedBranches")
    .lean()
    .exec();
  const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((item) => item.businessAccount) } })
    .select("assignedBranch")
    .lean()
    .exec();
  const defaultBranchByAccount = new Map(accounts.map((account) => [String(account._id), account.assignedBranch ? refId(account.assignedBranch) : ""]));
  const branchesByAccount = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const accountId = String(membership.businessAccount);
    const assignedBranches = (membership.assignedBranches ?? []).map(String);
    const accessibleBranches = assignedBranches.length ? assignedBranches : [defaultBranchByAccount.get(accountId) ?? ""];
    const branches = branchesByAccount.get(accountId) ?? new Set<string>();
    for (const branchId of accessibleBranches) if (branchId) branches.add(branchId);
    branchesByAccount.set(accountId, branches);
  }
  return branchesByAccount;
}

async function clientCanAccessPickup(
  userId: mongoose.Types.ObjectId,
  pickup: { businessAccountId: unknown; branchId: unknown }
) {
  const branchesByAccount = await loadClientPickupBranchAccess(userId);
  return branchesByAccount.get(refId(pickup.businessAccountId))?.has(refId(pickup.branchId)) ?? false;
}

function handle(error: unknown, response: Response, next: NextFunction) {
  if (error instanceof PickupServiceError) return response.status(error.statusCode).json({ success: false, message: error.message });
  return next(error);
}

export async function listClientEligiblePickups(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.status(200).json({ success: true, shipments: await listEligiblePickupShipments(user.id) });
  } catch (error) { return handle(error, response, next); }
}

export async function getClientPickupForm(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.status(200).json({ success: true, ...(await getClientPickupFormContext(user.id)) });
  } catch (error) { return handle(error, response, next); }
}

export async function listPickupCourierAddresses(request: Request, response: Response, next: NextFunction) {
  try {
    const allowed = operationsBranchIds(request);
    const branches = await Branch.find({
      status: "ACTIVE",
      ...(allowed === null ? {} : { _id: { $in: allowed } })
    }).select("name code").sort({ name: 1 }).lean().exec();
    const profiles = await PickupCourierAddress.find({ branchId: { $in: branches.map((branch) => branch._id) } })
      .select("branchId companyName address contact updatedAt")
      .sort({ companyName: 1 }).lean().exec();
    return response.status(200).json({ success: true, branches: branches.map((branch) => ({ id: String(branch._id), name: branch.name, code: branch.code })),
      courierAddresses: profiles.map((profile) => ({ id: String(profile._id), branchId: String(profile.branchId), companyName: profile.companyName,
        address: profile.address, contact: profile.contact, updatedAt: profile.updatedAt })) });
  } catch (error) { return handle(error, response, next); }
}

export async function savePickupCourierAddress(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const parsed = courierAddressSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the courier address." });
    const { branchId, companyName, address, contact } = parsed.data;
    const allowed = operationsBranchIds(request);
    if (allowed !== null && !allowed.includes(branchId)) return response.status(403).json({ success: false, message: "You do not have access to this branch." });
    if (!await Branch.exists({ _id: branchId, status: "ACTIVE" })) return response.status(400).json({ success: false, message: "Choose an active branch." });
    const companyKey = companyName.replace(/\s+/g, " ").toUpperCase();
    const profileId = String(request.params.profileId ?? "");
    if (profileId && !mongoose.Types.ObjectId.isValid(profileId)) return response.status(404).json({ success: false, message: "Courier address was not found." });
    if (profileId) {
      const existing = await PickupCourierAddress.findById(profileId).select("branchId").lean().exec();
      if (!existing || (allowed !== null && !allowed.includes(String(existing.branchId)))) return response.status(404).json({ success: false, message: "Courier address was not found." });
    }
    const duplicate = await PickupCourierAddress.exists({ branchId, companyKey, ...(profileId ? { _id: { $ne: profileId } } : {}) });
    if (duplicate) return response.status(409).json({ success: false, message: "This courier already has an address for the selected branch." });
    const values = { branchId, companyName: companyName.replace(/\s+/g, " "), companyKey, address, contact, updatedBy: user.id };
    const profile = profileId
      ? await PickupCourierAddress.findByIdAndUpdate(profileId, { $set: values }, { new: true, runValidators: true }).lean().exec()
      : await PickupCourierAddress.create({ ...values, createdBy: user.id });
    return response.status(profileId ? 200 : 201).json({ success: true, courierAddress: profile });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return response.status(409).json({ success: false, message: "This courier already has an address for the selected branch." });
    return handle(error, response, next);
  }
}

function pickupCreatePayload(request: Request) {
  const raw = (request.body as { request?: unknown } | undefined)?.request;
  if (typeof raw !== "string") return request.body;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new PickupServiceError("Pickup details could not be read. Review the form and try again."); }
}

export async function createClientPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const parsed = createSchema.safeParse(pickupCreatePayload(request));
    if (!parsed.success) return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the pickup details." });
    const uploads = (request.files as Record<string, Express.Multer.File[]> | undefined)?.documents ?? [];
    const pickup = await createClientPickup({
      userId: user.id,
      ...parsed.data,
      dispatchAt: parsePickupDateTimeInIndia(parsed.data.dispatchDate, parsed.data.dispatchTime),
      expectedDelhiArrival: {
        date: parsePickupDateInIndia(parsed.data.expectedDelhiArrival.date),
        window: parsed.data.expectedDelhiArrival.window,
        exactAt: parsed.data.expectedDelhiArrival.window === "EXACT"
          ? parsePickupDateTimeInIndia(parsed.data.expectedDelhiArrival.date, parsed.data.expectedDelhiArrival.exactTime)
          : null
      },
      documents: uploads.map((file) => ({ originalName: file.originalname, mimetype: file.mimetype, size: file.size, buffer: file.buffer }))
    });
    return response.status(201).json({ success: true, message: "Pickup request submitted.", pickup });
  } catch (error) { return handle(error, response, next); }
}

/**
 * Status and requested-window filters, shared by both audiences.
 *
 * The window is matched on `requestedWindow.startAt` rather than createdAt:
 * someone filtering pickups by date means the day of collection, not the day
 * the request happened to be typed.
 */
function pickupQueryFilters(request: Request) {
  const filter: Record<string, unknown> = {};
  const status = typeof request.query.status === "string" ? request.query.status : "";
  if (pickupRequestStatusValues.includes(status as never)) filter.status = status;

  const from = typeof request.query.dateFrom === "string" ? request.query.dateFrom : "";
  const to = typeof request.query.dateTo === "string" ? request.query.dateTo : "";
  if (from || to) {
    filter["requestedWindow.startAt"] = {
      ...(from ? { $gte: new Date(from) } : {}),
      // Inclusive of the whole end day, which is what picking a date means.
      ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {})
    };
  }
  return filter;
}

function sendPickupExport(request: Request, response: Response, format: TableExportFormat, pickups: unknown[]) {
  return sendTableExport(response, format, {
    title: "Pickups",
    columns: pickupExportColumns,
    rows: pickups as never[],
    appliedFilters: describeFilters({
      Status: request.query.status,
      From: request.query.dateFrom,
      To: request.query.dateTo
    })
  });
}

export async function listClientPickupRequests(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const branchesByAccount = await loadClientPickupBranchAccess(user.id);
    const scopeClauses = [...branchesByAccount.entries()]
      .filter(([, branchIds]) => branchIds.size > 0)
      .map(([businessAccountId, branchIds]) => ({
        businessAccountId: new mongoose.Types.ObjectId(businessAccountId),
        branchId: { $in: [...branchIds].map((branchId) => new mongoose.Types.ObjectId(branchId)) }
      }));
    const pickups = await listPickupRequests({
      ...(scopeClauses.length ? { $or: scopeClauses } : { businessAccountId: { $in: [] } }),
      ...pickupQueryFilters(request)
    });
    const format = exportFormat(request);
    if (format) return sendPickupExport(request, response, format, pickups);
    return response.status(200).json({ success: true, pickups });
  } catch (error) { return handle(error, response, next); }
}

const rescheduleSchema = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(80).default("Asia/Kolkata")
});
const clientRescheduleSchema = z.object({
  dispatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dispatchTime: z.string().regex(/^\d{2}:\d{2}$/)
});

export async function rescheduleClientPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    const pickup = await PickupRequest.findById(pickupId).select("businessAccountId branchId").lean().exec();
    if (!pickup || !await clientCanAccessPickup(user.id, pickup)) {
      return response.status(404).json({ success: false, message: "Pickup request was not found." });
    }
    const parsed = clientRescheduleSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Choose a valid pickup window." });
    const startAt = parsePickupDateTimeInIndia(parsed.data.dispatchDate, parsed.data.dispatchTime);
    return response.status(200).json({
      success: true,
      message: "Pickup rescheduled.",
      pickup: await reschedulePickup({ pickupId, actorId: user.id, source: "CLIENT", startAt, endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000), timezone: "Asia/Kolkata" })
    });
  } catch (error) { return handle(error, response, next); }
}

export async function reschedulePickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const parsed = rescheduleSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Choose a valid pickup window." });
    return response.status(200).json({
      success: true,
      message: "Pickup rescheduled.",
      pickup: await reschedulePickup({
        pickupId: String(request.params.pickupId ?? ""), actorId: user.id, source: "ADMIN", ...parsed.data
      })
    });
  } catch (error) { return handle(error, response, next); }
}

export async function markPickupRequestMissed(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Enter why the pickup was missed." });
    return response.status(200).json({
      success: true,
      message: "Pickup marked as missed.",
      pickup: await markPickupMissed({
        pickupId: String(request.params.pickupId ?? ""), actorId: user.id, reason: parsed.data.reason
      })
    });
  } catch (error) { return handle(error, response, next); }
}

export async function getClientPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickup = await getPickupDetail(String(request.params.pickupId ?? ""));
    if (!await clientCanAccessPickup(user.id, pickup)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    return response.status(200).json({ success: true, pickup });
  } catch (error) { return handle(error, response, next); }
}

export async function cancelClientPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    const pickup = await PickupRequest.findById(pickupId).select("businessAccountId branchId").lean().exec();
    if (!pickup || !await clientCanAccessPickup(user.id, pickup)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = cancellationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Enter a cancellation reason." });
    return response.status(200).json({ success: true, message: "Pickup request cancelled.", pickup: await cancelPickup({ pickupId, actorId: user.id, source: "CLIENT", reason: parsed.data.reason }) });
  } catch (error) { return handle(error, response, next); }
}

export async function listInternalPickupRequests(request: Request, response: Response, next: NextFunction) {
  try {
    const allowed = operationsBranchIds(request);
    const filter: Record<string, unknown> = { ...pickupQueryFilters(request) };
    if (allowed !== null) filter.branchId = { $in: allowed };
    const pickups = await listPickupRequests(filter);
    const format = exportFormat(request);
    if (format) return sendPickupExport(request, response, format, pickups);
    return response.status(200).json({ success: true, pickups });
  } catch (error) { return handle(error, response, next); }
}

export async function listAvailablePickupDrivers(request: Request, response: Response, next: NextFunction) {
  try {
    const allowed = operationsBranchIds(request);
    const users = await User.find({
      role: "delivery",
      userStatus: "active",
      ...(allowed === null ? {} : { assignedBranches: { $in: allowed } })
    }).select("firstName lastName name phone assignedBranches").populate("assignedBranches", "name code").lean().exec();
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const profiles = await DriverProfile.find({ userId: { $in: users.map((user) => user._id) }, deliverySubrole: "DRIVER", status: "ACTIVE" }).lean().exec();
    const drivers = profiles.flatMap((profile) => {
      const user = userById.get(String(profile.userId));
      return user ? [{
        id: String(profile._id),
        userId: String(user._id),
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        phone: user.phone ?? "",
        assignedBranches: user.assignedBranches ?? [],
        deliverySubrole: profile.deliverySubrole,
        engagementType: profile.engagementType,
        status: profile.status
      }] : [];
    });
    return response.status(200).json({ success: true, drivers });
  } catch (error) { return handle(error, response, next); }
}

async function internalPickupAccess(request: Request, pickupId: string) {
  const pickup = await PickupRequest.findById(pickupId).select("branchId").lean().exec();
  if (!pickup) return null;
  const allowed = operationsBranchIds(request);
  return allowed === null || allowed.includes(String(pickup.branchId)) ? pickup : null;
}

export async function getInternalPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    return response.status(200).json({ success: true, pickup: await getPickupDetail(pickupId) });
  } catch (error) { return handle(error, response, next); }
}

export async function confirmPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = confirmSchema.safeParse(request.body ?? {});
    if (!parsed.success) return response.status(400).json({ success: false, message: "Pickup approval request is invalid." });
    const result = await confirmPickup({ pickupId, actorId: user.id });
    return response.status(200).json({ success: true, message: "Pickup approved and driver assignment is available.", pickup: result.detail, attemptId: result.attemptId });
  } catch (error) { return handle(error, response, next); }
}

export async function updateInternalPickupStatus(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = z.object({
      status: z.enum(["IN_PROGRESS", "RECEIVED_AT_DELHI_HUB"]),
      receivedParcels: z.array(z.object({
        shipmentDraftId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value)),
        parcelNumber: z.string().trim().min(1).max(80)
      })).max(10000).optional()
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Select a valid pickup status." });
    if (parsed.data.status === "RECEIVED_AT_DELHI_HUB" && !parsed.data.receivedParcels) {
      return response.status(400).json({ success: false, message: "Review the linked parcels before closing the pickup." });
    }
    const pickup = parsed.data.status === "IN_PROGRESS"
      ? await markPickupStarted({ pickupId, actorId: user.id, source: "ADMIN" })
      : await markPickupReceivedAtDelhiHub({ pickupId, actorId: user.id, receivedParcels: parsed.data.receivedParcels ?? [] });
    return response.status(200).json({ success: true, message: "Pickup status updated.", pickup });
  } catch (error) { return handle(error, response, next); }
}

export async function updateInternalPickupPartnerInfo(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = z.object({ information: z.string().trim().max(500) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Pickup partner information must be 500 characters or less." });
    return response.status(200).json({ success: true, message: "Pickup partner information saved.", pickup: await updatePickupPartnerInfo({ pickupId, actorId: user.id, information: parsed.data.information }) });
  } catch (error) { return handle(error, response, next); }
}

export async function assignPickupRequestDriver(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = assignSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the assignment." });
    const pickup = await assignPickupDriver({ pickupId, actorId: user.id, ...parsed.data, vehicle: parsed.data.vehicle as Record<string, string> });
    return response.status(200).json({ success: true, message: "Driver assigned.", pickup });
  } catch (error) { return handle(error, response, next); }
}

export async function cancelInternalPickupRequest(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = cancellationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Enter a cancellation reason." });
    return response.status(200).json({ success: true, message: "Pickup request cancelled.", pickup: await cancelPickup({ pickupId, actorId: user.id, source: "ADMIN", reason: parsed.data.reason }) });
  } catch (error) { return handle(error, response, next); }
}

async function sendProofFile(proofId: string, pickupId: string, response: Response) {
  if (!mongoose.Types.ObjectId.isValid(proofId)) throw new PickupServiceError("Pickup proof was not found.", 404);
  const proof = await PickupProof.findOne({ _id: proofId, pickupRequestId: pickupId }).lean().exec();
  if (!proof) throw new PickupServiceError("Pickup proof was not found.", 404);
  // Proofs captured before storage keys existed still hold an absolute path;
  // resolving covers those as well as rows an early backfill keyed wrongly.
  const key = await resolveEvidenceKey(proof);
  if (!key) throw new PickupServiceError("Pickup proof file was not found.", 404);
  try {
    return await streamObjectToResponse({
      response,
      key,
      contentType: proof.mimeType,
      filename: proof.originalName,
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new PickupServiceError("Pickup proof file was not found.", 404);
    }
    throw error;
  }
}

async function sendPickupDocument(documentId: string, pickupId: string, response: Response) {
  if (!mongoose.Types.ObjectId.isValid(documentId)) throw new PickupServiceError("Pickup document was not found.", 404);
  const pickup = await PickupRequest.findById(pickupId).select("documents").lean().exec();
  const document = pickup?.documents.find((item) => String(item._id) === documentId);
  if (!document) throw new PickupServiceError("Pickup document was not found.", 404);
  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: document.mimeType,
      filename: document.originalName,
      disposition: "attachment"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) throw new PickupServiceError("Pickup document file was not found.", 404);
    throw error;
  }
}

export async function viewClientPickupDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId)) return response.status(404).json({ success: false, message: "Pickup document was not found." });
    const pickup = await PickupRequest.findById(pickupId).select("businessAccountId branchId").lean().exec();
    if (!pickup || !await clientCanAccessPickup(user.id, pickup)) return response.status(404).json({ success: false, message: "Pickup document was not found." });
    return await sendPickupDocument(String(request.params.documentId ?? ""), pickupId, response);
  } catch (error) { return handle(error, response, next); }
}

export async function viewInternalPickupDocument(request: Request, response: Response, next: NextFunction) {
  try {
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup document was not found." });
    return await sendPickupDocument(String(request.params.documentId ?? ""), pickupId, response);
  } catch (error) { return handle(error, response, next); }
}

export async function viewClientPickupProof(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const proofId = String(request.params.proofId ?? "");
    if (!mongoose.Types.ObjectId.isValid(String(request.params.pickupId ?? "")) || !mongoose.Types.ObjectId.isValid(proofId)) return response.status(404).json({ success: false, message: "Pickup proof was not found." });
    const pickup = await PickupRequest.findById(request.params.pickupId).select("businessAccountId branchId status pickupStartedAt").lean().exec();
    if (!pickup || (!pickup.pickupStartedAt && !["COLLECTED", "PARTIALLY_COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(pickup.status)) || pickup.status === "CANCELLED" || !await clientCanAccessPickup(user.id, pickup)) return response.status(404).json({ success: false, message: "Pickup proof was not found." });
    if (!["COLLECTED", "PARTIALLY_COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(pickup.status)) {
      const staffProof = await PickupProof.exists({ _id: proofId, pickupRequestId: pickup._id, source: "STAFF" });
      if (!staffProof) return response.status(404).json({ success: false, message: "Pickup proof was not found." });
    }
    return await sendProofFile(proofId, String(pickup._id), response);
  } catch (error) { return handle(error, response, next); }
}

export async function viewInternalPickupProof(request: Request, response: Response, next: NextFunction) {
  try {
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup proof was not found." });
    return await sendProofFile(String(request.params.proofId ?? ""), pickupId, response);
  } catch (error) { return handle(error, response, next); }
}

export async function uploadInternalPickupProof(request: Request, response: Response, next: NextFunction) {
  let storedKey = "";
  try {
    const user = actor(request);
    if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) {
      return response.status(404).json({ success: false, message: "Pickup request was not found." });
    }
    const file = request.file;
    if (!file) throw new PickupServiceError("Choose a pickup photo.");
    if (!matchesDeclaredType(file.buffer, file.mimetype)) throw new PickupServiceError("The pickup photo is not a valid JPG, PNG, or WebP image.");
    const pickup = await PickupRequest.findById(pickupId).select("currentAttemptId pickupStartedAt status").lean().exec();
    if (!pickup || !pickup.currentAttemptId ||
      ((!pickup.pickupStartedAt && !["COLLECTED", "PARTIALLY_COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(pickup.status)) || pickup.status === "CANCELLED")) {
      throw new PickupServiceError("Start the pickup before adding a proof photo.", 409);
    }
    const attempt = await PickupAttempt.findOne({ _id: pickup.currentAttemptId, pickupRequestId: pickup._id }).select("_id").lean().exec();
    if (!attempt) throw new PickupServiceError("The pickup attempt was not found.", 409);

    storedKey = pickupProofKey(pickupId, file.originalname);
    await putObject({ key: storedKey, body: file.buffer, contentType: file.mimetype, originalName: file.originalname });
    const proof = new PickupProof({ pickupRequestId: pickup._id, pickupAttemptId: attempt._id, type: "PHOTO", source: "STAFF",
      originalName: file.originalname, storageKey: storedKey, mimeType: file.mimetype, size: file.size, capturedBy: user.id });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await proof.save({ session });
        await AuditLog.create([{ action: "PICKUP_PROOF_CAPTURED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id,
          performedBy: user.id, performedAt: new Date(), metadata: { type: "PHOTO", source: "STAFF", proofId: proof._id } }], { session });
      });
    } finally { await session.endSession(); }
    storedKey = "";
    return response.status(201).json({ success: true, message: "Pickup photo saved.", pickup: await getPickupDetail(pickupId) });
  } catch (error) {
    if (storedKey) await deleteObject(storedKey).catch(() => undefined);
    return handle(error, response, next);
  }
}

export async function viewMyPickupProof(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
    const attempt = await PickupAttempt.findOne({ _id: request.params.attemptId, assignedDriverUserId: user.id }).select("pickupRequestId").lean().exec();
    if (!attempt) return response.status(404).json({ success: false, message: "Pickup proof was not found." });
    return await sendProofFile(String(request.params.proofId ?? ""), String(attempt.pickupRequestId), response);
  } catch (error) { return handle(error, response, next); }
}

export async function listMyPickupAttempts(request: Request, response: Response, next: NextFunction) {
  try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); return response.status(200).json({ success: true, attempts: await driverPickupAttempts(user.id) }); }
  catch (error) { return handle(error, response, next); }
}

export async function getMyPickupAttempt(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    return response.status(200).json({ success: true, pickup: await getDriverPickupAttempt({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id }) });
  } catch (error) { return handle(error, response, next); }
}

export async function updateMyPickupAttemptStatus(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ status: z.enum(["ACCEPTED", "EN_ROUTE", "ARRIVED", "COLLECTING"]), location: locationSchema.optional() }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Select a valid pickup status." });
    return response.status(200).json({ success: true, pickup: await transitionDriverAttempt({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, status: parsed.data.status, location: parsed.data.location }) });
  } catch (error) { return handle(error, response, next); }
}

export async function requestMyPickupOtp(request: Request, response: Response, next: NextFunction) {
  try { const user = actor(request); if (!user) return response.status(401).json({ success: false }); return response.status(200).json({ success: true, ...(await sendPickupOtp({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id })) }); }
  catch (error) { return handle(error, response, next); }
}

export async function verifyMyPickupOtp(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Enter the 6-digit pickup code." });
    return response.status(200).json({ success: true, ...(await verifyPickupOtp({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, code: parsed.data.code })) });
  } catch (error) { return handle(error, response, next); }
}

export async function requestMyPickupOtpException(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ reason: z.string().trim().min(5).max(500) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Explain why the pickup OTP cannot be completed." });
    return response.status(200).json({
      success: true,
      message: "OTP exception sent for supervisor review.",
      pickup: await requestPickupOtpException({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, reason: parsed.data.reason })
    });
  } catch (error) { return handle(error, response, next); }
}

export async function reviewPickupRequestOtpException(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const pickupId = String(request.params.pickupId ?? "");
    if (!mongoose.Types.ObjectId.isValid(pickupId) || !await internalPickupAccess(request, pickupId)) return response.status(404).json({ success: false, message: "Pickup request was not found." });
    const parsed = z.object({ attemptId: z.string(), approved: z.boolean(), reviewNote: z.string().trim().max(500).optional() }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Choose an OTP exception decision." });
    return response.status(200).json({
      success: true,
      message: parsed.data.approved ? "OTP exception approved." : "OTP exception rejected.",
      pickup: await reviewPickupOtpException({ pickupId, actorId: user.id, ...parsed.data })
    });
  } catch (error) { return handle(error, response, next); }
}

export async function scanMyPickupParcel(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ parcelNumber: z.string().trim().min(1).max(80), scanRequestId: z.string().trim().min(8).max(100) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Scan a valid parcel label." });
    return response.status(200).json({ success: true, pickup: await scanPickupParcel({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, ...parsed.data }) });
  } catch (error) { return handle(error, response, next); }
}

export async function addMyPickupException(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ parcelNumber: z.string().trim().min(1).max(80), status: z.string(), reason: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ success: false, message: "Enter the parcel exception and reason." });
    return response.status(200).json({ success: true, pickup: await recordPickupParcelException({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, ...parsed.data }) });
  } catch (error) { return handle(error, response, next); }
}


export async function uploadMyPickupProof(request: Request, response: Response, next: NextFunction) {
  const file = request.file;
  // Set once the object is written, so a later failure can unwind it. Nothing
  // before that point needs cleanup: the upload is only an in-memory buffer.
  let storedKey = "";
  try {
    const user = actor(request); if (!user) throw new PickupServiceError("Unauthorized", 401);
    const type = String(request.params.proofType ?? "").toUpperCase();
    if (!pickupProofTypeValues.includes(type as (typeof pickupProofTypeValues)[number])) throw new PickupServiceError("Select photo or signature proof.");
    if (!file) throw new PickupServiceError("Choose a proof image.");
    const attempt = await PickupAttempt.findOne({ _id: request.params.attemptId, assignedDriverUserId: user.id, status: "COLLECTING" }).exec();
    if (!attempt) throw new PickupServiceError("Start the assigned collection before adding proof.", 409);
    if (!isSupportedImage(file.buffer)) throw new PickupServiceError("The proof is not a valid JPG, PNG, or WebP image.");

    storedKey = pickupProofKey(String(attempt.pickupRequestId), file.originalname);
    await putObject({ key: storedKey, body: file.buffer, contentType: file.mimetype, originalName: file.originalname });

    const proof = new PickupProof({ pickupRequestId: attempt.pickupRequestId, pickupAttemptId: attempt._id, type: type as (typeof pickupProofTypeValues)[number], originalName: file.originalname, storageKey: storedKey, mimeType: file.mimetype, size: file.size, capturedBy: user.id });
    await proof.save();
    await AuditLog.create({ action: "PICKUP_PROOF_CAPTURED", entityType: "PICKUP_ATTEMPT", entityId: attempt._id, performedBy: user.id, performedAt: new Date(), metadata: { type, proofId: proof._id } });
    return response.status(201).json({ success: true, message: type === "PHOTO" ? "Pickup photograph saved." : "Customer signature saved." });
  } catch (error) {
    if (storedKey) await deleteObject(storedKey).catch(() => undefined);
    return handle(error, response, next);
  }
}

export async function completeMyPickupAttempt(request: Request, response: Response, next: NextFunction) {
  try {
    const user = actor(request); if (!user) return response.status(401).json({ success: false });
    const parsed = z.object({ location: locationSchema.optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return response.status(400).json({ success: false, message: "The captured GPS location is invalid." });
    return response.status(200).json({ success: true, message: "Pickup completed.", pickup: await completePickupAttempt({ attemptId: String(request.params.attemptId ?? ""), driverUserId: user.id, location: parsed.data.location }) });
  }
  catch (error) { return handle(error, response, next); }
}

export async function requirePickupManager(request: Request, response: Response, next: NextFunction) {
  const user = actor(request);
  if (!user) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (["admin", "operations"].includes(user.role)) return next();
  if (user.role === "delivery" && await DriverProfile.exists({ userId: user.id, deliverySubrole: "SUPERVISOR", status: "ACTIVE" })) return next();
  return response.status(403).json({ success: false, message: "Delivery supervisor access is required." });
}
