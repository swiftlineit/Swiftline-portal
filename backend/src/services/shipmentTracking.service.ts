/**
 * What the tracking pages say about a shipment.
 *
 * Client and staff tracking used to be served by two different endpoints that
 * had drifted: only the client one computed a delivery estimate, so Operations
 * could see a shipment's journey but not whether it was going to arrive on
 * time. Everything either page shows about schedule, weights, references or
 * required action is built here so both read the same shipment the same way.
 */
import mongoose from "mongoose";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import type { IShipmentDraft } from "../models/shipmentDraft.model.js";
import type { ShipmentHoldReason } from "../models/shipmentEvent.model.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";
import { calculateParcelVolumetricWeight } from "./shipmentPricing.service.js";
import { estimateRouteDelivery, findRoute, loadDestinationHolidays } from "./swiftlineRoute.service.js";
import type { ISwiftlineRoute } from "../models/swiftlineRoute.model.js";

/**
 * The shipment a typed tracking number belongs to, whatever kind of number it is.
 *
 * Customers quote whatever is printed in front of them: the Swiftline AWB, the
 * carrier's own shipment id, or a single piece's parcel number. All three resolve
 * to the same shipment, and a piece number that was never written onto the
 * DpdShipment still resolves through its label.
 *
 * Shared by the client tracker and the public one so the two can never disagree
 * about what counts as a valid reference. Returns the draft id only- deciding
 * who may see that shipment, and how much of it, belongs to the caller.
 */
export async function resolveShipmentByTrackingNumber(
  trackingNumber: string
): Promise<{ shipmentDraftId: mongoose.Types.ObjectId } | null> {
  const trimmed = trackingNumber.trim();
  if (!trimmed || trimmed.length > 80) return null;

  // Anchored and escaped: the number is user input on its way into a query, and
  // an unescaped "." would quietly match every shipment of the same length.
  const exact = new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

  const [shipmentByReference, pieceLabel] = await Promise.all([
    DpdShipment.findOne({
      $or: [{ dpdShipmentId: exact }, { swiftlineTrackingNumber: exact }, { parcelNumbers: exact }]
    }).select("shipmentDraftId").lean().exec(),
    // Either label's number resolves: a consignee reads whichever is on the box.
    LabelDocument.findOne({
      parcelNumber: exact,
      voidedAt: null
    }).select("dpdShipmentId").lean().exec()
  ]);

  const shipment = shipmentByReference ?? (
    pieceLabel
      ? await DpdShipment.findById(pieceLabel.dpdShipmentId).select("shipmentDraftId").lean().exec()
      : null
  );

  return shipment ? { shipmentDraftId: shipment.shipmentDraftId } : null;
}

/** The events tracking needs. Both callers already load more than this. */
export type TrackingEvent = {
  status: string;
  holdReason?: ShipmentHoldReason | string | null;
  eventAt: Date | string;
};

/** Delivery schedule state, as the Estimated Delivery card's chip reads it. */
export type ShipmentScheduleState =
  | "ON_SCHEDULE"
  | "POTENTIAL_DELAY"
  | "DELAYED"
  | "DELIVERED"
  /**
   * The shipment is held, so the date is no longer a forecast anyone should
   * plan on. Deliberately not "action required": this chip sits on the
   * Estimated Delivery card and has to describe that date. Whether the customer
   * has to do something about the hold is a separate question, answered by
   * `buildTrackingAttention` and shown on the status card instead.
   */
  | "ON_HOLD";

/** Newest event first is how both callers sort; this needs the opposite. */
function orderedByTime(events: TrackingEvent[]) {
  return [...events].sort(
    (left, right) => new Date(left.eventAt).getTime() - new Date(right.eventAt).getTime()
  );
}

/**
 * When the transit clock starts.
 *
 * Collection, not booking: a parcel collected three days after it was booked
 * has not spent those days in transit, and measuring from booking would report
 * it late before the carrier ever touched it. Falls back to the booking date
 * for a shipment not yet collected, which is the only date there is.
 */
export function resolveShipmentTransitStart(
  draft: Pick<IShipmentDraft, "createdAt">,
  events: TrackingEvent[],
  bookingAt?: Date | string | null
) {
  const collected = orderedByTime(events).find((event) => event.status === "PARCEL_COLLECTED");
  if (collected) return new Date(collected.eventAt);

  // Reused drafts may be much older than the actual booking. Use the carrier
  // booking timestamp, then the booking milestone for legacy callers, before
  // falling back to draft creation for records without either value.
  if (bookingAt) return new Date(bookingAt);
  const booked = orderedByTime(events).find((event) => event.status === "SHIPMENT_BOOKED");
  return booked ? new Date(booked.eventAt) : draft.createdAt;
}

/**
 * When this shipment should arrive, and whether it is going to.
 *
 * Measured from despatch rather than from booking: a parcel collected three days
 * after it was booked has not spent those days in transit, and quoting from the
 * booking date would report it late before the carrier ever touched it.
 */
