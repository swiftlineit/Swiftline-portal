"use client";

import { pickupStatusLabels } from "@/lib/pickups";

const statusStyles: Record<string, string> = {
  REQUESTED: "border-amber-200 bg-amber-50 text-amber-800",
  CONFIRMED: "border-blue-200 bg-blue-50 text-blue-800",
  DRIVER_ASSIGNED: "border-violet-200 bg-violet-50 text-violet-800",
  MISSED: "border-red-200 bg-red-50 text-red-800",
  SCHEDULED: "border-indigo-200 bg-indigo-50 text-indigo-800",
  ASSIGNED: "border-violet-200 bg-violet-50 text-violet-800",
  ACCEPTED: "border-cyan-200 bg-cyan-50 text-cyan-800",
  EN_ROUTE: "border-sky-200 bg-sky-50 text-sky-800",
  ARRIVED: "border-teal-200 bg-teal-50 text-teal-800",
  COLLECTING: "border-orange-200 bg-orange-50 text-orange-800",
  IN_PROGRESS: "border-orange-200 bg-orange-50 text-orange-800",
  ACTION_REQUIRED: "border-red-200 bg-red-50 text-red-800",
  PROOF_REVIEW_REQUIRED: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800",
  PARTIALLY_COLLECTED: "border-yellow-200 bg-yellow-50 text-yellow-900",
  COLLECTED: "border-emerald-200 bg-emerald-50 text-emerald-800",
  RECEIVED_AT_DELHI_HUB: "border-teal-200 bg-teal-50 text-teal-800",
  COMPLETED_WITH_MISSING_PARCELS: "border-amber-300 bg-amber-50 text-amber-900",
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-800",
  CANCELLED: "border-slate-300 bg-slate-100 text-slate-700",
  FAILED: "border-red-200 bg-red-50 text-red-800",
  CLOSED_UNSUCCESSFUL: "border-red-200 bg-red-50 text-red-800",
};

/**
 * Renders a pickup request status, or an attempt status.
 *
 * Request statuses read from the shared label map so a badge says the same
 * word as the filter tab that found it- CONFIRMED is called "Scheduled"
 * everywhere, and a customer clicking Scheduled must not then see cards marked
 * CONFIRMED. Attempt statuses (EN_ROUTE, COLLECTING and the rest) are not in
 * that map and keep the plain formatting.
 */
export function PickupStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${statusStyles[status] ?? "border-slate-200 bg-slate-50 text-slate-700"}`}
    >
      {pickupStatusLabels[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function PickupNewBadge() {
  return (
    <span className="inline-flex rounded-xl bg-[#D71313] h-5 p-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm">
      New
    </span>
  );
}
