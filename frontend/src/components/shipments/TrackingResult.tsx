"use client";

import Link from "next/link";
import { FiCheckCircle, FiMapPin, FiTruck, FiUser } from "react-icons/fi";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { labelStatus, type TrackingJourney } from "@/lib/shipmentJourney";
import type { TrackingPosition } from "@/lib/shipmentTracking";
import {
  ActionRequiredChip,
  EstimatedDelivery,
  ShipmentJourney,
  type DeliveryEstimate,
} from "@/components/shipments/ShipmentJourney";
import ParcelActivityPanel from "@/components/shipments/ParcelActivityPanel";
import type { ParcelActivity, ParcelProgress } from "@/lib/shipmentTracking";
import { orderTrackingEvents } from "@/lib/trackingEventOrder";

/**
 * A tracked shipment, as the two signed-in portals draw it.
 *
 * Staff and clients see the same shipment with the same fields, so they share
 * this rather than each keeping a copy. Only the fetching differs, and that
 * stays with the callers.
 *
 * The public tracker at /track deliberately does NOT use this. It has its own
 * component so its design can move independently, and the pieces that genuinely
 * must agree - which journey stages exist and how far a shipment has got - are
 * shared as plain data through `@/lib/shipmentJourney`. Do not reintroduce a
 * public branch here.
 */

export type TrackingTimelineEvent = {
  id?: string;
  status: string;
  statusLabel?: string;
  eventAt: string;
  location?: string;
  note?: string;
};

export type TrackingResultSummary = {
  carrierName?: string;
  pieces?: number;
  actualWeightKg?: number;
  /** Omitted for the public card- it is what the *sender* was priced on. */
  chargeableWeightKg?: number;
  /** Omitted for the public card- it is the sender's own reference. */
  customerReference?: string;
  lastUpdateAt?: string | null;
};

export type TrackingResultRecord = {
  swiftlineTrackingNumber: string;
  carrierShipmentNumber?: string;
  /** Blank on the public card, where the heading falls back to the AWB. */
  consignee?: string;
  destination?: string;
  status: string;
  statusLabel: string;
  parcelNumbers?: string[];
  branchName?: string;
  service: string;
  parcelCount: number;
  createdAt?: string | null;
  events: TrackingTimelineEvent[];
  deliveryEstimate: DeliveryEstimate | null;
  summary: TrackingResultSummary | null;
  attention: { label: string; detail: string } | null;
  journey?: TrackingJourney | null;
  position?: TrackingPosition | null;
  parcelActivities?: ParcelActivity[];
  parcelProgress?: ParcelProgress | null;
};

/**
 * A weight, or an honest blank.
 *
 * Zero is shown as unavailable rather than "0.000 kg": a booked shipment always
 * weighs something, so a zero here means the figure is missing, not that the
 * parcel is weightless.
 */
function weightLabel(weightKg: number | undefined) {
  return weightKg ? `${weightKg.toFixed(3)} kg` : "Not available";
}

