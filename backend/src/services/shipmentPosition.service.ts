import type { ShipmentHoldReason } from "../models/shipmentEvent.model.js";
import type { TrackingJourney } from "./shipmentJourney.service.js";

export type TrackingPositionSource = "RECORDED" | "INFERRED" | "PENDING";

export type TrackingPosition = {
  label: string;
  source: TrackingPositionSource;
  basisStatus: string;
  holdReasonLabel: string;
};

type PositionEvent = {
  status: string;
  eventAt: Date | string;
  location?: string | null;
  holdReason?: ShipmentHoldReason | string | null;
};

const nonMovementStatuses = new Set([
  "SHIPMENT_CANCELLED",
  "ON_HOLD",
  "RELEASED_FROM_HOLD",
  "LOST",
  "DAMAGED"
]);

const exactHoldLabels: Record<string, string> = {
  missing_documents: "Missing documents",
  customs_query: "Customs query",
  payment_issue: "Payment issue",
  customer_request: "Customer request",
  address_issue: "Address issue",
  restricted_item_check: "Restricted item check",
  operational_delay: "Operational delay",
  missed_connection: "Missed connection",
  offloaded: "Offloaded",
  other: "Other"
};

const publicHoldLabels: Record<string, string> = {
  missing_documents: "Documentation required",
  customs_query: "Customs review",
  payment_issue: "Sender action required",
  customer_request: "Sender request",
  address_issue: "Delivery address review",
  restricted_item_check: "Shipment contents review",
  operational_delay: "Operational delay",
  missed_connection: "Transport connection delay",
  offloaded: "Offloaded from transport",
  other: "Shipment under review"
};

function transitPosition(journey: TrackingJourney) {
  if (journey.context.profile === "UK") return "In Transit to United Kingdom";
  if (journey.context.profile === "USA") return "In Transit to United States";
  if (journey.context.profile === "CANADA") return "In Transit to Canada";
  if (journey.context.profile === "EUROPE") return "In Transit to Europe";
  return `In Transit to ${journey.context.destinationCountryName || "Destination"}`;
}

function deliveryHubPosition(journey: TrackingJourney) {
  if (journey.context.profile === "UK") return "DPD Delivery Hub";
  if (journey.context.profile === "EUROPE") return "Destination Delivery Hub";
  const partner = journey.context.deliveryPartnerName;
  return partner && partner !== "Delivery Partner" ? `${partner} Delivery Hub` : "Local Delivery Hub";
}

function inferredForStatus(status: string, journey: TrackingJourney, destinationCity: string): string {
  const originHub = journey.context.originHubName || "Origin Hub";
  const gateway = journey.context.gatewayLabel || "Destination Gateway";
  const partner = journey.context.deliveryPartnerName || "Delivery Partner";
  const destination = destinationCity || journey.context.destinationCountryName || "Destination";

  switch (status) {
    case "SHIPMENT_CREATED": return "Booking being prepared";
    case "SHIPMENT_BOOKED": return "Awaiting collection from sender";
    case "PARCEL_COLLECTED": return `En route to ${originHub}`;
    case "WAREHOUSE_SCAN_IN":
    case "ORIGIN_HUB_PROCESSED":
    case "READY_FOR_EXPORT":
    case "EXPORT_CUSTOMS_CLEARED": return originHub;
    case "FLIGHT_ASSIGNED": return `${originHub} - awaiting departure`;
    case "ORIGIN_HUB_DISPATCHED":
    case "FLIGHT_DEPARTED": return transitPosition(journey);
    case "DESTINATION_ARRIVED":
    case "IMPORT_CUSTOMS_CLEARANCE":
    case "IMPORT_CUSTOMS_CLEARED": return gateway;
    case "DELIVERY_PARTNER_TRANSFERRED": return journey.context.profile === "UK" ? "DPD Network" : partner;
    case "DELIVERY_HUB_ARRIVED": return deliveryHubPosition(journey);
    case "IN_TRANSIT": return "In transit to delivery location";
    case "OUT_FOR_DELIVERY": return `With ${journey.context.profile === "UK" ? "DPD" : partner} - out for delivery${destinationCity ? ` in ${destinationCity}` : ""}`;
    case "DELIVERED": return `${destination} - delivered`;
    case "RETURNED": return `Returned to sender via ${originHub}`;
    case "LOST": return "Location under investigation";
    default: return "Position not recorded";
  }
}

