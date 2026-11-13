import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import {
  OperationalCalendarEntry,
  calendarEntryCategoryValues
} from "../models/operationalCalendarEntry.model.js";
import {
  ServiceDisruption,
  serviceDisruptionSeverityValues,
  serviceDisruptionTypeValues
} from "../models/serviceDisruption.model.js";
import {
  RegulatoryUpdate,
  deriveRegulatoryUpdateStatus,
  regulatoryShipmentDirectionValues,
  regulatoryShipmentTypeValues,
  regulatoryUpdateCategoryValues,
  regulatoryUpdateStatusValues,
  type IRegulatoryUpdate
} from "../models/regulatoryUpdate.model.js";
import { regulatoryRegionCodes } from "../services/reference/regulatoryRegions.js";
import { dispatchServiceDisruptionNotification } from "../services/serviceDisruptionNotification.service.js";

const objectIdSchema = z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), {
  message: "Invalid identifier"
});

const objectIdOrNullSchema = objectIdSchema.nullable();

/**
 * Accepts a "YYYY-MM-DD" or ISO string (or null) and normalises it to a Date,
 * or null when the field is empty. The frontend sends the raw input[type=date]
 * value, which the wire schema must tolerate before the domain sees a Date.
 */
function optionalDateField() {
  return z
    .union([
      z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "Invalid date"
      }),
      z.null()
    ])
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null));
}

/** 24-hour "HH:mm" clock, with or without a leading zero on the hour. */
const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, { message: "Use 24-hour HH:mm, e.g. 18:00" })
  .nullable();

const affectedBranchesSchema = z
  .array(objectIdSchema)
  .max(200)
  .optional()
  .default([]);

const serviceDisruptionPayloadSchema = z.object({
  type: z.enum(serviceDisruptionTypeValues),
  severity: z.enum(serviceDisruptionSeverityValues).default("INFO"),
  title: z.string().trim().min(1, { message: "A title is required" }).max(120),
  message: z.string().trim().min(1, { message: "A message is required" }).max(500),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().nullable().optional().default(null),
  affectedBranches: affectedBranchesSchema,
  active: z.boolean().default(true)
}).refine((value) => !value.endAt || value.endAt >= value.startAt, {
  message: "The end time cannot be before the start time",
  path: ["endAt"]
});

type ServiceDisruptionPayload = z.infer<typeof serviceDisruptionPayloadSchema>;

const calendarEntryPayloadSchema = z.object({
  category: z.enum(calendarEntryCategoryValues),
  title: z.string().trim().min(1, { message: "A title is required" }).max(120),
  description: z.string().trim().max(500).optional().default(""),
  branchId: objectIdOrNullSchema.optional().default(null),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, { message: "Use a two-letter country code, e.g. IN" })
    .nullable()
    .optional()
    .default(null),
  locationLabel: z.string().trim().max(120).nullable().optional().default(null),
  date: optionalDateField(),
  endDate: optionalDateField(),
  time: timeSchema.optional().default(null),
  weekendDeliveryAvailable: z.boolean().nullable().optional().default(null),
  active: z.boolean().default(true)
}).superRefine((value, ctx) => {
  // Each category owns a fixed subset of the optional fields. Enforcing the
  // required ones here keeps the collection single-schema while still refusing
  // a row the client calendar could not render meaningfully.
  switch (value.category) {
    case "BRANCH_HOLIDAY":
      if (!value.date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "A date is required for a branch holiday." });
      }
      break;
    case "DESTINATION_HOLIDAY":
      if (!value.countryCode) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["countryCode"], message: "A destination country is required." });
      }
      break;
    case "CUSTOMS_HOLIDAY":
      if (!value.countryCode) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["countryCode"], message: "A country is required for a customs holiday." });
      }
      if (!value.date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "A date is required for a customs holiday." });
      }
      break;
    case "PICKUP_CUTOFF":
    case "SAME_DAY_BOOKING_CUTOFF":
      if (!value.time) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "A cut-off time is required." });
      }
      break;
    case "FLIGHT_CLOSING_TIME":
      if (!value.locationLabel) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locationLabel"], message: "A route or airport label is required." });
      }
      if (!value.time) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "A closing time is required." });
      }
      break;
    case "WEEKEND_DELIVERY":
      if (value.weekendDeliveryAvailable === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekendDeliveryAvailable"], message: "Choose whether weekend delivery is available." });
      }
      break;
    case "PEAK_SEASON_RESTRICTION":
      break;
  }

  if (value.date && value.endDate && value.endDate < value.date) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "The end date cannot be before the start date."
    });
  }
});

