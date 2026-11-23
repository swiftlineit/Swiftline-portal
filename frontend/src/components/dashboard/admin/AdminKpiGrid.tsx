"use client";

import Link from "next/link";
import {
  type DashboardOverview,
  formatCount,
} from "@/lib/dashboardOverview";
import { toRangeDay } from "@/lib/dateRange";

type KpiTone = "primary" | "secondary" | "soft" | "attention";

const toneStyles: Record<
  KpiTone,
  {
    label: string;
    value: string;
    meta: string;
  }
> = {
  primary: {
    label: "text-[#0D1282]/70",
    value: "text-[#0D1282]",
    meta: "text-slate-500",
  },

  secondary: {
    label: "text-[#303978]",
    value: "text-[#1C257E]",
    meta: "text-slate-500",
  },

  soft: {
    label: "text-slate-500",
    value: "text-slate-900",
    meta: "text-slate-500",
  },

  attention: {
    label: "text-[#0D1282]/75",
    value: "text-[#0D1282]",
    meta: "text-slate-600",
  },
};

function KpiCard({
  label,
  value,
  description,
  href,
  tone = "soft",
  aside,
}: {
  label: string;
  value: string;
  description: string;
  href: string;
  tone?: KpiTone;
  aside?: string;
}) {
  const styles = toneStyles[tone];

  return (
    <Link
      href={href}
      data-portal-theme-kpi
      className="relative flex h-full min-h-[8.5rem] flex-col rounded-2xl border border-slate-200 bg-white p-4 transition-[transform,background-color,border-color] duration-300 ease-out hover:-translate-y-0.5 hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/25 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="flex items-start justify-between gap-3">
        <p className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${styles.label}`}>
          {label}
        </p>

        {aside ? (
          <span className="shrink-0 rounded-md border border-current/10 bg-white/60 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {aside}
          </span>
        ) : null}
      </div>

      <p className={`mt-3 text-2xl font-semibold leading-none tracking-tight tabular-nums ${styles.value}`}>
        {value}
      </p>

      <p className={`mt-auto max-w-full pt-3 text-[11px] leading-4 ${styles.meta}`}>
        {description}
      </p>
    </Link>
  );
}

function KpiCardSkeleton() {
  return (
    <div data-portal-theme-kpi className="flex min-h-[8.5rem] animate-pulse flex-col rounded-2xl border border-slate-200 bg-white p-4">
      <div className="h-2.5 w-24 rounded bg-slate-200" />
      <div className="mt-3 h-7 w-20 rounded bg-slate-200" />
      <div className="mt-2 h-5 rounded bg-slate-100" />
      <div className="mt-auto space-y-1.5 pt-2">
        <div className="h-2.5 w-full rounded bg-slate-200" />
        <div className="h-2.5 w-2/3 rounded bg-slate-200" />
      </div>
    </div>
  );
}

export default function AdminKpiGrid({
  overview,
  dataLoading,
  tracksShipments,
  role,
}: {
  overview: DashboardOverview | null;
  dataLoading: boolean;
  tracksShipments: boolean;
  role: string;
}) {
  const operationsOnly = role === "operations";
  const shipments = overview?.shipments ?? null;
  const manifests = overview?.manifests ?? null;
  const accounts = overview?.accounts ?? null;
  const today = toRangeDay(new Date());

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {dataLoading
        ? Array.from({
            length: operationsOnly ? 4 : tracksShipments ? 8 : 4,
          }).map((_, index) => (
            <KpiCardSkeleton key={index} />
          ))
        : null}

      {!dataLoading && shipments ? (
        <>
          <KpiCard
            label="Booked today"
            value={formatCount(shipments.bookedToday)}
            description="Carrier bookings made today"
            href={`/dashboard/shipments?bookedDate=${today}`}
            tone="primary"
            aside={`${formatCount(shipments.bookedYesterday)} yesterday`}
          />

          <KpiCard
            label="In transit"
            value={formatCount(shipments.inTransit)}
            description="Collected through to out for delivery"
            href="/dashboard/shipments?status=IN_TRANSIT"
            tone="secondary"
          />

          <KpiCard
            label="Delivered"
            value={formatCount(shipments.delivered)}
            description="All shipments matching this status"
            href="/dashboard/shipments?status=DELIVERED"
            tone="soft"
          />

          <KpiCard
            label="Needs attention"
            value={formatCount(shipments.exceptions)}
            description={`${shipments.onHold} on hold, plus returns, cancellations, and failed bookings`}
            href="/dashboard/shipments?attention=1"
            tone={shipments.exceptions > 0 ? "attention" : "soft"}
            aside={
              shipments.onHold > 0
                ? `${formatCount(shipments.onHold)} on hold`
                : undefined
            }
          />
        </>
      ) : null}

      {!operationsOnly && !dataLoading && accounts ? (
        <>
          <KpiCard
            label="Business accounts"
            value={formatCount(accounts.total)}
            description={`${accounts.active} active, ${accounts.pendingReview} awaiting review`}
            href="/dashboard/business-accounts"
            tone="primary"
            aside={`${formatCount(accounts.active)} active`}
          />

          <KpiCard
            label="Active branches"
            value={formatCount(accounts.activeBranches)}
            description="Origins currently accepting bookings"
            href="/dashboard/branches"
            tone="secondary"
          />
        </>
      ) : null}

      {!operationsOnly &&
      !dataLoading &&
      manifests &&
      manifests.detailed ? (
        <>
          <KpiCard
            label="Manifests"
            value={formatCount(manifests.total)}
            description={`${manifests.packing} packing, ${manifests.readyToSeal} ready to seal`}
            href="/dashboard/operations-manifests"
            tone="soft"
          />

          <KpiCard
            label="Ready to seal"
            value={formatCount(manifests.readyToSeal)}
            description="Bags closed and scans reconciled"
            href="/dashboard/operations-manifests?status=READY_TO_SEAL"
            tone={manifests.readyToSeal > 0 ? "attention" : "soft"}
          />

          <KpiCard
            label="Awaiting dispatch"
            value={formatCount(manifests.sealed)}
            description="Sealed and waiting on a flight"
            href="/dashboard/operations-manifests?status=SEALED"
            tone="secondary"
          />

          <KpiCard
            label="Dispatched"
            value={formatCount(manifests.dispatched)}
            description="Handed to the carrier to date"
            href="/dashboard/operations-manifests?status=DISPATCHED"
            tone="primary"
          />
        </>
      ) : null}

      {!operationsOnly &&
      !dataLoading &&
      manifests &&
      !manifests.detailed ? (
        <KpiCard
          label="Awaiting dispatch"
          value={formatCount(manifests.sealed)}
          description={`${manifests.readyToSeal} more ready to seal`}
          href="/dashboard/operations-manifests?status=SEALED"
          tone="secondary"
        />
      ) : null}

    </div>
  );
}
