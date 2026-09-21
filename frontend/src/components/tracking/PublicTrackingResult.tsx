import {
  FiAlertCircle,
  FiCheckCircle,
  FiClock,
  FiMapPin,
  FiPackage,
  FiTruck,
} from "react-icons/fi";

import { formatDashboardDateTime } from "@/lib/dateFormat";
import {
  labelStatus,
  resolveJourneyStages,
  type DeliveryEstimate,
} from "@/lib/shipmentJourney";
import type {
  PublicTracking,
  PublicTrackingResult as TrackingLookup,
} from "@/lib/publicTracking";
import PublicTrackingForm from "@/components/tracking/PublicTrackingForm";
import ParcelActivityPanel from "@/components/shipments/ParcelActivityPanel";

/**
 * The public tracking result page, top to bottom.
 *
 * OWNED BY THE PUBLIC TRACKER. Nothing in this file is shared with
 * `components/shipments/TrackingResult.tsx`, which is the signed-in portals'
 * version - the two are free to look nothing alike, and editing this file cannot
 * change what staff or clients see.
 *
 * The one thing that is shared, and must stay shared, is `@/lib/shipmentJourney`:
 * which stages exist and how far a shipment has got. That is meaning, not
 * styling. A rail here that claimed a stage the event history lacks would be
 * wrong no matter how it was drawn.
 *
 * A server component - no "use client". The consignee usually arrives from a
 * forwarded link, so everything below is in the first paint and works with
 * JavaScript switched off. Only the search box is interactive.
 */

export default function PublicTrackingResult({
  lookup,
  requestedNumber,
}: {
  lookup: TrackingLookup;
  /** What was in the URL, so a miss can name it back to the reader. */
  requestedNumber: string;
}) {
  if (!lookup.ok) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.06)]">
          <div className="absolute inset-x-0 top-0 h-0.75 bg-linear-to-r from-[#d71920] via-[#d71920] to-[#0D1282]" />

          <div className="relative px-5 py-10 text-center sm:px-10 sm:py-14 lg:px-16">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-red-100 bg-red-50 text-[#d71920]">
              <FiAlertCircle aria-hidden="true" className="h-6 w-6" />
            </span>

            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-[#d71920]">
              Tracking unavailable
            </p>

            <h1 className="mx-auto mt-3 max-w-2xl wrap-break-words text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
              We could not find {requestedNumber}
            </h1>

            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-[15px]">
              {lookup.message}
            </p>

            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
              Check the number against your label - the letter O and the digit 0
              are easy to confuse - or try again below.
            </p>

            <div className="mx-auto mt-8 max-w-xl text-left">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2 sm:p-3">
                <PublicTrackingForm initialValue={requestedNumber} />
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const tracking = lookup.tracking;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="space-y-5 sm:space-y-6">
        <TrackingHeader tracking={tracking} />

        {tracking.isParcelLevel ? <ParcelNotice tracking={tracking} /> : null}

        <ParcelActivityPanel
          activities={tracking.parcelActivities}
          progress={tracking.parcelProgress}
        />

        <SummaryBand tracking={tracking} />

        <JourneyRail tracking={tracking} />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <StatusCard tracking={tracking} />
          <EstimateCard estimate={tracking.deliveryEstimate} />
        </div>

        <FactsGrid tracking={tracking} />

        <Timeline tracking={tracking} />
      </div>

      <section className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_520px] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#0D1282]">
              Another shipment?
            </p>

            <h2 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">
              Track another shipment
            </h2>

            <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500">
              Enter another Swiftline AWB or parcel number to view its latest
              shipment status.
            </p>
          </div>

          <div>
            <PublicTrackingForm />
          </div>
        </div>
      </section>
    </div>
  );
}

/** A weight, or an honest blank - a booked shipment always weighs something. */
function weightLabel(weightKg: number) {
  return weightKg ? `${weightKg.toFixed(3)} kg` : "Not available";
}

function statusDotClass(status: string) {
  if (status === "DELIVERED") return "bg-emerald-500";

  if (["SHIPMENT_CANCELLED", "RETURNED", "LOST", "DAMAGED"].includes(status)) {
    return "bg-red-500";
  }

  if (status === "ON_HOLD") return "bg-amber-500";

  return "bg-emerald-500";
}

