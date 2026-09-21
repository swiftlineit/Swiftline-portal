import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { CarrierApiRateBucket } from "../../models/carrierApiRateBucket.model.js";
import { CarrierTrackingEvent } from "../../models/carrierTrackingEvent.model.js";
import { CarrierTrackingSync } from "../../models/carrierTrackingSync.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import {
  ShipmentEvent,
  shipmentMilestoneKey,
  type ShipmentEventStatus
} from "../../models/shipmentEvent.model.js";
import { runWithConcurrency } from "../../utils/runWithConcurrency.js";
import { SYSTEM_ACTOR_ID } from "../../utils/systemActor.js";
import { readShipmentBookingSnapshot } from "../shipmentBookingSnapshot.service.js";
import { resolveShipmentEventNote } from "../shipmentEventCopy.service.js";
import { findMissingPrerequisites } from "../shipmentStatusSequence.service.js";

const ALS_TRACKING_CONCURRENCY = 3;
const ALS_TRACKING_REQUESTS_PER_MINUTE = 30;
const ALS_TRACKING_REQUESTS_PER_DAY = 25_000;
const ALS_MANUAL_REQUESTS_PER_USER_HOUR = 20;
const ALS_MANUAL_AWB_COOLDOWN_MS = 5 * 60 * 1000;

export class AlsTrackingServiceError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
  }
}

export type AlsTrackingProviderEvent = {
  id: string;
  eventAt: string;
  eventState: string;
  description: string;
  location: string;
  countryCode: string;
  rawPayload: Record<string, unknown>;
};

type AlsTrackingConfiguration = {
  apiUrl: string;
  companyId: number;
  customerCode: string;
  timeoutMs: number;
};

export function readAlsTrackingConfiguration():
  | { ok: true; configuration: AlsTrackingConfiguration }
  | { ok: false; missing: string[] } {
  const missing = [
    !env.ALS_TRACKING_API_URL && "ALS_TRACKING_API_URL",
    !env.ALS_TRACKING_COMPANY_ID && "ALS_TRACKING_COMPANY_ID",
    !env.ALS_TRACKING_CUSTOMER_CODE && "ALS_TRACKING_CUSTOMER_CODE"
  ].filter((value): value is string => Boolean(value));
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    configuration: {
      apiUrl: env.ALS_TRACKING_API_URL as string,
      companyId: env.ALS_TRACKING_COMPANY_ID as number,
      customerCode: env.ALS_TRACKING_CUSTOMER_CODE as string,
      timeoutMs: env.ALS_TRACKING_TIMEOUT_MS
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function parseAlsIndiaTimestamp(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number];
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second) - (330 * 60 * 1000);
  const indiaClock = new Date(timestamp + (330 * 60 * 1000));
  if (
    indiaClock.getUTCFullYear() !== year
      || indiaClock.getUTCMonth() !== month - 1
      || indiaClock.getUTCDate() !== day
      || indiaClock.getUTCHours() !== hour
      || indiaClock.getUTCMinutes() !== minute
      || indiaClock.getUTCSeconds() !== second
  ) return null;
  return new Date(timestamp);
}

export function parseAlsTrackingResponse(payload: unknown, carrierAwbNumber: string): AlsTrackingProviderEvent[] {
  const docket = Array.isArray(payload) ? record(payload[0]) : record(payload);
  if (!Object.keys(docket).length) throw new AlsTrackingServiceError("ALS returned an empty tracking response.");
  if (docket.errors && docket.errors !== false) {
    throw new AlsTrackingServiceError(text(docket.message) || "ALS could not find this tracking number.", 409);
  }
  const returnedAwb = text(docket.tracking_no);
  if (returnedAwb && returnedAwb !== carrierAwbNumber) {
    throw new AlsTrackingServiceError("ALS returned tracking data for a different AWB.");
  }
  const events = Array.isArray(docket.docket_events) ? docket.docket_events : [];
  return events.map((value) => {
    const item = record(value);
    return {
      id: text(item.id),
      eventAt: text(item.event_at),
      eventState: text(item.event_state).toLowerCase(),
      description: text(item.event_description),
      location: text(item.event_location),
      countryCode: text(item.add_country_code).toUpperCase(),
      rawPayload: item
    };
  }).filter((event) => event.id || event.eventAt || event.description);
}

