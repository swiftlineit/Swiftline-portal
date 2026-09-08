"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  FiArrowRight,
  FiDownload,
  FiPlus,
  FiRefreshCw,
  FiTrash2,
  FiUpload,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import {
  getFlightDetail,
  transitionFlight,
  cancelFlight,
  searchEligibleShipments,
  allocateShipments,
  removeAllocation,
  moveAllocation,
  listAttachableManifests,
  attachManifest,
  detachManifest,
  updateConnection,
  createOffload,
  updateHandover,
  uploadFlightDocument,
  deleteFlightDocument,
  acknowledgeException,
  updateException,
  resolveException,
  type FlightDetail,
  type FlightStatus,
} from "@/lib/flightLinehaul";
import { listFlights } from "@/lib/flightLinehaul";
import { normalizeFlightNumber } from "@/lib/flightNumber";

const tabs = [
  "Overview",
  "Shipments",
  "Bags",
  "Manifest",
  "Timeline",
  "Connection",
  "Documents",
  "Destination handover",
  "Exceptions",
  "Audit history",
] as const;
type Tab = (typeof tabs)[number];

const statusFlow: FlightStatus[] = [
  "PLANNED",
  "BOOKING_CONFIRMED",
  "CARGO_ALLOCATED",
  "MANIFEST_READY",
  "HANDED_TO_AIRLINE",
  "DEPARTED",
  "IN_TRANSIT",
  "CONNECTION",
  "ARRIVED_DESTINATION",
  "CUSTOMS",
  "HANDED_TO_FINAL_MILE",
  "CLOSED",
];
const allowedNext: Record<string, FlightStatus[]> = {
  PLANNED: ["BOOKING_CONFIRMED", "CANCELLED"],
  BOOKING_CONFIRMED: ["CARGO_ALLOCATED", "CANCELLED"],
  CARGO_ALLOCATED: ["MANIFEST_READY", "CANCELLED"],
  MANIFEST_READY: ["HANDED_TO_AIRLINE", "CANCELLED"],
  HANDED_TO_AIRLINE: ["DEPARTED", "CANCELLED"],
  DEPARTED: ["IN_TRANSIT"],
  IN_TRANSIT: ["CONNECTION", "ARRIVED_DESTINATION"],
  CONNECTION: ["ARRIVED_DESTINATION"],
  ARRIVED_DESTINATION: ["CUSTOMS"],
  CUSTOMS: ["HANDED_TO_FINAL_MILE"],
  HANDED_TO_FINAL_MILE: ["CLOSED"],
};

function statusBadge(status: string) {
  const base =
    "inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-bold tracking-[0.02em]";
  if (status === "CANCELLED")
    return `${base} bg-red-50 text-red-700 border-red-200`;
  if (status === "CLOSED")
    return `${base} bg-emerald-50 text-emerald-700 border-emerald-200`;
  if (["DEPARTED", "IN_TRANSIT", "CONNECTION"].includes(status))
    return `${base} bg-sky-50 text-sky-700 border-sky-200`;
  if (["ARRIVED_DESTINATION", "CUSTOMS"].includes(status))
    return `${base} bg-amber-50 text-amber-700 border-amber-200`;
  return `${base} bg-slate-50 text-slate-700 border-slate-200`;
}

