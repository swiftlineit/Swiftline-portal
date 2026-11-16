"use client";

import { BarsSkeleton, KpiCardSkeleton, RowsSkeleton, Shimmer, panelSurface } from "@/components/dashboard/DashboardWidgets";

export default function AdminDashboardBootstrap() {
  // Rendered as a page, so it sits inside the shell's content area and must
  // skeleton only the page body. Repeating the sidebar and header here drew a
  // second shell nested inside the real one.
  return (
    <div className="flex flex-col gap-6">
      <div className={`p-6 ${panelSurface}`}>
        <Shimmer surface="light" className="h-4 w-40" />
        <Shimmer surface="light" className="mt-4 h-7 w-64" />
        <Shimmer surface="light" className="mt-3 h-3 w-full max-w-xl" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => <KpiCardSkeleton key={index} />)}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className={`p-5 lg:col-span-2 ${panelSurface}`}>
          <Shimmer surface="light" className="h-4 w-48" />
          <div className="mt-5"><BarsSkeleton rows={8} /></div>
        </div>
        <div className={`p-5 ${panelSurface}`}>
          <Shimmer surface="light" className="h-4 w-32" />
          <div className="mt-5"><RowsSkeleton rows={5} /></div>
        </div>
      </div>
    </div>
  );
}
