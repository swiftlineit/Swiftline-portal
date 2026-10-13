import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { BookingPause, bookingPauseCountryValues, deriveBookingPauseStatus } from "../models/bookingPause.model.js";
import { DpdBookingSetting } from "../models/dpdBookingSetting.model.js";
import { isDpdBookingEnabled } from "../services/bookingPause.service.js";
import { BOOKING_PAUSE_COUNTRY_LABELS, EUROPE_COUNTRY_CODES } from "../services/reference/europeCountryCodes.js";

const objectIdSchema = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), { message: "Invalid identifier" });
const dpdBookingSettingSchema = z.object({ enabled: z.boolean() }).strict();

const bookingPausePayloadSchema = z
  .object({
    countries: z
      .array(z.enum(bookingPauseCountryValues))
      .min(1, { message: "Select at least one destination" })
      .max(20),
    startAt: z.coerce.date({ message: "Start date is required" }),
    endAt: z.coerce.date({ message: "End date is required" }),
    reason: z.string().trim().min(1, { message: "Reason is required" }).max(500, { message: "Reason must be 500 characters or fewer" }),
    active: z.boolean().default(true)
  })
  .refine((v) => v.endAt >= v.startAt, { message: "End date cannot be before start date", path: ["endAt"] })
  .transform((v) => {
    // Normalize ALL: if ALL is selected it supersedes other selections
    let countries = Array.from(new Set(v.countries));
    if (countries.includes("ALL")) countries = ["ALL"];
    // Normalize dates to inclusive window: start 00:00:00, end 23:59:59.999
    const startAt = new Date(v.startAt);
    startAt.setHours(0, 0, 0, 0);
    const endAt = new Date(v.endAt);
    endAt.setHours(23, 59, 59, 999);
    const countryLabels = countries.map((c) => BOOKING_PAUSE_COUNTRY_LABELS[c] ?? c);
    return { ...v, countries: countries as typeof v.countries, startAt, endAt, countryLabels };
  });

type BookingPausePayload = z.infer<typeof bookingPausePayloadSchema>;

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function toObjectId(raw: string | undefined): mongoose.Types.ObjectId | null {
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function serializeBookingPause(pause: {
  _id: unknown;
  countries: string[];
  countryLabels?: string[];
  startAt: Date;
  endAt: Date;
  reason: string;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  const base = {
    id: String(pause._id),
    countries: pause.countries ?? [],
    countryLabels: pause.countryLabels ?? (pause.countries ?? []).map((c) => BOOKING_PAUSE_COUNTRY_LABELS[c] ?? c),
    startAt: pause.startAt,
    endAt: pause.endAt,
    reason: pause.reason,
    active: pause.active,
    createdAt: pause.createdAt,
    updatedAt: pause.updatedAt
  };
  return {
    ...base,
    status: deriveBookingPauseStatus({ active: base.active, startAt: base.startAt, endAt: base.endAt })
  };
}

async function writeAudit(
  action: "BOOKING_PAUSE_CREATED" | "BOOKING_PAUSE_UPDATED" | "BOOKING_PAUSE_DELETED" | "BOOKING_PAUSE_TOGGLED",
  pauseId: mongoose.Types.ObjectId,
  data: Partial<Pick<BookingPausePayload, "countries" | "active"> & { reason?: string }>,
  userId: mongoose.Types.ObjectId
) {
  await AuditLog.create({
    action,
    entityType: "BOOKING_PAUSE" as never,
    entityId: pauseId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      countries: data.countries ?? [],
      active: data.active,
      ...(data.reason ? { reason: data.reason } : {})
    }
  });
}

// ── Staff ──────────────────────────────────────────────────────────

export async function listBookingPauses(request: Request, response: Response): Promise<Response> {
  const filters: Record<string, unknown> = {};

  if (request.query.active === "true") filters.active = true;
  if (request.query.active === "false") filters.active = false;

  if (request.query.scope === "live") {
    const now = new Date();
    filters.active = true;
    filters.startAt = { $lte: now };
    filters.endAt = { $gte: now };
  }

  if (typeof request.query.country === "string" && request.query.country) {
    const code = request.query.country.toString().trim().toUpperCase();
    // Match direct token or pauses that cover this country via EUROPE/ALL
    // For list filtering, match any pause that contains ALL, EUROPE (if European), or the exact code
    const isEuropean = (EUROPE_COUNTRY_CODES as readonly string[]).includes(code) || code === "GB" || code === "UK";
    const tokens: string[] = [code === "UK" ? "GB" : code];
    if (isEuropean) tokens.push("EUROPE");
    tokens.push("ALL");
    filters.countries = { $in: tokens };
  }

  const [pauses, dpdBookingEnabled] = await Promise.all([
    BookingPause.find(filters).sort({ startAt: -1 }).lean().exec(),
    isDpdBookingEnabled()
  ]);

  return response.status(200).json({
    success: true,
    dpdBookingEnabled,
    pauses: pauses.map((p) =>
      serializeBookingPause({
        _id: p._id,
        countries: p.countries as string[],
        countryLabels: (p as unknown as { countryLabels?: string[] }).countryLabels,
        startAt: p.startAt as Date,
        endAt: p.endAt as Date,
        reason: p.reason,
        active: p.active,
        createdAt: p.createdAt as Date,
        updatedAt: p.updatedAt as Date
      })
    )
  });
}

export async function createBookingPause(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = bookingPausePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const pause = await BookingPause.create({
    ...parsed.data,
    createdBy: userId
  });

  await writeAudit("BOOKING_PAUSE_CREATED", pause._id as mongoose.Types.ObjectId, parsed.data, userId);

  return response.status(201).json({ success: true, pause: serializeBookingPause(pause) });
}

export async function updateBookingPause(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const pauseId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!pauseId) return response.status(404).json({ success: false, message: "Booking pause not found" });

  const parsed = bookingPausePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const existing = await BookingPause.findById(pauseId).exec();
  if (!existing) return response.status(404).json({ success: false, message: "Booking pause not found" });

  const pause = await BookingPause.findByIdAndUpdate(
    pauseId,
    { ...parsed.data, updatedBy: userId },
    { new: true, runValidators: true }
  ).exec();

  if (!pause) return response.status(500).json({ success: false, message: "Booking pause could not be saved" });

  await writeAudit("BOOKING_PAUSE_UPDATED", pauseId, parsed.data, userId);

  return response.status(200).json({ success: true, pause: serializeBookingPause(pause) });
}