type CalendarEntryPayload = z.infer<typeof calendarEntryPayloadSchema>;

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function toObjectId(raw: string | undefined): mongoose.Types.ObjectId | null {
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function serializeServiceDisruption(disruption: {
  _id: unknown;
  type: string;
  severity: string;
  title: string;
  message: string;
  startAt?: Date;
  endAt?: Date | null;
  affectedBranches?: unknown[];
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: String(disruption._id),
    type: disruption.type,
    severity: disruption.severity,
    title: disruption.title,
    message: disruption.message,
    startAt: disruption.startAt ?? null,
    endAt: disruption.endAt ?? null,
    affectedBranches: (disruption.affectedBranches ?? []).map((branchId) => String(branchId)),
    active: disruption.active,
    createdAt: disruption.createdAt,
    updatedAt: disruption.updatedAt
  };
}

type CalendarEntryDocument = InstanceType<typeof OperationalCalendarEntry>;

function serializeCalendarEntry(entry: CalendarEntryDocument) {
  const branch = entry.branchId && typeof entry.branchId === "object" && entry.branchId !== null
    ? entry.branchId
    : null;
  const branchId = branch ? String((branch as { _id: unknown })._id) : null;

  return {
    id: String(entry._id),
    category: entry.category,
    title: entry.title,
    description: entry.description ?? "",
    branchId,
    branch: branch
      ? {
        _id: branchId,
        name: (branch as { name?: string }).name ?? "",
        code: (branch as { code?: string }).code ?? ""
      }
      : null,
    countryCode: entry.countryCode ?? null,
    locationLabel: entry.locationLabel ?? null,
    date: entry.date ?? null,
    endDate: entry.endDate ?? null,
    time: entry.time ?? null,
    weekendDeliveryAvailable: entry.weekendDeliveryAvailable ?? null,
    active: entry.active,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

async function writeServiceDisruptionAuditLog(
  action: "SERVICE_DISRUPTION_CREATED" | "SERVICE_DISRUPTION_UPDATED" | "SERVICE_DISRUPTION_DELETED",
  disruptionId: mongoose.Types.ObjectId,
  data: Pick<ServiceDisruptionPayload, "type" | "severity" | "active">,
  userId: mongoose.Types.ObjectId
) {
  await AuditLog.create({
    action,
    entityType: "SERVICE_DISRUPTION",
    entityId: disruptionId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      type: data.type,
      severity: data.severity,
      active: data.active
    }
  });
}

async function writeCalendarEntryAuditLog(
  action: "CALENDAR_ENTRY_CREATED" | "CALENDAR_ENTRY_UPDATED" | "CALENDAR_ENTRY_DELETED",
  entryId: mongoose.Types.ObjectId,
  data: Pick<CalendarEntryPayload, "category" | "active">,
  userId: mongoose.Types.ObjectId
) {
  await AuditLog.create({
    action,
    entityType: "OPERATIONAL_CALENDAR_ENTRY",
    entityId: entryId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      category: data.category,
      active: data.active
    }
  });
}

// ── Staff: service disruptions ───────────────────────────────────────────────

export async function listServiceDisruptions(request: Request, response: Response): Promise<Response> {
  const filters: Record<string, unknown> = {};

  // The marquee (staff variant) shows exactly what clients see, so it asks for
  // the same time-windowed, active-only slice the client endpoint returns.
  if (request.query.scope === "live") {
    const now = new Date();
    filters.active = true;
    filters.startAt = { $lte: now };
    filters.$or = [{ endAt: null }, { endAt: { $gte: now } }];
  } else {
    if (request.query.active === "true") filters.active = true;
    if (request.query.active === "false") filters.active = false;
  }

  if (typeof request.query.type === "string" && request.query.type) filters.type = request.query.type;

  const disruptions = await ServiceDisruption.find(filters)
    .sort({ startAt: -1 })
    .lean()
    .exec();

  return response.status(200).json({
    success: true,
    disruptions: disruptions.map(serializeServiceDisruption)
  });
}

export async function createServiceDisruption(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = serviceDisruptionPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const disruption = await ServiceDisruption.create({
    ...parsed.data,
    createdBy: userId
  });

  await writeServiceDisruptionAuditLog(
    "SERVICE_DISRUPTION_CREATED",
    disruption._id as mongoose.Types.ObjectId,
    parsed.data,
    userId
  );
  await dispatchServiceDisruptionNotification(disruption, "PUBLISHED");

  return response.status(201).json({
    success: true,
    disruption: serializeServiceDisruption(disruption)
  });
}

export async function updateServiceDisruption(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const disruptionId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!disruptionId) return response.status(404).json({ success: false, message: "Disruption not found" });

  const parsed = serviceDisruptionPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const existing = await ServiceDisruption.findById(disruptionId).exec();
  if (!existing) return response.status(404).json({ success: false, message: "Disruption not found" });

  const wasActive = existing.active;

  const disruption = await ServiceDisruption.findByIdAndUpdate(
    disruptionId,
    { ...parsed.data, updatedBy: userId },
    { new: true, runValidators: true }
  ).exec();

  if (!disruption) return response.status(500).json({ success: false, message: "Disruption could not be saved" });

  await writeServiceDisruptionAuditLog(
    "SERVICE_DISRUPTION_UPDATED",
    disruptionId,
    parsed.data,
    userId
  );

  // An activation is a publish; changes to a live advisory are a new version
  // and notify the same audiences again. Inactive advisories stay silent.
  await dispatchServiceDisruptionNotification(disruption, wasActive ? "UPDATED" : "PUBLISHED");

  return response.status(200).json({
    success: true,
    disruption: serializeServiceDisruption(disruption)
  });
}

