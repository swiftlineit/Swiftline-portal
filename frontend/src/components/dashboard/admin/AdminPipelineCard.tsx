"use client";

import { FiActivity, FiPackage } from "react-icons/fi";
import { StagePipelineChart } from "@/components/dashboard/DashboardCharts";
import {
  BarsSkeleton,
  EmptyState,
} from "@/components/dashboard/DashboardWidgets";
import type { DashboardOverview } from "@/lib/dashboardOverview";

export default function AdminPipelineCard({
  overview,
  dataLoading,
  refreshing,
  tracksShipments,
}: {
  overview: DashboardOverview | null;
  dataLoading: boolean;
  refreshing: boolean;
  tracksShipments: boolean;
}) {
  const shipments = overview?.shipments ?? null;
  const manifests = overview?.manifests ?? null;

  return (
    <section className="portal-theme-surface overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2">
      <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5 sm:px-6">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-slate-900">
            {tracksShipments
              ? "Shipment distribution"
              : "Manifest lifecycle"}
          </h2>

          <p className="mt-0.5 text-[11px] text-slate-400">
            {tracksShipments
              ? "Current shipments by lifecycle stage"
              : "Current manifests by lifecycle stage"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {refreshing ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#0D1282]" />
              Updating
            </span>
          ) : null}

          {shipments ? (
            <span className="rounded-lg bg-[#0D1282]/5 px-2.5 py-1 text-[10px] font-semibold text-[#0D1282]">
              {shipments.windowSize} bookings
            </span>
          ) : null}
        </div>
      </div>

      <div className="px-3 pb-4 pt-3 sm:px-5 sm:pb-5">
        <div className="portal-theme-surface rounded-2xl bg-white px-3 pb-4 pt-5 sm:px-5 sm:pt-6">
          {dataLoading ? (
            <BarsSkeleton rows={tracksShipments ? 8 : 6} />
          ) : null}

          {!dataLoading && shipments ? (
            <StagePipelineChart
              stages={shipments.stages}
              unitLabel="shipments"
              dimmed={refreshing}
            />
          ) : null}

          {!dataLoading && !shipments && manifests?.stages.length ? (
            <StagePipelineChart
              stages={manifests.stages}
              unitLabel="manifests"
              dimmed={refreshing}
            />
          ) : null}

          {!dataLoading &&
          !shipments &&
          !manifests?.stages.length ? (
            <div className="flex min-h-65 items-center justify-center">
              <EmptyState
                icon={tracksShipments ? FiPackage : FiActivity}
                title="No data available"
                message="Lifecycle data will appear here when available."
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