export async function toggleBookingPause(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const pauseId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!pauseId) return response.status(404).json({ success: false, message: "Booking pause not found" });

  const pause = await BookingPause.findById(pauseId).exec();
  if (!pause) return response.status(404).json({ success: false, message: "Booking pause not found" });

  pause.active = !pause.active;
  pause.updatedBy = userId;
  await pause.save();

  await writeAudit("BOOKING_PAUSE_TOGGLED", pauseId, { countries: pause.countries as never, active: pause.active }, userId);

  return response.status(200).json({ success: true, pause: serializeBookingPause(pause) });
}

export async function deleteBookingPause(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const pauseId = toObjectId(typeof request.params.id === "string" ? request.params.id : "");
  if (!pauseId) return response.status(404).json({ success: false, message: "Booking pause not found" });

  const pause = await BookingPause.findByIdAndDelete(pauseId).exec();
  if (!pause) return response.status(404).json({ success: false, message: "Booking pause not found" });

  await writeAudit(
    "BOOKING_PAUSE_DELETED",
    pauseId,
    { countries: pause.countries as never, active: pause.active, reason: pause.reason },
    userId
  );

  return response.status(200).json({ success: true, message: "Booking pause deleted" });
}

// ── Client / Public active ───────────────────────────────────────

export async function listActiveBookingPauses(_request: Request, response: Response): Promise<Response> {
  const now = new Date();
  const [pauses, dpdBookingEnabled] = await Promise.all([
    BookingPause.find({
      active: true,
      startAt: { $lte: now },
      endAt: { $gte: now }
    }).sort({ startAt: 1 }).lean().exec(),
    isDpdBookingEnabled()
  ]);

  return response.status(200).json({
    success: true,
    dpdBookingEnabled,
    pauses: pauses.map((p) =>
      serializeBookingPause({
        _id: p._id,
        countries: p.countries as string[],
        countryLabels: (p as unknown as { countryLabels?: string[] }).countryLabels,
        startAt: p.startAt as Date,
        endAt: p.endAt as Date,
        reason: p.reason,
        active: p.active,
        createdAt: p.createdAt as Date,
        updatedAt: p.updatedAt as Date
      })
    )
  });
}

export async function listClientBookingPauses(_request: Request, response: Response): Promise<Response> {
  return listActiveBookingPauses(_request, response);
}

export async function updateDpdBookingSetting(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = dpdBookingSettingSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Choose whether DPD booking is enabled." });
  }

  const setting = await DpdBookingSetting.findOneAndUpdate(
    { key: "GLOBAL" },
    { $set: { enabled: parsed.data.enabled, updatedBy: userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();

  await AuditLog.create({
    action: "DPD_BOOKING_SETTING_UPDATED",
    entityType: "DPD_BOOKING_SETTING",
    entityId: setting._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { enabled: setting.enabled }
  });

  return response.status(200).json({ success: true, dpdBookingEnabled: setting.enabled });
}
