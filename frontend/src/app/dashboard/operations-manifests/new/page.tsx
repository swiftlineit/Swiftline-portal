"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FiChevronDown, FiSearch, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { normalizeFlightNumber } from "@/lib/flightNumber";
import { DashboardLoading } from "@/components/DashboardShell";
import CountryFlag from "@/components/CountryFlag";
import { countryCodeOptions } from "@/lib/countries";
import { findCountries, resolveCountry } from "@/lib/countryLookup";
import {
  createOperationsManifestWithFlight,
  listManifestBranches,
  type ManifestHeader,
} from "@/lib/operationsManifests";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { indiaDateTimeLocalToIso } from "@/lib/indiaDateTime";
import {
  flightArrivalDateTimeLocalToIso,
  flightArrivalTimeZoneLabel,
  isUkFlightDestination,
} from "@/lib/dateTimeZones";

// Almost every flight clears through the UK agent, so the TO block starts filled in
// and the operator edits it only when the destination agent differs.
const defaultDestinationAgent = [
  "M/S SWIFTLINE CARGO LTD",
  "CFL CODE:SLC",
  "14 MARVVELL AVENUE",
  "UB4 0QR",
  "EORI:GB047637985000",
  "UNITED KINGDOM",
].join("\n");

const valueTypeOptions = [
  { code: "HV", label: "HVG" },
  { code: "LV", label: "LVG" },
  { code: "TS", label: "TS" },
  { code: "Docs", label: "Docs" },
];

const originIataOptions = [
  { code: "DEL", label: "DEL" },
  { code: "AMD", label: "AMD" },
  { code: "BOM", label: "BOM" },
  { code: "JAI", label: "JAI" },
  { code: "HYD", label: "HYD" },
  { code: "BLR", label: "BLR" },
];

const destinationIataOptions = [
  { code: "LHR", label: "LHR" },
  { code: "LGW", label: "LGW" },
  { code: "STN", label: "STN" },
  { code: "LTN", label: "LTN" },
  { code: "LCY", label: "LCY" },
  { code: "SEN", label: "SEN" },
];

const emptyHeader: ManifestHeader = {
  destinationAgent: defaultDestinationAgent,
  destinationCountryCode: "",
  destinationCountryName: "",
  flightNumber: "",
  departureDate: "",
  mawbNumber: "",
  originIataCode: "",
  destinationIataCode: "",
  valueType: "LV",
};

const controlBase =
  "h-11 w-full rounded-2xl border border-slate-300 bg-white px-3 text-sm normal-case text-slate-950 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]";
const controlClass = `mt-2 ${controlBase}`;
// `padding-right` moves the text, never the native arrow. The arrow is only movable
// once the browser control is removed and the chevron is drawn beside it.
const selectClass = `${controlBase} appearance-none pr-10 `;
const labelClass = "text-xs  uppercase text-slate-600";

/** Positions the chevron inset from the right border, clear of the rounded corner. */
function SelectShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative mt-2">
      {children}
      <FiChevronDown
        aria-hidden
        className="pointer-events-none  rounded-2xl absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}

