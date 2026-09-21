import mongoose from "mongoose";
import { DeliveryPartner } from "../models/deliveryPartner.model.js";
import { DeliveryAssignment } from "../models/pod.model.js";
import type { ISwiftlineRoute, TrackingProfileSetting } from "../models/swiftlineRoute.model.js";
import { findRoute } from "./swiftlineRoute.service.js";
import {
  defaultShipmentEventNote,
  isSystemWrittenNote,
  resolveShipmentEventNote
} from "./shipmentEventCopy.service.js";
import { formatShipmentEventLabel } from "./shipmentStatusSequence.service.js";

export type TrackingProfile = Exclude<TrackingProfileSetting, "AUTO">;

export type JourneyEvent = {
  status: string;
  eventAt: Date | string;
  gatewayCode?: string | null;
  gatewayName?: string | null;
  partnerName?: string | null;
  partnerCode?: string | null;
};

export type TrackingJourneyContext = {
  profile: TrackingProfile;
  originHubName: string;
  destinationCountryName: string;
  gatewayCode: string;
  gatewayName: string;
  gatewayLabel: string;
  deliveryPartnerName: string;
  deliveryPartnerCode: string;
  routeSegments: string[];
};

export type TrackingJourneyMilestone = {
  key: string;
  label: string;
  reachedAt: string | null;
  isCurrent: boolean;
};

export type TrackingJourney = {
  version: 2;
  context: TrackingJourneyContext;
  stages: TrackingJourneyMilestone[];
  milestones: TrackingJourneyMilestone[];
};

/**
 * Destinations the EUROPE tracking flow describes.
 *
 * Turkey is deliberately absent. Swiftline sells it as a Middle East lane, and
 * `lib/rateCardRegions.ts` on the frontend groups it that way for customers, so
 * presenting it as a European shipment while it is browsed under Middle East
 * told the customer two different stories about the same parcel. Falling
 * through to OTHER also reads better: "In Transit to Turkey" rather than "In
 * Transit to Europe". A Turkish lane can still be pinned to EUROPE explicitly
 * on its route record if that ever changes.
 */
const europeanCountryCodes = new Set([
  "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE",
  "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT",
  "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU",
  "SM", "RS", "SK", "SI", "ES", "SE", "CH", "UA", "VA"
]);

const gatewayNames: Record<string, string> = {
  LHR: "London",
  JFK: "New York",
  ORD: "Chicago",
  LAX: "Los Angeles",
  MIA: "Miami",
  YYZ: "Toronto",
  YVR: "Vancouver",
  AMS: "Amsterdam",
  FRA: "Frankfurt",
  CDG: "Paris"
};

const milestoneDefinitions: Array<{
  key: string;
  canonicalStatus: string;
  statuses: readonly string[];
  customerJourney: boolean;
}> = [
  { key: "BOOKED", canonicalStatus: "SHIPMENT_BOOKED", statuses: ["SHIPMENT_BOOKED", "SHIPMENT_CREATED"], customerJourney: true },
  { key: "COLLECTED", canonicalStatus: "PARCEL_COLLECTED", statuses: ["PARCEL_COLLECTED"], customerJourney: false },
  { key: "ORIGIN_RECEIVED", canonicalStatus: "WAREHOUSE_SCAN_IN", statuses: ["WAREHOUSE_SCAN_IN"], customerJourney: true },
  { key: "ORIGIN_PROCESSED", canonicalStatus: "ORIGIN_HUB_PROCESSED", statuses: ["ORIGIN_HUB_PROCESSED"], customerJourney: true },
  { key: "EXPORT_READY", canonicalStatus: "READY_FOR_EXPORT", statuses: ["READY_FOR_EXPORT", "EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED"], customerJourney: true },
  { key: "ORIGIN_DISPATCHED", canonicalStatus: "ORIGIN_HUB_DISPATCHED", statuses: ["ORIGIN_HUB_DISPATCHED", "FLIGHT_DEPARTED"], customerJourney: true },
  { key: "INTERNATIONAL_TRANSIT", canonicalStatus: "IN_TRANSIT", statuses: ["IN_TRANSIT", "FLIGHT_DEPARTED"], customerJourney: true },
  { key: "DESTINATION_ARRIVED", canonicalStatus: "DESTINATION_ARRIVED", statuses: ["DESTINATION_ARRIVED"], customerJourney: true },
  { key: "CUSTOMS_IN_PROGRESS", canonicalStatus: "IMPORT_CUSTOMS_CLEARANCE", statuses: ["IMPORT_CUSTOMS_CLEARANCE"], customerJourney: false },
  { key: "CUSTOMS_CLEARED", canonicalStatus: "IMPORT_CUSTOMS_CLEARED", statuses: ["IMPORT_CUSTOMS_CLEARED"], customerJourney: false },
  { key: "PARTNER_TRANSFERRED", canonicalStatus: "DELIVERY_PARTNER_TRANSFERRED", statuses: ["DELIVERY_PARTNER_TRANSFERRED"], customerJourney: false },
  { key: "DELIVERY_HUB", canonicalStatus: "DELIVERY_HUB_ARRIVED", statuses: ["DELIVERY_HUB_ARRIVED"], customerJourney: false },
  { key: "OUT_FOR_DELIVERY", canonicalStatus: "OUT_FOR_DELIVERY", statuses: ["OUT_FOR_DELIVERY"], customerJourney: true },
  { key: "DELIVERED", canonicalStatus: "DELIVERED", statuses: ["DELIVERED"], customerJourney: true }
];