export async function buildDeliveryEstimate(input: {
  draft: Pick<IShipmentDraft, "consigneeEnteredAddress" | "serviceType" | "createdAt">;
  events: TrackingEvent[];
  bookingAt?: Date | string | null;
  /** Pre-fetched by `buildDeliveryEstimates` so a page shares one lookup. */
  route?: ISwiftlineRoute | null;
  holidays?: Set<string>;
}) {
  const destinationCountryCode = input.draft.consigneeEnteredAddress?.countryCode ?? "";
  if (!destinationCountryCode) return null;

  const ordered = orderedByTime(input.events);
  const delivered = ordered.find((event) => event.status === "DELIVERED");
  const latest = ordered[ordered.length - 1];

  const estimate = await estimateRouteDelivery({
    destinationCountryCode,
    service: input.draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
    dispatchedAt: resolveShipmentTransitStart(input.draft, input.events, input.bookingAt),
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.holidays === undefined ? {} : { holidays: input.holidays })
  });
  if (!estimate) return null;

  const now = new Date();
  const due = estimate.estimatedDeliveryAt;

  let state: ShipmentScheduleState = "ON_SCHEDULE";
  if (delivered) state = "DELIVERED";
  else if (latest?.status === "ON_HOLD") state = "ON_HOLD";
  else if (now > due) state = "DELAYED";
  // Inside the last day before the date, with the shipment not yet out for
  // delivery, it is not late but it is no longer comfortable.
  else if (
    due.getTime() - now.getTime() < 24 * 60 * 60 * 1000
    && latest?.status !== "OUT_FOR_DELIVERY"
  ) state = "POTENTIAL_DELAY";

  return {
    estimatedDeliveryAt: due.toISOString(),
    earliestDeliveryAt: estimate.earliestDeliveryAt.toISOString(),
    transitDaysMin: estimate.transitDaysMin,
    transitDaysMax: estimate.transitDaysMax,
    transitBasis: estimate.transitBasis,
    state,
    deliveredAt: delivered ? new Date(delivered.eventAt).toISOString() : null
  };
}

/**
 * Estimates for a whole page of shipments, in a handful of queries.
 *
 * Calling `buildDeliveryEstimate` per row would issue a route lookup and a
 * holiday lookup for every shipment- forty queries to draw a twenty-row
 * table, most of them asking the identical question, because a page of
 * shipments is usually a handful of lanes repeated.
 *
 * Routes are fetched once per lane and holidays once per destination country,
 * over a window wide enough for every dispatch date on the page. The estimate
 * itself is then pure arithmetic per row.
 */
export async function buildDeliveryEstimates<T>(
  items: Array<{
    key: T;
    draft: Pick<IShipmentDraft, "consigneeEnteredAddress" | "serviceType" | "createdAt">;
    events: TrackingEvent[];
    bookingAt?: Date | string | null;
  }>
): Promise<Map<T, Awaited<ReturnType<typeof buildDeliveryEstimate>>>> {
  const results = new Map<T, Awaited<ReturnType<typeof buildDeliveryEstimate>>>();
  if (!items.length) return results;

  const laneOf = (draft: { consigneeEnteredAddress?: { countryCode?: string } | null; serviceType?: string }) => ({
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
    service: (draft.serviceType === "CARGO" ? "CARGO" : "COURIER") as "CARGO" | "COURIER"
  });

  const routes = new Map<string, Awaited<ReturnType<typeof findRoute>>>();
  await Promise.all([...new Set(items.map((item) => {
    const lane = laneOf(item.draft);
    return `${lane.destinationCountryCode}|${lane.service}`;
  }))].map(async (laneKey) => {
    const [destinationCountryCode = "", service = "COURIER"] = laneKey.split("|");
    if (!destinationCountryCode) return;
    routes.set(laneKey, await findRoute({ destinationCountryCode, service: service as "CARGO" | "COURIER" }));
  }));

  // One holiday window per country, spanning every dispatch date on the page.
  const holidays = new Map<string, Set<string>>();
  const dispatchDates = items.map((item) => resolveShipmentTransitStart(item.draft, item.events, item.bookingAt).getTime());
  const earliest = new Date(Math.min(...dispatchDates));
  const latest = new Date(Math.max(...dispatchDates));
  await Promise.all([...new Set([...routes.values()]
    .filter((route) => route?.serviceable && route.transitBasis === "BUSINESS_DAYS")
    .map((route) => route!.destinationCountryCode))]
    .map(async (countryCode) => {
      const longest = Math.max(...[...routes.values()]
        .filter((route) => route?.destinationCountryCode === countryCode)
        .map((route) => route!.transitDaysMax));
      holidays.set(countryCode, await loadDestinationHolidays(
        countryCode,
        earliest,
        new Date(latest.getTime() + (longest * 3 + 30) * 24 * 60 * 60 * 1000)
      ));
    }));

  for (const item of items) {
    const lane = laneOf(item.draft);
    const route = routes.get(`${lane.destinationCountryCode}|${lane.service}`) ?? null;
    results.set(item.key, await buildDeliveryEstimate({
      draft: item.draft,
      events: item.events,
      bookingAt: item.bookingAt,
      route,
      holidays: route ? holidays.get(route.destinationCountryCode) : undefined
    }));
  }

  return results;
}