export async function deleteServiceDisruption(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const disruptionId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!disruptionId) return response.status(404).json({ success: false, message: "Disruption not found" });

  const disruption = await ServiceDisruption.findByIdAndDelete(disruptionId).exec();
  if (!disruption) return response.status(404).json({ success: false, message: "Disruption not found" });

  await writeServiceDisruptionAuditLog(
    "SERVICE_DISRUPTION_DELETED",
    disruptionId,
    {
      type: disruption.type,
      severity: disruption.severity,
      active: disruption.active
    },
    userId
  );

  return response.status(200).json({ success: true, message: "Disruption deleted" });
}

// ── Staff: calendar entries ──────────────────────────────────────────────────

export async function listCalendarEntries(request: Request, response: Response): Promise<Response> {
  const filters: Record<string, unknown> = {};

  if (request.query.active === "true") filters.active = true;
  if (request.query.active === "false") filters.active = false;
  if (typeof request.query.category === "string" && request.query.category) {
    filters.category = request.query.category;
  }

  const entries = await OperationalCalendarEntry.find(filters)
    .sort({ category: 1, date: 1 })
    .populate({ path: "branchId", select: "name code" })
    .exec();

  return response.status(200).json({
    success: true,
    entries: entries.map(serializeCalendarEntry)
  });
}

export async function createCalendarEntry(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = calendarEntryPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const entry = await OperationalCalendarEntry.create({
    ...parsed.data,
    createdBy: userId
  });
  await entry.populate({ path: "branchId", select: "name code" });

  await writeCalendarEntryAuditLog(
    "CALENDAR_ENTRY_CREATED",
    entry._id as mongoose.Types.ObjectId,
    parsed.data,
    userId
  );

  return response.status(201).json({
    success: true,
    entry: serializeCalendarEntry(entry)
  });
}