/** Searchable country field: type to filter, flags + code stay visible, UI stays compact. */
function CountrySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string, name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const selected = countryCodeOptions.find((item) => item.code === value);
  const [query, setQuery] = useState(selected?.name ?? "");

  const hasValue = !!selected;

  useEffect(() => {
    // Sync the visible text when the stored code changes externally (e.g., draft load),
    // but never clobber what the user is actively typing.
    if (document.activeElement !== inputRef.current) {
      setQuery(selected?.name ?? "");
    }
  }, [value, selected?.name]);

  const suggestions = useMemo(() => findCountries(query).slice(0, 8), [query]);
  const activeIndex = Math.min(highlighted, Math.max(suggestions.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function selectCountry(code: string, name: string) {
    setQuery(name);
    onChange(code, name);
    setOpen(false);
    setHighlighted(0);
  }

  function handleInputChange(next: string) {
    setQuery(next);
    setOpen(true);
    setHighlighted(0);
    const trimmed = next.trim();
    if (!trimmed) {
      onChange("", "");
      return;
    }
    const exact = resolveCountry(next);
    if (exact) {
      onChange(exact.iso2.toUpperCase(), exact.name);
    } else if (value) {
      // Clear stale code while the text no longer matches a country exactly.
      onChange("", "");
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlighted((prev) => Math.min(prev + 1, suggestions.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && suggestions[activeIndex]) {
      event.preventDefault();
      const pick = suggestions[activeIndex];
      selectCountry(pick.iso2.toUpperCase(), pick.name);
    }
  }

  return (
    <div ref={containerRef} className="relative mt-2">
      <div className="relative">
        {hasValue ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
            <CountryFlag code={selected!.code} />
          </span>
        ) : (
          <FiSearch
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && suggestions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
          }
          autoComplete="off"
          value={query}
          onChange={(event) => handleInputChange(event.target.value)}
          onFocus={() => {
            setOpen(true);
            setHighlighted(0);
          }}
          onBlur={() => {
            // If the typed text is an alias (e.g. "UK") normalise the visible text
            // to the canonical country name so the field and the stored value match.
            if (selected && query && query !== selected.name) {
              const exact = resolveCountry(query);
              if (exact && exact.iso2.toUpperCase() === selected.code) {
                setQuery(selected.name);
              }
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type to search country..."
          className={`${controlBase} !pl-9 !pr-16 text-left placeholder:text-slate-400`}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear country"
            onMouseDown={(event) => {
              event.preventDefault();
              setQuery("");
              onChange("", "");
              setOpen(true);
              setHighlighted(0);
              inputRef.current?.focus();
            }}
            className="absolute right-8 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <FiX className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <FiChevronDown
          aria-hidden
          className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {suggestions.length ? (
            suggestions.map((item, index) => (
              <button
                key={item.iso2}
                type="button"
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectCountry(item.iso2.toUpperCase(), item.name);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-slate-50 ${index === activeIndex ? "bg-[#EEEDED]/70 font-medium text-[#0D1282]" : "text-slate-800"}`}
              >
                <CountryFlag code={item.iso2} />
                <span className="truncate">{item.name}</span>
                <span className="ml-auto shrink-0 text-[11px] font-semibold tracking-wide text-slate-400">
                  {item.iso2.toUpperCase()}
                </span>
              </button>
            ))
          ) : (
            <p className="px-3 py-3 text-center text-sm text-slate-500">No matching countries</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function NewOperationsManifestPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const router = useRouter();
  const [branches, setBranches] = useState<
    Array<{ id: string; name: string; code: string }>
  >([]);
  const [branchId, setBranchId] = useState("");
  const [header, setHeader] = useState(emptyHeader);
  const [flight, setFlight] = useState({
    airlineName: "",
    scheduledDepartureLocal: "",
    scheduledArrivalLocal: "",
    capacityKg: "1000",
    transitIataCode: "",
    finalMileCarrier: "",
    transitAirportCode: "",
    transitArrivalLocal: "",
    transitDepartureLocal: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user)
      void listManifestBranches()
        .then((data) => setBranches(data.branches))
        .catch((error) => toast.error(error.message));
  }, [user]);

  if (loading || !user) return <DashboardLoading />;

  const field = (key: keyof ManifestHeader, value: string) =>
    setHeader((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!branchId) return toast.error("Select the origin branch.");
    const departureAt = indiaDateTimeLocalToIso(flight.scheduledDepartureLocal);
    const arrivalAt = flightArrivalDateTimeLocalToIso(flight.scheduledArrivalLocal, header.destinationIataCode);
    if (!departureAt) return toast.error("Enter a valid scheduled departure time in IST.");
    if (!arrivalAt) {
      return toast.error(isUkFlightDestination(header.destinationIataCode)
        ? "Enter a valid UK arrival time (GMT/BST); skipped or repeated clock times cannot be used."
        : "Enter a valid scheduled arrival time in IST.");
    }
    if (new Date(arrivalAt) <= new Date(departureAt)) return toast.error("Arrival must be after departure.");
    const capacityKg = Number(flight.capacityKg);
    if (!Number.isFinite(capacityKg) || capacityKg <= 0) return toast.error("Enter a valid positive flight capacity.");
    if (flight.transitAirportCode.trim() && !flight.transitArrivalLocal && !flight.transitDepartureLocal) {
      return toast.error("Enter a transit arrival or departure time, or clear the transit airport.");
    }

    setSaving(true);
    try {
      const created = await createOperationsManifestWithFlight({
        branchId,
        header: {
          ...header,
          departureDate: flight.scheduledDepartureLocal.slice(0, 10),
        },
        flight: {
          airlineName: flight.airlineName.trim(),
          transitIataCode: flight.transitIataCode.trim().toUpperCase(),
          scheduledDepartureAt: departureAt,
          scheduledArrivalAt: arrivalAt,
          capacityKg,
          finalMileCarrier: flight.finalMileCarrier.trim(),
          connection: flight.transitAirportCode.trim()
            ? {
                transitAirportCode: flight.transitAirportCode.trim().toUpperCase(),
                scheduledArrivalAt: flight.transitArrivalLocal
                  ? indiaDateTimeLocalToIso(flight.transitArrivalLocal)
                  : null,
                scheduledDepartureAt: flight.transitDepartureLocal
                  ? indiaDateTimeLocalToIso(flight.transitDepartureLocal)
                  : null,
              }
            : null,
        },
      });
      toast.success(`${created.manifestNumber} and its booked flight were created.`);
      router.push(`/dashboard/operations-manifests/${created.manifestId}`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Manifest and flight could not be created.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
      <form onSubmit={submit} className="mx-start max-w-8xl">
        <div className="mb-6 rounded-xl border border-[#EEEDED] bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold text-[#0D1282]">Create Manifest &amp; Flight</h1>
          <p className="mt-1 text-sm text-slate-500">
            One submission creates the manifest, opens its first bag and books the linked flight. You can pack shipments after creation.
          </p>
        </div>

        <section className="overflow-hidden rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
          <div className="border-b border-[#EEEDED] bg-[#EEEDED]/70 px-6 py-4">
            <h2 className="font-semibold text-slate-700">Manifest routing</h2>
          </div>
          <div className="grid gap-5 p-6 md:grid-cols-2">
            <label className={labelClass}>
              Origin Branch *
              <SelectShell>
                <select
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  className={selectClass}
                >
                  <option value="">Select branch</option>
                  {branches.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.code})
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>

            <div className={labelClass}>
              MAWB Routing Country *
              <CountrySelect
                value={header.destinationCountryCode}
                onChange={(code, name) => {
                  field("destinationCountryCode", code);
                  field("destinationCountryName", name);
                }}
              />
            </div>

            <p className="-mt-3 text-xs normal-case text-slate-500 md:col-span-2">
              This is the shared flight or routing-hub country. Parcels for other final destination countries can still be packed and will be listed before sealing.
            </p>

            <label className={`${labelClass} md:col-span-2`}>
              Destination Agent Details *
              <textarea
                value={header.destinationAgent}
                onChange={(event) =>
                  field("destinationAgent", event.target.value)
                }
                rows={6}
                placeholder="Agent name, company, complete address and contact details"
                className="mt-2 w-full resize-y rounded-2xl border border-slate-300 p-3 text-sm normal-case text-slate-950 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]"
              />
            </label>

            <label className={labelClass}>
              Flight Number *
              <input
                value={header.flightNumber}
                onChange={(event) =>
                  field("flightNumber", normalizeFlightNumber(event.target.value))
                }
                placeholder="EY-219"
                className={controlClass}
              />
            </label>

            <label className={labelClass}>
              MAWB Number *
              <input
                value={header.mawbNumber}
                onChange={(event) =>
                  field("mawbNumber", event.target.value.toUpperCase())
                }
                placeholder="607-54691055"
                className={controlClass}
              />
            </label>

            <label className={labelClass}>
              Value Type *
              <SelectShell>
                <select
                  value={header.valueType}
                  onChange={(event) => field("valueType", event.target.value)}
                  className={selectClass}
                >
                  {valueTypeOptions.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>

            <label className={labelClass}>
              Origin IATA *
              <SelectShell>
                <select
                  value={header.originIataCode}
                  onChange={(event) =>
                    field("originIataCode", event.target.value)
                  }
                  className={selectClass}
                >
                  <option value="">Select origin airport</option>
                  {originIataOptions.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>

            <label className={labelClass}>
              Destination IATA *
              <SelectShell>
                <select
                  value={header.destinationIataCode}
                  onChange={(event) =>
                    field("destinationIataCode", event.target.value)
                  }
                  className={selectClass}
                >
                  <option value="">Select destination airport</option>
                  {destinationIataOptions.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>
          </div>
        </section>

        <section className="mt-5 overflow-hidden rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
          <div className="border-b border-[#EEEDED] bg-[#EEEDED]/70 px-6 py-4">
            <h2 className="font-semibold text-slate-700">Flight schedule</h2>
            <p className="mt-1 text-xs text-slate-600">Departure and transit use IST. Scheduled arrival uses local time at the destination airport (UK GMT/BST for UK airports; IST otherwise). Shipment destination countries do not restrict which consignments can use this flight.</p>
            <p className="mt-1 text-xs text-slate-600">After this manifest is dispatched, the flight changes to Departed automatically at the scheduled departure time. If a readiness check blocks it, Operations can still use the manual Depart action.</p>
          </div>
          <div className="grid gap-5 p-6 sm:grid-cols-2">
            <label className={labelClass}>
              Airline *
              <input required value={flight.airlineName} onChange={(event) => setFlight((current) => ({ ...current, airlineName: event.target.value }))} placeholder="Air India" className={controlClass} />
            </label>
            <label className={labelClass}>
              Flight capacity (kg) *
              <input required type="number" min="0.1" step="0.1" value={flight.capacityKg} onChange={(event) => setFlight((current) => ({ ...current, capacityKg: event.target.value }))} className={controlClass} />
            </label>
            <label className={labelClass}>
              Scheduled departure (IST) *
              <input required type="datetime-local" value={flight.scheduledDepartureLocal} onChange={(event) => setFlight((current) => ({ ...current, scheduledDepartureLocal: event.target.value }))} className={controlClass} />
            </label>
            <label className={labelClass}>
              Scheduled arrival ({flightArrivalTimeZoneLabel(header.destinationIataCode)}) *
              <input required type="datetime-local" value={flight.scheduledArrivalLocal} onChange={(event) => setFlight((current) => ({ ...current, scheduledArrivalLocal: event.target.value }))} className={controlClass} />
            </label>
            <label className={labelClass}>
              Transit IATA (optional)
              <input maxLength={3} value={flight.transitIataCode} onChange={(event) => setFlight((current) => ({ ...current, transitIataCode: event.target.value.toUpperCase() }))} placeholder="DXB" className={controlClass} />
            </label>
            <label className={labelClass}>
              Final-mile carrier (optional)
              <input value={flight.finalMileCarrier} onChange={(event) => setFlight((current) => ({ ...current, finalMileCarrier: event.target.value }))} placeholder="DPD UK" className={controlClass} />
            </label>
            <div className="rounded-xl border border-slate-200 p-4 sm:col-span-2">
              <p className="text-sm font-semibold text-slate-800">Transit connection (optional)</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <label className={labelClass}>
                  Transit airport
                  <input maxLength={3} value={flight.transitAirportCode} onChange={(event) => setFlight((current) => ({ ...current, transitAirportCode: event.target.value.toUpperCase() }))} placeholder="DXB" className={controlClass} />
                </label>
                <label className={labelClass}>
                  Transit arrival (IST)
                  <input type="datetime-local" value={flight.transitArrivalLocal} onChange={(event) => setFlight((current) => ({ ...current, transitArrivalLocal: event.target.value }))} className={controlClass} />
                </label>
                <label className={labelClass}>
                  Transit departure (IST)
                  <input type="datetime-local" value={flight.transitDepartureLocal} onChange={(event) => setFlight((current) => ({ ...current, transitDepartureLocal: event.target.value }))} className={controlClass} />
                </label>
              </div>
            </div>
            <p className="text-sm leading-6 text-slate-600 sm:col-span-2">
              The flight is booked when this form is submitted. Shipment allocations are made after the manifest is dispatched.
            </p>
          </div>
        </section>

        <div className="mt-5 flex justify-end gap-3">
          <Link
            href="/dashboard/operations-manifests"
            className="inline-flex h-11 items-center rounded-4xl border border-[#0D1282]/20 bg-white px-5 text-sm font-semibold text-[#0D1282]"
          >
            Cancel
          </Link>
          <button
            disabled={saving || !branchId}
            className="h-11 rounded-4xl bg-[#0D1282] tracking-wide px-6 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:opacity-60"
          >
            {saving ? "Creating manifest & flight..." : "Create Manifest & Flight"}
          </button>
        </div>
      </form>
  );
}
