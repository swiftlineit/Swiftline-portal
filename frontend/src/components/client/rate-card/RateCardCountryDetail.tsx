"use client";

import { useMemo } from "react";
import CountryFlag from "@/components/CountryFlag";
import { panelSurface } from "@/components/dashboard/DashboardWidgets";
import { formatRate } from "@/components/client/rate-card/rateCardView";
import {
  countryRateServices,
  formatCountryRateService,
  rateCardDisplay,
  type ClientCountryRateCard,
  type ClientCountryRouteCharge,
  type CountryRateService
} from "@/lib/countryRateCards";

/**
 * Everything published for one destination.
 *
 * One table per service rather than a service column, because a customer is
 * shipping by one service and reading the other one's rows is noise. Route
 * charges sit beneath the rates they apply to, since a rate per kilogram is not
 * the price until the surcharges are counted.
 */
export default function RateCardCountryDetail({
  countryCode,
  countryName,
  rates,
  routeCharges
}: {
  countryCode: string;
  countryName: string;
  rates: ClientCountryRateCard[];
  routeCharges: ClientCountryRouteCharge[];
}) {
  const byService = useMemo(() => {
    return countryRateServices
      .map((service) => ({
        service,
        rates: rates
          .filter((rate) => rate.service === service)
          .sort((a, b) => a.fromKg - b.fromKg),
        routeCharge: routeCharges.find((charge) => charge.service === service)
      }))
      .filter((entry) => entry.rates.length);
  }, [rates, routeCharges]);

  const lowestRate = Math.min(...rates.map((rate) => rateCardDisplay(rate).amount));
  const heaviest = Math.max(...rates.map((rate) => rate.toKg));

  return (
    <div className="flex flex-col gap-5">
      <div className={`flex flex-wrap items-center justify-between gap-4 p-5 ${panelSurface}`}>
        <div className="flex items-center gap-3">
          <CountryFlag code={countryCode} size={32} />
          <div>
            <h2 className="text-xl font-semibold text-slate-950">{countryName}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {byService.map((entry) => formatCountryRateService(entry.service)).join(" and ")}
              {" · up to "}{heaviest} kg per box
            </p>
          </div>
        </div>
        <dl className="flex items-center divide-x divide-slate-200">
          <div className="px-4 text-center first:pl-0">
            <dd className="text-base font-semibold tabular-nums text-slate-900">{byService.length}</dd>
            <dt className="mt-0.5 text-[11px] font-medium text-slate-500">Services</dt>
          </div>
          <div className="px-4 text-center">
            <dd className="text-base font-semibold tabular-nums text-slate-900">{rates.length}</dd>
            <dt className="mt-0.5 text-[11px] font-medium text-slate-500">Weight slabs</dt>
          </div>
          <div className="pl-4 text-right">
            <dd className="text-lg font-semibold text-[#0D1282]">{formatRate(lowestRate)} <span className="text-sm font-medium text-slate-500">/ kg</span></dd>
            <dt className="mt-0.5 text-[11px] font-medium text-slate-500">Starting from</dt>
          </div>
        </dl>
      </div>

      {byService.map((entry) => (
        <ServiceRates key={entry.service} service={entry.service} rates={entry.rates} routeCharge={entry.routeCharge} />
      ))}

    </div>
  );
}

function ServiceRates({
  service,
  rates,
  routeCharge
}: {
  service: CountryRateService;
  rates: ClientCountryRateCard[];
  routeCharge: ClientCountryRouteCharge | undefined;
}) {
  const charges = routeCharge
    ? [
        routeCharge.fuelSurchargePercent ? `Fuel surcharge ${routeCharge.fuelSurchargePercent}%` : "",
        routeCharge.remoteAreaCharge ? `Remote area ${formatRate(routeCharge.remoteAreaCharge)}` : "",
        routeCharge.handlingCharge ? `Handling ${formatRate(routeCharge.handlingCharge)}` : "",
        // Insurance is switched off portal-wide and never charged, so it is not
        // quoted here.
        routeCharge.discountPercent ? `Discount ${routeCharge.discountPercent}%` : ""
      ].filter(Boolean)
    : [];

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{formatCountryRateService(service)}</h3>
        <span className="text-xs text-slate-500">{rates.length} weight slab{rates.length === 1 ? "" : "s"}</span>
      </header>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="border-b border-slate-100">
              <th className="px-5 py-2.5 font-semibold">Weight</th>
              <th className="px-5 py-2.5 font-semibold">Rate / KG</th>
              <th className="px-5 py-2.5 font-semibold">Max box</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate, index) => (
              <tr key={rate._id} className={index % 2 ? "bg-slate-50/50" : ""}>
                <td className="px-5 py-2.5 font-medium text-slate-800">
                  {rate.fromKg} - {rate.toKg} kg
                </td>
                <td className="px-5 py-2.5 font-semibold text-slate-950">
                  <div>{formatRate(rateCardDisplay(rate).amount)}</div>
                  <div className="text-[11px] font-medium text-slate-500">{rateCardDisplay(rate).label}</div>
                </td>
                <td className="px-5 py-2.5 text-slate-600">{rate.maxBoxKg} kg</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
        {charges.length ? (
          <span>
            <span className="font-semibold text-slate-800">Route charges: </span>
            {charges.join(" · ")}
          </span>
        ) : (
          "No additional route charges on this lane."
        )}
      </footer>
    </section>
  );
}
