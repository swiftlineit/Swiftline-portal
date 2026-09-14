"use client";

import { useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiChevronRight } from "react-icons/fi";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import RateCardSearch from "@/components/client/rate-card/RateCardSearch";
import RateCardRegionTiles from "@/components/client/rate-card/RateCardRegionTiles";
import RateCardCountryGrid from "@/components/client/rate-card/RateCardCountryGrid";
import RateCardCountryDetail from "@/components/client/rate-card/RateCardCountryDetail";
import RateCardNotCovered from "@/components/client/rate-card/RateCardNotCovered";
import {
  buildDestinations,
  buildRegions,
  formatRate
} from "@/components/client/rate-card/rateCardView";
import { countryName } from "@/lib/countries";
import { rateCardRegionLabel } from "@/lib/rateCardRegions";
import {
  listClientCountryRateCards,
  rateCardDisplay,
  type ClientCountryRateCard,
  type ClientCountryRouteCharge,
} from "@/lib/countryRateCards";
import { useClientUser } from "@/lib/useClientUser";
import { getClientDashboard } from "@/lib/clientDashboard";

/**
 * The customer's assigned rate card, browsed rather than scrolled.
 *
 * An assigned card is one row per country, service and weight slab, so a card
 * covering the European lanes runs to nine hundred rows. Presented flat, the
 * question every customer actually arrives with- what does it cost to send
 * five kilos to Belgium- is buried. So the card is entered by region, narrowed
 * to a destination, and searchable from anywhere in that path.
 */
type View =
  | { kind: "regions" }
  | { kind: "region"; code: string }
  | { kind: "country"; iso2: string };

