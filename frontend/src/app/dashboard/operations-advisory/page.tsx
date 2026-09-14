"use client";

import { Suspense } from "react";
import { FiAlertOctagon, FiCalendar, FiEye, FiFileText, FiImage, FiSlash } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import CalendarEntriesManager from "@/components/operations-advisory/CalendarEntriesManager";
import RegulatoryUpdatesManager from "@/components/operations-advisory/RegulatoryUpdatesManager";
import ServiceDisruptionsManager from "@/components/operations-advisory/ServiceDisruptionsManager";
import BookingPausesManager from "@/components/operations-advisory/BookingPausesManager";
import OperationsCalendarView, {
  OperationsCalendarSkeleton,
} from "@/components/operations-advisory/OperationsCalendarView";
import DashboardBannerManager from "@/components/operations-advisory/DashboardBannerManager";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  listCalendarEntries,
  listRegulatoryUpdates,
  listServiceDisruptions,
  type CalendarEntry,
  type RegulatoryUpdate,
  type ServiceDisruption
} from "@/lib/operationsAdvisory";

type Tab = "disruptions" | "calendar" | "regulatory" | "banner" | "bookingPauses";

const tabMeta: Record<Tab, { label: string; icon: typeof FiCalendar }> = {
  disruptions: { label: "Service Disruption Centre", icon: FiAlertOctagon },
  calendar: { label: "Holiday & Cut-Off Calendar", icon: FiCalendar },
  regulatory: { label: "Customs & Regulatory Updates", icon: FiFileText },
  banner: { label: "Dashboard Banner", icon: FiImage },
  bookingPauses: { label: "Booking Pauses", icon: FiSlash }
};

/** Tabs the header calendar icon and other deep links can address by name. */
function tabFromQuery(value: string | null): Tab {
  if (value === "calendar") return "calendar";
  if (value === "regulatory") return "regulatory";
  if (value === "banner") return "banner";
  if (value === "booking-pauses" || value === "bookingPauses" || value === "pauses") return "bookingPauses";
  return "disruptions";
}

export default function OperationsAdvisoryPage() {
  // useSearchParams opts the tree into client rendering, so the boundary has to
  // sit above it or the build fails on prerender.
  return (
    <Suspense fallback={<DashboardLoading message="Loading Operations Advisory..." />}>
      <OperationsAdvisoryContent />
    </Suspense>
  );
}

function OperationsAdvisoryContent() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const searchParams = useSearchParams();

  // The header calendar icon deep-links here with ?tab=calendar. Tab state is
  // kept local so clicking the tabs never rewrites the URL, but a navigation
  // that changes the query (e.g. clicking the header icon again) adjusts the
  // tab during render using React's store-info-from-previous-renders pattern.
  const [tab, setTab] = useState<Tab>(() => tabFromQuery(searchParams.get("tab")));
  const [previousSearchParams, setPreviousSearchParams] = useState(searchParams);
  if (searchParams !== previousSearchParams) {
    setPreviousSearchParams(searchParams);
    setTab(tabFromQuery(searchParams.get("tab")));
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-950">Operations Advisory</h1>
        <p className="mt-1 text-sm text-slate-500">
          Publish service disruptions, maintain the Holiday &amp; Cut-Off Calendar and keep clients ahead of customs rule changes.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-slate-200">
        {(Object.keys(tabMeta) as Tab[]).map((key) => {
          const meta = tabMeta[key];
          const Icon = meta.icon;
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition ${
                active
                  ? "border-[#0D1282] text-[#0D1282]"
                  : "border-transparent text-slate-500 hover:text-slate-900"
              }`}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {meta.label}
            </button>
          );
        })}
      </div>

      {tab === "disruptions" ? <ServiceDisruptionsManager /> : null}
      {tab === "bookingPauses" ? <BookingPausesManager /> : null}
      {tab === "regulatory" ? <RegulatoryUpdatesManager /> : null}
      {tab === "banner" ? <DashboardBannerManager /> : null}
      {tab === "calendar" ? (
        <>
          <CalendarEntriesManager />
          <PreviewStrip />
        </>
      ) : null}
    </>
  );
}

/**
 * A staff-only look at exactly what the client calendar page renders. Reuses the
 * same read-only view component with a small fetch wrapper so admins can verify
 * an entry before it reaches clients.
 */
function PreviewStrip() {
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [disruptions, setDisruptions] = useState<ServiceDisruption[]>([]);
  const [regulatoryUpdates, setRegulatoryUpdates] = useState<RegulatoryUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [entryData, disruptionData, regulatoryData] = await Promise.all([
          listCalendarEntries({ active: true }),
          listServiceDisruptions({ scope: "live" }),
          listRegulatoryUpdates({ active: true })
        ]);
        if (!active) return;
        setEntries(entryData.entries);
        setDisruptions(disruptionData.disruptions);
        // Matches what the client endpoint serves: published, not yet expired.
        setRegulatoryUpdates(regulatoryData.updates.filter((update) => update.status !== "EXPIRED"));
        setError("");
      } catch (caughtError) {
        if (!active) return;
        setError(caughtError instanceof Error ? caughtError.message : "Preview could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, []);

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center gap-2">
        <FiEye aria-hidden="true" className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Client preview</h2>
      </div>
      {error ? (
        <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      ) : loading ? (
        <div aria-busy="true">
          <OperationsCalendarSkeleton />
        </div>
      ) : (
        <OperationsCalendarView entries={entries} disruptions={disruptions} regulatoryUpdates={regulatoryUpdates} />
      )}
    </section>
  );
}