/**
 * Holds only the customer can clear, and what they have to do about each.
 *
 * Kept here rather than derived from `exceptionNextSteps` in
 * clientAttention.service, because that table answers "what is Swiftline doing"
 * for a dashboard list, and a payment hold maps there to a generic delay whose
 * next step reads as Operations chasing it- the opposite of the truth. Every
 * other hold reason is Swiftline's move and produces no chip.
 */
const clientActionByHoldReason: Partial<Record<ShipmentHoldReason, { label: string; detail: string }>> = {
  missing_documents: {
    label: "Documents required",
    detail: "Customs has asked for more paperwork. Upload it on the shipment page to release this shipment."
  },
  address_issue: {
    label: "Address confirmation required",
    detail: "The delivery address could not be used. Confirm or correct it so delivery can be attempted again."
  },
  payment_issue: {
    label: "Payment required",
    detail: "An outstanding payment is holding this shipment. Settle it to release the shipment."
  }
};

export type TrackingAttention = {
  label: string;
  detail: string;
  holdReason: string;
};

/**
 * Whether this shipment is waiting on the customer.
 *
 * Read off the newest event rather than any hold in the history, so a shipment
 * released from a hold stops asking for something that has already been done.
 */
export function buildTrackingAttention(events: TrackingEvent[]): TrackingAttention | null {
  const latest = orderedByTime(events).at(-1);
  if (!latest || latest.status !== "ON_HOLD") return null;

  const action = clientActionByHoldReason[latest.holdReason as ShipmentHoldReason];
  return action ? { ...action, holdReason: String(latest.holdReason ?? "") } : null;
}

export type TrackingSummary = {
  serviceType: string;
  serviceCode: string;
  /** Who actually carries it, so a client can chase the right party. */
  carrierName: string;
  pieces: number;
  actualWeightKg: number;
  chargeableWeightKg: number;
  customerReference: string;
  /** Newest scan time, or the last time the shipment record itself changed. */
  lastUpdateAt: string | null;
};

function round3(value: number) {
  return Number(value.toFixed(3));
}

/**
 * The shipment's own facts, as the tracking details panel lists them.
 *
 * Weights come from the booking snapshot where one exists, because that is what
 * the customer was actually charged on; an amended shipment carries a newer
 * snapshot and the panel should agree with the invoice, not with the original
 * booking. Only an unbooked draft falls back to recomputing.
 */
export function buildTrackingSummary(input: {
  draft: Pick<IShipmentDraft, "parcelList" | "serviceType" | "serviceCode" | "updatedAt">;
  dpdShipment?: {
    bookingProvider?: string | null;
    bookingSnapshot?: unknown;
    currentShipmentSnapshot?: unknown;
    updatedAt?: Date | null;
  } | null;
  events: TrackingEvent[];
}): TrackingSummary {
  const snapshot = readShipmentBookingSnapshot(input.dpdShipment?.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(input.dpdShipment?.bookingSnapshot);

  const serviceType = snapshot?.service?.type ?? input.draft.serviceType;
  const parcels = snapshot?.parcels ?? [];

  const actualWeightKg = parcels.length
    ? parcels.reduce((sum, parcel) => sum + (Number(parcel.actualWeightKg) || 0), 0)
    : input.draft.parcelList.reduce((sum, parcel) => sum + (parcel.weightKg || 0), 0);

  // The priced chargeable weight is authoritative; recomputing is only for a
  // shipment that has never been priced, where nothing has been charged yet.
  const pricedParcels = snapshot?.pricing?.parcels ?? [];
  const chargeableWeightKg = pricedParcels.length
    ? pricedParcels.reduce((sum, parcel) => sum + (Number(parcel.chargeableWeightKg) || 0), 0)
    : input.draft.parcelList.reduce((sum, parcel) => sum + Math.max(
      parcel.weightKg || 0,
      calculateParcelVolumetricWeight(parcel, serviceType === "CARGO" ? "CARGO" : "COURIER")
    ), 0);

  // The first parcel reference is the one sent to the carrier as the customer's
  // own reference, so it is the one to show back to them.
  const customerReference = parcels.find((parcel) => typeof parcel.reference === "string" && parcel.reference.trim())?.reference
    ?? input.draft.parcelList.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1
    ?? "";

  const newestEvent = orderedByTime(input.events).at(-1);
  const lastUpdateAt = newestEvent?.eventAt
    ?? input.dpdShipment?.updatedAt
    ?? input.draft.updatedAt
    ?? null;

  return {
    serviceType,
    serviceCode: snapshot?.service?.code ?? input.draft.serviceCode ?? "",
    carrierName: input.dpdShipment ? "Swiftline" : "Not assigned",
    pieces: parcels.length || input.draft.parcelList.length,
    actualWeightKg: round3(actualWeightKg),
    chargeableWeightKg: round3(chargeableWeightKg),
    customerReference: String(customerReference),
    lastUpdateAt: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null
  };
}
