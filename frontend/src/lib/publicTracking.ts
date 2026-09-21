import { apiUrl } from "@/lib/api";
import type { DeliveryEstimate } from "@/components/shipments/ShipmentJourney";
import type { TrackingJourney } from "@/lib/shipmentJourney";
import type { ParcelActivity, ParcelProgress, TrackingPosition } from "@/lib/shipmentTracking";

/**
 * The tracking card as someone with no account sees it.
 *
 * Deliberately a much narrower shape than `ClientShipmentDetails`: there is no
 * consignee, no address, no pricing and no document metadata, because the public
 * endpoint never sends any. Keeping the type this tight means a component that
 * tries to render one of those fields fails to compile rather than at runtime.
 */
export type PublicTrackingEvent = {
  status: string;
  statusLabel: string;
  eventAt: string;
  location: string;
  note: string;
};

export type PublicTracking = {
  /** What the visitor typed, which may be one piece of a multi-parcel shipment. */
  trackedNumber: string;
  /** The shipment's own AWB, which the timeline below always belongs to. */
  trackingNumber: string;
  isParcelLevel: boolean;

  status: string;
  statusLabel: string;
  currentPosition: TrackingPosition;

  serviceType: string;
  carrierName: string;
  pieces: number;
  actualWeightKg: number;

  originStationCode: string;
  originCity: string;
  originCountryName: string;

  destinationCity: string;
  destinationCountryCode: string;
  destinationCountryName: string;

  bookedAt: string | null;
  lastUpdateAt: string | null;
  deliveryEstimate: DeliveryEstimate | null;
  attention: { label: string; detail: string } | null;
  journey: TrackingJourney;
  parcelActivities: ParcelActivity[];
  parcelProgress: ParcelProgress | null;

  events: PublicTrackingEvent[];
};

export type PublicTrackingResult =
  | { ok: true; tracking: PublicTracking }
  | { ok: false; status: number; message: string };

/**
 * Looks a shipment up with no session.
 *
 * Returns a result rather than throwing: "that number is not one of ours" is an
 * ordinary outcome of a public search box, not an exception, and the page has to
 * render something useful for it either way. Only a genuine transport failure is
 * folded into a generic message.
 */
export async function trackPublicShipment(trackingNumber: string): Promise<PublicTrackingResult> {
  const target = apiUrl(`/api/v1/public/tracking/${encodeURIComponent(trackingNumber.trim())}`);

  let response: Response;
  try {
    // Never cached: a shipment's position is the whole point, and a stale one is
    // worse than a slow one.
    response = await fetch(target, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Tracking is temporarily unavailable. Please try again in a moment."
    };
  }

  const payload = await response.json().catch(() => null) as
    | { success?: boolean; message?: string; tracking?: PublicTracking }
    | null;

  if (!response.ok || !payload?.success || !payload.tracking) {
    return {
      ok: false,
      status: response.status,
      message: payload?.message || "No shipment was found for that tracking number."
    };
  }

  return { ok: true, tracking: payload.tracking };
}

/**
 * What a tracking reference may look like, mirrored from the server so the form
 * can reject an obvious typo without a round trip. The server revalidates.
 *
 * Intentionally not pinned to today's SLCDEL170826001 shape: shipments booked
 * earlier carry an older SLDL20072026000001 form and carrier-numbered pieces
 * like DPDTESTDL2107202600000101, all of which are printed on labels people
 * still hold. See the matching comment on the server for the full reasoning.
 */
export const TRACKING_REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9-]{10,39}$/i;

export function isTrackingReference(value: string) {
  return TRACKING_REFERENCE_PATTERN.test(value.trim());
}

/** Uppercased and stripped of the spaces people paste in from a label. */
export function normalizeTrackingNumber(value: string) {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}