function positionForEvent(event: PositionEvent, journey: TrackingJourney, destinationCity: string): TrackingPosition {
  const recordedLocation = String(event.location ?? "").trim();
  const statusUsesRecordedLocation = ![
    "SHIPMENT_CREATED",
    "SHIPMENT_BOOKED",
    "PARCEL_COLLECTED",
    "ORIGIN_HUB_DISPATCHED",
    "FLIGHT_DEPARTED",
    "IN_TRANSIT",
    "OUT_FOR_DELIVERY",
    "LOST"
  ].includes(event.status);
  if (recordedLocation && statusUsesRecordedLocation) {
    return { label: recordedLocation, source: "RECORDED", basisStatus: event.status, holdReasonLabel: "" };
  }
  const pending = event.status === "SHIPMENT_CREATED" || event.status === "SHIPMENT_BOOKED";
  return {
    label: inferredForStatus(event.status, journey, destinationCity),
    source: pending ? "PENDING" : "INFERRED",
    basisStatus: event.status,
    holdReasonLabel: ""
  };
}

export function buildTrackingPosition(input: {
  events: readonly PositionEvent[];
  journey: TrackingJourney;
  destinationCity?: string;
  audience?: "PUBLIC" | "AUTHENTICATED";
}): TrackingPosition {
  const events = [...input.events].sort(
    (left, right) => new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime()
  );
  const latest = events[0];
  if (!latest) {
    return { label: "Awaiting collection from sender", source: "PENDING", basisStatus: "SHIPMENT_BOOKED", holdReasonLabel: "" };
  }

  if (nonMovementStatuses.has(latest.status)) {
    const previousMovement = events.find((event) => !nonMovementStatuses.has(event.status));
    const base = previousMovement
      ? positionForEvent(previousMovement, input.journey, input.destinationCity ?? "")
      : { label: "Position not recorded", source: "INFERRED" as const, basisStatus: latest.status, holdReasonLabel: "" };
    if (latest.status === "LOST") base.label = "Location under investigation";
    if (latest.status === "SHIPMENT_CANCELLED" && !previousMovement) base.label = "Cancelled before collection";
    if (latest.status === "ON_HOLD") {
      const labels = input.audience === "PUBLIC" ? publicHoldLabels : exactHoldLabels;
      base.holdReasonLabel = labels[String(latest.holdReason ?? "")] || "Shipment under review";
    }
    return base;
  }

  return positionForEvent(latest, input.journey, input.destinationCity ?? "");
}

/** A reliable event-place default. Movement states deliberately stay blank. */
export function defaultEventLocation(input: {
  status: string;
  journey: TrackingJourney;
  destinationCity?: string;
}): string {
  const position = inferredForStatus(input.status, input.journey, input.destinationCity ?? "");
  return [
    "WAREHOUSE_SCAN_IN",
    "ORIGIN_HUB_PROCESSED",
    "READY_FOR_EXPORT",
    "EXPORT_CUSTOMS_CLEARED",
    "FLIGHT_ASSIGNED",
    "DESTINATION_ARRIVED",
    "IMPORT_CUSTOMS_CLEARANCE",
    "IMPORT_CUSTOMS_CLEARED",
    "DELIVERY_PARTNER_TRANSFERRED",
    "DELIVERY_HUB_ARRIVED",
    "DELIVERED",
    "RETURNED"
  ].includes(input.status) ? position : "";
}
