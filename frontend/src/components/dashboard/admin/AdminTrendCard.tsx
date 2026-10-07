"use client";

import { FiActivity, FiPackage } from "react-icons/fi";
import { DailyTrendChart } from "@/components/dashboard/DashboardCharts";
import {
  ColumnsSkeleton,
  EmptyState,
} from "@/components/dashboard/DashboardWidgets";
import {
  type DashboardOverview,
  formatMinorMoney,
} from "@/lib/dashboardOverview";

export default function AdminTrendCard({
  overview,
  dataLoading,
  refreshing,
}: {
  overview: DashboardOverview | null;
  dataLoading: boolean;
  refreshing: boolean;
}) {
  const shipments = overview?.shipments ?? null;

  return (
    <section className="portal-theme-surface overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5 sm:px-6">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-slate-900">
            Daily shipment bookings
          </h2>

          <p className="mt-0.5 text-[11px] text-slate-400">
            {shipments
              ? `Last ${shipments.trendCoversDays} day${
                  shipments.trendCoversDays === 1 ? "" : "s"
                }`
              : "Recent booking activity"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {refreshing ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#0D1282]" />
              Updating
            </span>
          ) : null}

          {shipments?.bookedValueMinor ? (
            <span className="rounded-lg bg-[#0D1282]/5 px-2.5 py-1 text-[10px] font-semibold text-[#0D1282]">
              {formatMinorMoney(
                shipments.bookedValueMinor,
                shipments.currency,
              )}
            </span>
          ) : null}
        </div>
      </div>

      {/* Chart */}
      <div className="px-3 pb-4 pt-3 sm:px-5 sm:pb-5">
        <div className="portal-theme-surface rounded-2xl bg-white px-3 pb-4 pt-5 sm:px-5 sm:pt-6">
          {dataLoading ? <ColumnsSkeleton /> : null}

          {!dataLoading && shipments?.trend.length ? (
            <DailyTrendChart
              points={shipments.trend}
              unitLabel="shipments"
              dimmed={refreshing}
            />
          ) : null}

          {!dataLoading && !shipments?.trend.length ? (
            <div className="flex min-h- items-65 center justify-center">
              <EmptyState
                icon={FiPackage}
                title="No booking activity"
                message="Daily shipment activity will appear here when bookings are available."
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
