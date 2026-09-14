"use client";

import { FiArrowRight } from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import { formatCountryRateService } from "@/lib/countryRateCards";
import { formatRate, type Destination } from "@/components/client/rate-card/rateCardView";

/** The destinations inside one region, each with its cheapest published rate. */
export default function RateCardCountryGrid({
  destinations,
  onSelect
}: {
  destinations: Destination[];
  onSelect: (countryCode: string) => void;
}) {
  // No grid of its own: the page lays these cards out next to the summary
  // list, so the wrapper dissolves and the cards become the grid's items.
  return (
    <div className="contents">
      {destinations.map((destination) => (
        <button
          key={destination.countryCode}
          type="button"
          onClick={() => onSelect(destination.countryCode)}
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#0D1282]/25 hover:shadow-[0_10px_26px_-18px_rgba(13,18,130,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/20"
        >
          <div className="flex items-center gap-2.5">
            <CountryFlag code={destination.countryCode} size={20} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900 transition-colors duration-200 group-hover:text-[#0D1282]">
              {destination.countryName}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {destination.services.map((service) => (
              <span
                key={service}
                className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
              >
                {formatCountryRateService(service)}
              </span>
            ))}
          </div>

          <div className="mt-auto flex items-end justify-between gap-2">
            <span className="text-xs text-slate-500">
              From <span className="font-semibold text-slate-900">{formatRate(destination.lowestRate)}</span> / kg
            </span>
            <FiArrowRight
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-[#0D1282]"
            />
          </div>
        </button>
      ))}
    </div>
  );
}
