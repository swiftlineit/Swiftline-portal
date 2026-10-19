"use client";

import { ChangeEvent, FormEvent, useEffect, useId, useState, type ReactNode } from "react";
import { FiSave } from "react-icons/fi";
import { confirmLeave, useUnsavedChanges } from "@/lib/useUnsavedChanges";
import { toast } from "react-toastify";
import {
  CountryRouteCharge,
  RateCardTarget,
  CountryRateService,
  countryRateServices,
  formatCountryRateService,
  listCountryRouteCharges,
  saveCountryRouteCharge
} from "@/lib/countryRateCards";

type FormState = {
  fuelSurchargePercent: string;
  remoteAreaCharge: string;
  remoteAreaPostcodes: string;
  handlingCharge: string;
  insurancePercent: string;
  insuranceMinimum: string;
  discountPercent: string;
};

// What an unconfigured route charges: nothing. Shown as blanks rather than zeros
// so it is obvious the route has never been configured.
const emptyForm: FormState = {
  fuelSurchargePercent: "",
  remoteAreaCharge: "",
  remoteAreaPostcodes: "",
  handlingCharge: "",
  insurancePercent: "",
  insuranceMinimum: "",
  discountPercent: ""
};

function toFormState(routeCharge: CountryRouteCharge | undefined): FormState {
  if (!routeCharge) return emptyForm;

  return {
    fuelSurchargePercent: String(routeCharge.fuelSurchargePercent),
    remoteAreaCharge: String(routeCharge.remoteAreaCharge),
    remoteAreaPostcodes: routeCharge.remoteAreaPostcodes.join(", "),
    handlingCharge: String(routeCharge.handlingCharge),
    insurancePercent: String(routeCharge.insurancePercent),
    insuranceMinimum: String(routeCharge.insuranceMinimum),
    discountPercent: String(routeCharge.discountPercent)
  };
}

/**
 * Surcharges, insurance and discount for the country selected in the weight
 * slab form above. Service targeting is deliberately independent so one set of
 * values can be applied to Courier, Cargo, or both.
 *
 * These are per route, not per slab: a fuel percentage set here applies to every
 * weight band for that country and service. Keeping it beside the slabs- rather
 * than on a screen of its own- means an operator setting up a new destination
 * sees both halves of what a shipment there will cost.
 */