export async function updateCalendarEntry(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const entryId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!entryId) return response.status(404).json({ success: false, message: "Calendar entry not found" });

  const parsed = calendarEntryPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const existing = await OperationalCalendarEntry.findById(entryId).exec();
  if (!existing) return response.status(404).json({ success: false, message: "Calendar entry not found" });

  const entry = await OperationalCalendarEntry.findByIdAndUpdate(
    entryId,
    { ...parsed.data, updatedBy: userId },
    { new: true, runValidators: true }
  ).exec();

  if (!entry) return response.status(500).json({ success: false, message: "Calendar entry could not be saved" });
  await entry.populate({ path: "branchId", select: "name code" });

  await writeCalendarEntryAuditLog(
    "CALENDAR_ENTRY_UPDATED",
    entryId,
    parsed.data,
    userId
  );

  return response.status(200).json({
    success: true,
    entry: serializeCalendarEntry(entry)
  });
}

export async function deleteCalendarEntry(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const entryId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!entryId) return response.status(404).json({ success: false, message: "Calendar entry not found" });

  const entry = await OperationalCalendarEntry.findByIdAndDelete(entryId).exec();
  if (!entry) return response.status(404).json({ success: false, message: "Calendar entry not found" });

  await writeCalendarEntryAuditLog(
    "CALENDAR_ENTRY_DELETED",
    entryId,
    { category: entry.category, active: entry.active },
    userId
  );

  return response.status(200).json({ success: true, message: "Calendar entry deleted" });
}

// ── Client-facing (mounted under the client router, client role only) ────────

/** Severity rank drives the marquee ordering: critical first, then newest. */
const severityRank: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

export async function listClientServiceDisruptions(_request: Request, response: Response): Promise<Response> {
  const now = new Date();

  const disruptions = await ServiceDisruption.find({
    active: true,
    startAt: { $lte: now },
    $or: [{ endAt: null }, { endAt: { $gte: now } }]
  })
    .lean()
    .exec();

  const ordered = disruptions.sort((left, right) => {
    const rankDelta = (severityRank[left.severity] ?? 9) - (severityRank[right.severity] ?? 9);
    if (rankDelta !== 0) return rankDelta;
    return new Date(right.startAt ?? 0).getTime() - new Date(left.startAt ?? 0).getTime();
  });

  return response.status(200).json({
    success: true,
    disruptions: ordered.map(serializeServiceDisruption)
  });
}

export async function listClientCalendarEntries(_request: Request, response: Response): Promise<Response> {
  const entries = await OperationalCalendarEntry.find({ active: true })
    .sort({ category: 1, date: 1, createdAt: -1 })
    .populate({ path: "branchId", select: "name code" })
    .exec();

  return response.status(200).json({
    success: true,
    entries: entries.map(serializeCalendarEntry)
  });
}

// ── Customs & regulatory updates ─────────────────────────────────────────────

/**
 * "All" is not one option among many- it swallows the others. Collapsing the
 * selection here means the client view never has to render "All · Import".
 */
function normaliseMultiSelect<T extends string>(values: T[], fallback: T): T[] {
  const unique = Array.from(new Set(values));
  if (!unique.length || unique.includes(fallback)) return [fallback];
  return unique;
}

