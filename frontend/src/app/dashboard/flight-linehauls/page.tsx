"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  FiAlertTriangle,
  FiArrowRight,
  FiCheckCircle,
  FiChevronDown,
  FiClock,
  FiMapPin,
  FiNavigation,
  FiPackage,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiTruck,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import {
  getFlightSummary,
  listFlights,
  type FlightCardSummary,
  type FlightListItem,
} from "@/lib/flightLinehaul";
import { normalizeFlightNumber } from "@/lib/flightNumber";

const statusOptions = [
  "",
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
  "CANCELLED",
];

function statusColor(status: string) {
  if (status === "DELAYED" || status === "CANCELLED" || status === "OFFLOADED")
    return "border-red-200 bg-red-50 text-red-700";
  if (["DEPARTED", "IN_TRANSIT", "CONNECTION"].includes(status))
    return "border-sky-200 bg-sky-50 text-sky-700";
  if (["ARRIVED_DESTINATION", "CUSTOMS"].includes(status))
    return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "CLOSED")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "HANDED_TO_FINAL_MILE")
    return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default function FlightLinehaulDashboardPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [items, setItems] = useState<FlightListItem[]>([]);
  const [cards, setCards] = useState<FlightCardSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [list, summary] = await Promise.all([
        listFlights({
          page,
          limit: 15,
          status: status || undefined,
          search: search || undefined,
        }),
        getFlightSummary(),
      ]);
      setItems(list.items);
      setPages(list.pagination.pages);
      setCards(summary.cards);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load flights.");
    } finally {
      setBusy(false);
    }
  }, [page, status, search]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [load, user]);

  // polling every 30s for control centre freshness
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => void load(), 30000);
    return () => clearInterval(id);
  }, [load, user]);

  if (loading || !user) return <DashboardLoading />;

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5">
      {/* Page heading */}
      <section className="overflow-hidden rounded-xl bg-white  shadow-[0_4px_14px_rgba(15,23,42,0.035)]">
        <div className="flex flex-col gap-5 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                Flight operations
              </p>

              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-[27px]">
                Flight &amp; Linehaul Control Centre
              </h1>

              <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500">
                Manage capacity, allocation, departures, transit, arrivals,
                customs, handover and operational exceptions from one view.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <Link
              href="/dashboard/flight-linehauls/new"
              className="group inline-flex h-10 items-center justify-center gap-2 rounded-4xl border border-blue-700 bg-white px-4 text-sm font-semibold text-[#0D1282] shadow-sm transition hover:bg-[#0A0F6D] hover:text-white"
            >
              <FiPlus className="h-4 w-4 transition-all duration-200 group-hover:h-5 group-hover:w-5" />
              Create New Flight
            </Link>
          </div>
        </div>

       
      </section>

      {/* Operational snapshot */}
      {cards ? (
        <section className="rounded-xl border border-[#DDE3EC] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.035)] sm:p-5">
          <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-950">
                Operational snapshot
              </h2>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">
                Current movement and exception counts across flight operations.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Card
              label="Tonight's departures"
              value={cards.tonightDepartures}
              icon={<FiClock />}
              tone="primary"
            />
            <Card
              label="Awaiting flight"
              value={cards.awaitingFlight}
              icon={<FiPackage />}
            />
            <Card
              label="Ready for handover"
              value={cards.readyForHandover}
              icon={<FiTruck />}
            />
            <Card
              label="Departed"
              value={cards.departed}
              icon={<FiArrowRight />}
              tone="primary"
            />
            <Card
              label="In transit"
              value={cards.inTransit}
              icon={<FiMapPin />}
              tone="primary"
            />
            <Card
              label="Connection risk"
              value={cards.connectionRisk}
              icon={<FiAlertTriangle />}
              tone={cards.connectionRisk > 0 ? "warning" : "neutral"}
            />
            <Card
              label="Offloaded"
              value={cards.offloaded}
              icon={<FiPackage />}
              tone={cards.offloaded > 0 ? "danger" : "neutral"}
            />
            <Card
              label="Delayed"
              value={cards.delayed}
              icon={<FiClock />}
              tone={cards.delayed > 0 ? "danger" : "neutral"}
            />
            <Card
              label="Destination arrived"
              value={cards.destinationArrived}
              icon={<FiCheckCircle />}
              tone="success"
            />
            <Card
              label="Action required"
              value={cards.actionRequiredExceptions}
              icon={<FiAlertTriangle />}
              tone={cards.actionRequiredExceptions > 0 ? "danger" : "neutral"}
            />
          </div>
        </section>
      ) : null}

      {/* Search and filters */}
      <section className="rounded-xl border border-[#DDE3EC] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.035)] sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_250px_auto] lg:items-end">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">
              Search flights
            </span>

            <div className="flex min-w-0">
              <div className="relative min-w-0 flex-1">
                <FiSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setSearch(searchInput);
                      setPage(1);
                    }
                  }}
                  placeholder="Flight number, MAWB or airline"
                  className="h-11 w-full rounded-l-lg border border-[#CDD5DF] bg-white py-2 pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:z-10 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  setSearch(searchInput);
                  setPage(1);
                }}
                className="h-11 shrink-0 rounded-r-lg border border-l-0 border-[#CDD5DF] bg-[#F8FAFC] px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-[#F1F4F8]"
              >
                Search
              </button>
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">
              Status
            </span>

            <div className="relative">
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="h-11 w-full appearance-none rounded-lg border border-[#CDD5DF] bg-white py-2 pl-3.5 pr-12 text-sm font-medium text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
              >
                <option value="">All statuses</option>
                {statusOptions.filter(Boolean).map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </select>

              <FiChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-4.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              />
            </div>
          </label>

          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSearchInput("");
              setStatus("");
              setPage(1);
            }}
            className="h-11 rounded-lg border border-[#CDD5DF] bg-white px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          >
            Clear filters
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#EEF1F4] pt-3 text-xs text-slate-500">
          <span>
            {search || status
              ? "Showing flights matching the active filters."
              : "Showing all flights available to your branch."}
          </span>

          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Auto-refresh enabled
          </span>
        </div>
      </section>

      {/* Flights table */}
      <section className="overflow-hidden rounded-xl border border-[#DDE3EC] bg-white shadow-[0_4px_14px_rgba(15,23,42,0.035)]">
        <div className="flex flex-col gap-2 border-b border-[#E7EBF0] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h2 className="text-sm font-bold text-slate-950">Flights</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Capacity, routing, schedule and lifecycle status.
            </p>
          </div>

          <span className="inline-flex w-fit rounded-md bg-[#F7F8FA] px-2.5 py-1.5 text-[11px] font-medium text-slate-500 ring-1 ring-[#E4E8ED]">
            Page {page} of {pages}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-295 text-left text-sm">
            <thead className="border-b border-[#E7EBF0] bg-[#F8FAFC]">
              <tr className="text-[11px] font-bold uppercase tracking-[0.07em] text-slate-500">
                <th className="px-5 py-3.5">Flight</th>
                <th className="px-5 py-3.5">Route</th>
                <th className="px-5 py-3.5">Schedule</th>
                <th className="px-5 py-3.5 text-right">Capacity</th>
                <th className="px-5 py-3.5 text-center">Utilisation</th>
                <th className="px-5 py-3.5 text-center">Shipments</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#EEF1F4]">
              {busy && !items.length ? (
                <tr>
                  <td colSpan={8} className="px-5 py-16 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F3F5FA] text-[#0D1282]">
                        <FiRefreshCw className="h-4 w-4 animate-spin" />
                      </span>
                      <p className="mt-3 text-sm font-semibold text-slate-700">
                        Loading flights
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Refreshing the latest flight and capacity information.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : items.length ? (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className="group transition-colors hover:bg-[#FAFBFD]"
                  >
                    <td className="px-5 py-4 align-top">
                      <Link
                        href={`/dashboard/flight-linehauls/${item.id}`}
                        className="font-bold text-[#0D1282] transition hover:text-[#0A0F6D] hover:underline"
                      >
                        {item.flightLinehaulNumber}
                      </Link>

                      <p className="mt-0.5 text-sm font-semibold text-slate-800">
                        {normalizeFlightNumber(item.flightNumber)}
                      </p>

                      <p className="mt-1 max-w-65 truncate text-xs text-slate-500">
                        {item.airlineName || "Airline pending"} ·{" "}
                        {item.mawbNumber || "MAWB pending"}
                      </p>

                      {item.branch?.code ? (
                        <span className="mt-2 inline-flex rounded-md bg-[#F1F3F6] px-2 py-0.5 text-[10px] font-bold text-slate-500">
                          {item.branch.code}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-5 py-4 align-top">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md border border-[#E0E5EB] bg-[#FAFBFC] px-2.5 py-1 text-xs font-bold text-slate-800">
                          {item.originIataCode || "???"}
                        </span>
                        <FiArrowRight className="h-3.5 w-3.5 text-slate-400" />
                        <span className="rounded-md border border-[#E0E5EB] bg-[#FAFBFC] px-2.5 py-1 text-xs font-bold text-slate-800">
                          {item.destinationIataCode || "???"}
                        </span>
                      </div>

                      {item.transitIataCode ? (
                        <span className="mt-2 inline-flex rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                          Via {item.transitIataCode}
                        </span>
                      ) : null}

                      <p className="mt-2 max-w-62.5 truncate text-xs text-slate-500">
                        {item.destinationAgent
                          ? `Agent: ${item.destinationAgent.slice(0, 32)}`
                          : "No destination agent"}
                      </p>
                    </td>

                    <td className="px-5 py-4 align-top">
                      <div className="grid gap-2">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            Departure
                          </p>
                          <p className="mt-0.5 font-semibold text-slate-800">
                            {new Date(item.scheduledDepartureAt).toLocaleString(
                              "en-IN",
                              { timeZone: "Asia/Kolkata" },
                            )}
                          </p>
                        </div>

                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            Arrival
                          </p>
                          <p className="mt-0.5 text-xs font-medium text-slate-600">
                            {new Date(item.scheduledArrivalAt).toLocaleString(
                              "en-IN",
                              { timeZone: "Asia/Kolkata" },
                            )}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="px-5 py-4 text-right align-top tabular-nums">
                      <span
                        className={
                          item.allocatedWeightKg > item.capacityKg
                            ? "font-bold text-red-600"
                            : "font-bold text-slate-800"
                        }
                      >
                        {item.allocatedWeightKg.toFixed(1)} /{" "}
                        {item.capacityKg.toFixed(1)} kg
                      </span>

                      <div className="ml-auto mt-2 h-1.5 w-28 overflow-hidden rounded-full bg-[#EEF1F4]">
                        <div
                          className={`h-full rounded-full ${
                            item.utilisationPercent > 100
                              ? "bg-red-600"
                              : item.utilisationPercent > 90
                                ? "bg-amber-500"
                                : "bg-[#0D1282]"
                          }`}
                          style={{
                            width: `${Math.min(item.utilisationPercent, 100)}%`,
                          }}
                        />
                      </div>
                    </td>

                    <td className="px-5 py-4 text-center align-top">
                      <span
                        className={`inline-flex min-w-16 justify-center rounded-md px-2.5 py-1 text-xs font-bold tabular-nums ${
                          item.utilisationPercent > 100
                            ? "bg-red-50 text-red-700"
                            : item.utilisationPercent > 90
                              ? "bg-amber-50 text-amber-700"
                              : "bg-[#F2F4F8] text-slate-700"
                        }`}
                      >
                        {item.utilisationPercent.toFixed(1)}%
                      </span>
                    </td>

                    <td className="px-5 py-4 text-center align-top">
                      <span className="inline-flex min-w-10 justify-center rounded-md bg-[#F2F4F8] px-2.5 py-1 text-xs font-bold text-slate-700 tabular-nums">
                        {item.totalShipments}
                      </span>
                    </td>

                    <td className="px-5 py-4 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-bold ${statusColor(
                            item.status,
                          )}`}
                        >
                          {item.status.replaceAll("_", " ")}
                        </span>

                        {item.connection?.riskLevel &&
                        ["HIGH", "CRITICAL", "MISSED"].includes(
                          item.connection.riskLevel,
                        ) ? (
                          <span className="inline-flex rounded-md bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700">
                            {item.connection.riskLevel}
                          </span>
                        ) : null}
                      </div>
                    </td>

                    <td className="px-5 py-4 text-right align-top">
                      <Link
                        href={`/dashboard/flight-linehauls/${item.id}`}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#D9E0EA] bg-white px-3 text-xs font-semibold text-[#0D1282] transition hover:border-[#BFC9D6] hover:bg-[#F8FAFC]"
                      >
                        Open
                        <FiArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="px-5 py-16 text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center">
                      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#F3F5FA] text-[#0D1282]">
                        <FiTruck className="h-5 w-5" />
                      </span>
                      <p className="mt-3 text-sm font-semibold text-slate-800">
                        No flights found
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        Try adjusting your filters, or create your first flight
                        to start allocations.
                      </p>
                      <Link
                        href="/dashboard/flight-linehauls/new"
                        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#0D1282] px-3.5 text-xs font-semibold text-white transition hover:bg-[#0A0F6D]"
                      >
                        <FiPlus className="h-3.5 w-3.5" />
                        New Flight
                      </Link>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex flex-col gap-3 border-t border-[#E7EBF0] bg-[#FAFBFC] px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="text-xs text-slate-500">
            Page <span className="font-semibold text-slate-700">{page}</span> of{" "}
            <span className="font-semibold text-slate-700">{pages}</span>
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((v) => v - 1)}
              className="h-9 rounded-lg border border-[#CDD5DF] bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((v) => v + 1)}
              className="h-9 rounded-lg border border-[#CDD5DF] bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

type CardTone = "neutral" | "primary" | "warning" | "danger" | "success";

function Card({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: CardTone;
}) {
  const toneClasses: Record<
    CardTone,
    { icon: string; value: string; card: string }
  > = {
    neutral: {
      card: "border-[#E1E6EC] bg-white",
      icon: "bg-[#F3F5F7] text-slate-600",
      value: "text-slate-950",
    },
    primary: {
      card: "border-[#DCE2EC] bg-white",
      icon: "bg-[#F1F3FA] text-[#0D1282]",
      value: "text-slate-950",
    },
    warning: {
      card: "border-amber-200 bg-white",
      icon: "bg-amber-50 text-amber-700",
      value: "text-slate-950",
    },
    danger: {
      card: "border-red-200 bg-white",
      icon: "bg-red-50 text-red-700",
      value: "text-red-700",
    },
    success: {
      card: "border-emerald-200 bg-white",
      icon: "bg-emerald-50 text-emerald-700",
      value: "text-slate-950",
    },
  };

  const classes = toneClasses[tone];

  return (
    <article
      className={`group min-h-27.5 rounded-xl border p-4 transition duration-200 hover:border-[#C9D1DC] hover:shadow-[0_6px_16px_rgba(15,23,42,0.05)] ${classes.card}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold leading-5 text-slate-600">
            {label}
          </p>
          <p
            className={`mt-3 text-[26px] font-bold leading-none tracking-tight tabular-nums ${classes.value}`}
          >
            {value}
          </p>
        </div>

        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[15px] ${classes.icon}`}
        >
          {icon}
        </span>
      </div>
    </article>
  );
}