export default function RouteChargesForm({
  countryCode,
  countryName,
  target,
  countryPicker,
  disabled = false,
  initialService = "COURIER",
  onSaved
}: {
  countryCode: string;
  countryName: string;
  target: RateCardTarget;
  countryPicker: ReactNode;
  disabled?: boolean;
  initialService?: CountryRateService;
  onSaved?: () => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [selectedServices, setSelectedServices] = useState<CountryRateService[]>([initialService]);
  const [routeCharges, setRouteCharges] = useState<Partial<Record<CountryRateService, CountryRouteCharge>>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [version, setVersion] = useState(0);
  const [baseline, setBaseline] = useState<FormState>(emptyForm);
  useUnsavedChanges(JSON.stringify(form) !== JSON.stringify(baseline), { label: "route charges" });

  // Reloads whenever the selection above changes, so the fields always describe
  // the route named in the heading, and again after a save so what is shown is
  // what was actually stored.
  useEffect(() => {
    let active = true;

    // Nothing to load until a country is chosen. The slab form above starts
    // empty, so this runs with no country on every fresh visit. Whatever the
    // fields hold meanwhile is never rendered- the component returns the
    // "select a country" prompt below instead- so there is no state to clear.
    if (!countryCode) return;

    async function loadRouteCharge() {
      setLoading(true);
      setError("");

      try {
        const result = await listCountryRouteCharges(target);
        if (!active) return;
        const nextCharges: Partial<Record<CountryRateService, CountryRouteCharge>> = {};
        for (const service of countryRateServices) {
          const routeCharge = result.routeCharges.find(
            (item) => item.countryCode === countryCode && item.service === service
          );
          if (routeCharge) nextCharges[service] = routeCharge;
        }
        setVersion(result.version ?? 0);
        setRouteCharges(nextCharges);
        const nextForm = toFormState(nextCharges[selectedServices[0]]);
        setForm(nextForm);
        setBaseline(nextForm);
      } catch (caughtError) {
        if (!active) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load route charges.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadRouteCharge();

    return () => {
      active = false;
    };
  }, [target, countryCode, reloadKey, selectedServices]);

  function handleInput(field: keyof FormState) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };
  }

  function toggleService(service: CountryRateService) {
    if (!confirmLeave(JSON.stringify(form) !== JSON.stringify(baseline))) return;
    setSelectedServices((current) => {
      if (current.includes(service)) {
        const next = current.length === 1 ? current : current.filter((item) => item !== service);
        setForm(toFormState(routeCharges[next[0]]));
        return next;
      }
      const next = [...current, service];
      setForm(toFormState(routeCharges[next[0]]));
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedServices.length) {
      toast.error("Select at least one service for these route charges.");
      return;
    }
    setBusy(true);
    setError("");

    try {
      // Blank fields mean "do not charge this", which is zero to the pricing engine.
      const result = await saveCountryRouteCharge({
          ...target,
          expectedVersion: version,
          countryCode,
          service: selectedServices[0],
          services: selectedServices,
          fuelSurchargePercent: Number(form.fuelSurchargePercent) || 0,
          remoteAreaCharge: Number(form.remoteAreaCharge) || 0,
          remoteAreaPostcodes: form.remoteAreaPostcodes,
          handlingCharge: Number(form.handlingCharge) || 0,
          insurancePercent: Number(form.insurancePercent) || 0,
          insuranceMinimum: Number(form.insuranceMinimum) || 0,
          discountPercent: Number(form.discountPercent) || 0
        });
      setVersion(result.version);
      setBaseline(form);
      toast.success(`Route charges saved for ${countryName} (${selectedServices.map(formatCountryRateService).join(" and ")}).`);
      setReloadKey((current) => current + 1);
      onSaved?.();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Route charges could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Route charges" className="mb-6 rounded-xl border border-slate-200 bg-white">
      <div className="grid gap-4 border-b border-slate-100 p-4 sm:p-5 lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">{countryPicker}</div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{countryCode ? `Route charges for ${countryName}` : "Configure route charges"}</h2>
          <p className="mt-1 text-sm leading-5 text-slate-600">
            {countryCode ? "These settings apply to every weight slab for this destination." : "Choose a destination to configure its Courier and Cargo charges."}
          </p>
        </div>
        {countryCode ? (
          <button
            type="submit"
            form={formId}
            disabled={disabled || busy || loading}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:cursor-not-allowed disabled:bg-slate-400 sm:w-auto"
          >
            <FiSave aria-hidden="true" className="h-4 w-4" />
            {busy ? "Saving…" : "Save Route Charges"}
          </button>
        ) : null}
      </div>

      {countryCode ? (
        <form id={formId} onSubmit={handleSubmit} className="p-4 sm:p-5">
          {error ? (
            <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {error}
            </p>
          ) : null}

          <fieldset disabled={disabled || loading} className="min-w-0">
            <legend className="sr-only">Route charges for {countryName}</legend>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-slate-100 pb-4">
              <span className="text-sm font-semibold text-slate-800">Apply to services</span>
              {countryRateServices.map((serviceOption) => (
                <label key={serviceOption} className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={selectedServices.includes(serviceOption)}
                    onChange={() => toggleService(serviceOption)}
                    className="h-4 w-4 accent-blue-900"
                  />
                  {formatCountryRateService(serviceOption)}
                </label>
              ))}
              <span className="text-xs text-slate-600">The same values will be saved for each selected service.</span>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
              <ChargeInput
                label="Fuel Surcharge %"
                hint="Percentage of base freight"
                value={form.fuelSurchargePercent}
                onChange={handleInput("fuelSurchargePercent")}
                max={100}
              />
              <ChargeInput
                label="Remote Area Charge"
                hint="Flat, on matching postcodes"
                value={form.remoteAreaCharge}
                onChange={handleInput("remoteAreaCharge")}
              />
              <ChargeInput
                label="Handling Charge"
                hint="Flat, once per shipment"
                value={form.handlingCharge}
                onChange={handleInput("handlingCharge")}
              />
              {/*
                Insurance is switched off portal-wide while the product is unfinished.
                Keep its stored values unchanged so the route configuration survives.
              */}
              <ChargeInput
                label="Discount %"
                hint="Off all GST-inclusive charges"
                value={form.discountPercent}
                onChange={handleInput("discountPercent")}
                max={100}
              />
            </div>

            <label className="mt-5 block border-t border-slate-100 pt-4">
              <span className="text-sm font-semibold text-slate-800">Remote Area Postcodes</span>
              <span className="mt-1 block max-w-4xl text-xs leading-5 text-slate-600">
                Enter prefixes separated by commas or new lines. A destination is remote when its postcode starts with one, so &quot;HS&quot; covers a region and &quot;HS12AB&quot; a single delivery point.
              </span>
              <textarea
                value={form.remoteAreaPostcodes}
                onChange={handleInput("remoteAreaPostcodes")}
                rows={2}
                placeholder="HS, IV41, ZE"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium uppercase text-slate-900 outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-900/15"
              />
            </label>
            <p className="mt-4 text-xs leading-5 text-slate-600">
              Charges and discounts apply only to this rate card, destination, and selected services.
            </p>
          </fieldset>
        </form>
      ) : (
        <p className="px-4 py-5 text-sm text-slate-600 sm:px-5">
          Select a country above to configure its fuel surcharge, remote area, and handling charges.
        </p>
      )}
    </section>
  );
}

function ChargeInput({
  label,
  hint,
  value,
  onChange,
  max
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  max?: number;
}) {
  return (
    <label>
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      <input
        type="number"
        min="0"
        max={max}
        step="0.01"
        value={value}
        onChange={onChange}
        placeholder="0"
        className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-900 outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-900/15"
      />
      <span className="mt-1 block text-xs text-slate-500">{hint}</span>
    </label>
  );
}