const regulatoryUpdatePayloadSchema = z.object({
  regions: z
    .array(z.string().trim().toUpperCase())
    .min(1, { message: "Choose at least one country or region" })
    .max(40)
    .refine((values) => values.every((value) => regulatoryRegionCodes.includes(value)), {
      message: "One of the selected countries or regions is not recognised"
    }),
  category: z.enum(regulatoryUpdateCategoryValues),
  title: z.string().trim().min(1, { message: "A title is required" }).max(160),
  effectiveFrom: optionalDateField(),
  effectiveFromTbc: z.boolean().default(false),
  effectiveUntil: optionalDateField(),
  statusOverride: z.enum(regulatoryUpdateStatusValues).nullable().optional().default(null),
  affectedShipments: z
    .array(z.enum(regulatoryShipmentDirectionValues))
    .optional()
    .default(["ALL"]),
  shipmentTypes: z
    .array(z.enum(regulatoryShipmentTypeValues))
    .optional()
    .default(["ALL"]),
  valueThreshold: z.string().trim().max(80).nullable().optional().default(null),
  customerImpact: z
    .string()
    .trim()
    .min(1, { message: "Describe how this affects the customer" })
    .max(800),
  actionRequired: z.string().trim().max(800).optional().default(""),
  sourceUrl: z
    .union([
      z.string().trim().url({ message: "Use a full link, e.g. https://www.gov.uk/..." }).max(500),
      z.literal(""),
      z.null()
    ])
    .optional()
    .default(null)
    .transform((value) => value || null),
  active: z.boolean().default(true)
}).superRefine((value, ctx) => {
  // Effective From is required on the form, but "to be confirmed" is a real
  // answer- a reform is often announced long before a date exists. Exactly one
  // of the two must be supplied so an entry can never be silently undated.
  if (!value.effectiveFrom && !value.effectiveFromTbc) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveFrom"],
      message: "Give an effective date, or mark it as to be confirmed."
    });
  }

  if (value.effectiveFrom && value.effectiveFromTbc) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveFromTbc"],
      message: "Clear the date before marking it as to be confirmed."
    });
  }

  if (value.effectiveFrom && value.effectiveUntil && value.effectiveUntil < value.effectiveFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveUntil"],
      message: "The end date cannot be before the effective date."
    });
  }
});

type RegulatoryUpdatePayload = z.infer<typeof regulatoryUpdatePayloadSchema>;

/** Everything the wire payload needs settled before it reaches the collection. */
function toRegulatoryUpdateDocument(payload: RegulatoryUpdatePayload) {
  return {
    ...payload,
    affectedShipments: normaliseMultiSelect(payload.affectedShipments, "ALL"),
    shipmentTypes: normaliseMultiSelect(payload.shipmentTypes, "ALL"),
    valueThreshold: payload.valueThreshold || null,
    sourceUrl: payload.sourceUrl || null
  };
}

type RegulatoryUpdateSource = Pick<
  IRegulatoryUpdate,
  | "regions"
  | "category"
  | "title"
  | "effectiveFrom"
  | "effectiveFromTbc"
  | "effectiveUntil"
  | "statusOverride"
  | "affectedShipments"
  | "shipmentTypes"
  | "valueThreshold"
  | "customerImpact"
  | "actionRequired"
  | "sourceUrl"
  | "active"
  | "createdAt"
  | "updatedAt"
> & { _id: unknown };

function serializeRegulatoryUpdate(update: RegulatoryUpdateSource) {
  return {
    id: String(update._id),
    regions: update.regions ?? [],
    category: update.category,
    title: update.title,
    effectiveFrom: update.effectiveFrom ?? null,
    effectiveFromTbc: update.effectiveFromTbc ?? false,
    effectiveUntil: update.effectiveUntil ?? null,
    statusOverride: update.statusOverride ?? null,
    // The derived value is what every reader shows. `statusOverride` rides
    // along only so the admin form can round-trip a pinned status.
    status: deriveRegulatoryUpdateStatus(update),
    affectedShipments: update.affectedShipments ?? ["ALL"],
    shipmentTypes: update.shipmentTypes ?? ["ALL"],
    valueThreshold: update.valueThreshold ?? null,
    customerImpact: update.customerImpact,
    actionRequired: update.actionRequired ?? "",
    sourceUrl: update.sourceUrl ?? null,
    active: update.active,
    createdAt: update.createdAt,
    // Shown as "Last Updated": the timestamp the schema already maintains,
    // never a field anyone types.
    updatedAt: update.updatedAt
  };
}

async function writeRegulatoryUpdateAuditLog(
  action: "REGULATORY_UPDATE_CREATED" | "REGULATORY_UPDATE_UPDATED" | "REGULATORY_UPDATE_DELETED",
  updateId: mongoose.Types.ObjectId,
  data: Pick<RegulatoryUpdatePayload, "category" | "regions" | "active">,
  userId: mongoose.Types.ObjectId
) {
  await AuditLog.create({
    action,
    entityType: "REGULATORY_UPDATE",
    entityId: updateId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      category: data.category,
      regions: data.regions,
      active: data.active
    }
  });
}