const stageDefinitions: Array<{ key: string; label: string; milestoneKeys: readonly string[] }> = [
  { key: "ORIGIN", label: "Origin", milestoneKeys: ["BOOKED", "ORIGIN_RECEIVED", "ORIGIN_PROCESSED"] },
  { key: "EXPORT", label: "Export", milestoneKeys: ["EXPORT_READY", "ORIGIN_DISPATCHED"] },
  { key: "INTERNATIONAL", label: "International Transit", milestoneKeys: ["INTERNATIONAL_TRANSIT"] },
  { key: "DESTINATION", label: "Destination", milestoneKeys: ["DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"] },
  { key: "DELIVERED", label: "Delivered", milestoneKeys: ["DELIVERED"] }
];

function titleCase(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function resolveTrackingProfile(
  destinationCountryCode: string,
  configured: TrackingProfileSetting = "AUTO"
): TrackingProfile {
  if (configured !== "AUTO") return configured;
  const code = destinationCountryCode.toUpperCase();
  if (code === "GB") return "UK";
  if (code === "US") return "USA";
  if (code === "CA") return "CANADA";
  if (europeanCountryCodes.has(code)) return "EUROPE";
  return "OTHER";
}

function profileDestinationName(profile: TrackingProfile, supplied: string) {
  if (profile === "UK") return "United Kingdom";
  if (profile === "USA") return "United States";
  if (profile === "CANADA") return "Canada";
  return supplied || "Destination";
}

function fallbackGatewayLabel(profile: TrackingProfile) {
  if (profile === "UK") return "London Gateway (LHR)";
  if (profile === "USA") return "USA Gateway";
  if (profile === "CANADA") return "Canada Gateway";
  if (profile === "EUROPE") return "European Gateway";
  return "Destination Gateway";
}

function gatewayLabel(profile: TrackingProfile, code: string, suppliedName: string) {
  if (!code) return fallbackGatewayLabel(profile);
  const name = suppliedName || gatewayNames[code] || "";
  return name ? `${titleCase(name)} Gateway (${code})` : `Gateway (${code})`;
}

function originFacilityLocation(value: string) {
  const location = value
    .replace(/\s+origin\s+facility$/i, "")
    .replace(/\s+(?:origin\s+)?hub$/i, "")
    .trim();
  return location || value;
}

function milestoneLabel(key: string, context: TrackingJourneyContext) {
  const originLocation = originFacilityLocation(context.originHubName);
  const originFacilityLabel = originLocation ? `Origin Facility ${originLocation}` : "Origin Facility";
  const labels: Record<string, string> = {
    BOOKED: "Booking Confirmed",
    COLLECTED: "Shipment Collected",
    ORIGIN_RECEIVED: `Received at ${originFacilityLabel}`,
    ORIGIN_PROCESSED: "Processing for Export",
    EXPORT_READY: "Ready for Dispatch",
    ORIGIN_DISPATCHED: `Departed from ${originFacilityLabel}`,
    INTERNATIONAL_TRANSIT: "In International Transit",
    DESTINATION_ARRIVED: "Arrived in Destination Country",
    CUSTOMS_IN_PROGRESS: "Customs Processing",
    CUSTOMS_CLEARED: "Customs Cleared",
    PARTNER_TRANSFERRED: context.profile === "UK"
      ? "Transferred to DPD Network"
      : `Transferred to ${context.deliveryPartnerName}`,
    DELIVERY_HUB: context.profile === "UK"
      ? "Arrived at DPD Delivery Hub"
      : context.profile === "EUROPE"
        ? "Arrived at Destination Delivery Hub"
        : context.deliveryPartnerName === "Delivery Partner"
          ? "Arrived at Local Delivery Hub"
          : `Arrived at ${context.deliveryPartnerName} Delivery Hub`,
    OUT_FOR_DELIVERY: "Out for Delivery",
    DELIVERED: "Delivered"
  };
  return labels[key] ?? key;
}

function firstReachedAt(events: readonly JourneyEvent[], statuses: readonly string[]) {
  const times = events
    .filter((event) => statuses.includes(event.status))
    .map((event) => new Date(event.eventAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return times[0]?.toISOString() ?? null;
}

function latestEventValue(events: readonly JourneyEvent[], field: "gatewayCode" | "gatewayName" | "partnerName" | "partnerCode") {
  return [...events]
    .sort((left, right) => new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime())
    .map((event) => String(event[field] ?? "").trim())
    .find(Boolean) ?? "";
}

function latestGatewayValue(events: readonly JourneyEvent[], field: "gatewayCode" | "gatewayName") {
  return latestEventValue(
    events.filter((event) => event.status === "DESTINATION_ARRIVED"),
    field
  );
}

export function buildTrackingJourney(input: {
  destinationCountryCode: string;
  destinationCountryName: string;
  configuredProfile?: TrackingProfileSetting;
  originHubName?: string;
  deliveryPartnerName?: string;
  deliveryPartnerCode?: string;
  events: readonly JourneyEvent[];
}): TrackingJourney {
  const profile = resolveTrackingProfile(input.destinationCountryCode, input.configuredProfile);
  const destinationCountryName = profileDestinationName(profile, input.destinationCountryName);
  const eventGatewayCode = latestGatewayValue(input.events, "gatewayCode").toUpperCase();
  const resolvedGatewayCode = (eventGatewayCode || (profile === "UK" ? "LHR" : "")).toUpperCase();
  const resolvedGatewayName = latestGatewayValue(input.events, "gatewayName")
    || gatewayNames[resolvedGatewayCode]
    || "";
  const eventPartnerName = latestEventValue(input.events, "partnerName");
  const eventPartnerCode = latestEventValue(input.events, "partnerCode");
  const deliveryPartnerName = profile === "UK"
    ? "DPD Network"
    : eventPartnerName || input.deliveryPartnerName || "Delivery Partner";
  const deliveryPartnerCode = profile === "UK"
    ? "DPD"
    : eventPartnerCode || input.deliveryPartnerCode || "";
  const originHubName = input.originHubName?.trim() || "Origin Hub";
  const resolvedGatewayLabel = gatewayLabel(profile, resolvedGatewayCode, resolvedGatewayName);
  const gatewaySegment = resolvedGatewayCode
    ? `${resolvedGatewayCode} Gateway`
    : profile === "EUROPE"
      ? "European Gateway"
      : `${profile === "OTHER" ? "Destination" : profile} Gateway`;

  const routeSegments = profile === "EUROPE"
    ? [originHubName, gatewaySegment, "Destination Country", deliveryPartnerName, "Delivery"]
    : [originHubName, gatewaySegment, deliveryPartnerName, "Delivery"];

  const context: TrackingJourneyContext = {
    profile,
    originHubName,
    destinationCountryName,
    gatewayCode: resolvedGatewayCode,
    gatewayName: resolvedGatewayName,
    gatewayLabel: resolvedGatewayLabel,
    deliveryPartnerName,
    deliveryPartnerCode,
    routeSegments
  };

  const rawMilestones = milestoneDefinitions
    .filter((definition) => definition.customerJourney)
    .map((definition) => ({
      key: definition.key,
      label: milestoneLabel(definition.key, context),
      reachedAt: firstReachedAt(input.events, definition.statuses),
      isCurrent: false
    }));
  const currentMilestoneIndex = rawMilestones.reduce(
    (latest, milestone, index) => (milestone.reachedAt ? index : latest),
    -1
  );
  const milestones = rawMilestones.map((milestone, index) => ({
    ...milestone,
    isCurrent: index === currentMilestoneIndex
  }));

  const rawStages = stageDefinitions.map((definition) => {
    const reached = milestones
      .filter((milestone) => definition.milestoneKeys.includes(milestone.key) && milestone.reachedAt)
      .map((milestone) => milestone.reachedAt as string)
      .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
    return { key: definition.key, label: definition.label, reachedAt: reached[0] ?? null, isCurrent: false };
  });
  const currentStageIndex = rawStages.reduce(
    (latest, stage, index) => (stage.reachedAt ? index : latest),
    -1
  );

  return {
    version: 2,
    context,
    stages: rawStages.map((stage, index) => ({ ...stage, isCurrent: index === currentStageIndex })),
    milestones
  };
}

export function formatTrackingEventLabel(status: string, journey: TrackingJourney) {
  const definition = milestoneDefinitions.find((item) => item.statuses.includes(status));
  return definition ? milestoneLabel(definition.key, journey.context) : formatShipmentEventLabel(status);
}

type VisibleHistoryEvent = {
  status: string;
  eventAt: Date | string;
  note?: string | null;
  location?: string | null;
};

function eventTime(value: Date | string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Turns raw operational events into the concise history shown in tracking.
 *
 * Legacy statuses can describe different internal actions while representing
 * one customer milestone. They remain separate in MongoDB and in audit data,
 * but only the earliest occurrence is displayed. Repeatable exceptions such as
 * holds have no journey definition and therefore remain untouched.
 */
export function normalizeVisibleTrackingHistory<T extends VisibleHistoryEvent>(
  events: readonly T[],
  journey?: TrackingJourney
): Array<T & { statusLabel: string; note: string }> {
  const chronological = [...events].sort((left, right) => (
    eventTime(left.eventAt) - eventTime(right.eventAt)
  ));
  const milestoneGroups = new Map<string, { definition: (typeof milestoneDefinitions)[number]; events: T[] }>();
  const visible: Array<T & { statusLabel: string; note: string }> = [];

  for (const event of chronological) {
    // The first matching definition is deliberate: a departure establishes the
    // transit phase too, but its single history row is "Dispatched", while the
    // journey rail may still light both phases from the same confirmed event.
    const definition = milestoneDefinitions.find((item) => item.statuses.includes(event.status));
    if (!definition) {
      visible.push({
        ...event,
        statusLabel: journey
          ? formatTrackingEventLabel(event.status, journey)
          : formatShipmentEventLabel(event.status),
        note: resolveShipmentEventNote(event.note, event.status)
      });
      continue;
    }

    const existing = milestoneGroups.get(definition.key);
    if (existing) existing.events.push(event);
    else milestoneGroups.set(definition.key, { definition, events: [event] });
  }

  for (const { definition, events: groupEvents } of milestoneGroups.values()) {
    const first = groupEvents[0];
    if (!first) continue;

    // A person's note is never discarded merely because the status is a legacy
    // alias. System-generated legacy copy is replaced by the current canonical
    // milestone description.
    const humanNote = groupEvents.find((event) => !isSystemWrittenNote(event.note, event.status))?.note?.trim();
    const recordedLocation = groupEvents
      .map((event) => String(event.location ?? "").trim())
      .find(Boolean);

    visible.push({
      ...first,
      ...(recordedLocation ? { location: recordedLocation } : {}),
      statusLabel: journey
        ? milestoneLabel(definition.key, journey.context)
        : formatShipmentEventLabel(definition.canonicalStatus),
      note: humanNote || defaultShipmentEventNote(definition.canonicalStatus)
    });
  }

  // A shipment cannot be released twice without another hold. The data layer
  // now makes a customs release idempotent, but this small display guard keeps
  // historical double-writes from appearing in admin, client and public views.
  let releasedSinceLastHold = false;
  const coherentHistory = visible
    .sort((left, right) => eventTime(left.eventAt) - eventTime(right.eventAt))
    .filter((event) => {
      if (event.status === "ON_HOLD") {
        releasedSinceLastHold = false;
        return true;
      }
      if (event.status !== "RELEASED_FROM_HOLD") return true;
      if (releasedSinceLastHold) return false;
      releasedSinceLastHold = true;
      return true;
    });

  // API event arrays have always been newest-first. Frontends that present a
  // chronological story can continue sorting locally without a contract change.
  return coherentHistory.sort((left, right) => eventTime(right.eventAt) - eventTime(left.eventAt));
}

/**
 * Loads only the shipment route and delivery facts tracking needs. Manifest
 * routing is deliberately absent: its IATA fields describe a freight movement,
 * which may later contain shipments for several final destinations.
 */
export async function loadShipmentJourney(input: {
  shipmentDraftId: string | mongoose.Types.ObjectId;
  destinationCountryCode: string;
  destinationCountryName: string;
  service: "COURIER" | "CARGO";
  events: readonly JourneyEvent[];
  route?: ISwiftlineRoute | null;
  originHubFallback?: string;
}) {
  const route = input.route === undefined
    ? await findRoute({ destinationCountryCode: input.destinationCountryCode, service: input.service })
    : input.route;

  const assignment = await DeliveryAssignment.findOne({ shipmentDraftId: input.shipmentDraftId })
    .select("deliveryPartnerId")
    .lean()
    .exec();
  const partner = assignment?.deliveryPartnerId
    ? await DeliveryPartner.findById(assignment.deliveryPartnerId).select("name code").lean().exec()
    : null;

  return buildTrackingJourney({
    destinationCountryCode: input.destinationCountryCode,
    destinationCountryName: route?.destinationCountryName || input.destinationCountryName,
    configuredProfile: route?.trackingProfile ?? "AUTO",
    originHubName: route?.originHubName
      || input.originHubFallback
      || "Origin Hub",
    deliveryPartnerName: partner?.name ?? "",
    deliveryPartnerCode: partner?.code ?? "",
    events: input.events
  });
}
