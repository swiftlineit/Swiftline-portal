"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowUpRight, FiSearch } from "react-icons/fi";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import {
  getOperatorShipmentDetails,
  listOperatorClientBookedShipments,
  listOperatorStaffBookedShipments,
  type OperatorShipmentDetails
} from "@/lib/operatorShipments";
import type { ShipmentListItem } from "@/lib/shipmentsList";

type TrackingMatch = {
  id: string;
  trackingNumber: string;
  consignee: string;
  destination: string;
  status: string;
  createdAt: string;
  parcelCount: number;
  businessAccountName: string;
};

function humanize(value?: string | null) {
  if (!value) return "Shipment booked";
  if (value === "LABEL_RECEIVED" || value === "SHIPMENT_BOOKED") return "Shipment booked";
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function statusTone(status: string) {
  const normalized = status.toUpperCase();
  if (normalized.includes("DELIVERED")) return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (normalized.includes("CANCEL") || normalized.includes("RETURN")) return "bg-rose-50 text-rose-800 ring-rose-200";
  if (normalized.includes("HOLD") || normalized.includes("EXCEPTION")) return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-sky-50 text-sky-900 ring-sky-200";
}

function clientMatch(row: ShipmentListItem): TrackingMatch | null {
  const trackingNumber = row.swiftlineTrackingNumber || row.awbNumbers?.[0] || "";
  if (!trackingNumber) return null;
  return {
    id: row.id,
    trackingNumber,
    consignee: row.consignee || "Consignee not provided",
    destination: [row.destination, row.destinationCountry].filter((value, index, values) => value && values.indexOf(value) === index).join(", ") || "Destination not provided",
    status: row.statusLabel || humanize(row.status),
    createdAt: row.createdAt || "",
    parcelCount: row.pieces || row.awbNumbers?.length || 0,
    businessAccountName: row.businessAccountName || ""
  };
}

function staffMatch(row: Awaited<ReturnType<typeof listOperatorStaffBookedShipments>>["shipments"][number]): TrackingMatch | null {
  const trackingNumber = row.shipment?.swiftlineTrackingNumber || row.shipment?.parcelNumbers?.[0] || "";
  if (!trackingNumber) return null;
  const consignee = row.draft.consigneeEnteredAddress;
  const destination = [consignee.townOrCity, consignee.countryName || consignee.countryCode]
    .filter(Boolean)
    .join(", ");
  return {
    id: row.draft._id,
    trackingNumber,
    consignee: consignee.companyName || consignee.contactName || "Consignee not provided",
    destination: destination || "Destination not provided",
    status: row.currentEvent?.status ? humanize(row.currentEvent.status) : humanize(row.shipment?.status),
    createdAt: row.shipment?.createdAt || row.draft.createdAt,
    parcelCount: row.shipment?.parcelNumbers?.length || row.draft.parcelCount || 0,
    businessAccountName: row.businessAccountName || ""
  };
}

export default function OperatorTrackingPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [matches, setMatches] = useState<TrackingMatch[]>([]);
  const [selected, setSelected] = useState<TrackingMatch | null>(null);
  const [shipment, setShipment] = useState<OperatorShipmentDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const detailsRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then((result) => {
      if (active) setSession(result);
    }).catch((cause: unknown) => {
      if (!active) return;
      const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
      if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/tracking`);
        return;
      }
      setSearchError(cause instanceof Error ? cause.message : "Unable to verify operator workspace access.");
    }).finally(() => { if (active) setSessionLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, router]);

  useEffect(() => () => detailsRequest.current?.abort(), []);

  const events = useMemo(() => [...(shipment?.events ?? [])]
    .sort((left, right) => new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime()), [shipment]);
  const currentStatus = shipment?.currentEvent?.statusLabel
    || shipment?.currentEvent?.status
    || events[0]?.statusLabel
    || events[0]?.status
    || (shipment?.dpdShipment ? humanize(shipment.dpdShipment.status) : selected?.status)
    || "Shipment booked";
  const parcelWeights = shipment?.shipmentDraft.parcelList?.map((parcel) => parcel.weightKg).filter(Number.isFinite) ?? [];
  const totalWeightKg = parcelWeights.length ? parcelWeights.reduce((total, weight) => total + weight, 0) : null;

  async function loadDetails(match: TrackingMatch, client: boolean) {
    detailsRequest.current?.abort();
    const controller = new AbortController();
    detailsRequest.current = controller;
    setSelected(match);
    setShipment(null);
    setDetailsError("");
    setDetailsLoading(true);
    try {
      const result = await getOperatorShipmentDetails(operatorSlug, match.id, client, controller.signal);
      if (!controller.signal.aborted) setShipment(result.shipment);
    } catch (cause) {
      if (!controller.signal.aborted) setDetailsError(cause instanceof Error ? cause.message : "Shipment tracking details could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setDetailsLoading(false);
    }
  }

  async function searchShipments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trackingNumber = query.trim();
    if (!trackingNumber || !session) {
      setSearchError("Enter a tracking or parcel number.");
      return;
    }

    setSearching(true);
    setSearchError("");
    setDetailsError("");
    detailsRequest.current?.abort();
    setDetailsLoading(false);
    setMatches([]);
    setSelected(null);
    setShipment(null);
    try {
      const results = session.membership.role === "CLIENT"
        ? (await listOperatorClientBookedShipments(operatorSlug, { page: 1, pageSize: 20, search: trackingNumber }))
          .shipments.map(clientMatch).filter((match): match is TrackingMatch => match !== null)
        : (await listOperatorStaffBookedShipments(operatorSlug, { page: 1, pageSize: 20, search: trackingNumber }))
          .shipments.map(staffMatch).filter((match): match is TrackingMatch => match !== null);
      setMatches(results);
      if (!results.length) {
        setSearchError("No booked shipment matched that number in this workspace.");
      } else if (results.length === 1) {
        await loadDetails(results[0], session.membership.role === "CLIENT");
      }
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : "Shipment tracking could not be searched.");
    } finally {
      setSearching(false);
    }
  }

  if (sessionLoading) return <OperatorPageLoading label="Checking workspace access…" />;

  const client = session?.membership.role === "CLIENT";

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-950 sm:text-3xl">Track a shipment</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Search by tracking or parcel number to view its latest status and history.</p>
        </header>

        <section aria-label="Shipment tracking search" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
          <form onSubmit={(event) => void searchShipments(event)} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label htmlFor="operator-tracking-search" className="min-w-0 text-sm font-semibold text-slate-800">
              AWB, sender or recipient name
              <span className="relative mt-1.5 block">
                <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="operator-tracking-search"
                  autoComplete="off"
                  maxLength={80}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Enter an AWB, sender name, or recipient name"
                  className="min-h-11 w-full rounded-md border border-slate-300 bg-white py-2 pl-10 pr-3 text-sm font-normal text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
                />
              </span>
            </label>
            <button type="submit" disabled={searching || !session} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-wait disabled:opacity-55">
              <FiSearch aria-hidden="true" className="h-4 w-4" />{searching ? "Searching…" : "Track shipment"}
            </button>
          </form>
          {searchError ? <p role="alert" className="mt-3 text-sm font-medium text-rose-700">{searchError}</p> : null}
        </section>

        {matches.length > 1 ? <section aria-labelledby="tracking-matches-heading" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="tracking-matches-heading" className="font-semibold text-slate-950">Matching shipments</h2><p className="mt-1 text-sm text-slate-600">Choose the shipment you want to follow.</p></div>
          <ul className="divide-y divide-slate-200">
            {matches.map((match) => <li key={match.id}>
              <button type="button" onClick={() => void loadDetails(match, Boolean(client))} className="grid w-full min-w-0 gap-2 px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#0D1282] sm:grid-cols-[minmax(10rem,1.2fr)_minmax(10rem,1fr)_minmax(8rem,1fr)_auto] sm:items-center sm:gap-4 sm:px-5">
                <span className="min-w-0"><span className="block truncate font-semibold text-slate-950">{match.trackingNumber}</span>{match.businessAccountName ? <span className="mt-0.5 block truncate text-xs text-slate-500">{match.businessAccountName}</span> : null}</span>
                <span className="min-w-0"><span className="block truncate text-sm text-slate-800">{match.consignee}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{match.destination}</span></span>
                <span className="text-sm text-slate-600">{match.status}</span>
                <span className="text-xs tabular-nums text-slate-500">{formatDate(match.createdAt)}</span>
              </button>
            </li>)}
          </ul>
        </section> : null}

        {detailsError ? <p role="alert" className="rounded-md border border-rose-200 bg-white px-4 py-3 text-sm font-medium text-rose-700">{detailsError}</p> : null}
        {detailsLoading ? <div role="status" className="flex min-h-56 items-center justify-center rounded-lg border border-slate-200 bg-white px-5 py-8 text-sm font-medium text-slate-600">Loading tracking history…</div> : null}

        {selected && shipment && !detailsLoading ? <section aria-labelledby="tracking-result-heading" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AWB / tracking number</p>
              <h2 id="tracking-result-heading" className="mt-1 break-all text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">{shipment.dpdShipment?.swiftlineTrackingNumber || selected.trackingNumber}</h2>
              <p className="mt-1.5 text-sm text-slate-600">Booked {formatDate(shipment.dpdShipment?.createdAt || selected.createdAt)}</p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
              <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments/${encodeURIComponent(selected.id)}`} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                View shipment details <FiArrowUpRight aria-hidden="true" className="h-4 w-4" />
              </Link>
              <span className={`inline-flex min-h-9 w-fit shrink-0 items-center rounded-full px-3 text-sm font-semibold ring-1 ring-inset ${statusTone(currentStatus)}`}>{shipment.currentEvent?.statusLabel || humanize(currentStatus)}</span>
            </div>
          </div>

          <div className="grid gap-0 border-b border-slate-200 sm:grid-cols-2 sm:divide-x sm:divide-slate-200 lg:grid-cols-4">
            <div className="px-4 py-4 sm:px-6"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Consignee</p><p className="mt-1 break-words font-medium text-slate-900">{shipment.shipmentDraft.consignee.companyName || shipment.shipmentDraft.consignee.contactName || selected.consignee}</p></div>
            <div className="border-t border-slate-200 px-4 py-4 sm:border-t-0 sm:px-6"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Destination</p><p className="mt-1 break-words font-medium text-slate-900">{[shipment.shipmentDraft.consignee.townOrCity, shipment.shipmentDraft.consignee.countryName || shipment.shipmentDraft.consignee.countryCode].filter(Boolean).join(", ") || selected.destination}</p></div>
            <div className="border-t border-slate-200 px-4 py-4 sm:px-6 lg:border-t-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parcels</p><p className="mt-1 font-medium tabular-nums text-slate-900">{shipment.shipmentDraft.parcelCount || selected.parcelCount || 0}</p></div>
            <div className="border-t border-slate-200 px-4 py-4 sm:px-6 lg:border-t-0 lg:border-l"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total weight</p><p className="mt-1 font-medium tabular-nums text-slate-900">{totalWeightKg === null ? "—" : `${totalWeightKg.toFixed(2)} kg`}</p></div>
          </div>

          <div className="px-4 py-5 sm:px-6 sm:py-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-base font-semibold text-slate-950">Tracking history</h3>{events.length ? <span className="text-xs text-slate-500">Newest update first</span> : null}</div>
            {events.length ? <ol aria-label="Shipment tracking events" className="mt-5 space-y-0">
              {events.map((event, index) => {
                const current = index === 0;
                const last = index === events.length - 1;
                return <li key={event.id} className="relative grid grid-cols-[0.625rem_minmax(0,1fr)] gap-x-4 pb-6 last:pb-0">
                  {!last ? <span aria-hidden="true" className="absolute left-[3px] top-3 -bottom-1 w-px bg-sky-200" /> : null}
                  <span aria-hidden="true" className={`absolute left-0 top-1 z-10 h-2 w-2 rounded-full ${current ? "bg-emerald-500 ring-4 ring-emerald-100 shadow-[0_1px_8px_rgba(34,197,94,0.5)]" : "bg-sky-300 ring-4 ring-sky-50"}`} />
                  <div className="col-start-2 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <h4 className={`min-w-0 font-semibold ${current ? "text-slate-950" : "text-slate-800"}`}>{event.statusLabel || humanize(event.status)}</h4>
                    <time dateTime={event.eventAt} className="shrink-0 text-xs tabular-nums text-slate-500">{formatDate(event.eventAt)}</time>
                  </div>
                  {event.note ? <p className="col-start-2 mt-1 min-w-0 break-words text-sm leading-5 text-slate-600">{event.note}</p> : null}
                  {event.location ? <p className="col-start-2 mt-1 min-w-0 break-words text-xs leading-5 text-slate-500">{event.location}</p> : null}
                </li>;
              })}
            </ol> : <p className="mt-4 rounded-md bg-slate-50 px-4 py-4 text-sm text-slate-600">No tracking updates have been recorded yet.</p>}
          </div>
        </section> : null}
      </main>
    </div>
  );
}
