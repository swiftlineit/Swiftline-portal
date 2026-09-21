"use client";

import Link from "next/link";
import { FiCheckCircle, FiClock } from "react-icons/fi";
import {
  EmptyState,
  RowsSkeleton,
  SectionCard,
  SeverityChip,
  severityStyles,
} from "@/components/dashboard/DashboardWidgets";
import type { DashboardOverview } from "@/lib/dashboardOverview";

export default function AdminTasksCard({
  overview,
  dataLoading,
  refreshing,
}: {
  overview: DashboardOverview | null;
  dataLoading: boolean;
  refreshing: boolean;
}) {
  const dim = refreshing ? "opacity-60" : "opacity-100";

  return (
    <SectionCard
      icon={FiClock}
      title="Tasks requiring attention"
      subtitle="Operational items that need follow-up"
    >
      {dataLoading ? <RowsSkeleton rows={5} /> : null}

      {!dataLoading && overview?.tasks.length ? (
        <div
          className={`overflow-hidden rounded-xl border border-slate-200 bg-white transition-opacity duration-200 ${dim}`}
        >
          <ul className="divide-y divide-slate-100">
            {overview.tasks.map((task) => (
              <li key={`${task.href ?? "task"}:${task.label}`}>
                <Link
                  href={task.href}
                  className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50/80 sm:px-5"
                >
                  {/* Severity rail */}
                  <span
                    className={`h-9 w-1 shrink-0 rounded-full ${
                      severityStyles[task.tone].rail
                    }`}
                  />

                  {/* Main content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[13px] font-semibold text-slate-900 transition-colors group-hover:text-[#0D1282]">
                            {task.label}
                          </p>

                          <SeverityChip tone={task.tone}>{task.tone}</SeverityChip>
                        </div>

                        {task.detail ? (
                          <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-slate-500">
                            {task.detail}
                          </p>
                        ) : null}
                      </div>

                      {/* Count */}
                      <div className="shrink-0">
                        <span className="inline-flex min-w-9 items-center justify-center rounded-lg bg-[#0D1282]/5.5 px-2.5 py-1.5 text-xs font-semibold tabular-nums text-[#0D1282]">
                          {task.count}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!dataLoading && !overview?.tasks.length ? (
        <div className="flex min-h-55 items-center justify-center">
          <EmptyState
            icon={FiCheckCircle}
            title="All caught up"
            message="There are no operational tasks requiring attention."
          />
        </div>
      ) : null}
    </SectionCard>
  );
}