export function mapAlsTrackingEvent(
  event: AlsTrackingProviderEvent,
  destinationCountryCode: string
): ShipmentEventStatus | null {
  const description = event.description.toLowerCase();
  if (event.eventState === "delivered") return "DELIVERED";
  if (event.eventState === "redrs" && description.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  if (
    event.eventState === "in_transit"
      && Boolean(destinationCountryCode)
      && event.countryCode === destinationCountryCode.trim().toUpperCase()
      && /confirmed at (hub|depot)|arrived at (hub|depot)/i.test(event.description)
  ) return "DESTINATION_ARRIVED";
  return null;
}

function providerEventKey(event: AlsTrackingProviderEvent) {
  if (event.id) return event.id;
  return crypto.createHash("sha256")
    .update([event.eventAt, event.eventState, event.description, event.location].join("|"))
    .digest("hex")
    .slice(0, 40);
}

function indiaDayKey(now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

async function reserveRateBucket(key: string, limit: number, expiresAt: Date) {
  try {
    const reserved = await CarrierApiRateBucket.findOneAndUpdate(
      { key, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" }
    ).lean().exec();
    if (!reserved) throw new AlsTrackingServiceError("ALS tracking request limit reached. Try again later.", 429);
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new AlsTrackingServiceError("ALS tracking request limit reached. Try again later.", 429);
    }
    throw error;
  }
}

async function reserveAlsRequest(now = new Date()) {
  const minuteKey = now.toISOString().slice(0, 16);
  await reserveRateBucket(
    `ALS:MINUTE:${minuteKey}`,
    ALS_TRACKING_REQUESTS_PER_MINUTE,
    new Date(now.getTime() + 2 * 60 * 60 * 1000)
  );
  await reserveRateBucket(
    `ALS:DAY:${indiaDayKey(now)}`,
    ALS_TRACKING_REQUESTS_PER_DAY,
    new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  );
}

async function requestAlsTracking(carrierAwbNumber: string) {
  if (env.ALS_TRACKING_ENABLED !== true) {
    throw new AlsTrackingServiceError("ALS tracking is disabled.", 409);
  }
  const settings = readAlsTrackingConfiguration();
  if (!settings.ok) {
    throw new AlsTrackingServiceError(`ALS tracking is missing ${settings.missing.join(", ")}.`, 503);
  }
  await reserveAlsRequest();
  const url = new URL(settings.configuration.apiUrl);
  url.searchParams.set("api_company_id", String(settings.configuration.companyId));
  url.searchParams.set("customer_code", settings.configuration.customerCode);
  url.searchParams.set("tracking_no", carrierAwbNumber);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.configuration.timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new AlsTrackingServiceError(`ALS tracking returned HTTP ${response.status}.`);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new AlsTrackingServiceError("ALS tracking returned an unreadable response."); }
    return parseAlsTrackingResponse(payload, carrierAwbNumber);
  } catch (error) {
    if (error instanceof AlsTrackingServiceError) throw error;
    throw new AlsTrackingServiceError(
      error instanceof Error && error.name === "AbortError"
        ? "ALS tracking timed out."
        : "ALS tracking could not be reached."
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function ingestAlsEvents(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  carrierAwbNumber: string;
  events: AlsTrackingProviderEvent[];
}) {
  const [shipment, shipmentEvents] = await Promise.all([
    DpdShipment.findById(input.dpdShipmentId)
      .select("currentShipmentSnapshot bookingSnapshot")
      .lean()
      .exec(),
    ShipmentEvent.find({ shipmentDraftId: input.shipmentDraftId })
      .select("status")
      .lean()
      .exec()
  ]);
  const snapshot = readShipmentBookingSnapshot(shipment?.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(shipment?.bookingSnapshot);
  const destinationCountryCode = snapshot?.consignee?.countryCode?.trim().toUpperCase() ?? "";
  const recorded = new Set(shipmentEvents.map((event) => event.status));
  let applied = 0;
  let reviewRequired = 0;
  let newestEventAt: Date | null = null;

  const ordered = [...input.events].sort((left, right) =>
    (parseAlsIndiaTimestamp(left.eventAt)?.getTime() ?? 0) - (parseAlsIndiaTimestamp(right.eventAt)?.getTime() ?? 0));

  for (const event of ordered) {
    const key = providerEventKey(event);
    if (await CarrierTrackingEvent.exists({ provider: "ALS", carrierAwbNumber: input.carrierAwbNumber, providerEventKey: key })) continue;
    const eventAt = parseAlsIndiaTimestamp(event.eventAt);
    const mappedStatus = mapAlsTrackingEvent(event, destinationCountryCode);
    let processingStatus: "APPLIED" | "IGNORED" | "REVIEW_REQUIRED" = "IGNORED";
    let processingNote = mappedStatus ? "Milestone already recorded." : "ALS event does not map to an approved customer milestone.";

    if (!eventAt) {
      processingStatus = "REVIEW_REQUIRED";
      processingNote = "ALS event timestamp is missing or invalid.";
    } else if (!mappedStatus && event.eventState !== "entry") {
      processingStatus = "REVIEW_REQUIRED";
      processingNote = `Unknown ALS event combination: ${event.eventState || "blank state"}.`;
    } else if (mappedStatus && !recorded.has(mappedStatus)) {
      const missing = findMissingPrerequisites(mappedStatus, recorded);
      if (missing.length) {
        processingStatus = "REVIEW_REQUIRED";
        processingNote = `Cannot apply ${mappedStatus}; missing ${missing.join(", ")}.`;
      } else {
        const milestoneKey = shipmentMilestoneKey(mappedStatus);
        const existingMilestone = milestoneKey
          ? await ShipmentEvent.exists({ shipmentDraftId: input.shipmentDraftId, milestoneKey })
          : null;
        if (!existingMilestone) {
          await ShipmentEvent.create({
            shipmentDraftId: input.shipmentDraftId,
            dpdShipmentId: input.dpdShipmentId,
            status: mappedStatus,
            milestoneKey,
            note: resolveShipmentEventNote("", mappedStatus),
            location: event.location.slice(0, 120),
            source: "CARRIER",
            sourceReference: `ALS:${input.carrierAwbNumber}:${key}`.slice(0, 120),
            partnerName: ["OUT_FOR_DELIVERY", "DELIVERED"].includes(mappedStatus) ? "Airport Link Services" : "",
            partnerCode: ["OUT_FOR_DELIVERY", "DELIVERED"].includes(mappedStatus) ? "ALS" : "",
            customerVisible: true,
            createdBy: SYSTEM_ACTOR_ID,
            eventAt
          });
          recorded.add(mappedStatus);
          processingStatus = "APPLIED";
          processingNote = `Applied ${mappedStatus}.`;
          applied += 1;
        }
      }
    }
    if (processingStatus === "REVIEW_REQUIRED") reviewRequired += 1;
    if (eventAt && (!newestEventAt || eventAt > newestEventAt)) newestEventAt = eventAt;
    await CarrierTrackingEvent.create({
      provider: "ALS",
      shipmentDraftId: input.shipmentDraftId,
      dpdShipmentId: input.dpdShipmentId,
      carrierAwbNumber: input.carrierAwbNumber,
      providerEventKey: key,
      providerEventId: event.id,
      eventState: event.eventState || "unknown",
      description: event.description,
      location: event.location,
      eventAt: eventAt ?? new Date(),
      mappedStatus,
      processingStatus,
      processingNote,
      rawPayload: event.rawPayload,
      receivedAt: new Date()
    });
  }
  return { applied, reviewRequired, newestEventAt, recorded };
}

function nextPollPlan(statuses: Set<string>, now: Date) {
  if (statuses.has("DELIVERED")) return { state: "COMPLETED" as const, pollPhase: "OUT_FOR_DELIVERY" as const, nextPollAt: null };
  if (statuses.has("OUT_FOR_DELIVERY")) return { state: "ACTIVE" as const, pollPhase: "OUT_FOR_DELIVERY" as const, nextPollAt: new Date(now.getTime() + 15 * 60 * 1000) };
  if (statuses.has("DESTINATION_ARRIVED")) return { state: "ACTIVE" as const, pollPhase: "DESTINATION" as const, nextPollAt: new Date(now.getTime() + 30 * 60 * 1000) };
  return { state: "ACTIVE" as const, pollPhase: "PRE_DESTINATION" as const, nextPollAt: new Date(now.getTime() + 2 * 60 * 60 * 1000) };
}

async function ensureAlsTrackingSync(shipmentDraftId: mongoose.Types.ObjectId) {
  const [shipment, departed] = await Promise.all([
    DpdShipment.findOne({ shipmentDraftId, "responseSnapshot.provider": "ALS" }).exec(),
    ShipmentEvent.exists({ shipmentDraftId, status: { $in: ["IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY", "DELIVERED"] } })
  ]);
  const carrierAwbNumber = shipment?.dpdShipmentId?.trim() ?? "";
  if (!shipment || !departed || !/^\d+$/.test(carrierAwbNumber)) return null;
  return CarrierTrackingSync.findOneAndUpdate(
    { provider: "ALS", carrierAwbNumber },
    {
      $set: { shipmentDraftId, dpdShipmentId: shipment._id },
      $setOnInsert: { state: "ACTIVE", pollPhase: "PRE_DESTINATION", nextPollAt: new Date(), failureCount: 0 }
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).exec();
}

async function pollSync(sync: InstanceType<typeof CarrierTrackingSync>) {
  const now = new Date();
  try {
    const events = await requestAlsTracking(sync.carrierAwbNumber);
    const result = await ingestAlsEvents({
      shipmentDraftId: sync.shipmentDraftId,
      dpdShipmentId: sync.dpdShipmentId,
      carrierAwbNumber: sync.carrierAwbNumber,
      events
    });
    const plan = nextPollPlan(result.recorded, now);
    sync.state = plan.state;
    sync.pollPhase = plan.pollPhase;
    sync.nextPollAt = plan.nextPollAt;
    sync.lastPolledAt = now;
    sync.lastSuccessAt = now;
    sync.lastEventAt = result.newestEventAt ?? sync.lastEventAt;
    sync.failureCount = 0;
    sync.lastError = "";
    sync.completedAt = plan.state === "COMPLETED" ? now : null;
    await sync.save();
    return { carrierAwbNumber: sync.carrierAwbNumber, ...result, state: sync.state };
  } catch (error) {
    sync.lastPolledAt = now;
    sync.failureCount += 1;
    sync.lastError = error instanceof Error ? error.message : "ALS tracking failed.";
    sync.state = sync.failureCount >= 5 ? "ERROR" : "ACTIVE";
    sync.nextPollAt = new Date(now.getTime() + (sync.failureCount >= 3 ? 2 * 60 : 30) * 60 * 1000);
    await sync.save();
    throw error;
  }
}

export async function refreshAlsTrackingForShipment(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
}) {
  const sync = await ensureAlsTrackingSync(input.shipmentDraftId);
  if (!sync) throw new AlsTrackingServiceError("This shipment is not eligible for ALS tracking yet.", 409);
  if (sync.lastManualRefreshAt && Date.now() - sync.lastManualRefreshAt.getTime() < ALS_MANUAL_AWB_COOLDOWN_MS) {
    throw new AlsTrackingServiceError("This AWB was refreshed recently. Try again after five minutes.", 429);
  }
  await reserveRateBucket(
    `ALS:MANUAL_USER_HOUR:${String(input.userId)}:${new Date().toISOString().slice(0, 13)}`,
    ALS_MANUAL_REQUESTS_PER_USER_HOUR,
    new Date(Date.now() + 2 * 60 * 60 * 1000)
  );
  sync.lastManualRefreshAt = new Date();
  await sync.save();
  return pollSync(sync);
}

export async function runAlsTrackingSweep() {
  if (env.ALS_TRACKING_ENABLED !== true) return { enabled: false, created: 0, attempted: 0, succeeded: 0, failed: 0 };
  const departedDraftIds = await ShipmentEvent.distinct("shipmentDraftId", {
    status: { $in: ["IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"] }
  }).exec();
  let created = 0;
  for (const draftId of departedDraftIds) {
    const before = await CarrierTrackingSync.exists({ shipmentDraftId: draftId, provider: "ALS" });
    const sync = await ensureAlsTrackingSync(draftId);
    if (sync && !before) created += 1;
  }
  const due = await CarrierTrackingSync.find({
    provider: "ALS",
    state: "ACTIVE",
    nextPollAt: { $lte: new Date() }
  }).sort({ nextPollAt: 1 }).limit(ALS_TRACKING_REQUESTS_PER_MINUTE).exec();
  let succeeded = 0;
  let failed = 0;
  await runWithConcurrency(due, ALS_TRACKING_CONCURRENCY, async (sync) => {
    try { await pollSync(sync); succeeded += 1; }
    catch { failed += 1; }
  });
  return { enabled: true, created, attempted: due.length, succeeded, failed };
}
