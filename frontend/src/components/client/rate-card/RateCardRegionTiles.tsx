"use client";

import { FiArrowRight } from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import { panelSurface } from "@/components/dashboard/DashboardWidgets";
import { formatRate, type Region } from "@/components/client/rate-card/rateCardView";

/**
 * The top level of the rate card: where do you ship to.
 *
 * A region tile carries the flags of the destinations behind it, so the grouping
 * is legible without being opened- somebody looking for Belgium can see it is
 * inside Europe rather than having to guess.
 */
export default function RateCardRegionTiles({
  regions,
  onSelect
}: {
  regions: Region[];
  onSelect: (regionCode: string) => void;
}) {
  // No grid of its own: the page lays these tiles out next to the summary
  // list, so the wrapper dissolves and the tiles become the grid's items.
  return (
    <div className="contents">
      {regions.map(({ region, destinations, lowestRate }) => {
        const shownFlags = destinations.slice(0, 6);
        const remaining = destinations.length - shownFlags.length;

        return (
          <button
            key={region.code}
            type="button"
            onClick={() => onSelect(region.code)}
            className={`group flex flex-col justify-between gap-4 p-5 text-left transition duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_2px_6px_rgba(15,23,42,0.05),0_20px_44px_-22px_rgba(13,18,130,0.40)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 ${panelSurface}`}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold text-slate-900 transition-colors duration-200 group-hover:text-[#0D1282]">
                {region.label}
              </h3>
              <span className="shrink-0 rounded-full bg-[#0D1282]/10 px-2.5 py-1 text-[11px] font-bold text-[#0D1282]">
                {destinations.length}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {shownFlags.map((destination) => (
                <CountryFlag key={destination.countryCode} code={destination.countryCode} size={16} />
              ))}
              {remaining > 0 ? (
                <span className="text-[11px] font-semibold text-slate-400">+{remaining} more</span>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200/70 pt-3">
              <span className="text-xs text-slate-500">
                From <span className="font-semibold text-slate-900">{formatRate(lowestRate)}</span> / kg
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-[#0D1282] transition-all duration-200 group-hover:border-[#0D1282] group-hover:bg-[#0D1282] group-hover:text-white">
                <FiArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