// ── Staff: regulatory updates ────────────────────────────────────────────────

export async function listRegulatoryUpdates(request: Request, response: Response): Promise<Response> {
  const filters: Record<string, unknown> = {};

  if (request.query.active === "true") filters.active = true;
  if (request.query.active === "false") filters.active = false;
  if (typeof request.query.category === "string" && request.query.category) {
    filters.category = request.query.category;
  }
  if (typeof request.query.region === "string" && request.query.region) {
    filters.regions = request.query.region.toUpperCase();
  }

  const updates = await RegulatoryUpdate.find(filters)
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean()
    .exec();

  const serialized = updates.map(serializeRegulatoryUpdate);

  // Status is derived, so it can never be a Mongo filter: the narrowing happens
  // after serialization, against the same value the caller will render.
  const status = typeof request.query.status === "string" ? request.query.status : "";

  return response.status(200).json({
    success: true,
    updates: status ? serialized.filter((update) => update.status === status) : serialized
  });
}

export async function createRegulatoryUpdate(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = regulatoryUpdatePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const update = await RegulatoryUpdate.create({
    ...toRegulatoryUpdateDocument(parsed.data),
    createdBy: userId
  });

  await writeRegulatoryUpdateAuditLog(
    "REGULATORY_UPDATE_CREATED",
    update._id as mongoose.Types.ObjectId,
    parsed.data,
    userId
  );

  return response.status(201).json({
    success: true,
    update: serializeRegulatoryUpdate(update)
  });
}

export async function updateRegulatoryUpdate(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const updateId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!updateId) return response.status(404).json({ success: false, message: "Regulatory update not found" });

  const parsed = regulatoryUpdatePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const update = await RegulatoryUpdate.findByIdAndUpdate(
    updateId,
    { ...toRegulatoryUpdateDocument(parsed.data), updatedBy: userId },
    { new: true, runValidators: true }
  ).exec();

  if (!update) return response.status(404).json({ success: false, message: "Regulatory update not found" });

  await writeRegulatoryUpdateAuditLog(
    "REGULATORY_UPDATE_UPDATED",
    updateId,
    parsed.data,
    userId
  );

  return response.status(200).json({
    success: true,
    update: serializeRegulatoryUpdate(update)
  });
}

export async function deleteRegulatoryUpdate(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const updateId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!updateId) return response.status(404).json({ success: false, message: "Regulatory update not found" });

  const update = await RegulatoryUpdate.findByIdAndDelete(updateId).exec();
  if (!update) return response.status(404).json({ success: false, message: "Regulatory update not found" });

  await writeRegulatoryUpdateAuditLog(
    "REGULATORY_UPDATE_DELETED",
    updateId,
    { category: update.category, regions: update.regions, active: update.active },
    userId
  );

  return response.status(200).json({ success: true, message: "Regulatory update deleted" });
}

// ── Client: regulatory updates ───────────────────────────────────────────────

/** Upcoming rules lead: they are the ones a client can still prepare for. */
const regulatoryStatusRank: Record<string, number> = { UPCOMING: 0, ACTIVE: 1, EXPIRED: 2 };

/**
 * Published, still-relevant regulatory updates. Expired ones are dropped: the
 * status exists so staff can watch an entry age out, not so clients read rules
 * that no longer apply.
 */
export async function listClientRegulatoryUpdates(_request: Request, response: Response): Promise<Response> {
  const updates = await RegulatoryUpdate.find({ active: true })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean()
    .exec();

  const ordered = updates
    .map(serializeRegulatoryUpdate)
    .filter((update) => update.status !== "EXPIRED")
    .sort((left, right) => {
      const rankDelta = (regulatoryStatusRank[left.status] ?? 9) - (regulatoryStatusRank[right.status] ?? 9);
      if (rankDelta !== 0) return rankDelta;
      return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
    });

  return response.status(200).json({ success: true, updates: ordered });
}
