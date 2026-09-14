"use client";

import type { CSSProperties } from "react";
import {
  calendarCategories,
  calendarCategoryLabels,
  regulatoryShipmentDirectionLabels,
  regulatoryShipmentTypeLabels,
  regulatoryUpdateCategoryLabels,
  serviceDisruptionTypeLabels,
  type CalendarCategory,
  type CalendarEntry,
  type RegulatoryUpdate,
  type ServiceDisruption,
} from "@/lib/operationsAdvisory";
import { regulatoryRegionLabel } from "@/lib/regulatoryRegions";

/**
 * The read-only Holiday & Cut-Off Calendar. Shared by the client page and (via
 * the management tab) the staff preview, so the two can never drift apart.
 *
 * Layout: service disruptions and regulatory updates sit side by side in two
 * equal columns, each rendering its items as cards. Calendar events follow
 * underneath in a full-width grid.
 */

const categoryDescriptions: Record<CalendarCategory, string> = {
  BRANCH_HOLIDAY: "Days our branches are closed",
  DESTINATION_HOLIDAY: "Public holidays at destination countries",
  CUSTOMS_HOLIDAY: "Customs offices closed",
  PICKUP_CUTOFF: "Latest time to request a pickup",
  SAME_DAY_BOOKING_CUTOFF: "Latest time to book for same-day dispatch",
  FLIGHT_CLOSING_TIME: "When the next flight closes for a route",
  WEEKEND_DELIVERY: "Whether weekend deliveries run",
  PEAK_SEASON_RESTRICTION: "Restrictions and surcharges during peak periods",
};

const monthNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

function formatCalendarDate(value: string | null) {
  if (!value) return null;
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;

  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${monthNames[(month ?? 1) - 1]} ${year}`;
}

function formatTime(value: string | null) {
  if (!value) return null;
  const [rawHour, rawMinute] = value.split(":").map(Number);
  if (rawHour === undefined || rawMinute === undefined) return value;

  const hour = rawHour % 12 === 0 ? 12 : rawHour % 12;
  const period = rawHour >= 12 ? "PM" : "AM";
  return `${hour}:${String(rawMinute).padStart(2, "0")} ${period}`;
}

function formatLocalDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function branchLabel(entry: CalendarEntry) {
  return entry.branch ? `${entry.branch.code} · ${entry.branch.name}` : "All branches";
}

/** The one-line detail shown under an entry title, per category. */
function entryDetail(entry: CalendarEntry): string {
  switch (entry.category) {
    case "BRANCH_HOLIDAY":
      return `${formatCalendarDate(entry.date) ?? "TBA"} · ${branchLabel(entry)}`;
    case "DESTINATION_HOLIDAY":
      return [
        entry.countryCode ?? "",
        entry.locationLabel ? `via ${entry.locationLabel}` : "",
        formatCalendarDate(entry.date) ?? ""
      ].filter(Boolean).join(" · ");
    case "CUSTOMS_HOLIDAY":
      return `${entry.countryCode ?? "Customs"} · ${formatCalendarDate(entry.date) ?? "TBA"}`;
    case "PICKUP_CUTOFF":
    case "SAME_DAY_BOOKING_CUTOFF":
      return `${formatTime(entry.time) ?? "TBA"} · ${branchLabel(entry)}`;
    case "FLIGHT_CLOSING_TIME":
      return `${entry.locationLabel ?? "Route"} · ${formatTime(entry.time) ?? "TBA"}`;
    case "WEEKEND_DELIVERY":
      return `${branchLabel(entry)} · ${entry.weekendDeliveryAvailable ? "Available" : "Not available"}`;
    case "PEAK_SEASON_RESTRICTION":
      return [formatCalendarDate(entry.date), formatCalendarDate(entry.endDate)]
        .filter(Boolean)
        .join(" - ") || "In effect";
  }
}

const severityTone: Record<ServiceDisruption["severity"], string> = {
  CRITICAL: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20",
  WARNING: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20",
  INFO: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20",
};

const severityLabel: Record<ServiceDisruption["severity"], string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  INFO: "Info",
};

/** Mirrors effectiveLabel below so both card footers read the same way. */
function disruptionDateLabel(disruption: ServiceDisruption) {
  const from = formatLocalDate(disruption.startAt);
  const until = disruption.endAt ? formatLocalDate(disruption.endAt) : null;

  if (!from) return "Start date to be confirmed";
  return until ? `Active ${from} – ${until}` : `Active from ${from}`;
}

/** Staggered entrance: each card rises slightly after the previous one. */
function riseStyle(index: number, stepMs = 70, maxMs = 420): CSSProperties {
  return { animationDelay: `${Math.min(index * stepMs, maxMs)}ms` };
}

function SkeletonBar({ className }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-slate-200/70 ${className ?? ""}`}>
      <div className="ops-shimmer-bar absolute inset-0" aria-hidden="true" />
    </div>
  );
}

