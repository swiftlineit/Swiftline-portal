"use client";

import { useState } from "react";
import { FiAlertTriangle, FiCheckCircle, FiSearch, FiXCircle } from "react-icons/fi";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import CountryAutocomplete from "@/components/ui/CountryAutocomplete";
import { apiUrl } from "@/lib/api";
import { toCountryCode } from "@/lib/countryLookup";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { useClientUser } from "@/lib/useClientUser";

type ServiceabilityOption = {
  service: "COURIER" | "CARGO";
  serviceable: boolean;
  unavailableReason: string;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  transitBasis: "BUSINESS_DAYS" | "CALENDAR_DAYS" | null;
  viaCountryCodes: string[];
  maxBoxKg: number | null;
  maxWeightKg: number | null;
  weightExceedsBands: boolean;
  restrictions: string;
  notes: string;
};

type ServiceabilityResult = {
  destinationCountryCode: string;
  destinationPostcode: string;
  remoteArea: { checked: boolean; isRemote: boolean };
  options: ServiceabilityOption[];
};

async function check(params: URLSearchParams) {
  let token = getAccessToken() ?? await refreshAccessToken();
  const send = () => fetch(apiUrl(`/api/v1/client/serviceability?${params.toString()}`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (token) response = await send();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.message || "Serviceability could not be checked.");
  return data.result as ServiceabilityResult;
}

function transitLabel(option: ServiceabilityOption) {
  if (option.transitDaysMin === null || option.transitDaysMax === null) return "Not published";
  const unit = option.transitBasis === "BUSINESS_DAYS" ? "business days" : "calendar days";
  return option.transitDaysMin === option.transitDaysMax
    ? `${option.transitDaysMax} ${unit}`
    : `${option.transitDaysMin}–${option.transitDaysMax} ${unit}`;
}

/**
 * Whether Swiftline can carry a shipment, before one is created.
 *
 * Answers from the same records that price and schedule a real booking, so a
 * lane called unserviceable here would genuinely be refused at booking. Both
 * services are always listed, including those that cannot carry it and why-
 * omitting one silently leaves the customer unsure it was considered.
 */
export default function ServiceabilityPage() {
  const { user, loading } = useClientUser();
  // The typed text, not the code. The code is derived from it on submit, so the
  // box and the search can never disagree about which country was meant.
  const [country, setCountry] = useState("");
  const [postcode, setPostcode] = useState("");
  const [weight, setWeight] = useState("");
  const [result, setResult] = useState<ServiceabilityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (loading || !user) return <ClientDashboardLoading />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // A recognised country resolves to its code whatever was typed; anything
    // else is passed through as-is, so a country the portal does not list can
    // still be checked by its code against the rate cards and routes.
    const code = toCountryCode(country);
    if (code.length !== 2) {
      setError(
        country.trim()
          ? `“${country.trim()}” was not recognised. Pick a country from the list, or enter its two-letter code, for example GB.`
          : "Enter the destination country, or its two-letter code, for example GB."
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ destinationCountryCode: code });
      if (postcode.trim()) params.set("destinationPostcode", postcode.trim());
      if (weight.trim()) params.set("weightKg", weight.trim());
      setResult(await check(params));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Serviceability could not be checked.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-8xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-950">Serviceability Checker</h1>
        <p className="mt-1 text-sm text-slate-500">
          Check where Swiftline delivers, how long it takes, and what weight is accepted- before you book.
        </p>
      </div>

      <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,.8fr)_minmax(0,.65fr)_auto] xl:items-end">
          <CountryAutocomplete
            label="Destination country"
            value={country}
            onChange={setCountry}
            placeholder="Country or code"
          />

          <label className="block">
            <span className="text-xs font-semibold uppercase text-slate-600">Destination postcode</span>
            <input
              value={postcode}
              onChange={(event) => setPostcode(event.target.value)}
              maxLength={20}
              placeholder="Optional"
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase text-slate-600">Weight (kg)</span>
            <input
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              inputMode="decimal"
              placeholder="Optional"
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
            />
          </label>

          <button
            disabled={busy}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-950 px-5 text-sm font-semibold text-white transition hover:bg-blue-900 disabled:bg-slate-400 sm:col-span-2 xl:col-span-1"
          >
            <FiSearch aria-hidden="true" className="h-4 w-4" />
            {busy ? "Checking…" : "Check serviceability"}
          </button>
        </div>

        {error ? <p className="mt-3 text-sm font-semibold text-red-700">{error}</p> : null}
      </form>

      {result ? (
        <div className="mt-6">
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Remote area</p>
              <p className="mt-1 text-sm text-slate-700">
                {/* Three outcomes, not two: not knowing is different from knowing
                    it is not remote, and saying "No" to an unchecked postcode
                    would be a promise nothing supports. */}
                {!result.remoteArea.checked
                  ? "Not checked- enter a destination postcode, or no remote-area list is configured for this country."
                  : result.remoteArea.isRemote
                    ? "This postcode is a remote area. A remote area surcharge applies."
                    : "This postcode is not a remote area."}
              </p>
            </div>

            {result.remoteArea.checked ? (
              <span
                className={`inline-flex w-fit shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
                  result.remoteArea.isRemote
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {result.remoteArea.isRemote ? "Remote area" : "Not remote"}
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {result.options.map((option) => (
              <section
                key={option.service}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">
                      {option.service === "COURIER" ? "Courier" : "Cargo"}
                    </h2>
                    {option.unavailableReason ? (
                      <p className="mt-1 text-sm text-slate-500">{option.unavailableReason}</p>
                    ) : null}
                  </div>

                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                      option.serviceable
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    {option.serviceable ? (
                      <FiCheckCircle aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <FiXCircle aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {option.serviceable ? "Available" : "Not available"}
                  </span>
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Transit
                    </dt>
                    <dd className="mt-1 text-sm font-medium text-slate-800">{transitLabel(option)}</dd>
                  </div>

                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Max weight
                    </dt>
                    <dd className="mt-1 text-sm font-medium text-slate-800">
                      {option.maxWeightKg === null ? "Not published" : `${option.maxWeightKg} kg`}
                    </dd>
                  </div>

                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Per box
                    </dt>
                    <dd className="mt-1 text-sm font-medium text-slate-800">
                      {option.maxBoxKg === null ? "Not published" : `${option.maxBoxKg} kg`}
                    </dd>
                  </div>
                </dl>

                {option.viaCountryCodes.length ? (
                  <p className="mt-3 text-sm text-slate-600">
                    Routed via {option.viaCountryCodes.join(" → ")}.
                  </p>
                ) : null}

                {option.restrictions ? (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <FiAlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <p className="text-sm text-amber-900">{option.restrictions}</p>
                  </div>
                ) : null}

                {option.notes ? <p className="mt-3 text-sm text-slate-500">{option.notes}</p> : null}
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}