export default function ClientRateCardPage() {
  const { user, loading: userLoading } = useClientUser();
  const [rates, setRates] = useState<ClientCountryRateCard[]>([]);
  const [routeCharges, setRouteCharges] = useState<ClientCountryRouteCharge[]>([]);
  const [assigned, setAssigned] = useState(false);
  const [canRequestQuote, setCanRequestQuote] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ kind: "regions" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (userLoading || !user) return;
    let active = true;

    void getClientDashboard()
      .then((dashboard) => {
        if (active) {
          // The same roles the sidebar uses to show "Get Live Quote", so the
          // uncovered-destination call to action never points somewhere this
          // member cannot open.
          setCanRequestQuote(
            dashboard.accounts.some((item) =>
              ["account_owner", "account_admin", "operations", "finance"].includes(
                item.membership.role,
              ),
            ),
          );
        }

        const requestedAccountId = new URLSearchParams(
          window.location.search,
        ).get("businessAccountId");
        const account =
          dashboard.accounts.find(
            (item) => item.account.id === requestedAccountId,
          ) ?? dashboard.accounts[0];
        if (!account)
          throw new Error("Business account access is not available.");
        return listClientCountryRateCards(account.account.id);
      })
      .then((result) => {
        if (!active) return;
        setRates(result.rates);
        setRouteCharges(result.routeCharges);
        setAssigned(result.rateCardAssigned);
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Your rate card could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user, userLoading]);

  const destinations = useMemo(() => buildDestinations(rates), [rates]);
  const regions = useMemo(() => buildRegions(destinations), [destinations]);
  const coveredCodes = useMemo(
    () => new Set(destinations.map((destination) => destination.countryCode)),
    [destinations],
  );

  const totals = useMemo(() => {
    if (!rates.length) return null;
    return {
      destinations: destinations.length,
      slabs: rates.length,
      lowestRate: Math.min(...rates.map((rate) => rateCardDisplay(rate).amount)),
    };
  }, [rates, destinations]);

  const activeRegion = view.kind === "region"
    ? regions.find((entry) => entry.region.code === view.code)
    : undefined;

  const countryRates = view.kind === "country"
    ? rates.filter((rate) => rate.countryCode === view.iso2)
    : [];

  if (userLoading || !user) return <ClientDashboardLoading />;

  // Same visibility rule the body uses below, so the search lives in the
  // header without appearing in loading, unassigned or empty states.
  const showSearch = !loading && assigned && rates.length > 0;

  return (
    <div className="mx-auto flex max-w-8xl flex-col gap-5">
      <header className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-end lg:gap-8">
          <div className="order-1 min-w-0">
            {/* <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0D1282]">
              Rate card
            </p> */}
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-slate-900 sm:text-2xl">
              Your Swiftline Rate Card
            </h1>
            <p className="mt-1.5 text-sm leading-6 text-slate-500">
              Your current destinations, weight slabs and applicable route charges.
            </p>
          </div>

          {showSearch ? (
            <div className="order-2 min-w-0 flex-1 lg:ml-auto lg:max-w-md xl:max-w-lg">
              <RateCardSearch
                value={query}
                onChange={setQuery}
                onSelect={(countryCode) => setView({ kind: "country", iso2: countryCode })}
                coveredCodes={coveredCodes}
              />
            </div>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}

      {!loading && !assigned ? (
        <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
          <FiAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">
              Shipment booking is paused for your account.
            </p>
            <p className="mt-1 text-sm">
              A rate card has not been assigned yet. Please contact Swiftline
              support.
            </p>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm font-semibold text-[#0D1282]">
          Loading your rate card...
        </div>
      ) : null}

      {!loading && assigned && !rates.length ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          No destination rates are currently available on your assigned card.
          Pricing remains blocked for uncovered routes.
        </p>
      ) : null}

      {!loading && assigned && rates.length ? (
        <>
          <Breadcrumb view={view} onNavigate={setView} />

          {view.kind === "regions" ? (
            <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {totals ? <StatsList rows={totalRows(totals)} /> : null}
              <RateCardRegionTiles
                regions={regions}
                onSelect={(code) => setView({ kind: "region", code })}
              />
            </div>
          ) : null}

          {view.kind === "region" ? (
            activeRegion ? (
              <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {totals ? <StatsList rows={totalRows(totals)} /> : null}
                <RateCardCountryGrid
                  destinations={activeRegion.destinations}
                  onSelect={(countryCode) => setView({ kind: "country", iso2: countryCode })}
                />
              </div>
            ) : (
              <>
                {totals ? <StatsList rows={totalRows(totals)} /> : null}
                <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
                  This region is no longer on your card.
                </p>
              </>
            )
          ) : null}

          {view.kind === "country" ? (
            countryRates.length ? (
              <RateCardCountryDetail
                countryCode={view.iso2}
                countryName={countryRates[0]?.countryName ?? countryName(view.iso2)}
                rates={countryRates}
                routeCharges={routeCharges.filter((charge) => charge.countryCode === view.iso2)}
              />
            ) : (
              <RateCardNotCovered
                countryCode={view.iso2}
                countryName={countryName(view.iso2)}
                canRequestQuote={canRequestQuote}
              />
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function totalRows(totals: { destinations: number; slabs: number; lowestRate: number }) {
  return [
    { label: "Destinations", value: String(totals.destinations) },
    { label: "Weight slabs", value: String(totals.slabs) },
    { label: "Starting from", value: `${formatRate(totals.lowestRate)} / kg` },
  ];
}

function StatsList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl aria-label="Rate card summary" className="flex flex-col self-stretch rounded-xl border border-slate-200 bg-white px-5 py-2">
      <div className="flex flex-1 flex-col divide-y divide-slate-100">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-1 items-center justify-between gap-3 py-2.5">
            <dt className="text-xs font-medium text-slate-500">{row.label}</dt>
            <dd className="truncate text-sm font-semibold tabular-nums text-slate-900">{row.value}</dd>
          </div>
        ))}
      </div>
    </dl>
  );
}

function Breadcrumb({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  if (view.kind === "regions") return null;

  const destinationName = view.kind === "country" ? countryName(view.iso2) : "";

  return (
    <nav aria-label="Rate card location" className="flex flex-wrap items-center gap-1.5 text-sm">
      <button
        type="button"
        onClick={() => onNavigate({ kind: "regions" })}
        className="font-semibold text-[#0D1282] hover:underline"
      >
        All destinations
      </button>

      {view.kind === "region" ? (
        <>
          <FiChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-semibold text-slate-700">{rateCardRegionLabel(view.code)}</span>
        </>
      ) : null}

      {view.kind === "country" ? (
        <>
          <FiChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-semibold text-slate-700">{destinationName}</span>
        </>
      ) : null}
    </nav>
  );
}
