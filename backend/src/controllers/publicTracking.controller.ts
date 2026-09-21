/**
 * Tracking for the person holding the parcel.
 *
 * The consignee owns the shipment but has no portal account, and until now had
 * no way to see where it was- they had to ring the shipper, who rang Swiftline.
 * This endpoint answers with no session at all.
 *
 * Swiftline AWBs are sequential (`SLC` + station + DDMMYY + a per-station daily
 * counter), so anything shown here is effectively shown for every shipment ever
 * booked. That is an accepted trade: every field below is already printed on the
 * label the consignee is holding, and the events are the ones already shown to
 * account holders. It is emphatically NOT licence to widen the payload- see the
 * never-expose list above `serializePublicTracking`.
 *
 * Written standalone rather than by re-guarding the client handler, which writes
 * a SHIPMENT_BOOKED event on read and stamps it with the viewing user's id. A
 * public visitor has no user id, so delegating there would either fail or record
 * a junk event. Nothing in this file writes.
 */
import type { Request, Response } from "express";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { consignorCountryName, ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { resolveShipmentEventNote } from "../services/shipmentEventCopy.service.js";
import {
  buildDeliveryEstimate,
  buildTrackingSummary,
  resolveShipmentByTrackingNumber
} from "../services/shipmentTracking.service.js";
import { findRoute } from "../services/swiftlineRoute.service.js";
import {
  formatTrackingEventLabel,
  loadShipmentJourney,
  normalizeVisibleTrackingHistory,
  type TrackingJourney
} from "../services/shipmentJourney.service.js";
import { buildTrackingPosition } from "../services/shipmentPosition.service.js";
import {
  loadShipmentParcelActivities,
  loadShipmentParcelProgress
} from "../services/shipmentParcelActivity.service.js";

/**
 * What a tracking reference may look like, checked before any query runs.
 *
 * Deliberately a charset-and-length guard rather than a match on today's AWB
 * shape. The current generator emits SLCDEL170826001 (`SLC` + station + DDMMYY +
 * sequence), with pieces as SLCDEL170826001-02. Shipments booked earlier carry an
 * older SLDL20072026000001 form, and their pieces were numbered by the carrier
 * as DPDTESTDL2107202600000101. Every one of those is printed on a label somebody
 * is holding right now, so pinning this to the newest format would mean the
 * public tracker did not work for the existing book of business.
 *
 * The twelve-character floor is what keeps the other `SLC` series out: operations
 * manifests (`SLC001`) and MHBS bags (`SLC01201`) top out around eleven. Neither
 * could resolve in any case - the resolver only searches shipment and parcel
 * identifiers - but there is no reason to spend a query finding that out.
 */
const TRACKING_REFERENCE = /^[A-Z0-9][A-Z0-9-]{10,39}$/i;

const NOT_FOUND = "No shipment was found for that tracking number.";

/** "UNITED KINGDOM" is how the draft stores it; nobody wants to read that. */
function toTitleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * The three-letter station a shipment left from.
 *
 * Read from the branch code, which is where `allocateSwiftlineTrackingNumber`
 * takes it from as well: codes are shaped `DEL-001`, so the prefix is the
 * station. Only the station travels into the payload - the branch's name is
 * internal routing detail and stays out of it.
 *
 * Parsing the AWB is the fallback rather than the primary, because only the
 * current `SLC` + station format carries one. Slicing the same offsets out of an
 * older SLDL20072026000001 yields "L21", which is not a station at all.
 */
function originStationCode(trackingNumber: string, branchCode: string): string {
  const fromBranch = branchCode.split("-")[0]?.trim().toUpperCase() ?? "";
  if (/^[A-Z]{3}$/.test(fromBranch)) return fromBranch;

  const embedded = /^SLC([A-Z]{3})/i.exec(trackingNumber);
  return embedded?.[1]?.toUpperCase() ?? "";
}

/**
 * What a shipment on hold says to someone with no account.
 *
 * The detailed signed-in instruction is deliberately not published. The
 * position resolver may show a separate standardized customer-safe category,
 * but commercial or operational notes never leave this endpoint.
 */
const PUBLIC_HOLD_NOTICE = {
  label: "Shipment on hold",
  detail: "This shipment is temporarily paused and the sender has been notified. "
    + "Contact the sender, or reach Swiftline with this tracking number, for the latest position."
};

type PublicEvent = {
  status: string;
  statusLabel: string;
  holdReason?: string | null;
  eventAt: Date;
  location: string;
  note: string;
};

/**
 * The public shipment card.
 *
 * NEVER add to this payload: address lines, either postcode, email, mobile,
 * Aadhaar, kycDocuments, declaredGoodsValueMinor, items[], HS codes,
 * contentsDescription, bookingConfirmation, taxInvoiceNumber, any *AmountMinor,
 * branch, labels[], idempotencyKey, dpdShipmentId, dpdTransactionId,
 * paymentSource, addressValidationStatus or csbType.
 *
 * This list is the whole security boundary for an endpoint anyone can reach, and
 * it is the one place a later edit is likely to widen by accident.
 */
function serializePublicTracking(input: {
  trackedNumber: string;
  trackingNumber: string;
  draft: {
    consignorAddress?: { townOrCity?: string; countryName?: string } | null;
    consigneeEnteredAddress?: { townOrCity?: string; countryCode?: string; countryName?: string } | null;
    createdAt?: Date | null;
  };
  bookedAt: Date | null;
  events: PublicEvent[];
  summary: ReturnType<typeof buildTrackingSummary>;
  deliveryEstimate: Awaited<ReturnType<typeof buildDeliveryEstimate>>;
  routeCountryName: string;
  journey: TrackingJourney;
  /** Branch code and city only - never its name, which is internal. */
  origin: { stationCode: string; city: string };
  onHold: boolean;
  parcelActivities: Awaited<ReturnType<typeof loadShipmentParcelActivities>>;
  parcelProgress: Awaited<ReturnType<typeof loadShipmentParcelProgress>>;
}) {
  const { draft, events } = input;
  const newest = events.find((event) => event.status !== "PARCEL_COLLECTED") ?? null;
  const isParcelLevel = input.trackedNumber.toUpperCase() !== input.trackingNumber.toUpperCase();

  const destinationCountryName = input.routeCountryName
    || toTitleCase(draft.consigneeEnteredAddress?.countryName ?? "");
  const currentPosition = buildTrackingPosition({
    events: events.filter((event) => event.status !== "PARCEL_COLLECTED"),
    journey: input.journey,
    destinationCity: toTitleCase(draft.consigneeEnteredAddress?.townOrCity ?? ""),
    audience: "PUBLIC"
  });

  return {
    trackedNumber: input.trackedNumber,
    trackingNumber: input.trackingNumber,
    // A piece-level search shows the whole shipment's timeline, so the page has
    // to be able to say so rather than implying these scans are for one parcel.
    isParcelLevel,

    status: newest?.status ?? "SHIPMENT_BOOKED",
    statusLabel: formatTrackingEventLabel(newest?.status ?? "SHIPMENT_BOOKED", input.journey),
    currentPosition,

    serviceType: input.summary.serviceType,
    carrierName: input.summary.carrierName,
    pieces: input.summary.pieces,
    actualWeightKg: input.summary.actualWeightKg,

    originStationCode: input.origin.stationCode,
    // Drafts written before the consignor snapshot existed have none at all, so
    // the originating branch's own city stands in rather than leaving the cell
    // blank. Consignors are pinned to India by the draft model, which is why the
    // country can be stated rather than looked up.
    originCity: toTitleCase(draft.consignorAddress?.townOrCity || input.origin.city),
    originCountryName: toTitleCase(draft.consignorAddress?.countryName || consignorCountryName),

    destinationCity: toTitleCase(draft.consigneeEnteredAddress?.townOrCity ?? ""),
    destinationCountryCode: (draft.consigneeEnteredAddress?.countryCode ?? "").toUpperCase(),
    destinationCountryName,

    bookedAt: input.bookedAt,
    lastUpdateAt: input.summary.lastUpdateAt,
    deliveryEstimate: input.deliveryEstimate,
    attention: input.onHold ? PUBLIC_HOLD_NOTICE : null,
    journey: input.journey,
    parcelProgress: input.parcelProgress,

    parcelActivities: input.parcelActivities
      // A parcel-number lookup must not reveal activity for other parcels in
      // the same shipment. A shipment-number lookup may show all parcel
      // activity because the caller supplied the parent reference.
      .filter((activity) => !isParcelLevel || activity.parcelNumber.toUpperCase() === input.trackedNumber.toUpperCase())
      .map((activity) => ({
        parcelNumber: activity.parcelNumber,
        status: activity.status,
        eventAt: activity.eventAt,
        message: activity.customerMessage
      })),

    events: normalizeVisibleTrackingHistory(events, input.journey).map((event) => ({
      status: event.status,
      statusLabel: event.statusLabel,
      eventAt: event.eventAt,
      location: event.location,
      note: event.note
    }))
  };
}

export async function trackPublicShipment(request: Request, response: Response): Promise<Response> {
  const trackedNumber = typeof request.params.trackingNumber === "string"
    ? request.params.trackingNumber.trim()
    : "";

  if (!TRACKING_REFERENCE.test(trackedNumber)) {
    return response.status(400).json({
      success: false,
      message: "Enter the tracking number exactly as it is printed on your shipping label."
    });
  }

  const resolved = await resolveShipmentByTrackingNumber(trackedNumber);
  if (!resolved) return response.status(404).json({ success: false, message: NOT_FOUND });

  const draft = await ShipmentDraft.findById(resolved.shipmentDraftId).lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: NOT_FOUND });

  const [dpdShipment, events, branch, parcelActivities, parcelProgress] = await Promise.all([
    DpdShipment.findOne({ shipmentDraftId: draft._id }).lean().exec(),
    // `customerVisible` is the whole line between an operator's public note and
    // an internal one. Never relax this filter, and never reach for the staff
    // query, which applies none.
    ShipmentEvent.find({ shipmentDraftId: draft._id, customerVisible: true })
      .sort({ eventAt: -1, createdAt: -1 })
      .select("status holdReason note location eventAt gatewayCode gatewayName partnerName partnerCode")
      .lean()
      .exec(),
    // Only the code and the city are selected, so the branch's name cannot leak
    // into the payload by a later edit that spreads this object.
    draft.branchId
      ? Branch.findById(draft.branchId).select("code address.city").lean().exec()
      : Promise.resolve(null),
    loadShipmentParcelActivities(draft._id),
    loadShipmentParcelProgress(draft._id)
  ]);

  // The lane, purely so the header can name the destination country the way
  // Operations spelled it. A shipment on an unconfigured lane still tracks; it
  // just falls back to the country recorded on the shipment itself.
  const route = await findRoute({
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
    service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER"
  });

  const journey = await loadShipmentJourney({
    shipmentDraftId: draft._id,
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
    destinationCountryName: draft.consigneeEnteredAddress?.countryName ?? "",
    service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
    events,
    route,
    originHubFallback: branch?.address?.city ? `${toTitleCase(branch.address.city)} Hub` : ""
  });
  const publicEvents: PublicEvent[] = normalizeVisibleTrackingHistory(events, journey).map((event) => ({
    status: event.status,
    statusLabel: formatTrackingEventLabel(event.status, journey),
    holdReason: event.holdReason ?? null,
    eventAt: event.eventAt,
    location: event.location ?? "",
    note: resolveShipmentEventNote(event.note, event.status)
  }));

  const deliveryEstimate = await buildDeliveryEstimate({ draft, events: publicEvents, route });

  const trackingNumber = dpdShipment?.swiftlineTrackingNumber
    || draft.allocatedTrackingNumber
    || trackedNumber;

  return response.status(200).json({
    success: true,
    tracking: serializePublicTracking({
      trackedNumber,
      trackingNumber,
      draft,
      bookedAt: dpdShipment?.createdAt ?? draft.createdAt ?? null,
      events: publicEvents,
      summary: buildTrackingSummary({ draft, dpdShipment, events: publicEvents }),
      deliveryEstimate,
      journey,
      routeCountryName: route?.destinationCountryName ?? "",
      origin: {
        stationCode: originStationCode(trackingNumber, branch?.code ?? ""),
        city: branch?.address?.city ?? ""
      },
      onHold: publicEvents[0]?.status === "ON_HOLD",
      parcelActivities,
      parcelProgress
    })
  });
}
