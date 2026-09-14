"use client";

import { useEffect, useState } from "react";
import {
  ClientDashboardLoading,
} from "@/components/client/ClientDashboardShell";
import OperationsCalendarView, {
  OperationsCalendarSkeleton,
} from "@/components/operations-advisory/OperationsCalendarView";
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

  const stats = [
    { label: "Service disruptions", value: disruptions.length },
    { label: "Regulatory updates", value: regulatoryUpdates.length },
    { label: "Calendar events", value: entries.length },
  ];

  return (
    <div className="mx-auto flex max-w-8xl flex-col gap-5">
      {/* Page header */}
      <header className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">

            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-slate-900 sm:text-2xl">
              Holiday &amp; Cut-Off Calendar
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500">
              Plan shipments around branch and destination holidays,
              operational cut-offs, customs changes and live service updates.
            </p>
          </div>

          <dl className="flex shrink-0 divide-x divide-slate-100 rounded-lg border border-slate-100 bg-slate-50/70">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-[104px] px-4 py-3 text-center">
                <dt className="order-2 mt-0.5 block text-[11px] font-medium leading-4 text-slate-500">
                  {stat.label}
                </dt>
                <dd className="order-1 text-lg font-semibold tabular-nums text-slate-900">
                  {loading ? "—" : stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* Error state */}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
          <p className="text-sm font-semibold text-slate-900">
            Unable to load calendar
          </p>
          <p className="mt-0.5 text-sm leading-5 text-red-700">
            {error}
          </p>
        </div>
      ) : null}

      {/* Calendar content */}
      {loading ? (
        <section className="min-w-0" aria-busy="true">
          <OperationsCalendarSkeleton />
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
