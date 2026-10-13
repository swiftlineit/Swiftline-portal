"use client";

import Link from "next/link";
import {
  type DashboardOverview,
  formatCompactMoney,
  formatCount,
} from "@/lib/dashboardOverview";
import { toRangeDay } from "@/lib/dateRange";

type KpiTone = "primary" | "secondary" | "soft" | "attention";

const toneStyles: Record<
  KpiTone,
  {
    card: string;
    label: string;
    value: string;
    meta: string;
    corner: string;
  }
> = {
  primary: {
    // CHANGE KPI HOVER BACKGROUND COLOR HERE:
    // Replace hover:bg-[#12185A] with any color you want.
    card: "border-[#0D1282]/18 bg-[#0D1282]/[0.045] hover:border-[#12185A] hover:bg-blue-800",
    label: "text-[#0D1282]/70",
    value: "text-[#0D1282]",
    meta: "text-slate-500",
    corner: "bg-[#0D1282]/[0.08]",
  },

  secondary: {
    // CHANGE KPI HOVER BACKGROUND COLOR HERE:
    card: "border-[#1C257E]/14 bg-[#1C257E]/[0.035] hover:border-[#12185A] hover:bg-blue-800",
    label: "text-[#303978]",
    value: "text-[#1C257E]",
    meta: "text-slate-500",
    corner: "bg-[#1C257E]/[0.065]",
  },

  soft: {
    // CHANGE KPI HOVER BACKGROUND COLOR HERE:
    card: "border-slate-200 bg-slate-50/70 hover:border-[#12185A] hover:bg-blue-800",
    label: "text-slate-500",
    value: "text-slate-900",
    meta: "text-slate-500",
    corner: "bg-slate-200/60",
  },

  attention: {
    // CHANGE KPI HOVER BACKGROUND COLOR HERE:
    card: "border-[#0D1282]/22 bg-[#0D1282]/[0.075] hover:border-[#12185A] hover:bg-blue-800",
    label: "text-[#0D1282]/75",
    value: "text-[#0D1282]",
    meta: "text-slate-600",
    corner: "bg-[#0D1282]/[0.12]",
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
      className={`group relative min-h-38.5 overflow-hidden rounded-2xl border p-5 transition-all duration-200 hover:-translate-y-px hover:shadow-[0_10px_26px_-14px_rgba(15,23,42,0.22)] ${styles.card}`}
    >
      {/* subtle decorative corner */}
      <div
        aria-hidden="true"
        className={`absolute -right-8 -top-10 h-28 w-28 rounded-full transition-all duration-300 group-hover:scale-110 group-hover:bg-white/10 ${styles.corner}`}
      />

      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-4">
          <p
            // CHANGE HOVER LABEL TEXT COLOR HERE:
            // Replace group-hover:text-white if another hover color is needed.
            className={`text-[12px] font-semibold uppercase tracking-[0.07em] transition-colors duration-200 group-hover:text-white ${styles.label}`}
          >
            {label}
          </p>

          {aside ? (
            <span
              // CHANGE HOVER BADGE COLORS HERE if needed.
              className="shrink-0 rounded-md border border-current/10 bg-white/60 px-2 py-1 text-[10px] font-semibold text-slate-500 transition-colors duration-200 group-hover:border-white/20 group-hover:bg-white/10 group-hover:text-white"
            >
              {aside}
            </span>
          ) : null}
        </div>

        <p
          // CHANGE HOVER VALUE TEXT COLOR HERE:
          className={`mt-4 text-[32px] font-semibold leading-none tracking-[-0.045em] tabular-nums transition-colors duration-200 group-hover:text-white ${styles.value}`}
        >
          {value}
        </p>

        <p
          // CHANGE HOVER DESCRIPTION TEXT COLOR HERE:
          className={`mt-auto max-w-[92%] pt-4 text-xs leading-5 transition-colors duration-200 group-hover:text-white ${styles.meta}`}
        >
          {description}
        </p>
      </div>
    </Link>
  );
}

function KpiCardSkeleton() {
  return (
    <div data-portal-theme-kpi className="min-h-38.5 animate-pulse rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
      <div className="h-2.5 w-24 rounded bg-slate-200" />
      <div className="mt-5 h-8 w-20 rounded bg-slate-200" />
      <div className="mt-6 h-2.5 w-full rounded bg-slate-200" />
      <div className="mt-2 h-2.5 w-2/3 rounded bg-slate-200" />
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
  const finance = overview?.finance ?? null;
  const today = toRangeDay(new Date());

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
            tone={
              shipments.exceptions > 0
                ? "attention"
                : "soft"
            }
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
            tone={
              manifests.readyToSeal > 0
                ? "attention"
                : "soft"
            }
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

      {!operationsOnly && !dataLoading && finance ? (
        <KpiCard
          label="Receivables"
          value={formatCompactMoney(
            finance.invoicedOutstandingMinor,
            finance.currency,
          )}
          description={`Unpaid across ${finance.activeFacilities} active credit facilities`}
          href="/dashboard/credit-accounts"
          tone="primary"
          aside={`${finance.activeFacilities} facilities`}
        />
      ) : null}
    </div>
  );
}