export function statusTone(status: string) {
  if (status === "DELIVERED")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (["SHIPMENT_CANCELLED", "RETURNED", "LOST", "DAMAGED"].includes(status))
    return "border-red-200 bg-red-50 text-red-700";
  if (status === "ON_HOLD")
    return "border-amber-200 bg-amber-50 text-amber-800";
  if (["SHIPMENT_BOOKED", "DPD_CREATED", "LABEL_RECEIVED"].includes(status))
    return "border-slate-200 bg-slate-50 text-slate-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

/**
 * The reference strip under the status card.
 *
 * Built as a list rather than written out as JSX so the grid can tell how many
 * cells it has and fill a short final row.
 *
 * Consignee and destination are deliberately absent: both have their own panel
 * beside the timeline, and this strip is for identifiers and measurements.
 */
function shipmentFacts(result: TrackingResultRecord): Array<{ label: string; value: string }> {
  const summary = result.summary;

  return [
    { label: "AWB / Tracking No.", value: result.swiftlineTrackingNumber || "AWB Pending" },
    { label: "Service Partner", value: result.journey?.context.deliveryPartnerName || summary?.carrierName || "Not assigned" },
    { label: "Service Type", value: result.service ? labelStatus(result.service) : "Not available" },
    { label: "Pieces", value: String(summary?.pieces ?? result.parcelCount) },
    { label: "Actual Weight", value: weightLabel(summary?.actualWeightKg) },
    // What the shipment was priced on: the greater of actual and volumetric
    // weight, so it can legitimately exceed the row above.
    { label: "Chargeable Weight", value: weightLabel(summary?.chargeableWeightKg) },
    { label: "Customer Reference", value: summary?.customerReference || "Not provided" },
    { label: "Booked", value: formatDashboardDateTime(result.createdAt) },
    {
      label: "Last Update",
      value: summary?.lastUpdateAt
        ? formatDashboardDateTime(summary.lastUpdateAt)
        : "No updates yet"
    }
  ];
}

export default function TrackingResult({
  record,
  trackedNumber = "",
  detailsHref,
}: {
  record: TrackingResultRecord;
  /** The number the visitor searched by, so a piece-level hit can say so. */
  trackedNumber?: string;
  /** Omitted where the reader has no shipment page to open. */
  detailsHref?: string;
}) {
  const timeline = orderTrackingEvents(record.events);
  const facts = shipmentFacts(record);
  const parcelNumbers = record.parcelNumbers ?? [];
  // A parcel-level search is one whose number belongs to a piece rather than the
  // shipment itself.
  const trackedParcel = trackedNumber
    ? parcelNumbers.find((number) => number.toLowerCase() === trackedNumber.toLowerCase())
    : undefined;

  return (
    <div className="space-y-4 sm:space-y-5">

      {trackedParcel ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 sm:px-5 sm:py-4">
          <FiTruck aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="font-semibold tracking-wide">Tracking parcel {trackedParcel}</span>
          <span className="text-blue-800">
            of shipment {record.swiftlineTrackingNumber || "AWB Pending"} ({record.parcelCount}{" "}
            {record.parcelCount === 1 ? "parcel" : "parcels"}). Events below cover the whole shipment.
          </span>
        </div>
      ) : null}

      <ParcelActivityPanel
        activities={record.parcelActivities}
        progress={record.parcelProgress}
      />

      {/* The journey and the promised date lead, because "where is it and will
          it arrive on time" is the whole reason anyone opens this. */}
      <ShipmentJourney
        events={record.events.map((event) => ({ status: event.status, eventAt: event.eventAt }))}
        journey={record.journey}
      />

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
        <section className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-slate-500">Current Shipment Status</p>
              <h2 className="mt-1 wrap-break-words text-lg font-semibold text-slate-950 sm:text-xl">
                {record.consignee || record.swiftlineTrackingNumber || "Shipment"}
              </h2>
              {record.consignee ? (
                <p className="mt-1 text-sm text-slate-500">
                  {record.swiftlineTrackingNumber || record.carrierShipmentNumber}
                </p>
              ) : null}
              {record.position ? (
                <div className="mt-2">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                    <FiMapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span>Current position: {record.position.label}</span>
                  </p>
                  {record.position.source === "INFERRED" ? (
                    <p className="mt-1 pl-5 text-xs text-slate-500">Based on latest update</p>
                  ) : null}
                  {record.position.holdReasonLabel ? (
                    <p className="mt-1 pl-5 text-xs font-medium text-amber-700">
                      Hold reason: {record.position.holdReasonLabel}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-3 py-1.5 text-xs font-semibold uppercase ${statusTone(record.status)}`}>
                {record.statusLabel}
              </span>
              <ActionRequiredChip attention={record.attention} />
            </div>
          </div>

          {/* The chip says something is needed; this says what, because a reader
              told only "action required" still has to ring in. */}
          {record.attention ? (
            <div className="border-t border-red-100 bg-red-50/60 px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold text-red-800">{record.attention.label}</p>
              <p className="mt-1 text-sm leading-6 text-red-700">{record.attention.detail}</p>
            </div>
          ) : null}
        </section>

        <EstimatedDelivery estimate={record.deliveryEstimate} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map((fact) => (
            <Info key={fact.label} label={fact.label} value={fact.value} />
          ))}
          {/* The grid draws its dividers by letting a slate background show
              through 1px gaps, so a short final row would read as a grey block.
              Only the four-column layout can be short- an even count always
              fills two columns- so the fillers appear there and nowhere else,
              where they would add a blank row instead. */}
          {Array.from(
            { length: (4 - (facts.length % 4)) % 4 },
            (_, index) => <div key={`filler-${index}`} className="hidden bg-white lg:block" />
          )}
        </div>
      </section>

      <div className="grid items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
            <h2 className="font-semibold tracking-wide text-slate-950">Shipment Timeline</h2>
            <p className="mt-1 text-sm text-slate-500">Confirmed shipment events from Swiftline operations.</p>
          </div>
          <div className="p-4 sm:p-5">
            {timeline.length ? (
              <ol className="relative ml-3 border-l border-slate-300">
                {timeline.map((item, index) => (
                  <li key={item.id ?? `${item.status}-${item.eventAt}-${index}`} className="relative pb-7 pl-7 last:pb-0">
                    <span className="absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded border border-emerald-400 bg-emerald-50 text-emerald-600">
                      <FiCheckCircle className="h-4 w-4" />
                    </span>
                    <p className="font-semibold tracking-wide text-slate-950">
                      {item.statusLabel || labelStatus(item.status)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">{formatDashboardDateTime(item.eventAt)}</p>
                    {/* Only scans Operations recorded a place for carry one; the
                        rest of the timeline reads normally without it. */}
                    {item.location ? (
                      <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                        <FiMapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        {item.location}
                      </p>
                    ) : null}
                    {item.note ? <p className="mt-1 text-sm leading-6 text-slate-600">{item.note}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-slate-500">No customer-visible tracking events have been recorded yet.</p>
            )}
          </div>
        </section>

        <aside className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
            <h2 className="font-semibold tracking-wide text-slate-950">Shipment Details</h2>
          </div>
          <div className="divide-y divide-slate-200">
            {record.destination ? (
              <Detail icon={<FiMapPin />} label="Destination" value={record.destination} />
            ) : null}
            {record.consignee ? (
              <Detail icon={<FiUser />} label="Consignee" value={record.consignee} />
            ) : null}
            {/* Pieces and service used to share a "Packages" line here. Both now
                have their own field above, so repeating them would just be the
                same facts twice. */}
            {parcelNumbers.length ? (
              <div className="flex gap-3 p-4 sm:p-5">
                <span className="mt-0.5 text-blue-900"><FiTruck /></span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-slate-500">Parcel Numbers</p>
                  <ul className="mt-1 space-y-1">
                    {parcelNumbers.map((number) => {
                      const active = number === trackedParcel;
                      return (
                        <li
                          key={number}
                          className={`wrap-break-words text-sm tracking-wide ${
                            active ? "font-semibold text-blue-900" : "font-medium text-slate-900"
                          }`}
                        >
                          {active ? "▸ " : ""}
                          {number}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ) : null}
            {record.branchName ? (
              <Detail icon={<FiMapPin />} label="Assigned Branch" value={record.branchName} />
            ) : null}
          </div>
          {detailsHref ? (
            <div className="border-t border-slate-200 p-4 sm:p-5">
              <Link
                href={detailsHref}
                className="inline-flex h-10 w-full items-center justify-center rounded-4xl border border-blue-900 text-sm font-semibold text-blue-900 hover:bg-blue-50"
              >
                Open Shipment Details
              </Link>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-white px-4 py-4 sm:px-5">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-2 wrap-break-words text-sm tracking-wide text-slate-950">{value}</p>
    </div>
  );
}

function Detail({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3 p-4 sm:p-5">
      <span className="mt-0.5 shrink-0 text-blue-900">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
        <p className="mt-1 wrap-break-words text-sm tracking-wide text-slate-900">{value}</p>
      </div>
    </div>
  );
}