export default function FlightDetailPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const params = useParams<{ flightId: string }>();
  const flightId = params.flightId;
  const [detail, setDetail] = useState<FlightDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState<Tab>("Overview");
  const [transitionTo, setTransitionTo] = useState<FlightStatus | "">("");
  const [actionReason, setActionReason] = useState("");
  const [actualDepartureAt, setActualDepartureAt] = useState("");
  const [actualArrivalAt, setActualArrivalAt] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await getFlightDetail(flightId);
      setDetail(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load flight.");
    } finally {
      setBusy(false);
    }
  }, [flightId]);

  useEffect(() => {
    // This effect synchronizes an async API request with page state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load();
  }, [load, user]);

  if (loading || !user) return <DashboardLoading />;
  if (busy && !detail) return <DashboardLoading />;
  if (!detail)
    return (
      <div className="p-8 text-center text-slate-500">Flight not found.</div>
    );

  const flight = detail.flight;
  const nextOptions = allowedNext[flight.status] ?? [];

  async function doTransition() {
    if (!transitionTo) return toast.error("Select a target status.");
    if (transitionTo === "DEPARTED" && !actualDepartureAt) {
      return toast.error("Enter the actual departure date and time before marking the flight departed.");
    }
    if (transitionTo === "ARRIVED_DESTINATION" && !actualArrivalAt) {
      return toast.error("Enter the actual arrival date and time before marking the flight arrived.");
    }
    try {
      const meta: Record<string, unknown> = {};
      if (transitionTo === "DEPARTED") meta.actualDepartureAt = new Date(actualDepartureAt).toISOString();
      if (transitionTo === "ARRIVED_DESTINATION") {
        meta.actualArrivalAt = new Date(actualArrivalAt).toISOString();
        meta.arrivalAt = new Date(actualArrivalAt).toISOString();
      }
      await transitionFlight(
        flightId,
        transitionTo as FlightStatus,
        actionReason,
        meta,
      );
      toast.success(`Flight moved to ${transitionTo}.`);
      setTransitionTo("");
      setActionReason("");
      setActualDepartureAt("");
      setActualArrivalAt("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Transition failed.");
    }
  }

  async function doCancel() {
    const reason = prompt("Enter cancellation reason (min 5 chars):");
    if (!reason || reason.trim().length < 5)
      return toast.error("Cancellation requires reason.");
    try {
      await cancelFlight(flightId, reason.trim());
      toast.success("Flight cancelled.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancel failed.");
    }
  }

  return (
    <div className="flight-detail-page mx-auto w-full max-w-[1600px] space-y-5">
      {/* Flight identity */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_14px_rgba(15,23,42,0.035)]">
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-7">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#0D1282]">
                {flight.flightLinehaulNumber}
              </span>
              <span className={statusBadge(flight.status)}>
                {flight.status.replaceAll("_", " ")}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-2xl font-bold tracking-[-0.03em] text-slate-950 sm:text-[29px]">
                {normalizeFlightNumber(flight.flightNumber)}
              </h1>
              <span className="text-sm font-semibold text-slate-500">
                {flight.airlineName || "Airline pending"}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-500">
              <div className="inline-flex items-center gap-2">
                <span className="rounded-md border border-[#E1E6EC] bg-[#F8FAFC] px-2.5 py-1 font-bold text-slate-800">
                  {flight.originIataCode || "???"}
                </span>

                <FiArrowRight className="h-3.5 w-3.5 text-slate-400" />

                {flight.transitIataCode ? (
                  <>
                    <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 font-bold text-amber-700">
                      {flight.transitIataCode}
                    </span>
                    <FiArrowRight className="h-3.5 w-3.5 text-slate-400" />
                  </>
                ) : null}

                <span className="rounded-md border border-[#E1E6EC] bg-[#F8FAFC] px-2.5 py-1 font-bold text-slate-800">
                  {flight.destinationIataCode || "???"}
                </span>
              </div>

              <span className="hidden h-4 w-px bg-slate-200 sm:block" />

              <span>
                MAWB{" "}
                <span className="font-semibold text-slate-700">
                  {flight.mawbNumber || "Pending"}
                </span>
              </span>

              {flight.branch?.code ? (
                <>
                  <span className="hidden h-4 w-px bg-slate-200 sm:block" />
                  <span className="font-semibold text-slate-600">
                    {flight.branch.code}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#D9E0E8] bg-white px-3.5 text-xs font-semibold text-slate-600 transition hover:border-[#C0C9D5] hover:bg-slate-50 hover:text-slate-900"
            >
              <FiRefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </button>

            {flight.status !== "CLOSED" && flight.status !== "CANCELLED" ? (
              <button
                type="button"
                onClick={doCancel}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-red-200 bg-white px-4 text-xs font-semibold text-red-700 transition hover:bg-red-50"
              >
                Cancel flight
              </button>
            ) : null}
          </div>
        </div>

        {/* Essential flight metadata */}
        <div className="grid gap-px border-t border-[#E7EBF0] bg-[#E7EBF0] sm:grid-cols-2 lg:grid-cols-4">
          <HeaderMeta
            label="Scheduled departure"
            value={new Date(flight.scheduledDepartureAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}
          />
          <HeaderMeta
            label="Scheduled arrival"
            value={new Date(flight.scheduledArrivalAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}
          />
          <HeaderMeta
            label="Shipments"
            value={`${detail.stats.totalShipments} allocated`}
          />
          <HeaderMeta
            label="Customs"
            value={flight.customsStatus.replaceAll("_", " ")}
          />
        </div>
      </section>

      {/* Flight snapshot */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_14px_rgba(15,23,42,0.035)]">
        <div className="border-b border-[#EEF1F4] px-5 py-3.5 sm:px-6">
          <h2 className="text-sm font-bold text-slate-950">Flight snapshot</h2>
        </div>

        <div className="grid grid-cols-2 gap-px bg-[#E7EBF0] sm:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Capacity"
            value={`${flight.allocatedWeightKg.toFixed(1)} / ${flight.capacityKg.toFixed(1)} kg`}
            sub={`${detail.stats.utilisationPercent.toFixed(1)}% utilised`}
            alert={flight.allocatedWeightKg > flight.capacityKg}
          />
          <Stat
            label="Shipments"
            value={String(detail.stats.totalShipments)}
            sub={`${flight.totalShipments} allocated`}
          />
          <Stat
            label="Pieces"
            value={String(detail.stats.totalPieces)}
            sub={`${detail.stats.totalPieces} pcs`}
          />
          <Stat
            label="Bags"
            value={String(detail.stats.totalBags)}
            sub={`${detail.stats.manifestCount} manifests`}
          />
          <Stat
            label="Departure"
            value={new Date(flight.scheduledDepartureAt).toLocaleDateString("en-IN")}
            sub={new Date(flight.scheduledDepartureAt).toLocaleTimeString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}
          />
          <Stat
            label="Customs"
            value={flight.customsStatus.replaceAll("_", " ")}
            sub={
              flight.customsClearedAt
                ? new Date(flight.customsClearedAt).toLocaleDateString("en-IN")
                : "Pending"
            }
          />
        </div>
      </section>

      {/* Status transition */}
      {nextOptions.length ? (
        <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.035)]">
          <div className="flex flex-col gap-3 border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
            <div className="flex min-w-0 items-start gap-3">
              
              <div>
                <h2 className="text-sm font-bold text-slate-950">Update flight status</h2>
                <p className="mt-0.5 max-w-2xl text-xs leading-5 text-slate-500">
                  Move this flight to its next operational milestone. Departure and arrival changes can also update shipment tracking.

                     <span>
                The system validates every active shipment first. If a required earlier milestone is missing, the entire update is blocked.
              </span>
                </p>
                
              </div>
            </div>

            <div className="flex max-w-xl items-start gap-2 rounded-lg border border-[#DDE3EC] bg-white px-3 py-2 text-[11px] leading-4 text-slate-500">
           
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end">
            <label className="block text-xs font-semibold text-slate-600">
              Transition to
              <select
                value={transitionTo}
                onChange={(e) => setTransitionTo(e.target.value as FlightStatus)}
                className="mt-1.5 h-11 w-full border border-[#CDD5DF] bg-white px-3.5 text-sm font-medium text-slate-700"
              >
                <option value="">Select status</option>
                {nextOptions.map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              {transitionTo === "DEPARTED" ? (
                <label className="block text-xs font-semibold text-slate-600">
                  Actual departure time <span className="text-red-600">*</span>
                  <input
                    type="datetime-local"
                    value={actualDepartureAt}
                    onChange={(e) => setActualDepartureAt(e.target.value)}
                    className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                  />
                </label>
              ) : null}

              {transitionTo === "ARRIVED_DESTINATION" ? (
                <label className="block text-xs font-semibold text-slate-600">
                  Actual arrival time <span className="text-red-600">*</span>
                  <input
                    type="datetime-local"
                    value={actualArrivalAt}
                    onChange={(e) => setActualArrivalAt(e.target.value)}
                    className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                  />
                </label>
              ) : null}

              <label
                className={`block text-xs font-semibold text-slate-600 ${
                  transitionTo === "DEPARTED" || transitionTo === "ARRIVED_DESTINATION"
                    ? ""
                    : "sm:col-span-2"
                }`}
              >
                Reason / note
                <input
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  placeholder="Optional operational note"
                  className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={() => void doTransition()}
              className="group inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0A0F6D]"
            >
              Apply status
              <FiArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
          </div>
        </section>
      ) : null}

      {/* Workspace tabs */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.035)]">
        <div className="overflow-x-auto border-b border-[#E7EBF0] bg-[#FBFCFD]">
          <div className="flex min-w-max px-2 sm:px-3">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`relative whitespace-nowrap px-3.5 py-3.5 text-sm font-semibold transition sm:px-4 ${
                  tab === t
                    ? "text-[#0D1282]"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                {t}
                {tab === t ? (
                  <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[#0D1282]" />
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white p-4 sm:p-5 lg:p-6">
          {tab === "Overview" && <OverviewTab detail={detail} />}
          {tab === "Shipments" && (
            <ShipmentsTab detail={detail} flightId={flightId} onRefresh={load} />
          )}
          {tab === "Bags" && <BagsTab detail={detail} />}
          {tab === "Manifest" && (
            <ManifestTab detail={detail} flightId={flightId} onRefresh={load} />
          )}
          {tab === "Timeline" && <TimelineTab detail={detail} />}
          {tab === "Connection" && (
            <ConnectionTab detail={detail} flightId={flightId} onRefresh={load} />
          )}
          {tab === "Documents" && (
            <DocumentsTab detail={detail} flightId={flightId} onRefresh={load} />
          )}
          {tab === "Destination handover" && (
            <HandoverTab detail={detail} flightId={flightId} onRefresh={load} />
          )}
          {tab === "Exceptions" && (
            <ExceptionsTab detail={detail} onRefresh={load} />
          )}
          {tab === "Audit history" && <AuditTab detail={detail} />}
        </div>
      </section>

      {/* Consistent form controls across all tabs */}
      <style jsx global>{`
        .flight-detail-page select {
          -webkit-appearance: none;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2364758b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 14px center;
          background-size: 16px 16px;
          padding-right: 2.75rem !important;
          border-radius: 8px !important;
          outline: none;
        }

        .flight-detail-page select:focus {
          border-color: #0d1282 !important;
          box-shadow: 0 0 0 3px rgba(13, 18, 130, 0.08);
        }

        .flight-detail-page input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),
        .flight-detail-page textarea {
          border-radius: 8px !important;
        }
      `}</style>
    </div>
  );
}

function HeaderMeta({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 bg-[#FBFCFD] px-5 py-3.5 lg:px-6">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
        {label}
      </p>
      <p
        className="mt-1 truncate text-xs font-semibold text-slate-700"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: string;
  sub: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`min-w-0 px-4 py-4 ${
        alert ? "bg-red-50/40" : "bg-white"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-400">
        {label}
      </p>
      <p
        className={`mt-1.5 wrap-break-words text-[15px] font-bold leading-5 ${
          alert ? "text-red-700" : "text-slate-950"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">{sub}</p>
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────
function OverviewTab({
  detail,
}: {
  detail: FlightDetail;
}) {
  const flight = detail.flight;
  const allocatedWeightKg = Math.max(0, Number(detail.stats.allocatedWeightKg) || 0);
  const capacityKg = Math.max(0, Number(flight.capacityKg) || 0);
  const utilisationPercent =
    capacityKg > 0 ? (allocatedWeightKg / capacityKg) * 100 : 0;
  const donutPercent = Math.min(utilisationPercent, 100);
  const remainingWeightKg = Math.max(capacityKg - allocatedWeightKg, 0);
  const overCapacityKg = Math.max(allocatedWeightKg - capacityKg, 0);
  const capacityTone =
    utilisationPercent > 100
      ? { text: "text-red-700", fill: "#DC2626" }
      : utilisationPercent >= 90
        ? { text: "text-amber-700", fill: "#D97706" }
        : { text: "text-[#0D1282]", fill: "#0D1282" };
  const donutBackground =
    capacityKg > 0
      ? `conic-gradient(${capacityTone.fill} 0 ${donutPercent}%, #EEF1F4 ${donutPercent}% 100%)`
      : "conic-gradient(#EEF1F4 0 100%)";
  const activeExceptions = detail.exceptions.filter((e) =>
    ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
  ).length;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.25fr_0.85fr]">
      <div className="space-y-4">
        {/* Flight information */}
        <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.035)]">
          <div className="border-b border-[#DDE3EC] bg-[#F5F7FF] px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-slate-950">
                Flight information
              </h3>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#DCE3FF] bg-white px-2 py-1 text-[11px] font-bold tracking-[0.04em] text-[#0D1282]">
                <span className="rounded-md bg-[#0D1282] px-1.5 py-0.5 text-white">
                  {flight.originIataCode || "???"}
                </span>
                <FiArrowRight className="h-3.5 w-3.5 text-[#8290C4]" />
                {flight.transitIataCode ? (
                  <>
                    <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
                      {flight.transitIataCode}
                    </span>
                    <FiArrowRight className="h-3.5 w-3.5 text-[#8290C4]" />
                  </>
                ) : null}
                <span className="rounded-md bg-[#E8ECFF] px-1.5 py-0.5">
                  {flight.destinationIataCode || "???"}
                </span>
              </div>
            </div>
          </div>

          <dl className="grid sm:grid-cols-2">
            <OverviewRow
              label="Flight"
              value={normalizeFlightNumber(flight.flightNumber)}
              strong
            />
            <OverviewRow label="Airline" value={flight.airlineName || "—"} />
            <OverviewRow label="MAWB" value={flight.mawbNumber || "Pending"} />
            <OverviewRow
              label="Branch"
              value={
                flight.branch?.name
                  ? `${flight.branch.name} (${flight.branch?.code ?? ""})`
                  : "—"
              }
            />
            <OverviewRow
              label="Scheduled departure"
              value={new Date(flight.scheduledDepartureAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}
            />
            <OverviewRow
              label="Scheduled arrival"
              value={new Date(flight.scheduledArrivalAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}
            />
            {flight.actualDepartureAt ? (
              <OverviewRow
                label="Actual departure"
                value={new Date(flight.actualDepartureAt).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                })}
                tone="warning"
              />
            ) : null}
          </dl>
        </section>

        {/* Destination */}
        <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.035)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#DDE3EC] bg-[#FBFCFD] px-4 py-3.5">
            <h3 className="text-sm font-bold text-slate-950">
              Destination &amp; handover
            </h3>

            {activeExceptions ? (
              <span className="rounded-full bg-red-100 px-2.5 py-1 text-[10px] font-bold text-red-800 ring-1 ring-red-200">
                {activeExceptions} action required
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-800 ring-1 ring-emerald-200">
                Clear
              </span>
            )}
          </div>

          <dl className="grid sm:grid-cols-2">
            <OverviewRow
              label="Agent"
              value={flight.destinationAgent || "—"}
            />
            <OverviewRow
              label="Final-mile"
              value={flight.finalMileCarrier || "—"}
            />
            <OverviewRow
              label="Customs"
              value={flight.customsStatus.replaceAll("_", " ")}
            />
            <OverviewRow
              label="Arrival"
              value={
                flight.arrivalAt
                  ? new Date(flight.arrivalAt).toLocaleString("en-IN")
                  : "—"
              }
            />
            <OverviewRow
              label="Handover"
              value={
                flight.handoverAt
                  ? new Date(flight.handoverAt).toLocaleString("en-IN")
                  : "—"
              }
            />
            {flight.handoverReference ? (
              <OverviewRow
                label="Reference"
                value={flight.handoverReference}
                mono
              />
            ) : null}
          </dl>
        </section>
      </div>

      {/* Capacity */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.035)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#DDE3EC] bg-[#F5F7FF] px-4 py-3.5">
          <div>
            <h3 className="text-sm font-bold text-slate-950">Capacity</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Active allocated weight against flight capacity
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${capacityTone.text} ${
            utilisationPercent > 100
              ? "bg-red-100 ring-red-200"
              : utilisationPercent >= 90
                ? "bg-amber-100 ring-amber-200"
                : "bg-[#E8ECFF] ring-[#D5DCFF]"
          }`}>
            {utilisationPercent.toFixed(1)}%
          </span>
        </div>

        <div className="p-4 sm:p-5">
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
            <div
              role="img"
              aria-label={`Capacity utilisation ${utilisationPercent.toFixed(1)} percent: ${allocatedWeightKg.toFixed(1)} of ${capacityKg.toFixed(1)} kilograms allocated`}
              className="relative h-36 w-36 shrink-0 rounded-full p-3 shadow-sm ring-1 ring-[#E7EBF0]"
              style={{ background: donutBackground }}
            >
              <div className="grid h-full w-full place-items-center rounded-full bg-white text-center ring-1 ring-[#EEF1F4]">
                <div>
                  <p className={`text-2xl font-bold tabular-nums ${capacityTone.text}`}>
                    {utilisationPercent.toFixed(1)}%
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    utilised
                  </p>
                </div>
              </div>
            </div>

            <div className="w-full min-w-0 space-y-3">
              <CapacityLegendRow
                label="Allocated"
                value={`${allocatedWeightKg.toFixed(1)} kg`}
                color={capacityTone.fill}
              />
              <CapacityLegendRow
                label="Remaining"
                value={`${remainingWeightKg.toFixed(1)} kg`}
                color="#CBD5E1"
              />
              <CapacityLegendRow
                label="Total capacity"
                value={`${capacityKg.toFixed(1)} kg`}
                color="#64748B"
              />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <MiniMetric label="Shipments" value={detail.stats.totalShipments} tone="blue" />
            <MiniMetric label="Pieces" value={detail.stats.totalPieces} tone="green" />
            <MiniMetric label="Bags" value={detail.stats.totalBags} tone="amber" />
            <MiniMetric label="Manifests" value={detail.stats.manifestCount} tone="slate" />
          </div>

          {overCapacityKg > 0 ? (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              Over capacity by {overCapacityKg.toFixed(1)} kg — action required before departure.
            </p>
          ) : utilisationPercent >= 90 ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
              Capacity is at or above 90%.
            </p>
          ) : null}

          <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[#DCE3FF] bg-[#F7F8FF] px-3.5 py-3">
            <div>
              <p className="text-[11px] font-semibold text-[#5262B6]">
                Connection
              </p>
              <p className="mt-0.5 text-xs font-bold text-slate-800">
                {flight.connection?.transitAirportCode
                  ? `${flight.connection.transitAirportCode} · ${
                      flight.connection.layoverMinutes ?? "—"
                    } min`
                  : "Direct flight"}
              </p>
            </div>

            {flight.connection?.transitAirportCode ? (
              <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${
            ["HIGH", "CRITICAL", "MISSED"].includes(
              flight.connection.riskLevel,
            )
              ? "bg-red-100 text-red-800 ring-red-200"
              : flight.connection.riskLevel === "MEDIUM"
                ? "bg-amber-100 text-amber-800 ring-amber-200"
                : "bg-emerald-100 text-emerald-800 ring-emerald-200"
          }`}
              >
                {flight.connection.riskLevel}
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function CapacityLegendRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="inline-flex min-w-0 items-center gap-2 font-semibold text-slate-600">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span className="font-bold tabular-nums text-slate-950">{value}</span>
    </div>
  );
}

