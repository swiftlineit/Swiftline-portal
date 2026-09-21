import { FiAlertTriangle, FiClock, FiPackage, FiXCircle } from "react-icons/fi";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import type { ParcelActivity, ParcelProgress } from "@/lib/shipmentTracking";

function activityCopy(activity: ParcelActivity) {
  return activity.message
    || activity.customerMessage
    || activity.reason
    || (activity.status === "OFFLOADED"
      ? "This parcel was removed from its scheduled flight."
      : activity.status === "HELD"
        ? "This parcel is being held at the origin facility."
        : activity.status === "DEFERRED_TO_NEXT_MANIFEST"
          ? "This parcel is scheduled to travel on a later manifest."
          : "This parcel was cancelled with the shipment.");
}

function activityAppearance(status: ParcelActivity["status"]) {
  if (status === "CANCELLED") {
    return { label: "Cancelled", Icon: FiXCircle, iconClass: "bg-red-50 text-red-700", labelClass: "bg-red-50 text-red-700" };
  }
  if (status === "DEFERRED_TO_NEXT_MANIFEST") {
    return { label: "Next manifest", Icon: FiClock, iconClass: "bg-blue-50 text-blue-700", labelClass: "bg-blue-50 text-blue-700" };
  }
  return {
    label: status === "HELD" ? "Held" : "Offloaded",
    Icon: FiAlertTriangle,
    iconClass: "bg-amber-50 text-amber-700",
    labelClass: "bg-amber-50 text-amber-800",
  };
}

export default function ParcelActivityPanel({
  activities,
  progress,
  title = "Parcel activity",
}: {
  activities?: ParcelActivity[] | null;
  progress?: ParcelProgress | null;
  title?: string;
}) {
  if (!activities?.length && !progress) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-slate-700 ring-1 ring-slate-200">
          <FiPackage aria-hidden="true" className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-slate-600">
            Parcel-specific changes are shown here without changing the shipment journey.
          </p>
        </div>
      </div>

      {progress ? (
        <div className={`border-b px-4 py-3 sm:px-5 ${progress.isPartial ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
          <p className={`text-sm font-semibold ${progress.isPartial ? "text-amber-950" : "text-emerald-900"}`}>
            {progress.completedParcels} of {progress.totalParcels} parcels departed from Origin Facility
          </p>
          {progress.isPartial ? (
            <p className="mt-1 text-xs leading-5 text-amber-800">
              The shipment is moving in parts. The affected parcel is listed below.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="divide-y divide-slate-100">
        {(activities ?? []).map((activity, index) => {
          const appearance = activityAppearance(activity.status);
          const Icon = appearance.Icon;
          return (
            <div key={`${activity.parcelNumber}-${activity.status}-${activity.eventAt}-${index}`} className="flex gap-3 px-4 py-3.5 sm:px-5">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${appearance.iconClass}`}>
                <Icon aria-hidden="true" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-xs font-semibold text-slate-950">
                    {activity.parcelNumber}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${appearance.labelClass}`}>
                    {appearance.label}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-700">{activityCopy(activity)}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>{formatDashboardDateTime(activity.eventAt)}</span>
                  {activity.flightLinehaulNumber || activity.flightNumber ? (
                    <span>
                      Flight {activity.flightLinehaulNumber || activity.flightNumber}
                      {activity.flightLinehaulNumber && activity.flightNumber ? ` · ${activity.flightNumber}` : ""}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
