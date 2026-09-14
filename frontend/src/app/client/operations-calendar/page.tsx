"use client";

import { useEffect, useState } from "react";
import {
  FiAlertTriangle,
  FiCalendar,
  FiClock,
  FiGlobe,
  FiShield,
} from "react-icons/fi";
import {
  ClientDashboardLoading,
} from "@/components/client/ClientDashboardShell";
import OperationsCalendarView from "@/components/operations-advisory/OperationsCalendarView";
import { useClientUser } from "@/lib/useClientUser";
import {
  listClientCalendarEntries,
  listClientRegulatoryUpdates,
  listClientServiceDisruptions,
  type CalendarEntry,
  type RegulatoryUpdate,
  type ServiceDisruption,
} from "@/lib/operationsAdvisory";

/**
 * The Holiday & Cut-Off Calendar a client sees: branch and destination
 * holidays, customs closures, cut-off and flight closing times, weekend
 * delivery availability, peak season restrictions and live service
 * disruptions- all grouped by category by the shared read-only view.
 */
export default function ClientOperationsCalendarPage() {
  const { user, loading: userLoading } = useClientUser();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [disruptions, setDisruptions] = useState<ServiceDisruption[]>([]);
  const [regulatoryUpdates, setRegulatoryUpdates] = useState<RegulatoryUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (userLoading || !user) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const [entryData, disruptionData, regulatoryData] = await Promise.all([
          listClientCalendarEntries(),
          listClientServiceDisruptions(),
          listClientRegulatoryUpdates(),
        ]);

        if (!active) return;

        setEntries(entryData.entries);
        setDisruptions(disruptionData.disruptions);
        setRegulatoryUpdates(regulatoryData.updates);
      } catch (caughtError) {
        if (!active) return;

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "The calendar could not be loaded.",
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [user, userLoading]);

  if (userLoading || !user) return <ClientDashboardLoading />;

  return (
    <div className="mx-auto flex max-w-8xl flex-col gap-5">
      {/* Page header */}
      <header className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex flex-col gap-5 px-5 py-5 sm:px-6 sm:py-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
         

            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0D1282]">
                  Operations
                </span>
              </div>

              <h1 className="text-xl font-semibold tracking-[-0.02em] text-slate-950 sm:text-2xl">
                Holiday &amp; Cut-Off Calendar
              </h1>

              <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500">
                Plan shipments around branch and destination holidays,
                operational cut-offs, customs changes and live service updates.
              </p>
            </div>
          </div>

          {/* Compact information markers */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600">
              <FiClock
                aria-hidden="true"
                className="h-3.5 w-3.5 text-slate-400"
              />
              Cut-off times
            </div>

            <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600">
              <FiGlobe
                aria-hidden="true"
                className="h-3.5 w-3.5 text-slate-400"
              />
              Global holidays
            </div>

            <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600">
              <FiShield
                aria-hidden="true"
                className="h-3.5 w-3.5 text-slate-400"
              />
              Regulatory updates
            </div>
          </div>
        </div>

     <div className="grid border-t border-slate-100 sm:grid-cols-3">
  <div className="flex min-h-[68px] items-center justify-center px-5 py-3 text-center">
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400">
        Calendar events
      </p>
      <p className="mt-0.5 text-base font-semibold text-slate-800">
        {entries.length}
      </p>
    </div>
  </div>

  <div className="flex min-h-[68px] items-center justify-center border-t border-slate-100 px-5 py-3 text-center sm:border-l sm:border-t-0">
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400">
        Service disruptions
      </p>
      <p className="mt-0.5 text-base font-semibold text-slate-800">
        {disruptions.length}
      </p>
    </div>
  </div>

  <div className="flex min-h-[68px] items-center justify-center border-t border-slate-100 px-5 py-3 text-center sm:border-l sm:border-t-0">
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400">
        Regulatory updates
      </p>
      <p className="mt-0.5 text-base font-semibold text-slate-800">
        {regulatoryUpdates.length}
      </p>
    </div>
  </div>
</div>
      </header>

      {/* Error state */}
      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
          <FiAlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-[#D71313]"
          />

          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800">
              Unable to load calendar
            </p>
            <p className="mt-0.5 text-sm leading-5 text-red-700">
              {error}
            </p>
          </div>
        </div>
      ) : null}

      {/* Calendar content */}
      {loading ? (
        <section className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex min-h-[360px] flex-col items-center justify-center px-6 py-12">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[#0D1282]/10 bg-[#0D1282]/[0.05]">
              <FiCalendar
                aria-hidden="true"
                className="h-5 w-5 text-[#0D1282]"
              />
            </div>

            <p className="text-sm font-semibold text-slate-800">
              Loading calendar
            </p>

            <p className="mt-1 text-xs text-slate-400">
              Fetching operational dates and service updates...
            </p>
          </div>
        </section>
      ) : (
        <section className="min-w-0">
          <OperationsCalendarView
            entries={entries}
            disruptions={disruptions}
            regulatoryUpdates={regulatoryUpdates}
          />
        </section>
      )}
    </div>
  );
}