/**
 * Loading placeholder that mirrors the loaded layout (two half-width panels
 * on top, calendar grid below) so content swaps in without layout shift.
 * Shared with the admin preview for the same reason.
 */
export function OperationsCalendarSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading operational calendar">
      <span className="sr-only">Loading calendar…</span>

      <div className="grid items-stretch gap-5 lg:grid-cols-2" aria-hidden="true">
        {[0, 1].map((column) => (
          <div
            key={column}
            className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            <div className="border-b border-slate-100 px-5 py-4">
              <SkeletonBar className="h-3.5 w-36" />
              <SkeletonBar className="mt-2 h-3 w-52" />
            </div>
            <div className="flex flex-1 flex-col gap-3 bg-white p-4">
              {[0, 1].map((card) => (
                <div
                  key={card}
                  className="rounded-lg bg-slate-100 px-4 py-3.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <SkeletonBar className="h-3 w-32" />
                    <SkeletonBar className="h-3 w-16" />
                  </div>
                  <SkeletonBar className="mt-3 h-4 w-3/4" />
                  <SkeletonBar className="mt-2 h-3 w-full" />
                  <SkeletonBar className="mt-1.5 h-3 w-2/3" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div
        className="overflow-hidden rounded-xl border border-slate-200 bg-white"
        aria-hidden="true"
      >
        <div className="px-5 py-4">
          <SkeletonBar className="h-3.5 w-32" />
          <SkeletonBar className="mt-2 h-3 w-64" />
        </div>
        <div className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, cell) => (
            <div key={cell} className="bg-white px-5 py-4">
              <SkeletonBar className="h-3.5 w-2/3" />
              <SkeletonBar className="mt-2 h-3 w-1/2" />
              <div className="mt-3 border-t border-slate-100 pt-3">
                <SkeletonBar className="h-3 w-5/6" />
                <SkeletonBar className="mt-2 h-3 w-2/3" />
                <SkeletonBar className="mt-2 h-3 w-4/6" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function OperationsCalendarView({
  entries,
  disruptions,
  regulatoryUpdates = []
}: {
  entries: CalendarEntry[];
  disruptions: ServiceDisruption[];
  /** Customs & regulatory updates, published from their own admin tab. */
  regulatoryUpdates?: RegulatoryUpdate[];
}) {
  const byCategory = new Map<CalendarCategory, CalendarEntry[]>();
  for (const category of calendarCategories) {
    byCategory.set(category, []);
  }
  for (const entry of entries) {
    byCategory.get(entry.category)?.push(entry);
  }

  const hasContent = entries.length > 0 || disruptions.length > 0 || regulatoryUpdates.length > 0;

  if (!hasContent) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
        <p className="text-sm font-semibold text-slate-900">No operational information yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-slate-500">
          Holidays, cut-off times, customs updates and service alerts will appear here as soon as our team publishes them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Top row: disruptions and regulatory updates side by side, equal height */}
      <div className="grid items-stretch gap-5 lg:grid-cols-2">
        <DisruptionsPanel disruptions={disruptions} />
        <RegulatoryUpdatesPanel updates={regulatoryUpdates} />
      </div>

      {/* Bottom: calendar events, full width */}
      <CalendarEventsPanel entries={entries} byCategory={byCategory} />
    </div>
  );
}

function PanelHeader({ title, count, description }: { title: string; count: number; description: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-600">
        {count}
      </span>
    </div>
  );
}

function EmptyList({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
      {message}
    </p>
  );
}

function DisruptionsPanel({ disruptions }: { disruptions: ServiceDisruption[] }) {
  return (
    <section
      aria-labelledby="service-disruptions-heading"
      className="ops-rise flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div id="service-disruptions-heading">
        <PanelHeader
          title="Service disruptions"
          count={disruptions.length}
          description="Live network and service alerts"
        />
      </div>

      <div className="flex flex-1 flex-col gap-3 bg-white p-4">
        {!disruptions.length ? (
          <EmptyList message="No active service disruptions." />
        ) : (
          disruptions.map((disruption, index) => (
            <article
              key={disruption.id}
              style={riseStyle(index)}
              className="ops-rise flex flex-1 flex-col rounded-lg bg-slate-100 px-4 py-3.5 transition-shadow duration-200 hover:shadow-[0_8px_20px_-12px_rgba(15,23,42,0.25)]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                  {serviceDisruptionTypeLabels[disruption.type]}
                </span>
                <span
                  className={`ml-auto rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${severityTone[disruption.severity]}`}
                >
                  {severityLabel[disruption.severity]}
                </span>
              </div>

              <div className="flex-1">
                <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-900">
                  {disruption.title}
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">{disruption.message}</p>
              </div>

              <div className="mt-2.5 border-t border-slate-200 pt-2.5">
                <p className="text-[11px] font-medium text-slate-500">
                  {disruptionDateLabel(disruption)}
                </p>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

const regulatoryStatusTone: Record<RegulatoryUpdate["status"], string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
  UPCOMING: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20",
  EXPIRED: "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-500/10",
};

/** "All · All" reads like noise, so a blanket scope is simply not printed. */
function scopeLabel(update: RegulatoryUpdate) {
  const parts: string[] = [];

  if (!update.affectedShipments.includes("ALL")) {
    parts.push(update.affectedShipments.map((value) => regulatoryShipmentDirectionLabels[value]).join(" / "));
  }
  if (!update.shipmentTypes.includes("ALL")) {
    parts.push(update.shipmentTypes.map((value) => regulatoryShipmentTypeLabels[value]).join(" / "));
  }
  if (update.valueThreshold) parts.push(update.valueThreshold);

  return parts.join(" · ");
}

function effectiveLabel(update: RegulatoryUpdate) {
  if (update.effectiveFromTbc || !update.effectiveFrom) return "Effective date to be confirmed";

  const from = formatLocalDate(update.effectiveFrom);
  const until = update.effectiveUntil ? formatLocalDate(update.effectiveUntil) : null;

  return until ? `Effective ${from} – ${until}` : `Effective from ${from}`;
}

function RegulatoryUpdatesPanel({ updates }: { updates: RegulatoryUpdate[] }) {
  return (
    <section
      aria-labelledby="regulatory-updates-heading"
      style={riseStyle(1, 80, 80)}
      className="ops-rise flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div id="regulatory-updates-heading">
        <PanelHeader
          title="Customs & regulatory updates"
          count={updates.length}
          description="Rule changes and clearance requirements"
        />
      </div>

      <div className="flex flex-1 flex-col gap-3 bg-white p-4">
        {!updates.length ? (
          <EmptyList message="No regulatory updates published." />
        ) : (
          updates.map((update, index) => {
            const scope = scopeLabel(update);

            return (
              <article
                key={update.id}
                style={riseStyle(index)}
                className="ops-rise flex flex-1 flex-col rounded-lg bg-slate-100 px-4 py-3.5 transition-shadow duration-200 hover:shadow-[0_8px_20px_-12px_rgba(15,23,42,0.25)]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {regulatoryUpdateCategoryLabels[update.category]}
                  </span>
                  {update.regions.map((code) => (
                    <span
                      key={code}
                      className="rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600"
                    >
                      {regulatoryRegionLabel(code)}
                    </span>
                  ))}
                  <span
                    className={`ml-auto rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${regulatoryStatusTone[update.status]}`}
                  >
                    {update.status}
                  </span>
                </div>

                <div className="flex-1">
                  <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-900">
                    {update.title}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{update.customerImpact}</p>

                  {update.actionRequired ? (
                    <p className="mt-2.5 rounded-md bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                      <span className="font-semibold text-slate-700">Action required — </span>
                      {update.actionRequired}
                    </p>
                  ) : null}
                </div>

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2.5">
                  <p className="text-[11px] font-medium text-slate-500">
                    {effectiveLabel(update)}
                    {scope ? ` · ${scope}` : ""}
                  </p>
                  {update.sourceUrl ? (
                    <a
                      href={update.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-semibold text-[#0D1282] hover:underline"
                    >
                      Official source
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function CalendarEventsPanel({
  entries,
  byCategory,
}: {
  entries: CalendarEntry[];
  byCategory: Map<CalendarCategory, CalendarEntry[]>;
}) {
  return (
    <section
      aria-label="Calendar events"
      style={riseStyle(2, 80, 160)}
      className="ops-rise overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Calendar events</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Holidays, cut-off times and operating hours by category
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-600">
          {entries.length}
        </span>
      </div>

      <div className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-2 xl:grid-cols-4">
        {calendarCategories.map((category, index) => {
          const categoryEntries = byCategory.get(category) ?? [];

          return (
            <div
              key={category}
              style={riseStyle(index, 50, 350)}
              className="ops-rise flex min-w-0 flex-col bg-white px-5 py-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate text-[13px] font-semibold text-slate-900">
                  {calendarCategoryLabels[category]}
                </h3>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-400">
                  {categoryEntries.length}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">{categoryDescriptions[category]}</p>

              <div className="mt-3 flex flex-1 flex-col divide-y divide-slate-100 border-t border-slate-100">
                {!categoryEntries.length ? (
                  <p className="py-3 text-xs text-slate-400">No entries published.</p>
                ) : (
                  categoryEntries.map((entry) => (
                    <div key={entry.id} className="py-2.5">
                      <p className="text-[13px] font-medium leading-5 text-slate-900">{entry.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{entryDetail(entry)}</p>
                      {entry.description ? (
                        <p className="mt-1 text-xs leading-5 text-slate-500">{entry.description}</p>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