function OverviewRow({
  label,
  value,
  strong,
  mono,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
  tone?: "warning";
}) {
  return (
    <div className="min-w-0 border-b border-r border-[#EEF1F4] bg-white px-4 py-3.5 odd:bg-[#FCFDFE] last:border-b-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">
        {label}
      </dt>
      <dd
        className={`mt-1.5 min-w-0 wrap-break-words text-xs leading-5 ${
          strong ? "font-bold text-slate-950" : "font-semibold text-slate-700"
        } ${mono ? "font-mono" : ""} ${
          tone === "warning" ? "text-amber-700" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: number;
  tone?: "blue" | "green" | "amber" | "slate";
}) {
  const toneClasses = {
    blue: {
      surface: "bg-[#F3F5FF]",
      label: "text-[#5262B6]",
      value: "text-[#0D1282]",
    },
    green: {
      surface: "bg-[#F1FAF6]",
      label: "text-emerald-700",
      value: "text-emerald-900",
    },
    amber: {
      surface: "bg-[#FFF8EB]",
      label: "text-amber-700",
      value: "text-amber-900",
    },
    slate: {
      surface: "bg-[#F8FAFC]",
      label: "text-slate-500",
      value: "text-slate-900",
    },
  }[tone];

  return (
    <div className={`px-2.5 py-2.5 text-center ${toneClasses.surface}`}>
      <p className={`text-[9px] font-semibold uppercase tracking-wider ${toneClasses.label}`}>
        {label}
      </p>
      <p className={`mt-1 text-sm font-bold tabular-nums ${toneClasses.value}`}>
        {value}
      </p>
    </div>
  );
}

// ── Shipments ──────────────────────────────────────────────────────────────
function ShipmentsTab({
  detail,
  flightId,
  onRefresh,
}: {
  detail: FlightDetail;
  flightId: string;
  onRefresh: () => void;
}) {
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [options, setOptions] = useState<
    Array<{
      shipmentDraftId: string;
      awb: string;
      weightKg: number;
      pieces: number;
      destinationCountryName: string;
      destinationCountryCode: string;
    }>
  >([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function search() {
    setSearching(true);
    try {
      const res = await searchEligibleShipments({
        q: q.trim() || undefined,
        limit: 20,
      });
      setOptions(res.shipments as never);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function allocate() {
    if (!selected.size) return toast.error("Select shipments to allocate.");
    try {
      const res = await allocateShipments(flightId, [...selected]);
      toast.success(res.message);
      if (res.results.some((r) => r.status === "skipped")) {
        const skipped = res.results
          .filter((r) => r.status === "skipped")
          .map((r) => `${r.shipmentDraftId.slice(-6)}: ${r.reason}`)
          .join("; ");
        toast.warn(`Some skipped: ${skipped}`);
      }
      setSelected(new Set());
      setOptions([]);
      setQ("");
      await onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Allocation failed.");
    }
  }

  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [targetFlight, setTargetFlight] = useState("");
  const [flightOptions, setFlightOptions] = useState<
    Array<{ id: string; flightLinehaulNumber: string }>
  >([]);

  async function loadFlightsForMove() {
    try {
      const res = await listFlights({ limit: 20, status: "" });
      setFlightOptions(
        res.items
          .map((f) => ({
            id: f.id,
            flightLinehaulNumber: f.flightLinehaulNumber,
          }))
          .filter((f) => f.id !== flightId),
      );
    } catch {}
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-[#DDE3EC] p-4">
        <Link
          href="/dashboard/operations-manifests/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#0D1282] px-4 text-sm font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
        >
          <FiPlus /> Create manifest
        </Link>
        <label className="flex-1 text-xs font-semibold text-slate-600">
        
          <div className="mt-1 flex">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void search()}
              placeholder="AWB or tracking number"
              className="h-10 flex-1 rounded-l-xl border border-slate-200 px-3 text-sm outline-none focus:border-[#0D1282]"
            />
            <button
              onClick={() => void search()}
              disabled={searching}
              className="h-10 rounded-r-xl bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {searching ? "…" : "Search"}
            </button>
          </div>
        </label>
        <button
          onClick={() => void allocate()}
          className="h-10 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          Allocate selected ({selected.size})
        </button>
      </div>
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-sm leading-6 text-blue-950">
        Create the manifest first, pack and seal it in Operations Manifests, then attach it here. Before attaching, Flight number, MAWB, origin, destination, and departure date must match this flight. Use one format everywhere, for example <span className="font-bold">EY-219</span>.
      </div>

      {options.length ? (
        <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={
                      selected.size === options.length && options.length > 0
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(options.map((o) => o.shipmentDraftId))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th className="px-3 py-2">AWB</th>
                <th className="px-3 py-2">Destination</th>
                <th className="px-3 py-2 text-right">Weight</th>
                <th className="px-3 py-2 text-center">Pcs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {options.map((o) => (
                <tr key={o.shipmentDraftId} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(o.shipmentDraftId)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(o.shipmentDraftId);
                        else s.delete(o.shipmentDraftId);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">
                    {o.awb}
                  </td>
                  <td className="px-3 py-2">
                    {o.destinationCountryName} ({o.destinationCountryCode})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {o.weightKg.toFixed(3)} kg
                  </td>
                  <td className="px-3 py-2 text-center">{o.pieces}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 className="font-semibold text-slate-900">
            Allocated shipments -{" "}
            {detail.allocations.filter((a) => a.status === "ALLOCATED").length}{" "}
            active ·{" "}
            {detail.allocations.filter((a) => a.status !== "ALLOCATED").length}{" "}
            historical
          </h3>
          <button
            onClick={() => void onRefresh()}
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <FiRefreshCw />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 text-left text-sm">
            <thead className="bg-white text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">AWB</th>
                <th className="px-4 py-3">Destination</th>
                <th className="px-4 py-3 text-right">Weight</th>
                <th className="px-4 py-3 text-center">Pcs</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.allocations.map((a) => (
                <tr
                  key={a.id}
                  className={
                    a.status !== "ALLOCATED"
                      ? "bg-slate-50/60 text-slate-500"
                      : "hover:bg-slate-50"
                  }
                >
                  <td className="px-4 py-3 font-mono text-xs font-semibold">
                    <Link
                      href={`/dashboard/shipments/${a.shipmentDraftId}`}
                      className="text-[#0D1282] hover:underline"
                    >
                      {a.awb || a.shipmentDraftId.slice(-8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {a.destinationCountryName ||
                      a.destinationCountryCode ||
                      "-"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {a.weightKg.toFixed(3)} kg
                  </td>
                  <td className="px-4 py-3 text-center">{a.pieces}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${a.status === "ALLOCATED" ? "bg-emerald-50 text-emerald-700" : a.status === "OFFLOADED" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {a.status === "ALLOCATED" ? (
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={async () => {
                            const reason = prompt("Removal reason:");
                            if (!reason || reason.trim().length < 3)
                              return toast.error("Reason required.");
                            try {
                              await removeAllocation(
                                flightId,
                                a.id,
                                reason.trim(),
                              );
                              toast.success("Removed.");
                              await onRefresh();
                            } catch (e) {
                              toast.error(
                                e instanceof Error ? e.message : "Failed.",
                              );
                            }
                          }}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Remove
                        </button>
                        <button
                          onClick={() => {
                            setMoveFor(a.id);
                            void loadFlightsForMove();
                          }}
                          className="rounded-lg border border-[#0D1282]/20 px-2 py-1 text-xs font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
                        >
                          Move
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">-</span>
                    )}
                  </td>
                </tr>
              ))}
              {!detail.allocations.length ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No shipments allocated yet. Search above to allocate.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {moveFor ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="font-semibold text-slate-900">
              Move shipment to another flight
            </h3>
            <label className="mt-3 block text-xs font-semibold text-slate-600">
              Target flight
              <select
                value={targetFlight}
                onChange={(e) => setTargetFlight(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-[#DDE3EC] bg-white px-3 text-sm"
              >
                <option value="">Select flight</option>
                {flightOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.flightLinehaulNumber}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setMoveFor(null);
                  setTargetFlight("");
                }}
                className="h-10 rounded-xl border border-[#DDE3EC] bg-white px-4 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!targetFlight)
                    return toast.error("Select target flight.");
                  const reason = prompt("Reason for move:");
                  if (!reason || reason.trim().length < 3)
                    return toast.error("Reason required.");
                  try {
                    await moveAllocation(
                      flightId,
                      moveFor,
                      targetFlight,
                      reason.trim(),
                    );
                    toast.success("Moved.");
                    setMoveFor(null);
                    setTargetFlight("");
                    await onRefresh();
                  } catch (e) {
                    toast.error(
                      e instanceof Error ? e.message : "Move failed.",
                    );
                  }
                }}
                className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BagsTab({ detail }: { detail: FlightDetail }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">
          Bags across attached manifests - {detail.bags.length} bags
        </h3>
        <span className="text-xs text-slate-500">
          {detail.bags.length} total
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">Bag number</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Parcels</th>
              <th className="px-4 py-3 text-right">Weight</th>
              <th className="px-4 py-3 text-center">Consignments</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.bags.map((b) => (
              <tr key={b.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-mono text-xs font-semibold">
                  {b.bagNumber}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${b.status === "CLOSED" ? "bg-emerald-50 text-emerald-700" : b.status === "OPEN" ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-600"}`}
                  >
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {b.totalPhysicalParcels}
                </td>
                <td className="px-4 py-3 text-right">
                  {b.totalWeightKg.toFixed(3)} kg
                </td>
                <td className="px-4 py-3 text-center">{b.totalConsignments}</td>
              </tr>
            ))}
            {!detail.bags.length ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  No bags yet. Attach a manifest and pack via Operations
                  Manifests.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ManifestTab({
  detail,
  flightId,
  onRefresh,
}: {
  detail: FlightDetail;
  flightId: string;
  onRefresh: () => void;
}) {
  const [options, setOptions] = useState<
    Array<{
      id: string;
      manifestNumber: string;
      status: string;
      totalWeightKg: number;
    }>
  >([]);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    listAttachableManifests(flightId)
      .then((r) => setOptions(r.manifests as never))
      .catch(() => {});
  }, [flightId]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-[#DDE3EC] p-4">
        <Link
          href="/dashboard/operations-manifests/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#0D1282] px-4 text-sm font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
        >
          <FiPlus /> Create manifest
        </Link>
        <label className="flex-1 text-xs font-semibold text-slate-600">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-[#DDE3EC] bg-white px-3 text-sm"
          >
            <option value="">Select manifest Attach operations manifest (must be same branch)
</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.manifestNumber} · {o.status} · {o.totalWeightKg.toFixed(1)}{" "}
                kg
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={async () => {
            if (!selected) return toast.error("Select a manifest.");
            try {
              await attachManifest(flightId, selected);
              toast.success("Manifest attached.");
              setSelected("");
              await onRefresh();
              const r = await listAttachableManifests(flightId);
              setOptions(r.manifests as never);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Attach failed.");
            }
          }}
          className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white"
        >
          Attach
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="px-4 py-3">Manifest</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Bags</th>
              <th className="px-4 py-3 text-right">Weight</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.manifests.map((m) => (
              <tr key={m.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/dashboard/operations-manifests/${m.id}`}
                    className="font-semibold text-[#0D1282] hover:underline"
                  >
                    {m.manifestNumber}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {m.header.originIataCode}→{m.header.destinationIataCode} ·{" "}
                    {normalizeFlightNumber(m.header.flightNumber)}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">
                    {m.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">{m.totalBags}</td>
                <td className="px-4 py-3 text-right">
                  {m.totalWeightKg.toFixed(3)} kg
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={async () => {
                      const reason =
                        prompt(
                          "Detach reason (required if manifest sealed):",
                        ) ?? "";
                      if (
                        ["SEALED", "DISPATCHED"].includes(m.status) &&
                        reason.trim().length < 5
                      )
                        return toast.error(
                          "Reason required for sealed manifest.",
                        );
                      try {
                        await detachManifest(flightId, m.id, reason);
                        toast.success("Detached.");
                        await onRefresh();
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "Detach failed.",
                        );
                      }
                    }}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                  >
                    Detach
                  </button>
                </td>
              </tr>
            ))}
            {!detail.manifests.length ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  No manifests attached. Create a manifest in Operations
                  Manifests, pack via scanning, then attach here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-sm leading-6 text-blue-950">
        Create the manifest first, pack and seal it in Operations Manifests, then attach it here. Before attaching, Flight number, MAWB, origin, destination, and departure date must match this flight. Use one format everywhere, for example <span className="font-bold">EY-219</span>.
      </div>
      <div className="rounded-xl border border-[#DDE3EC] bg-slate-50 p-4">
        <h4 className="font-semibold text-slate-900">
          Flight-level visibility
        </h4>
        <p className="mt-1 text-sm text-slate-600">
          All bags and consignments from attached manifests are visible in Bags
          tab. Sealed snapshot, bag closing, seal and dispatch rules are reused
          from the existing manifest service - this flight does not re-implement
          scanning.
        </p>
        <div className="mt-2 overflow-hidden rounded-lg border border-white bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">Consignment</th>
                <th className="px-3 py-2">Bags</th>
                <th className="px-3 py-2 text-right">Weight</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.consignments.slice(0, 20).map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2 font-mono">
                    {c.displayConsignmentNumber}
                  </td>
                  <td className="px-3 py-2">
                    {(c.bagNumbers ?? []).join(", ") || "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {c.weightKg.toFixed(3)} kg
                  </td>
                  <td className="px-3 py-2">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TimelineTab({ detail }: { detail: FlightDetail }) {
  const flight = detail.flight;
  const idx = statusFlow.indexOf(flight.status as FlightStatus);
  return (
    <div className="space-y-4">
      <div className="relative pl-6">
        <div className="absolute left-2 top-2 bottom-2 w-0.5 bg-slate-200" />
        {statusFlow.map((s, i) => {
          const done = i < idx;
          const current = i === idx;
          const future = i > idx;
          return (
            <div key={s} className="relative pb-6">
              <div
                className={`absolute -left-1 h-3 w-3 rounded-full border-2 ${done ? "bg-emerald-500 border-emerald-500" : current ? "bg-[#0D1282] border-[#0D1282] animate-pulse" : "bg-white border-slate-300"}`}
              />
              <p
                className={`ml-4 text-sm ${current ? "font-bold text-[#0D1282]" : done ? "font-semibold text-emerald-700" : future ? "text-slate-400" : "text-slate-600"}`}
              >
                {s.replaceAll("_", " ")}
                {current ? " • current" : done ? " • done" : ""}
              </p>
              {current && flight.scheduledDepartureAt ? (
                <p className="ml-4 text-xs text-slate-500">
                  Scheduled{" "}
                  {new Date(flight.scheduledDepartureAt).toLocaleString(
                    "en-IN",
                  )}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
        <div className="bg-slate-50 px-4 py-3 font-semibold text-slate-900">
          Recent transitions
        </div>
        <div className="divide-y divide-slate-100">
          {detail.auditHistory.slice(0, 10).map((a) => (
            <div key={a.id} className="px-4 py-3 text-sm">
              <p className="font-semibold text-slate-800">
                {a.action.replaceAll("_", " ")}
              </p>
              <p className="text-xs text-slate-500">
                {new Date(a.performedAt).toLocaleString("en-IN")} ·{" "}
                {JSON.stringify(a.metadata).slice(0, 120)}
              </p>
            </div>
          ))}
          {!detail.auditHistory.length ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">
              No transitions yet.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConnectionTab({
  detail,
  flightId,
  onRefresh,
}: {
  detail: FlightDetail;
  flightId: string;
  onRefresh: () => void;
}) {
  const c = detail.flight.connection;
  const [form, setForm] = useState({
    transitAirportCode: c?.transitAirportCode ?? "",
    scheduledArrivalAt: c?.scheduledArrivalAt
      ? new Date(c.scheduledArrivalAt).toISOString().slice(0, 16)
      : "",
    scheduledDepartureAt: c?.scheduledDepartureAt
      ? new Date(c.scheduledDepartureAt).toISOString().slice(0, 16)
      : "",
    actualArrivalAt: c?.actualArrivalAt
      ? new Date(c.actualArrivalAt).toISOString().slice(0, 16)
      : "",
    actualDepartureAt: c?.actualDepartureAt
      ? new Date(c.actualDepartureAt).toISOString().slice(0, 16)
      : "",
  });

  useEffect(() => {
    if (c) {
      // The form mirrors refreshed connection data returned by the API.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        transitAirportCode: c.transitAirportCode,
        scheduledArrivalAt: c.scheduledArrivalAt
          ? new Date(c.scheduledArrivalAt).toISOString().slice(0, 16)
          : "",
        scheduledDepartureAt: c.scheduledDepartureAt
          ? new Date(c.scheduledDepartureAt).toISOString().slice(0, 16)
          : "",
        actualArrivalAt: c.actualArrivalAt
          ? new Date(c.actualArrivalAt).toISOString().slice(0, 16)
          : "",
        actualDepartureAt: c.actualDepartureAt
          ? new Date(c.actualDepartureAt).toISOString().slice(0, 16)
          : "",
      });
    }
  }, [c]);

  return (
    <div className="space-y-5">
      {/* Connection */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white">
        <div className="flex flex-col gap-2 border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h3 className="text-sm font-bold text-slate-950">
              Transit connection
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Optional intermediate airport and layover timing.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-slate-400">
              Current risk
            </span>
            <span
              className={`rounded-md px-2.5 py-1 text-[10px] font-bold ${
                !c
                  ? "bg-slate-100 text-slate-600"
                  : ["HIGH", "CRITICAL", "MISSED"].includes(c.riskLevel)
                    ? "bg-red-50 text-red-700"
                    : c.riskLevel === "MEDIUM"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {c?.riskLevel ?? "-"}{" "}
              {c?.layoverMinutes != null ? `· ${c.layoverMinutes} min` : ""}
            </span>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
          <label className="text-xs font-semibold text-slate-600">
            Transit airport (IATA)
            <input
              value={form.transitAirportCode}
              onChange={(e) =>
                setForm({ ...form, transitAirportCode: e.target.value })
              }
              maxLength={3}
              placeholder="DXB"
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Scheduled arrival
            <input
              type="datetime-local"
              value={form.scheduledArrivalAt}
              onChange={(e) =>
                setForm({ ...form, scheduledArrivalAt: e.target.value })
              }
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Scheduled departure
            <input
              type="datetime-local"
              value={form.scheduledDepartureAt}
              onChange={(e) =>
                setForm({ ...form, scheduledDepartureAt: e.target.value })
              }
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Actual arrival
            <input
              type="datetime-local"
              value={form.actualArrivalAt}
              onChange={(e) =>
                setForm({ ...form, actualArrivalAt: e.target.value })
              }
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Actual departure
            <input
              type="datetime-local"
              value={form.actualDepartureAt}
              onChange={(e) =>
                setForm({ ...form, actualDepartureAt: e.target.value })
              }
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>
        </div>

        <div className="flex justify-end border-t border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={async () => {
              if (!form.transitAirportCode.trim())
                return toast.error("Transit airport required.");
              try {
                await updateConnection(flightId, {
                  transitAirportCode: form.transitAirportCode.trim().toUpperCase(),
                  scheduledArrivalAt: form.scheduledArrivalAt
                    ? new Date(form.scheduledArrivalAt).toISOString()
                    : null,
                  scheduledDepartureAt: form.scheduledDepartureAt
                    ? new Date(form.scheduledDepartureAt).toISOString()
                    : null,
                  actualArrivalAt: form.actualArrivalAt
                    ? new Date(form.actualArrivalAt).toISOString()
                    : null,
                  actualDepartureAt: form.actualDepartureAt
                    ? new Date(form.actualDepartureAt).toISOString()
                    : null,
                });
                toast.success("Connection updated.");
                await onRefresh();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Update failed.");
              }
            }}
            className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0A0F6D]"
          >
            Save connection
          </button>
        </div>
      </section>

      {/* Offloads stay in the Connection tab, but in their own section */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white">
        <div className="border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5 sm:px-5">
          <h3 className="text-sm font-bold text-slate-950">Offloads</h3>
        </div>
        <div className="p-4 sm:p-5">
          <OffloadSection
            flightId={flightId}
            detail={detail}
            onRefresh={onRefresh}
          />
        </div>
      </section>
    </div>
  );
}

function OffloadSection({
  flightId,
  detail,
  onRefresh,
}: {
  flightId: string;
  detail: FlightDetail;
  onRefresh: () => void;
}) {
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    offloadReason: "AIRLINE_OFFLOAD",
    reason: "",
    airline: "",
  });
  const [selectedParcels, setSelectedParcels] = useState<Set<string>>(new Set());
  const allocated = detail.allocations.filter((a) => a.status === "ALLOCATED");

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {!show ? (
          <button
            type="button"
            onClick={() => {
              setShow(true);
            }}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#CBD4DF] bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-[#F7F8FC]"
          >
            <FiPlus className="h-4 w-4" />
            Record offload
          </button>
        ) : null}
      </div>

      {show ? (
        <div className="overflow-hidden rounded-lg border border-[#DDE3EC] bg-[#FBFCFD]">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600">
              Offload category
              <select
                value={form.offloadReason}
                onChange={(e) =>
                  setForm({ ...form, offloadReason: e.target.value })
                }
                className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
              >
                <option value="AIRLINE_OFFLOAD">Airline offload</option>
                <option value="CAPACITY">Capacity</option>
                <option value="WEATHER">Weather</option>
                <option value="CUSTOMS">Customs</option>
                <option value="MISSED_CONNECTION">Missed connection</option>
                <option value="DAMAGE">Damage</option>
                <option value="SECURITY">Security</option>
                <option value="OTHER">Other</option>
              </select>
            </label>

            <label className="text-xs font-semibold text-slate-600">
              Airline
              <input
                value={form.airline}
                onChange={(e) => setForm({ ...form, airline: e.target.value })}
                placeholder="Emirates"
                className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
              />
            </label>

            <label className="text-xs font-semibold text-slate-600 sm:col-span-2">
              Detail *
              <input
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Explain why the selected parcels were offloaded"
                className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
              />
            </label>

            <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-slate-700">
                  Affected parcels
                </p>
                {selectedParcels.size ? (
                  <span className="rounded-md bg-[#F1F3FA] px-2 py-1 text-[10px] font-bold text-[#0D1282]">
                    {selectedParcels.size} selected
                  </span>
                ) : null}
              </div>

              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-[#DDE3EC] bg-white">
                {allocated.length ? (
                  allocated.map((allocation) => {
                    const activeParcels = allocation.parcelDetails.filter(
                      (parcel) => parcel.status === "ALLOCATED",
                    );

                    return (
                      <div key={allocation.id} className="px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-950">
                            {allocation.awb ||
                              allocation.shipmentDraftId.slice(-8)}
                          </span>
                          <span className="text-xs text-slate-500">
                            {allocation.destinationCountryName ||
                              allocation.destinationCountryCode}{" "}
                            · {activeParcels.length} active
                          </span>
                        </div>

                        <div className="mt-2 space-y-1.5">
                          {activeParcels.map((parcel) => {
                            const selectionKey = `${allocation.shipmentDraftId}|${parcel.parcelNumber}`;

                            return (
                              <label
                                key={parcel.parcelNumber}
                                className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-slate-50"
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={selectedParcels.has(selectionKey)}
                                  onChange={(event) => {
                                    const next = new Set(selectedParcels);
                                    if (event.target.checked)
                                      next.add(selectionKey);
                                    else next.delete(selectionKey);
                                    setSelectedParcels(next);
                                  }}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block break-all font-mono text-xs font-semibold text-slate-800">
                                    {parcel.parcelNumber}
                                  </span>
                                  <span className="mt-0.5 block text-xs text-slate-500">
                                    Actual {parcel.actualWeightKg.toFixed(3)} kg ·
                                    Volumetric {parcel.volumetricWeightKg.toFixed(3)} kg ·
                                    Chargeable {parcel.chargeableWeightKg.toFixed(3)} kg
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-slate-500">
                    No active parcels are available to offload.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-[#E7EBF0] bg-white px-4 py-3">
            <button
              type="button"
              onClick={() => {
                setShow(false);
                setSelectedParcels(new Set());
              }}
              className="h-10 rounded-lg border border-[#CDD5DF] bg-white px-4 text-sm font-semibold"
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={saving || !selectedParcels.size}
              onClick={async () => {
                if (form.reason.trim().length < 5)
                  return toast.error("Reason required.");
                if (!selectedParcels.size)
                  return toast.error("Select at least one parcel.");
                if (saving) return;
                setSaving(true);
                try {
                  const affectedParcels = [...selectedParcels].map(
                    (selection) => {
                      const [shipmentDraftId, parcelNumber] =
                        selection.split("|");
                      return { shipmentDraftId, parcelNumber };
                    },
                  );
                  await createOffload(flightId, {
                    reason: form.reason.trim(),
                    offloadReason: form.offloadReason,
                    airline: form.airline.trim(),
                    affectedParcels,
                  });
                  toast.success(
                    "Offload recorded. Use Shipment Rebook separately if the shipment must travel again.",
                  );
                  setShow(false);
                  setForm({
                    offloadReason: "AIRLINE_OFFLOAD",
                    reason: "",
                    airline: "",
                  });
                  setSelectedParcels(new Set());
                  await onRefresh();
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Offload failed.",
                  );
                } finally {
                  setSaving(false);
                }
              }}
              className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save offload"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-[#DDE3EC]">
        <div className="flex items-center justify-between border-b border-[#EEF1F4] bg-[#FBFCFD] px-3.5 py-2.5">
          <p className="text-xs font-bold text-slate-700">Offload history</p>
          <span className="text-[11px] text-slate-400">
            {detail.offloads.length} record{detail.offloads.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-180 text-left text-sm">
            <thead className="bg-white text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2.5">Reason</th>
                <th className="px-3 py-2.5">Detail</th>
                <th className="px-3 py-2.5">Parcels</th>
                <th className="px-3 py-2.5 text-right">Weight</th>
                <th className="px-3 py-2.5">At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.offloads.map((o) => (
                <tr key={o.id}>
                  <td className="px-3 py-2.5 font-semibold">{o.reason}</td>
                  <td className="max-w-64 truncate px-3 py-2.5">{o.detail}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {(o.affectedParcels ?? [])
                      .map((parcel) => parcel.parcelNumber)
                      .join(", ") || "Legacy record"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {o.affectedWeightKg.toFixed(1)} kg · {o.affectedPieces} pcs
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {new Date(o.createdAt).toLocaleString("en-IN")}
                  </td>
                </tr>
              ))}

              {!detail.offloads.length ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-7 text-center text-slate-500"
                  >
                    No offload records.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DocumentsTab({
  detail,
  flightId,
  onRefresh,
}: {
  detail: FlightDetail;
  flightId: string;
  onRefresh: () => void;
}) {
  const [type, setType] = useState("MAWB");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white">
        <div className="border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5 sm:px-5">
          <h3 className="text-sm font-bold text-slate-950">
            Upload document
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">Maximum 10 MB.</p>
        </div>

        <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[220px_minmax(0,1fr)_minmax(270px,0.9fr)]">
          <label className="text-xs font-semibold text-slate-600">
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
            >
              <option>MAWB</option>
              <option>BOOKING_CONFIRMATION</option>
              <option>CARGO_MANIFEST</option>
              <option>BAG_MANIFEST</option>
              <option>SECURITY</option>
              <option>CUSTOMS</option>
              <option>HANDOVER</option>
              <option>PROOF</option>
              <option>OTHER</option>
            </select>
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Note
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note"
              className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="block text-xs font-semibold text-slate-600">
            File
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1.5 block h-11 w-full cursor-pointer overflow-hidden rounded-lg border border-[#CDD5DF] bg-white text-xs font-medium text-slate-500 file:mr-3 file:h-full file:border-0 file:border-r file:border-[#E1E6EC] file:bg-[#F7F8FA] file:px-4 file:text-xs file:font-semibold file:text-[#0D1282] hover:file:bg-[#F1F3F8]"
            />
          </label>
        </div>

        <div className="flex justify-end border-t border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3 sm:px-5">
          <button
            type="button"
            disabled={uploading || !file}
            onClick={async () => {
              if (!file) return toast.error("Select a file.");
              setUploading(true);
              try {
                await uploadFlightDocument(flightId, file, type, note);
                toast.success("Document uploaded.");
                setFile(null);
                setNote("");
                await onRefresh();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Upload failed.");
              } finally {
                setUploading(false);
              }
            }}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0A0F6D] disabled:opacity-50"
          >
            <FiUpload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload document"}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white">
        <div className="flex items-center justify-between border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5">
          <h3 className="text-sm font-bold text-slate-950">Documents</h3>
          <span className="text-[11px] text-slate-400">
            {detail.documents.length} file{detail.documents.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-190 text-left text-sm">
            <thead className="bg-white text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.documents.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="font-medium">{d.originalName}</p>
                    {d.note ? (
                      <p className="text-xs text-slate-500">{d.note}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold">
                      {d.documentType}
                    </span>
                  </td>
                  <td className="px-4 py-3">{(d.size / 1024).toFixed(1)} KB</td>
                  <td className="px-4 py-3 text-xs">
                    {new Date(d.createdAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Download ${d.originalName}`}
                        onClick={async () => {
                          try {
                            const { apiUrl } = await import("@/lib/api");
                            const { getAccessToken, refreshAccessToken } =
                              await import("@/lib/auth");
                            let token =
                              getAccessToken() ?? (await refreshAccessToken());
                            if (!token) throw new Error("Session expired.");
                            let res = await fetch(
                              apiUrl(
                                `/api/v1/flight-linehauls/${flightId}/documents/${d.id}/download`,
                              ),
                              { headers: { Authorization: `Bearer ${token}` } },
                            );
                            if (res.status === 401) {
                              token = await refreshAccessToken();
                              if (!token) throw new Error("Session expired.");
                              res = await fetch(
                                apiUrl(
                                  `/api/v1/flight-linehauls/${flightId}/documents/${d.id}/download`,
                                ),
                                { headers: { Authorization: `Bearer ${token}` } },
                              );
                            }
                            if (!res.ok) throw new Error("Download failed.");
                            const blob = await res.blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = d.originalName;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 30000);
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : "Download failed.",
                            );
                          }
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-[#0D1282] hover:bg-slate-50"
                      >
                        <FiDownload className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        aria-label={`Delete ${d.originalName}`}
                        onClick={async () => {
                          if (!confirm("Delete document?")) return;
                          try {
                            await deleteFlightDocument(flightId, d.id);
                            toast.success("Deleted.");
                            await onRefresh();
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : "Delete failed.",
                            );
                          }
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 text-red-700 hover:bg-red-50"
                      >
                        <FiTrash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!detail.documents.length ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No documents uploaded.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function HandoverTab({
  detail,
  flightId,
  onRefresh,
}: {
  detail: FlightDetail;
  flightId: string;
  onRefresh: () => void;
}) {
  const f = detail.flight;
  const [form, setForm] = useState({
    arrivalAt: f.arrivalAt
      ? new Date(f.arrivalAt).toISOString().slice(0, 16)
      : "",
    customsStatus: f.customsStatus,
    customsClearedAt: f.customsClearedAt
      ? new Date(f.customsClearedAt as string).toISOString().slice(0, 16)
      : "",
    destinationAgent: f.destinationAgent ?? "",
    finalMileCarrier: f.finalMileCarrier ?? "",
    handoverAt: f.handoverAt
      ? new Date(f.handoverAt as string).toISOString().slice(0, 16)
      : "",
    handoverReference: f.handoverReference ?? "",
  });

  useEffect(() => {
    // The form mirrors refreshed handover data returned by the API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm({
      arrivalAt: f.arrivalAt
        ? new Date(f.arrivalAt).toISOString().slice(0, 16)
        : "",
      customsStatus: f.customsStatus,
      customsClearedAt: f.customsClearedAt
        ? new Date(f.customsClearedAt as string).toISOString().slice(0, 16)
        : "",
      destinationAgent: f.destinationAgent ?? "",
      finalMileCarrier: f.finalMileCarrier ?? "",
      handoverAt: f.handoverAt
        ? new Date(f.handoverAt).toISOString().slice(0, 16)
        : "",
      handoverReference: f.handoverReference ?? "",
    });
  }, [f]);

  return (
    <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3.5 sm:px-5">
        <div>
          <h3 className="text-sm font-bold text-slate-950">
            Destination handover
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {detail.stats.totalBags} bags · {detail.stats.totalShipments} shipments ·{" "}
            {detail.stats.totalPieces} pieces
          </p>
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
        <label className="text-xs font-semibold text-slate-600">
          Arrival at destination
          <input
            type="datetime-local"
            value={form.arrivalAt}
            onChange={(e) => setForm({ ...form, arrivalAt: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>

        <label className="text-xs font-semibold text-slate-600">
          Customs status
          <select
            value={form.customsStatus}
            onChange={(e) =>
              setForm({ ...form, customsStatus: e.target.value as never })
            }
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          >
            <option value="PENDING">PENDING</option>
            <option value="SUBMITTED">SUBMITTED</option>
            <option value="CLEARED">CLEARED</option>
            <option value="HELD">HELD</option>
          </select>
        </label>

        <label className="text-xs font-semibold text-slate-600">
          Customs cleared at
          <input
            type="datetime-local"
            value={form.customsClearedAt}
            onChange={(e) =>
              setForm({ ...form, customsClearedAt: e.target.value })
            }
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>

        <label className="text-xs font-semibold text-slate-600">
          Destination agent
          <input
            value={form.destinationAgent}
            onChange={(e) =>
              setForm({ ...form, destinationAgent: e.target.value })
            }
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>

        <label className="text-xs font-semibold text-slate-600">
          Final-mile carrier
          <input
            value={form.finalMileCarrier}
            onChange={(e) =>
              setForm({ ...form, finalMileCarrier: e.target.value })
            }
            placeholder="DPD UK / local partner"
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>

        <label className="text-xs font-semibold text-slate-600">
          Handover at
          <input
            type="datetime-local"
            value={form.handoverAt}
            onChange={(e) => setForm({ ...form, handoverAt: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>

        <label className="text-xs font-semibold text-slate-600 sm:col-span-2 lg:col-span-3">
          Handover reference
          <input
            value={form.handoverReference}
            onChange={(e) =>
              setForm({ ...form, handoverReference: e.target.value })
            }
            placeholder="AWB handover ref / POD"
            className="mt-1.5 h-11 w-full rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm"
          />
        </label>
      </div>

      <div className="flex justify-end border-t border-[#EEF1F4] bg-[#FBFCFD] px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={async () => {
            try {
              await updateHandover(flightId, {
                arrivalAt: form.arrivalAt
                  ? new Date(form.arrivalAt).toISOString()
                  : null,
                customsStatus: form.customsStatus,
                customsClearedAt: form.customsClearedAt
                  ? new Date(form.customsClearedAt).toISOString()
                  : null,
                destinationAgent: form.destinationAgent,
                finalMileCarrier: form.finalMileCarrier,
                handoverAt: form.handoverAt
                  ? new Date(form.handoverAt).toISOString()
                  : null,
                handoverReference: form.handoverReference,
              });
              toast.success("Handover updated.");
              await onRefresh();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Update failed.");
            }
          }}
          className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0A0F6D]"
        >
          Save handover
        </button>
      </div>
    </section>
  );
}

function ExceptionsTab({
  detail,
  onRefresh,
}: {
  detail: FlightDetail;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const items = filter
    ? detail.exceptions.filter((e) => e.status === filter)
    : detail.exceptions;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-700">Filter:</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-9 rounded-xl border border-[#DDE3EC] bg-white px-3 text-sm"
        >
          <option value="">All</option>
          <option value="OPEN">OPEN</option>
          <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
          <option value="IN_PROGRESS">IN_PROGRESS</option>
          <option value="RESOLVED">RESOLVED</option>
        </select>
        <span className="ml-auto text-xs text-slate-500">
          {items.length} exception{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-xs font-semibold">
                  {e.type.replaceAll("_", " ")}
                </td>
                <td className="px-3 py-2">
                  <p className="font-medium">{e.title}</p>
                  <p className="text-xs text-slate-500 line-clamp-2">
                    {e.description}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${e.severity === "CRITICAL" ? "bg-red-100 text-red-700" : e.severity === "HIGH" ? "bg-amber-100 text-amber-700" : e.severity === "MEDIUM" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}
                  >
                    {e.severity}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">
                    {e.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {e.dueAt ? new Date(e.dueAt).toLocaleString("en-IN") : "-"}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {e.status === "OPEN" ? (
                      <button
                        onClick={async () => {
                          try {
                            await acknowledgeException(e.id);
                            toast.success("Acknowledged.");
                            await onRefresh();
                          } catch (err) {
                            toast.error(
                              err instanceof Error ? err.message : "Failed.",
                            );
                          }
                        }}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold"
                      >
                        Ack
                      </button>
                    ) : null}
                    <button
                      onClick={async () => {
                        const notes = prompt("Resolution notes (min 5 chars):");
                        if (!notes || notes.trim().length < 5)
                          return toast.error("Notes required.");
                        try {
                          await resolveException(e.id, notes.trim());
                          toast.success("Resolved.");
                          await onRefresh();
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed.",
                          );
                        }
                      }}
                      className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      Resolve
                    </button>
                    <button
                      onClick={async () => {
                        const status = prompt(
                          "New status: OPEN, ACKNOWLEDGED, IN_PROGRESS, RESOLVED, CLOSED",
                        );
                        if (!status) return;
                        try {
                          await updateException(e.id, {
                            status: status.trim().toUpperCase(),
                          });
                          toast.success("Updated.");
                          await onRefresh();
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed.",
                          );
                        }
                      }}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                    >
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-slate-500"
                >
                  No exceptions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditTab({ detail }: { detail: FlightDetail }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#DDE3EC]">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">At</th>
            <th className="px-4 py-3">Metadata</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {detail.auditHistory.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-semibold">
                {a.action.replaceAll("_", " ")}
              </td>
              <td className="px-4 py-3 text-xs">
                {new Date(a.performedAt).toLocaleString("en-IN")}
              </td>
              <td className="px-4 py-3 text-xs font-mono max-w-md truncate">
                {JSON.stringify(a.metadata)}
              </td>
            </tr>
          ))}
          {!detail.auditHistory.length ? (
            <tr>
              <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                No audit history.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
