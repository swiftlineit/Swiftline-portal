"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FiChevronDown } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { createFlight } from "@/lib/flightLinehaul";
import {
  listManifestBranches,
  listOperationsManifests,
  type OperationsManifest,
} from "@/lib/operationsManifests";
import { normalizeFlightNumber } from "@/lib/flightNumber";

const inputClass =
  "mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";

const labelClass = "block text-xs font-semibold text-slate-600";

export default function NewFlightPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const router = useRouter();

  const [branches, setBranches] = useState<
    Array<{ id: string; name: string; code: string }>
  >([]);

  const [saving, setSaving] = useState(false);
  const [manifests, setManifests] = useState<OperationsManifest[]>([]);
  const [manifestId, setManifestId] = useState("");

  const [form, setForm] = useState({
    branchId: "",
    flightNumber: "",
    airlineName: "",
    mawbNumber: "",
    originIataCode: "",
    destinationIataCode: "",
    transitIataCode: "",
    scheduledDepartureAt: "",
    scheduledArrivalAt: "",
    capacityKg: "1000",
    destinationAgent: "",
    finalMileCarrier: "",
    transitAirportCode: "",
    connectionArrival: "",
    connectionDeparture: "",
  });

  useEffect(() => {
    if (!user) return;

    listManifestBranches()
      .then((r) => {
        setBranches(r.branches);

        if (r.branches.length) {
          setForm((current) =>
            current.branchId
              ? current
              : {
                  ...current,
                  branchId: r.branches[0]?.id ?? "",
                },
          );
        }
      })
      .catch(() => {});

    listOperationsManifests(1, "DISPATCHED")
      .then((result) =>
        setManifests(
          result.items.filter((item) => !item.flightLinehaulId),
        ),
      )
      .catch(() => setManifests([]));
  }, [user]);

  function selectManifest(id: string) {
    setManifestId(id);

    const manifest = manifests.find((item) => item.id === id);
    if (!manifest) return;

    setForm((current) => ({
      ...current,
      branchId: manifest.branchId,
      flightNumber: manifest.header.flightNumber,
      mawbNumber: manifest.header.mawbNumber,
      originIataCode: manifest.header.originIataCode,
      destinationIataCode: manifest.header.destinationIataCode,
      scheduledDepartureAt: manifest.header.departureDate
        ? `${manifest.header.departureDate}T12:00`
        : current.scheduledDepartureAt,
      capacityKg: String(
        Math.max(
          Number(current.capacityKg) || 0,
          manifest.totalWeightKg,
        ),
      ),
    }));
  }

  if (loading || !user) return <DashboardLoading />;

  async function submit() {
    if (!manifestId) {
      return toast.error(
        "Select a dispatched operations manifest.",
      );
    }

    if (!form.branchId) {
      return toast.error("Select a branch.");
    }

    if (
      !/^[A-Z0-9]{2,4}-\d{1,4}[A-Z]?$/.test(
        normalizeFlightNumber(form.flightNumber),
      )
    ) {
      return toast.error(
        "Enter a valid flight number (e.g., EY-219).",
      );
    }

    if (form.airlineName.trim().length < 2) {
      return toast.error("Enter the airline name.");
    }

    if (!/^\d{3}-?\d{8}$/.test(form.mawbNumber.trim())) {
      return toast.error(
        "Enter a valid MAWB (e.g., 098-12345678).",
      );
    }

    if (
      !/^[A-Za-z]{3}$/.test(form.originIataCode.trim()) ||
      !/^[A-Za-z]{3}$/.test(form.destinationIataCode.trim())
    ) {
      return toast.error(
        "Enter valid three-letter origin and destination IATA codes.",
      );
    }

    if (
      form.originIataCode.trim().toUpperCase() ===
      form.destinationIataCode.trim().toUpperCase()
    ) {
      return toast.error(
        "Origin and destination airports must be different.",
      );
    }

    if (!form.scheduledDepartureAt || !form.scheduledArrivalAt) {
      return toast.error("Select departure and arrival.");
    }

    const cap = Number(form.capacityKg);

    if (!Number.isFinite(cap) || cap <= 0) {
      return toast.error("Enter a valid positive capacity.");
    }

    if (
      new Date(form.scheduledArrivalAt) <=
      new Date(form.scheduledDepartureAt)
    ) {
      return toast.error("Arrival must be after departure.");
    }

    setSaving(true);

    try {
      const res = await createFlight({
        branchId: form.branchId,
        flightNumber: normalizeFlightNumber(form.flightNumber),
        airlineName: form.airlineName.trim(),
        mawbNumber: form.mawbNumber.trim().toUpperCase(),
        originIataCode: form.originIataCode.trim().toUpperCase(),
        destinationIataCode:
          form.destinationIataCode.trim().toUpperCase(),
        transitIataCode: form.transitIataCode.trim().toUpperCase(),
        scheduledDepartureAt: new Date(
          form.scheduledDepartureAt,
        ).toISOString(),
        scheduledArrivalAt: new Date(
          form.scheduledArrivalAt,
        ).toISOString(),
        capacityKg: cap,
        destinationAgent: form.destinationAgent.trim(),
        finalMileCarrier: form.finalMileCarrier.trim(),
        manifestId,
        connection: form.transitAirportCode.trim()
          ? {
              transitAirportCode:
                form.transitAirportCode.trim().toUpperCase(),
              scheduledArrivalAt: form.connectionArrival
                ? new Date(form.connectionArrival).toISOString()
                : undefined,
              scheduledDepartureAt: form.connectionDeparture
                ? new Date(form.connectionDeparture).toISOString()
                : undefined,
            }
          : null,
      });

      toast.success(
        "Flight created; manifest and its packed shipments attached.",
      );

      router.push(
        `/dashboard/flight-linehauls/${res.flightId}`,
      );
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Could not create flight.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className=" w-full max-w-6xl space-y-4 pb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[#0D1282]">
          Create Flight
        </h1>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-red-100 bg-red-50/60 px-4 py-3 sm:px-5">
          <p className="text-xs font-medium leading-5 text-amber-700 sm:text-sm">
            Select the dispatched operations manifest first. Its
            route, MAWB and packed shipments are attached to the
            flight automatically; only airline and exact schedule
            details remain to complete.
          </p>
        </div>

        <div className="p-4 sm:p-5">
          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
            <label className={`${labelClass} sm:col-span-2`}>
              Operations manifest <span className="text-red-500">*</span>

              <div className="relative mt-1.5">
                <select
                  value={manifestId}
                  onChange={(event) =>
                    selectManifest(event.target.value)
                  }
                  className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white py-0 pl-3 pr-10 text-sm font-medium text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                >
                  <option value="">
                    Select dispatched operations manifest
                  </option>

                  {manifests.map((manifest) => (
                    <option
                      key={manifest.id}
                      value={manifest.id}
                    >
                      {manifest.manifestNumber} ·{" "}
                      {manifest.header.flightNumber} ·{" "}
                      {manifest.header.mawbNumber} ·{" "}
                      {manifest.totalPhysicalParcels} parcels
                    </option>
                  ))}
                </select>

                <FiChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                />
              </div>

              {manifestId ? (
                <span className="mt-1.5 block text-xs font-medium text-emerald-700">
                  Route, flight number, MAWB and departure date
                  were copied. Add the airline and exact
                  departure/arrival times before creating.
                </span>
              ) : (
                <span className="mt-1.5 block text-xs font-medium text-slate-500">
                  A dispatched manifest is required to create a
                  flight.
                </span>
              )}
            </label>

            <label className={labelClass}>
              Branch <span className="text-red-500">*</span>

              <div className="relative mt-1.5">
                <select
                  value={form.branchId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      branchId: e.target.value,
                    })
                  }
                  className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white py-0 pl-3 pr-10 text-sm font-medium text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                >
                  <option value="">Select branch</option>

                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>

                <FiChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                />
              </div>
            </label>

            <label className={labelClass}>
              Flight number <span className="text-red-500">*</span>

              <input
                value={form.flightNumber}
                onChange={(e) =>
                  setForm({
                    ...form,
                    flightNumber: e.target.value,
                  })
                }
                placeholder="EY-219"
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Airline <span className="text-red-500">*</span>

              <input
                required
                value={form.airlineName}
                onChange={(e) =>
                  setForm({
                    ...form,
                    airlineName: e.target.value,
                  })
                }
                placeholder="Air India"
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              MAWB <span className="text-red-500">*</span>

              <input
                required
                value={form.mawbNumber}
                onChange={(e) =>
                  setForm({
                    ...form,
                    mawbNumber: e.target.value,
                  })
                }
                placeholder="098-12345678"
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Origin IATA <span className="text-red-500">*</span>

              <input
                required
                value={form.originIataCode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    originIataCode: e.target.value,
                  })
                }
                placeholder="DEL"
                maxLength={3}
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Destination IATA <span className="text-red-500">*</span>

              <input
                required
                value={form.destinationIataCode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    destinationIataCode: e.target.value,
                  })
                }
                placeholder="LHR"
                maxLength={3}
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Transit IATA (optional)

              <input
                value={form.transitIataCode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    transitIataCode: e.target.value,
                  })
                }
                placeholder="DXB"
                maxLength={3}
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Capacity (kg) <span className="text-red-500">*</span>

              <input
                required
                type="number"
                min={0.1}
                step={0.1}
                value={form.capacityKg}
                onChange={(e) =>
                  setForm({
                    ...form,
                    capacityKg: e.target.value,
                  })
                }
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Scheduled departure <span className="text-red-500">*</span>

              <input
                type="datetime-local"
                value={form.scheduledDepartureAt}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scheduledDepartureAt: e.target.value,
                  })
                }
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Scheduled arrival <span className="text-red-500">*</span>

              <input
                type="datetime-local"
                value={form.scheduledArrivalAt}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scheduledArrivalAt: e.target.value,
                  })
                }
                className={inputClass}
              />
            </label>

            <label className={`${labelClass} sm:col-span-2`}>
              Destination agent

              <textarea
                value={form.destinationAgent}
                onChange={(e) =>
                  setForm({
                    ...form,
                    destinationAgent: e.target.value,
                  })
                }
                rows={2}
                className="mt-1.5 min-h-[76px] w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                placeholder="Destination handling agent details"
              />
            </label>

            <label className={labelClass}>
              Final-mile carrier

              <input
                value={form.finalMileCarrier}
                onChange={(e) =>
                  setForm({
                    ...form,
                    finalMileCarrier: e.target.value,
                  })
                }
                placeholder="DPD UK"
                className={inputClass}
              />
            </label>

            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 sm:col-span-2">
              <p className="text-sm font-semibold text-amber-800">
                Single transit connection (optional)
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className={labelClass}>
                  Transit airport

                  <input
                    value={form.transitAirportCode}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        transitAirportCode: e.target.value,
                      })
                    }
                    placeholder="DXB"
                    maxLength={3}
                    className={inputClass}
                  />
                </label>

                <label className={labelClass}>
                  Transit arrival

                  <input
                    type="datetime-local"
                    value={form.connectionArrival}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        connectionArrival: e.target.value,
                      })
                    }
                    className={inputClass}
                  />
                </label>

                <label className={labelClass}>
                  Transit departure

                  <input
                    type="datetime-local"
                    value={form.connectionDeparture}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        connectionDeparture: e.target.value,
                      })
                    }
                    className={inputClass}
                  />
                </label>
              </div>

              <p className="mt-2 text-xs leading-5 text-slate-500">
                Industry buffer: 90 min minimum, &lt;120 min
                flagged HIGH risk, &lt;90 CRITICAL. Server
                calculates risk automatically.
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <Link
              href="/dashboard/flight-linehauls"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Cancel
            </Link>

            <button
              onClick={() => void submit()}
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create Flight"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}