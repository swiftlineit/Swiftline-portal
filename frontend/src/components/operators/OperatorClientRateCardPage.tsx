"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FiAlertTriangle, FiChevronRight } from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import RateCardSearch from "@/components/client/rate-card/RateCardSearch";
import RateCardRegionTiles from "@/components/client/rate-card/RateCardRegionTiles";
import RateCardCountryGrid from "@/components/client/rate-card/RateCardCountryGrid";
import RateCardCountryDetail from "@/components/client/rate-card/RateCardCountryDetail";
import { buildDestinations, buildRegions, formatRate } from "@/components/client/rate-card/rateCardView";
import { countryName } from "@/lib/countries";
import { rateCardRegionLabel } from "@/lib/rateCardRegions";
import { listClientCountryRateCards, rateCardDisplay, type ClientCountryRateCard, type ClientCountryRouteCharge } from "@/lib/countryRateCards";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";

type View = { kind: "regions" } | { kind: "region"; code: string } | { kind: "country"; iso2: string };

export default function OperatorClientRateCardPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [rates, setRates] = useState<ClientCountryRateCard[]>([]);
  const [routeCharges, setRouteCharges] = useState<ClientCountryRouteCharge[]>([]);
  const [assigned, setAssigned] = useState(false);
  const [title, setTitle] = useState("Your rate card");
  const [sessionLoading, setSessionLoading] = useState(true);
  const [rateLoading, setRateLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ kind: "regions" });
  const [countryQuery, setCountryQuery] = useState("");

  useEffect(() => {
    let active = true;
    getOperatorSession(operatorSlug).then((session) => {
      if (!active) return;
      if (session.membership.role !== "CLIENT") {
        setError("Rate cards are available to operator business account clients.");
        setRateLoading(false);
        return;
      }
      setOperator(session);
    }).catch((cause: unknown) => {
      if (!active) return;
      const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
      if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/rate-card`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to verify operator access.");
      setRateLoading(false);
    }).finally(() => { if (active) setSessionLoading(false); });
    return () => { active = false; };
  }, [operatorSlug, router]);

  useEffect(() => {
    if (!operator || operator.membership.role !== "CLIENT") return;
    let active = true;
    listClientCountryRateCards(undefined, operatorSlug).then((result) => {
      if (!active) return;
      setRates(result.rates);
      setRouteCharges(result.routeCharges);
      setAssigned(result.rateCardAssigned);
      setTitle(result.title);
      setView({ kind: "regions" });
      setCountryQuery("");
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to load this rate card.");
    }).finally(() => { if (active) setRateLoading(false); });
    return () => { active = false; };
  }, [operator, operatorSlug]);

  const destinations = useMemo(() => buildDestinations(rates), [rates]);
  const regions = useMemo(() => buildRegions(destinations), [destinations]);
  const coveredCodes = useMemo(() => new Set(destinations.map((destination) => destination.countryCode)), [destinations]);
  const totals = useMemo(() => rates.length ? {
    destinations: destinations.length,
    slabs: rates.length,
    lowestRate: Math.min(...rates.map((rate) => rateCardDisplay(rate).amount))
  } : null, [rates, destinations]);
  const activeRegion = view.kind === "region" ? regions.find((entry) => entry.region.code === view.code) : undefined;
  const countryRates = view.kind === "country" ? rates.filter((rate) => rate.countryCode === view.iso2) : [];
  const showSearch = !rateLoading && assigned && rates.length > 0;

  if (sessionLoading) return <OperatorPageLoading label="Checking operator access…" />;

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <header className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-col gap-5 px-5 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1><p className="mt-1.5 text-sm leading-6 text-slate-600">View the destinations, weight slabs and route charges configured by your operator.</p></div>
            {showSearch ? <div className="min-w-0 flex-1 lg:max-w-md"><RateCardSearch value={countryQuery} onChange={setCountryQuery} onSelect={(iso2) => setView({ kind: "country", iso2 })} coveredCodes={coveredCodes} /></div> : null}
          </div>
        </header>

        {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
        {rateLoading ? <p role="status" className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm font-semibold text-[#0D1282]">Loading rate card…</p> : null}
        {!rateLoading && operator && !assigned ? <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-900"><FiAlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-semibold">Shipment booking is paused for your account.</p><p className="mt-1 text-sm">{operator.operator.companyName || "Your operator"} has not configured your business account’s rate card yet.</p></div></div> : null}
        {!rateLoading && assigned && !rates.length ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">No destination rates are available on this account’s card yet. Ask your operator administrator about pricing coverage.</p> : null}

        {!rateLoading && assigned && rates.length ? <>
          {view.kind !== "regions" ? <nav aria-label="Rate card location" className="flex flex-wrap items-center gap-1.5 text-sm"><button type="button" onClick={() => setView({ kind: "regions" })} className="font-semibold text-[#0D1282] hover:underline">All destinations</button>{view.kind === "region" ? <><FiChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" /><span className="font-semibold text-slate-700">{rateCardRegionLabel(view.code)}</span></> : null}{view.kind === "country" ? <><FiChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" /><span className="font-semibold text-slate-700">{countryName(view.iso2)}</span></> : null}</nav> : null}
          {view.kind === "regions" ? <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">{totals ? <StatsList rows={[{ label: "Destinations", value: String(totals.destinations) }, { label: "Weight slabs", value: String(totals.slabs) }, { label: "Starting from", value: `${formatRate(totals.lowestRate)} / kg` }]} /> : null}<RateCardRegionTiles regions={regions} onSelect={(code) => setView({ kind: "region", code })} /></div> : null}
          {view.kind === "region" ? activeRegion ? <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4"><StatsList rows={[{ label: "Destinations", value: String(totals?.destinations ?? 0) }, { label: "Weight slabs", value: String(totals?.slabs ?? 0) }, { label: "Starting from", value: `${formatRate(totals?.lowestRate ?? 0)} / kg` }]} /><RateCardCountryGrid destinations={activeRegion.destinations} onSelect={(iso2) => setView({ kind: "country", iso2 })} /></div> : <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">This region is no longer on your card.</p> : null}
          {view.kind === "country" ? countryRates.length ? <RateCardCountryDetail countryCode={view.iso2} countryName={countryRates[0]?.countryName ?? countryName(view.iso2)} rates={countryRates} routeCharges={routeCharges.filter((charge) => charge.countryCode === view.iso2)} /> : <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white px-6 py-10 text-center"><CountryFlag code={view.iso2} size={28} /><h2 className="text-lg font-semibold text-slate-900">No rate published for {countryName(view.iso2)}</h2><p className="max-w-lg text-sm leading-6 text-slate-600">Contact {operator?.operator.companyName || "your operator"} to confirm pricing for this destination.</p></div> : null}
        </> : null}
      </main>
    </div>
  );
}

function StatsList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return <dl aria-label="Rate card summary" className="flex flex-col self-stretch rounded-xl border border-slate-200 bg-white px-5 py-2"><div className="flex flex-1 flex-col divide-y divide-slate-100">{rows.map((row) => <div key={row.label} className="flex flex-1 items-center justify-between gap-3 py-2.5"><dt className="text-xs font-medium text-slate-500">{row.label}</dt><dd className="truncate text-sm font-semibold tabular-nums text-slate-900">{row.value}</dd></div>)}</div></dl>;
}
