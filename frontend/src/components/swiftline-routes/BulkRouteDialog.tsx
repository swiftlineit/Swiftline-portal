"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FiAlertTriangle, FiCheckCircle, FiX } from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import { countryRateServices, formatCountryRateService, type CountryRateService } from "@/lib/countryRateCards";
import {
  bulkSaveSwiftlineRoutes,
  routeTransitBases,
  routeTransitBasisLabels,
  trackingProfileLabels,
  trackingProfiles,
  type BulkRouteOutcome,
  type RouteTransitBasis,
  type TrackingProfileSetting
} from "@/lib/swiftlineRoutes";

/**
 * Opens many lanes from one set of details.
 *
 * A rate list opens thirty destinations at once, and each of them needs a lane
 * before Swiftline can quote a transit time or show the real origin hub on the
 * customer tracking page. Entered one at a time that is the same twelve fields
 * typed sixty times, and the fields that genuinely differ per lane- transit
 * stops, restrictions- are the ones an operator wants to revisit afterwards
 * anyway. So this writes the shared details, and every lane stays individually
 * editable in the form behind it.
 */

/** One destination offered for bulk routing, with what it already has. */
export type BulkRouteCandidate = {
  countryCode: string;
  countryName: string;
  /** Services the destination has rates for but no lane. */
  missingServices: CountryRateService[];
  /** Services it already has a lane for. */
  existingServices: CountryRateService[];
};

type Result = {
  message: string;
  created: BulkRouteOutcome[];
  updated: BulkRouteOutcome[];
  skipped: BulkRouteOutcome[];
};

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-70 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <FiX aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

const labelClass = "text-xs font-semibold uppercase text-slate-500";
const inputClass = "mt-2 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-blue-900";

