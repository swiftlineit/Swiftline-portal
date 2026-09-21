"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { createFlight } from "@/lib/flightLinehaul";
import {
  listManifestBranches,
  listOperationsManifests,
  type OperationsManifest
} from "@/lib/operationsManifests";
import { normalizeFlightNumber } from "@/lib/flightNumber";

const inputClass =
  "mt-1.5 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";

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
        if (r.branches.length)
          setForm((current) =>
            current.branchId
              ? current
              : { ...current, branchId: r.branches[0]?.id ?? "" },
          );
      })
      .catch(() => {});
    listOperationsManifests(1, "DISPATCHED")
      .then((result) => setManifests(result.items.filter((item) => !item.flightLinehaulId)))
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
      capacityKg: String(Math.max(Number(current.capacityKg) || 0, manifest.totalWeightKg))
    }));
  }

  if (loading || !user) return <DashboardLoading />;

  async function submit() {
    if (!manifestId) return toast.error("Select a dispatched operations manifest.");
    if (!form.branchId) return toast.error("Select a branch.");
    if (
      !/^[A-Z0-9]{2,4}-\d{1,4}[A-Z]?$/.test(
        normalizeFlightNumber(form.flightNumber),
      )
    )
      return toast.error("Enter a valid flight number (e.g., EY-219).");
    if (form.airlineName.trim().length < 2)
      return toast.error("Enter the airline name.");
    if (!/^\d{3}-?\d{8}$/.test(form.mawbNumber.trim()))
      return toast.error("Enter a valid MAWB (e.g., 098-12345678).");
    if (
      !/^[A-Za-z]{3}$/.test(form.originIataCode.trim()) ||
      !/^[A-Za-z]{3}$/.test(form.destinationIataCode.trim())
    )
      return toast.error(
        "Enter valid three-letter origin and destination IATA codes.",
      );
    if (
      form.originIataCode.trim().toUpperCase() ===
      form.destinationIataCode.trim().toUpperCase()
    )
      return toast.error("Origin and destination airports must be different.");
    if (!form.scheduledDepartureAt || !form.scheduledArrivalAt)
      return toast.error("Select departure and arrival.");
    const cap = Number(form.capacityKg);
    if (!Number.isFinite(cap) || cap <= 0)
      return toast.error("Enter a valid positive capacity.");
    if (
      new Date(form.scheduledArrivalAt) <= new Date(form.scheduledDepartureAt)
    )
      return toast.error("Arrival must be after departure.");
    setSaving(true);
    try {
      const res = await createFlight({
        branchId: form.branchId,
        flightNumber: normalizeFlightNumber(form.flightNumber),
        airlineName: form.airlineName.trim(),
        mawbNumber: form.mawbNumber.trim().toUpperCase(),
        originIataCode: form.originIataCode.trim().toUpperCase(),
        destinationIataCode: form.destinationIataCode.trim().toUpperCase(),
        transitIataCode: form.transitIataCode.trim().toUpperCase(),
        scheduledDepartureAt: new Date(form.scheduledDepartureAt).toISOString(),
        scheduledArrivalAt: new Date(form.scheduledArrivalAt).toISOString(),
        capacityKg: cap,
        destinationAgent: form.destinationAgent.trim(),
        finalMileCarrier: form.finalMileCarrier.trim(),
        manifestId,
        connection: form.transitAirportCode.trim()
          ? {
              transitAirportCode: form.transitAirportCode.trim().toUpperCase(),
              scheduledArrivalAt: form.connectionArrival
                ? new Date(form.connectionArrival).toISOString()
                : undefined,
              scheduledDepartureAt: form.connectionDeparture
                ? new Date(form.connectionDeparture).toISOString()
                : undefined,
            }
          : null,
      });
      toast.success("Flight created; manifest and its packed shipments attached.");
      router.push(`/dashboard/flight-linehauls/${res.flightId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create flight.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-8xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-[#0D1282]">Create Flight</h1>
      </div>

      <div className="rounded-2xl border border-[#EEEDED] bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          Select the dispatched operations manifest first. Its route, MAWB and packed shipments are attached to the flight automatically; only airline and exact schedule details remain to complete.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-slate-700 sm:col-span-2">
            Operations manifest *
            <select
              value={manifestId}
              onChange={(event) => selectManifest(event.target.value)}
              className={inputClass}
            >
              <option value="">Select dispatched operations manifest</option>
              {manifests.map((manifest) => (
                <option key={manifest.id} value={manifest.id}>
                  {manifest.manifestNumber} · {manifest.header.flightNumber} · {manifest.header.mawbNumber} · {manifest.totalPhysicalParcels} parcels
                </option>
              ))}
            </select>
            {manifestId ? (
              <span className="mt-1.5 block text-xs font-medium text-emerald-700">
                Route, flight number, MAWB and departure date were copied. Add the airline and exact departure/arrival times before creating.
              </span>
            ) : <span className="mt-1.5 block text-xs font-medium text-slate-500">A dispatched manifest is required to create a flight.</span>}
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Branch *
            <select
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              className={`${inputClass} `}
            >
              <option value="">Select branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Flight number *
            <input
              value={form.flightNumber}
              onChange={(e) =>
                setForm({ ...form, flightNumber: e.target.value })
              }
              placeholder="EY-219"
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Airline *
            <input
              required
              value={form.airlineName}
              onChange={(e) =>
                setForm({ ...form, airlineName: e.target.value })
              }
              placeholder="Air India"
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            MAWB *
            <input
              required
              value={form.mawbNumber}
              onChange={(e) => setForm({ ...form, mawbNumber: e.target.value })}
              placeholder="098-12345678"
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Origin IATA *
            <input
              required
              value={form.originIataCode}
              onChange={(e) =>
                setForm({ ...form, originIataCode: e.target.value })
              }
              placeholder="DEL"
              maxLength={3}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Destination IATA *
            <input
              required
              value={form.destinationIataCode}
              onChange={(e) =>
                setForm({ ...form, destinationIataCode: e.target.value })
              }
              placeholder="LHR"
              maxLength={3}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Transit IATA (optional)
            <input
              value={form.transitIataCode}
              onChange={(e) =>
                setForm({ ...form, transitIataCode: e.target.value })
              }
              placeholder="DXB"
              maxLength={3}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Capacity (kg) *
            <input
              required
              type="number"
              min={0.1}
              step={0.1}
              value={form.capacityKg}
              onChange={(e) => setForm({ ...form, capacityKg: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Scheduled departure *
            <input
              type="datetime-local"
              value={form.scheduledDepartureAt}
              onChange={(e) =>
                setForm({ ...form, scheduledDepartureAt: e.target.value })
              }
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Scheduled arrival *
            <input
              type="datetime-local"
              value={form.scheduledArrivalAt}
              onChange={(e) =>
                setForm({ ...form, scheduledArrivalAt: e.target.value })
              }
              className={inputClass}
            />
          </label>
          <label className="text-sm font-semibold text-slate-700 sm:col-span-2">
            Destination agent
            <textarea
              value={form.destinationAgent}
              onChange={(e) =>
                setForm({ ...form, destinationAgent: e.target.value })
              }
              rows={2}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-[#0D1282]"
              placeholder="Destination handling agent details"
            />
          </label>
          <label className="text-sm font-semibold text-slate-700">
            Final-mile carrier
            <input
              value={form.finalMileCarrier}
              onChange={(e) =>
                setForm({ ...form, finalMileCarrier: e.target.value })
              }
              placeholder="DPD UK"
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <p className="text-sm font-semibold text-amber-800">
              Single transit connection (optional)
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-semibold text-slate-600">
                Transit airport
                <input
                  value={form.transitAirportCode}
                  onChange={(e) =>
                    setForm({ ...form, transitAirportCode: e.target.value })
                  }
                  placeholder="DXB"
                  maxLength={3}
                  className={inputClass}
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Transit arrival
                <input
                  type="datetime-local"
                  value={form.connectionArrival}
                  onChange={(e) =>
                    setForm({ ...form, connectionArrival: e.target.value })
                  }
                  className={inputClass}
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Transit departure
                <input
                  type="datetime-local"
                  value={form.connectionDeparture}
                  onChange={(e) =>
                    setForm({ ...form, connectionDeparture: e.target.value })
                  }
                  className={inputClass}
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Industry buffer: 90 min minimum, &lt;120 min flagged HIGH risk,
              &lt;90 CRITICAL. Server calculates risk automatically.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Link
            href="/dashboard/flight-linehauls"
            className="h-11 rounded-xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="h-11 rounded-xl bg-[#0D1282] px-6 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create Flight"}
          </button>
        </div>
      </div>
    </div>
  );
}