function statusChipClass(status: string) {
  if (status === "DELIVERED") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (["SHIPMENT_CANCELLED", "RETURNED", "LOST", "DAMAGED"].includes(status)) {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (status === "ON_HOLD") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }

  if (status === "SHIPMENT_BOOKED") {
    return "border-slate-200 bg-slate-50 text-slate-700";
  }

  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function TrackingHeader({ tracking }: { tracking: PublicTracking }) {
  return (
    <section className="relative overflow-hidden rounded-lg bg-[#07113f] text-white shadow-[0_24px_70px_rgba(7,17,63,0.16)]">
      <div className="absolute inset-x-0 top-0 h-0.75 bg-[#d71920]" />

      <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/4 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 left-1/4 h-60 w-60 rounded-full bg-[#d71920]/6 blur-3xl" />

      <div className="relative p-5 sm:p-7 lg:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/55">
                Swiftline tracking
              </p>

              <span className="h-1 w-1 rounded-full bg-[#d71920]" />

              <p className="text-xs font-medium text-white/50">
                {tracking.serviceType
                  ? labelStatus(tracking.serviceType)
                  : "Shipment service"}
              </p>
            </div>

            <h1 className="mt-3 break-all text-2xl font-semibold tracking-tight sm:text-3xl lg:text-4xl">
              {tracking.trackingNumber}
            </h1>

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-white/70">
              <div className="flex items-center gap-2">
                <FiMapPin
                  aria-hidden="true"
                  className="h-4 w-4 text-[#d71920]"
                />

                <span>
                  {tracking.originCity ||
                    tracking.originCountryName ||
                    "Origin"}
                </span>

                <span className="text-white/30">→</span>

                <span>
                  {tracking.destinationCity ||
                    tracking.destinationCountryName ||
                    "Destination"}
                </span>
              </div>

              {tracking.currentPosition.label ? (
                <div className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-white/30" />

                  <span>
                    Current position{" "}
                    <strong className="font-semibold text-white">
                      {tracking.currentPosition.label}
                    </strong>
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="shrink-0">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-wide ${statusChipClass(
                tracking.status,
              )}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${statusDotClass(
                  tracking.status,
                )}`}
              />

              {tracking.statusLabel}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The at-a-glance band.
 *
 * One column on a phone, fanning out to five from xl, so the same five facts
 * stay readable at every width instead of being crushed into columns.
 */
function SummaryBand({ tracking }: { tracking: PublicTracking }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard
        label="Current Status"
        value={tracking.statusLabel}
        hint={tracking.currentPosition.label}
        accent
      />

      <SummaryCard
        label="Route"
        value={`${tracking.originCountryName || "Origin"} → ${
          tracking.destinationCountryName || "Destination"
        }`}
        hint={
          tracking.serviceType
            ? labelStatus(tracking.serviceType)
            : "Service not set"
        }
      />

      <SummaryCard
        label="Destination"
        value={
          tracking.destinationCity ||
          tracking.destinationCountryName ||
          "Not available"
        }
        hint={tracking.destinationCity ? tracking.destinationCountryName : ""}
      />

      <SummaryCard
        label="Shipment"
        value={`${tracking.pieces} ${
          tracking.pieces === 1 ? "piece" : "pieces"
        }`}
        hint={weightLabel(tracking.actualWeightKg)}
      />
    </section>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-white p-5">
      {accent ? (
        <span className="absolute inset-y-0 left-0 w-0.75 bg-[#d71920]" />
      ) : null}

      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </p>

      <p className="mt-2 wrap-break-words text-base font-semibold text-slate-950">
        {value}
      </p>

      <Hint>{hint}</Hint>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 truncate text-xs text-slate-500">{children || " "}</p>
  );
}

function ParcelNotice({ tracking }: { tracking: PublicTracking }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-4 sm:px-5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0D1282] text-white">
        <FiPackage aria-hidden="true" className="h-4 w-4" />
      </span>

      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-950">
          Tracking parcel {tracking.trackedNumber}
        </p>

        <p className="mt-1 text-sm leading-6 text-slate-600">
          This parcel belongs to shipment {tracking.trackingNumber} (
          {tracking.pieces} {tracking.pieces === 1 ? "parcel" : "parcels"}).
          Events below cover the whole shipment.
        </p>
      </div>
    </div>
  );
}

/**
 * The public journey rail.
 *
 * Its own markup, but the stages come from `resolveJourneyStages` so it can
 * never claim a step the shipment's history does not have.
 */
function JourneyRail({ tracking }: { tracking: PublicTracking }) {
  const stages = resolveJourneyStages(tracking.events, tracking.journey);

  return (
   <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
  <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#d71920]">
        Shipment progress
      </p>

      <h2 className="mt-1 text-base font-semibold text-slate-950">
        Shipment journey
      </h2>
    </div>

    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0D1282]/5">
      <FiTruck
        aria-hidden="true"
        className="h-4 w-4 text-[#0D1282]"
      />
    </div>
  </div>

  <div className="px-5 py-5 sm:px-6 sm:py-6">
    {tracking.journey?.context.routeSegments.length ? (
      <div className="mb-6 rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
          {tracking.journey.context.routeSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="contents">
              {index ? (
                <span
                  aria-hidden="true"
                  className="text-slate-300"
                >
                  →
                </span>
              ) : null}

              <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
                {segment}
              </span>
            </span>
          ))}
        </div>
      </div>
    ) : null}

    <div className="overflow-x-auto">
      <ol className="flex min-w-0 flex-col md:min-w-[760px] md:flex-row">
        {stages.map((stage, index) => {
          const reached = stage.reachedAt !== null;

          return (
            <li
              key={stage.label}
              className="relative flex flex-1 gap-4 pb-7 last:pb-0 md:min-w-0 md:flex-col md:gap-3 md:pb-0"
            >
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`absolute left-3.5 top-7 h-[calc(100%-4px)] w-px md:left-7 md:top-3.5 md:h-px md:w-[calc(100%-28px)] ${
                    stages[index + 1].reachedAt
                      ? "bg-emerald-400"
                      : "bg-slate-200"
                  }`}
                />
              ) : null}

              <div className="relative z-10 flex shrink-0 md:h-7">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition ${
                    reached
                      ? stage.isCurrent
                        ? "border-emerald-500 bg-emerald-500 text-white shadow-[0_0_0_4px_rgba(16,185,129,0.12)]"
                        : "border-emerald-500 bg-emerald-500 text-white"
                      : "border-slate-200 bg-white text-slate-300"
                  }`}
                >
                  {reached ? (
                    <FiCheckCircle
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                    />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
              </div>

              <div className="min-w-0 md:pr-5">
                <p
                  className={`text-xs font-semibold leading-5 ${
                    reached
                      ? stage.isCurrent
                        ? "text-emerald-700"
                        : "text-slate-900"
                      : "text-slate-400"
                  }`}
                >
                  {stage.label}
                </p>

                <p
                  className={`mt-1 text-[11px] leading-4 ${
                    reached ? "text-slate-500" : "text-slate-400"
                  }`}
                >
                  {reached
                    ? formatDashboardDateTime(stage.reachedAt)
                    : "Pending"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  </div>
</section>
  );
}

function StatusCard({ tracking }: { tracking: PublicTracking }) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Current shipment status
            </p>

            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
              {tracking.statusLabel}
            </h2>
          </div>

          <span
            className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${statusChipClass(
              tracking.status,
            )}`}
          >
            {tracking.statusLabel}
          </span>
        </div>

        <div className="mt-6 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-slate-400">
              Tracking number
            </p>
            <p className="mt-1 break-all text-sm font-semibold text-slate-900">
              {tracking.trackingNumber}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-400">
              Current position
            </p>

            <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FiMapPin
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-[#d71920]"
              />

              {tracking.currentPosition.label}
            </p>

            {tracking.currentPosition.source === "INFERRED" ? (
              <p className="mt-1 text-xs text-slate-500">Based on latest update</p>
            ) : null}

            {tracking.currentPosition.holdReasonLabel ? (
              <p className="mt-1 text-xs font-medium text-amber-700">
                Hold reason: {tracking.currentPosition.holdReasonLabel}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {tracking.attention ? (
        <div className="border-t border-amber-100 bg-amber-50/80 px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />

            <div>
              <p className="text-sm font-semibold text-amber-900">
                {tracking.attention.label}
              </p>

              <p className="mt-1 text-sm leading-6 text-amber-800">
                {tracking.attention.detail}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const scheduleChips: Record<
  DeliveryEstimate["state"],
  { label: string; className: string }
> = {
  ON_SCHEDULE: {
    label: "On Schedule",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  POTENTIAL_DELAY: {
    label: "Potential Delay",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  DELAYED: {
    label: "Delayed",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  DELIVERED: {
    label: "Delivered",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  // A hold means the date can no longer be relied on, not that it has passed.
  ON_HOLD: {
    label: "Estimate Paused",
    className: "border-slate-300 bg-slate-100 text-slate-600",
  },
};

function EstimateCard({ estimate }: { estimate: DeliveryEstimate | null }) {
  if (!estimate) {
    return (
      <section className="flex min-h-47.5 flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <FiClock className="h-4 w-4" />
        </div>

        <div className="mt-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Estimated Delivery
          </p>

          <p className="mt-2 text-sm leading-6 text-slate-500">
            Not available for this destination yet.
          </p>
        </div>
      </section>
    );
  }

  const chip = scheduleChips[estimate.state];

  const unit =
    estimate.transitBasis === "BUSINESS_DAYS"
      ? "business days"
      : "calendar days";

  return (
    <section className="relative overflow-hidden rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
      <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-[#d71920]/[0.035] blur-2xl" />

      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0D1282]/[0.07] text-[#0D1282]">
            <FiClock className="h-4 w-4" />
          </span>

          <span
            className={`inline-flex rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}
          >
            {chip.label}
          </span>
        </div>

        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {estimate.deliveredAt ? "Delivered" : "Estimated Delivery"}
        </p>

        <p className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
          {formatDashboardDateTime(
            estimate.deliveredAt ?? estimate.estimatedDeliveryAt,
          )}
        </p>

        {!estimate.deliveredAt ? (
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {estimate.transitDaysMin === estimate.transitDaysMax
              ? `${estimate.transitDaysMax} ${unit} in transit`
              : `${estimate.transitDaysMin}-${estimate.transitDaysMax} ${unit} in transit`}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The reference strip.
 *
 * Pieces and weight are deliberately absent - the summary band above already
 * carries them, and showing the same two numbers twice on one page reads as a
 * mistake.
 */
function FactsGrid({ tracking }: { tracking: PublicTracking }) {
  const facts = [
    {
      label: "AWB / Tracking No.",
      value: tracking.trackingNumber || "AWB Pending",
    },
    {
      label: "Service Partner",
      value: tracking.journey?.context.deliveryPartnerName || tracking.carrierName || "Not assigned",
    },
    {
      label: "Service Type",
      value: tracking.serviceType
        ? labelStatus(tracking.serviceType)
        : "Not available",
    },
    {
      label: "Booked",
      value: formatDashboardDateTime(tracking.bookedAt),
    },
    {
      label: "Last Update",
      value: tracking.lastUpdateAt
        ? formatDashboardDateTime(tracking.lastUpdateAt)
        : "No updates yet",
    },
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#d71920]">
          Shipment information
        </p>

        <h2 className="mt-1 text-base font-semibold text-slate-950">
          Shipment details
        </h2>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5">
        {facts.map((fact, index) => (
          <div
            key={fact.label}
            className={[
              "min-w-0 px-5 py-5 sm:px-6",
              index !== facts.length - 1
                ? "border-b border-slate-100 sm:border-b-0 sm:border-r"
                : "",
            ].join(" ")}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {fact.label}
            </p>

            <p className="mt-2 wrap-break-words text-sm font-medium leading-6 text-slate-900">
              {fact.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Timeline({ tracking }: { tracking: PublicTracking }) {
  // Oldest first: the public page reads as a story of where the parcel has been.
  const events = tracking.events
    .filter((event) => event.status !== "PARCEL_COLLECTED")
    .sort(
    (left, right) =>
      new Date(left.eventAt).getTime() - new Date(right.eventAt).getTime(),
  );

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-5 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#d71920]">
          Tracking history
        </p>

        <h2 className="text-xl font-semibold tracking-tight text-slate-950">
          Shipment Timeline
        </h2>

        <p className="text-sm leading-6 text-slate-500">
          Confirmed shipment events from Swiftline operations.
        </p>
      </div>

      <div className="p-4 sm:p-5">
        {events.length ? (
          <ol className="relative space-y-3">
            {events.map((event, index) => {
              const isLatest = index === events.length - 1;

              return (
                <li
                  key={`${event.status}-${event.eventAt}-${index}`}
                  className="relative pl-8 sm:pl-9"
                >
                  {index < events.length - 1 ? (
                    <span className="absolute left-3.25 top-7 h-[calc(100%+12px)] w-px bg-slate-200 sm:left-3.5" />
                  ) : null}

                  <span
                    className={[
                      "absolute left-0 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 sm:h-7 sm:w-7",
                      isLatest
                        ? "border-emerald-500 bg-emerald-500 text-white shadow-[0_4px_12px_rgba(16,185,129,0.18)]"
                        : "border-emerald-200 bg-white text-emerald-600",
                    ].join(" ")}
                  >
                    <FiCheckCircle aria-hidden="true" className="h-3.5 w-3.5" />
                  </span>

                  <div
                    className={[
                      "rounded-xl border px-4 py-3.5 sm:px-5 sm:py-4",
                      isLatest
                        ? "border-emerald-200 bg-emerald-50/40"
                        : "border-slate-200 bg-white",
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900 sm:text-[15px]">
                            {event.statusLabel || labelStatus(event.status)}
                          </p>

                          {isLatest ? (
                            <span className="rounded-full bg-[#d71920]/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#d71920]">
                              Latest
                            </span>
                          ) : null}
                        </div>

                        {event.location || event.eventAt ? (
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-slate-500">
                            {event.location ? (
                              <span className="flex items-center gap-1.5">
                                <FiMapPin
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5 shrink-0 text-[#d71920]"
                                />
                                {event.location}
                              </span>
                            ) : null}

                            {event.eventAt ? (
                              <span className="text-slate-400">
                                {formatDashboardDateTime(event.eventAt)}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {event.note ? (
                      <p className="mt-3 border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">
                        {event.note}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-400 shadow-sm">
              <FiTruck className="h-4.5 w-4.5" />
            </span>

            <div>
              <p className="text-sm font-semibold text-slate-800">
                No tracking events yet
              </p>

              <p className="mt-0.5 text-xs text-slate-500">
                No tracking events have been recorded yet.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