export default function BulkRouteDialog({
  candidates,
  onClose,
  onSaved
}: {
  candidates: BulkRouteCandidate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => candidates.map((entry) => entry.countryCode));
  const [services, setServices] = useState<CountryRateService[]>(["COURIER"]);
  const [transitDaysMin, setTransitDaysMin] = useState("10");
  const [transitDaysMax, setTransitDaysMax] = useState("12");
  const [transitBasis, setTransitBasis] = useState<RouteTransitBasis>("BUSINESS_DAYS");
  const [trackingProfile, setTrackingProfile] = useState<TrackingProfileSetting>("AUTO");
  const [originHubName, setOriginHubName] = useState("Delhi Hub");
  const [cutOffTime, setCutOffTime] = useState("");
  const [restrictions, setRestrictions] = useState("");
  const [notes, setNotes] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const chosen = useMemo(
    () => candidates.filter((entry) => selected.includes(entry.countryCode)),
    [candidates, selected]
  );

  // What this save would actually do, split the way the server will split it.
  const plan = useMemo(() => {
    let create = 0;
    let overwrite = 0;

    for (const entry of chosen) {
      for (const service of services) {
        if (entry.existingServices.includes(service)) overwrite += 1;
        else create += 1;
      }
    }

    return { create, overwrite };
  }, [chosen, services]);

  const min = Number(transitDaysMin);
  const max = Number(transitDaysMax);
  const transitValid = Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min && max <= 120;
  const blocked = !chosen.length || !services.length || !transitValid || originHubName.trim().length < 2;

  function toggleCountry(countryCode: string) {
    setSelected((current) =>
      current.includes(countryCode)
        ? current.filter((entry) => entry !== countryCode)
        : [...current, countryCode]
    );
    setOverwriteExisting(false);
  }

  async function handleSave() {
    if (blocked) return;

    setBusy(true);
    setError("");

    try {
      const saved = await bulkSaveSwiftlineRoutes({
        destinations: chosen.map((entry) => ({
          countryCode: entry.countryCode,
          countryName: entry.countryName
        })),
        services,
        overwriteExisting,
        details: {
          viaCountryCodes: [],
          transitDaysMin: min,
          transitDaysMax: max,
          transitBasis,
          trackingProfile,
          originHubName: originHubName.trim(),
          serviceable: true,
          cutOffTime: cutOffTime.trim(),
          restrictions: restrictions.trim(),
          notes: notes.trim()
        }
      });

      setResult({
        message: saved.message,
        created: saved.created,
        updated: saved.updated,
        skipped: saved.skipped
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The lanes could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Shell title="Lanes updated" onClose={onClose}>
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-900">
            <FiCheckCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">{result.message}</p>
              <p className="mt-1 text-sm">
                Transit stops and per-lane restrictions can now be set on each route individually.
              </p>
            </div>
          </div>

          {result.skipped.length ? (
            <div className="rounded-2xl border border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold uppercase text-slate-500">Left as they were</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                These already had a lane, and the replace box was not ticked:{" "}
                {result.skipped.map((entry) => `${entry.countryName} (${formatCountryRateService(entry.service)})`).join(", ")}.
              </p>
            </div>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-4xl bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0a0e66]"
            >
              Done
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Open lanes in bulk" onClose={onClose}>
      <div className="flex flex-col gap-5">
        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {error}
          </p>
        ) : null}

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={labelClass}>Destinations</span>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-500">{chosen.length} of {candidates.length} selected</span>
              <button
                type="button"
                onClick={() => setSelected(candidates.map((entry) => entry.countryCode))}
                className="font-semibold text-[#0D1282] hover:underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setSelected([])}
                className="font-semibold text-slate-500 hover:underline"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="mt-2 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-xl border border-slate-200 p-2 sm:grid-cols-2">
            {candidates.map((entry) => {
              const isSelected = selected.includes(entry.countryCode);
              return (
                <label
                  key={entry.countryCode}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition ${
                    isSelected ? "bg-[#0D1282]/[0.08] text-slate-900" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleCountry(entry.countryCode)}
                    className="h-4 w-4 accent-[#0D1282]"
                  />
                  <CountryFlag code={entry.countryCode} />
                  <span className="min-w-0 flex-1 truncate">{entry.countryName}</span>
                  {entry.existingServices.length ? (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                      has a lane
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className={labelClass}>Service</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {countryRateServices.map((service) => {
                const isSelected = services.includes(service);
                return (
                  <button
                    key={service}
                    type="button"
                    onClick={() => {
                      setServices((current) =>
                        current.includes(service)
                          ? current.filter((entry) => entry !== service)
                          : [...current, service]
                      );
                      setOverwriteExisting(false);
                    }}
                    className={`inline-flex h-10 items-center rounded-full border px-4 text-xs font-semibold transition ${
                      isSelected
                        ? "border-[#0D1282] bg-[#0D1282]/10 text-[#0D1282]"
                        : "border-slate-300 text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {formatCountryRateService(service)}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className={labelClass}>Origin hub</span>
            <input
              required
              maxLength={120}
              value={originHubName}
              onChange={(event) => setOriginHubName(event.target.value)}
              className={inputClass}
            />
            <span className="mt-1 block text-[11px] leading-4 text-slate-500">
              Named on the customer tracking page as &ldquo;Received at Origin Facility {originHubName.trim() || "..."}&rdquo;.
            </span>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className={labelClass}>Transit days (min)</span>
            <input
              type="number"
              min="1"
              max="120"
              value={transitDaysMin}
              onChange={(event) => setTransitDaysMin(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Transit days (max)</span>
            <input
              type="number"
              min="1"
              max="120"
              value={transitDaysMax}
              onChange={(event) => setTransitDaysMax(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Counted as</span>
            <select
              value={transitBasis}
              onChange={(event) => setTransitBasis(event.target.value as RouteTransitBasis)}
              className={inputClass}
            >
              {routeTransitBases.map((basis) => (
                <option key={basis} value={basis}>{routeTransitBasisLabels[basis]}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Tracking flow</span>
            <select
              value={trackingProfile}
              onChange={(event) => setTrackingProfile(event.target.value as TrackingProfileSetting)}
              className={inputClass}
            >
              {trackingProfiles.map((profile) => (
                <option key={profile} value={profile}>{trackingProfileLabels[profile]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Cut-off time (optional)</span>
            <input
              placeholder="16:30"
              maxLength={5}
              value={cutOffTime}
              onChange={(event) => setCutOffTime(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block">
          <span className={labelClass}>Restrictions (optional)</span>
          <input
            maxLength={1000}
            value={restrictions}
            onChange={(event) => setRestrictions(event.target.value)}
            placeholder="Applied to every lane selected above"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className={labelClass}>Internal notes (optional)</span>
          <input
            maxLength={1000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Never shown to customers"
            className={inputClass}
          />
        </label>

        {!transitValid ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
            Give a transit range between 1 and 120 days, with the maximum at or above the minimum.
          </p>
        ) : null}

        {plan.overwrite ? (
          <label className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(event) => setOverwriteExisting(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#0D1282]"
            />
            <span>
              <span className="font-semibold">
                Replace the details on {plan.overwrite} lane{plan.overwrite === 1 ? "" : "s"} that already exist.
              </span>
              <span className="mt-0.5 block text-xs leading-5">
                Their transit times, hub and tracking flow are overwritten with the values above. Leave this
                unticked to add only the {plan.create} missing lane{plan.create === 1 ? "" : "s"}.
              </span>
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-xs text-slate-500">
            {plan.create ? `${plan.create} lane${plan.create === 1 ? "" : "s"} will be added` : "No new lanes"}
            {plan.overwrite
              ? overwriteExisting
                ? `, ${plan.overwrite} replaced`
                : `, ${plan.overwrite} left as ${plan.overwrite === 1 ? "it is" : "they are"}`
              : ""}
            .
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-4xl border border-slate-300 px-5 text-sm font-semibold text-slate-700 hover:border-slate-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || blocked || (!plan.create && !overwriteExisting)}
              className="h-10 rounded-4xl bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {busy ? "Saving..." : "Open lanes"}
            </button>
          </div>
        </div>

        {!chosen.length ? (
          <p className="flex items-center gap-2 text-xs font-semibold text-amber-700">
            <FiAlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            Select at least one destination.
          </p>
        ) : null}
      </div>
    </Shell>
  );
}
