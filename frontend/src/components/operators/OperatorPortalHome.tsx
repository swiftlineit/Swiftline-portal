"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FiArrowRight,
  FiCreditCard,
  FiMapPin,
  FiMessageSquare,
  FiPlus
} from "react-icons/fi";
import type { IconType } from "react-icons";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { getOperatorHome, type OperatorHomeData } from "@/lib/operatorHome";
import { loadOperatorBannerImage } from "@/lib/operatorSettings";

const panel = "min-w-0 rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)]";
const number = (value: number) => new Intl.NumberFormat("en-IN").format(value);
const money = (minor: number, currency = "INR") => new Intl.NumberFormat("en-IN", {
  style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(minor / 100);
const dayLabel = (value: string) => new Date(`${value}T12:00:00.000Z`).toLocaleDateString("en-IN", {
  day: "numeric", month: "short", timeZone: "Asia/Kolkata"
});
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata"
}) : "—";
const titleCase = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

type Tone = "indigo" | "teal" | "amber" | "sky";
type KpiItem = { label: string; value: string; hint: string; tone: Tone; detail?: string };

const toneStyles: Record<Tone, { value: string }> = {
  indigo: { value: "text-indigo-800" },
  teal: { value: "text-teal-800" },
  amber: { value: "text-amber-800" },
  sky: { value: "text-sky-800" }
};

function Action({ href, icon: Icon, children, primary = false }: {
  href: string; icon: IconType; children: React.ReactNode; primary?: boolean;
}) {
  return <Link href={href} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] ${primary ? "border-[#0D1282] bg-[#0D1282] text-white hover:bg-[#171D70]" : "border-slate-300 bg-white text-[#0D1282] hover:bg-slate-50"}`}>
    <Icon aria-hidden="true" className="size-4" />{children}
  </Link>;
}

function KpiCard({ item }: { item: KpiItem }) {
  const style = toneStyles[item.tone];
  return <article className={`${panel} relative isolate overflow-hidden p-4 sm:p-5`}>
    <p className={`break-words text-[clamp(1.55rem,2.2vw,2rem)] font-semibold leading-tight tracking-tight tabular-nums ${style.value}`}>{item.value}</p>
    <h2 className="mt-2 text-sm font-semibold text-slate-900">{item.label}</h2>
    {item.detail
      ? <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">{item.detail}</p>
      : <p className="mt-1 text-xs leading-5 text-slate-500">{item.hint}</p>}
  </article>;
}

function FeatureCarousel({
  banners,
  images,
  canManage,
  settingsHref
}: {
  banners: OperatorHomeData["banners"];
  images: Record<string, string>;
  canManage: boolean;
  settingsHref: string;
}) {
  const [index, setIndex] = useState(0);
  const safeBanners = banners ?? [];
  const usable = safeBanners.filter((banner) => images[banner.id]);
  const activeIndex = usable.length ? index % usable.length : 0;
  useEffect(() => {
    if (usable.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % usable.length), 6500);
    return () => window.clearInterval(timer);
  }, [usable.length]);

  const current = usable[activeIndex];

  return <section aria-label="Workspace banner carousel" className={`${panel} flex min-h-64 flex-col overflow-hidden sm:min-h-72 lg:min-h-full`}>
    {current ? <div className="relative min-h-48 flex-1 sm:min-h-56"><Image src={images[current.id]} alt={current.heading || "Workspace banner"} fill unoptimized sizes="(max-width: 1024px) 100vw, 40vw" className="object-cover" /></div> : <div aria-hidden="true" className="min-h-48 flex-1 bg-slate-100 sm:min-h-56" />}
    {current?.heading || current?.description ? <div className="space-y-1 px-5 py-4 sm:px-6">
      {current.heading ? <h2 className="text-lg font-semibold leading-snug text-slate-950">{current.heading}</h2> : null}
      {current.description ? <p className="text-sm leading-6 text-slate-600">{current.description}</p> : null}
    </div> : null}
    {!safeBanners.length && canManage ? <div className="border-t border-slate-200 px-5 py-3 sm:px-6">
      <Link href={settingsHref} className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-[#0D1282] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><span>Add a banner</span><FiArrowRight aria-hidden="true" className="size-4" /></Link>
    </div> : null}
    {usable.length > 1 ? <div role="group" aria-label="Choose workspace banner" className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 sm:px-6">
      {usable.map((banner, dotIndex) => <button key={banner.id} type="button" onClick={() => setIndex(dotIndex)} aria-label={`Show banner ${dotIndex + 1}`} aria-current={activeIndex === dotIndex ? "true" : undefined} className={`h-2 rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] ${activeIndex === dotIndex ? "w-6 bg-[#0D1282]" : "w-2 bg-slate-300 hover:bg-slate-500"}`} />)}
    </div> : null}
  </section>;
}

function BookingTrend({ rows }: { rows: OperatorHomeData["trend"] }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return <section className={`${panel} p-5 sm:p-6`} aria-labelledby="booking-trend-title">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 id="booking-trend-title" className="text-lg font-semibold text-slate-950">Booking activity</h2><p className="mt-1 text-sm text-slate-500">Daily bookings over the last 14 days</p></div>
      <p className="text-lg font-semibold tabular-nums text-[#0D1282]">{number(total)} <span className="text-sm font-medium text-slate-500">shipments</span></p>
    </div>
    <div className="mt-6 overflow-x-auto pb-1 [scrollbar-width:thin]"><div className="flex h-40 min-w-[500px] items-end gap-2" role="img" aria-label="Daily shipment bookings for the last 14 days">
      {rows.map((row, index) => <div key={row.day} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2">
        <span className="sr-only">{dayLabel(row.day)}: {number(row.count)} bookings</span>
        <div title={`${dayLabel(row.day)}: ${number(row.count)} bookings`} className="flex h-[122px] w-full items-end overflow-hidden rounded-t-md bg-slate-50"><div className={`w-full rounded-t-md transition-colors ${row.count ? "bg-indigo-600 group-hover:bg-[#0D1282]" : "bg-slate-200"}`} style={{ height: `${row.count ? Math.max(5, row.count / max * 100) : 3}%` }} /></div>
        <span className="whitespace-nowrap text-[11px] text-slate-500">{index % 2 === 0 || index === rows.length - 1 ? dayLabel(row.day) : ""}</span>
      </div>)}
    </div></div>
    {!total ? <p className="mt-2 text-sm text-slate-500">No shipments were booked in this period.</p> : null}
  </section>;
}

function AccountDonut({ rows }: { rows: NonNullable<OperatorHomeData["accountStatuses"]> }) {
  const palette = ["#0D1282", "#3F55B9", "#78A3E1", "#0F766E", "#F59E0B", "#94A3B8"];
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const stops = rows.filter((row) => row.count > 0).reduce<{ cursor: number; stops: string[] }>((result, row, index) => {
    const next = result.cursor + row.count / Math.max(1, total) * 100;
    return { cursor: next, stops: [...result.stops, `${palette[index % palette.length]} ${result.cursor}% ${next}%`] };
  }, { cursor: 0, stops: [] }).stops;
  const ring = stops.length ? `conic-gradient(${stops.join(",")})` : "conic-gradient(#e2e8f0 0% 100%)";

  return <section className={`${panel} p-5 sm:p-6`}>
    <div><h2 className="text-lg font-semibold text-slate-950">Business accounts</h2><p className="mt-1 text-sm text-slate-500">Current review status</p></div>
    <div className="mt-5 flex flex-wrap items-center justify-center gap-6 sm:justify-start">
      <div className="relative grid size-36 shrink-0 place-items-center rounded-full" style={{ background: ring }} role="img" aria-label={`${number(total)} business accounts by status`}>
        <div className="grid size-[5.25rem] place-items-center rounded-full bg-white text-center"><div><p className="text-xl font-semibold tabular-nums text-slate-950">{number(total)}</p><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Accounts</p></div></div>
      </div>
      <ul className="min-w-[9rem] flex-1 space-y-2.5">
        {rows.filter((row) => row.count > 0).map((row) => {
          const color = palette[rows.filter((item) => item.count > 0).findIndex((item) => item.status === row.status) % palette.length];
          return <li key={row.status} className="flex items-center justify-between gap-3 text-sm"><span className="flex min-w-0 items-center gap-2 text-slate-600"><span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><span className="truncate">{titleCase(row.status)}</span></span><strong className="tabular-nums text-slate-900">{number(row.count)}</strong></li>;
        })}
        {!total ? <li className="text-sm text-slate-500">No business accounts yet.</li> : null}
      </ul>
    </div>
  </section>;
}

function CreditUsage({ credit }: { credit: NonNullable<OperatorHomeData["credit"]> }) {
  const percent = credit.creditLimitMinor > 0 ? Math.min(100, Math.round(credit.usedCreditMinor / credit.creditLimitMinor * 100)) : 0;
  return <section className={`${panel} p-5 sm:p-6`}>
    <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-800"><FiCreditCard aria-hidden="true" /></span><div><h2 className="text-lg font-semibold text-slate-950">Credit usage</h2><p className="mt-1 text-sm text-slate-500">Approved limit currently committed</p></div></div>
    <div className="mt-5 flex items-end justify-between gap-3"><p className="text-3xl font-semibold tracking-tight text-[#0D1282]">{percent}%</p><p className="text-sm text-slate-500">of {money(credit.creditLimitMinor)}</p></div>
    <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label="Credit usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="h-full rounded-full bg-indigo-600" style={{ width: `${percent}%` }} /></div>
    <div className="mt-5 flex justify-between gap-3 border-t border-slate-100 pt-4 text-sm"><span className="text-slate-600">Committed credit</span><strong className="text-slate-900">{money(credit.usedCreditMinor)}</strong></div>
  </section>;
}

function shipmentTone(status: string) {
  if (["DELIVERED", "SHIPMENT_CANCELLED", "RETURNED"].includes(status)) return "bg-emerald-50 text-emerald-800 ring-emerald-600/20";
  if (["ON_HOLD", "LOST", "DAMAGED"].includes(status)) return "bg-rose-50 text-rose-800 ring-rose-600/20";
  if (["IN_TRANSIT", "OUT_FOR_DELIVERY", "DESTINATION_ARRIVED"].includes(status)) return "bg-sky-50 text-sky-800 ring-sky-600/20";
  return "bg-indigo-50 text-indigo-800 ring-indigo-600/20";
}

function RecentShipments({ rows, base, client }: { rows: OperatorHomeData["recentShipments"]; base: string; client: boolean }) {
  return <section className={`${panel} overflow-hidden`}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
      <div><h2 className="text-lg font-semibold text-slate-950">Recent shipments</h2><p className="mt-0.5 text-sm text-slate-500">{client ? "Your latest bookings" : "Latest bookings across accessible branches"}</p></div>
      <Link href={`${base}/shipments`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-[#0D1282] hover:bg-indigo-50">All shipments <FiArrowRight aria-hidden="true" /></Link>
    </div>
    {rows.length ? <>
      <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[920px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600"><tr><th scope="col" className="px-5 py-3">AWB</th><th scope="col" className="px-5 py-3">Consignee</th><th scope="col" className="px-5 py-3">Parcels</th><th scope="col" className="px-5 py-3">Amount</th><th scope="col" className="px-5 py-3">Status</th><th scope="col" className="px-5 py-3">Created</th><th scope="col" className="px-5 py-3">Actions</th></tr></thead>
        <tbody className="divide-y divide-slate-200">{rows.map((shipment) => <tr key={shipment.id} className="hover:bg-slate-50/70">
          <td className="max-w-[17rem] px-5 py-4"><Link href={`${base}/shipments/${encodeURIComponent(shipment.id)}`} className="block truncate font-semibold tabular-nums text-[#0D1282] hover:underline">{shipment.awb}</Link><p className="mt-1 truncate text-xs text-slate-500" title={shipment.accountName}>{shipment.accountName}</p></td>
          <td className="max-w-[17rem] px-5 py-4"><p className="truncate font-medium text-slate-900" title={shipment.consignee}>{shipment.consignee}</p><p className="mt-1 truncate text-xs text-slate-500" title={shipment.destinationCountry}>{shipment.destinationCountry}</p></td>
          <td className="whitespace-nowrap px-5 py-4 text-slate-700">{number(shipment.parcelCount)}</td>
          <td className="whitespace-nowrap px-5 py-4 font-semibold tabular-nums text-slate-900">{money(shipment.bookingAmountMinor, shipment.currency)}</td>
          <td className="px-5 py-4"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${shipmentTone(shipment.status)}`}>{titleCase(shipment.status)}</span></td>
          <td className="whitespace-nowrap px-5 py-4 tabular-nums text-slate-600">{dateLabel(shipment.bookedAt)}</td>
          <td className="px-5 py-4"><Link href={`${base}/shipments/${encodeURIComponent(shipment.id)}`} className="font-semibold text-[#0D1282] underline-offset-2 hover:underline">Details</Link></td>
        </tr>)}</tbody>
      </table></div>
      <ul className="divide-y divide-slate-200 md:hidden">{rows.map((shipment) => <li key={shipment.id} className="space-y-3 px-4 py-4">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><Link href={`${base}/shipments/${encodeURIComponent(shipment.id)}`} className="break-all font-semibold tabular-nums text-[#0D1282]">{shipment.awb}</Link><p className="mt-1 truncate text-xs text-slate-500">{shipment.accountName}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${shipmentTone(shipment.status)}`}>{titleCase(shipment.status)}</span></div>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm"><dt className="text-slate-500">Consignee</dt><dd className="break-words text-slate-800">{shipment.consignee}<span className="block text-xs text-slate-500">{shipment.destinationCountry}</span></dd><dt className="text-slate-500">Parcels</dt><dd className="text-slate-800">{number(shipment.parcelCount)}</dd><dt className="text-slate-500">Amount</dt><dd className="font-semibold tabular-nums text-slate-800">{money(shipment.bookingAmountMinor, shipment.currency)}</dd><dt className="text-slate-500">Created</dt><dd className="text-slate-700">{dateLabel(shipment.bookedAt)}</dd></dl>
        <Link href={`${base}/shipments/${encodeURIComponent(shipment.id)}`} className="inline-flex min-h-9 items-center font-semibold text-[#0D1282]">Shipment details <FiArrowRight className="ml-1" aria-hidden="true" /></Link>
      </li>)}</ul>
    </> : <p className="px-5 py-12 text-center text-sm text-slate-500">No shipments have been booked in this workspace yet.</p>}
  </section>;
}

export default function OperatorPortalHome({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [home, setHome] = useState<OperatorHomeData | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [bannerImages, setBannerImages] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.all([getOperatorSession(operatorSlug, controller.signal), getOperatorHome(operatorSlug, controller.signal)]).then(([currentSession, data]) => {
      if (active) { setSession(currentSession); setHome(data); setError(""); }
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load this workspace.");
    });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, refreshKey, router]);

  useEffect(() => {
    if (!home?.banners?.length) return;
    let active = true;
    const controller = new AbortController();
    let urls: string[] = [];
    void Promise.allSettled(home.banners.map((banner) => loadOperatorBannerImage(operatorSlug, banner.id, controller.signal))).then((results) => {
      const loaded = results.flatMap((result, index) => result.status === "fulfilled" ? [[home.banners[index]!.id, result.value] as const] : []);
      urls = loaded.map(([, url]) => url);
      if (active) setBannerImages(Object.fromEntries(loaded));
      else urls.forEach((url) => URL.revokeObjectURL(url));
    });
    return () => { active = false; controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [home?.banners, operatorSlug]);

  if (!session && !error) return <OperatorPageLoading label="Loading workspace overview" />;
  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const pageShell = "mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8";
  if (error || !session || !home) return <main className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] py-6 sm:py-8"><div className={pageShell}><div role="alert" className={`${panel} p-5 sm:p-7`}><h1 className="text-xl font-semibold text-slate-950">Workspace overview unavailable</h1><p className="mt-2 text-sm text-slate-600">{error}</p><button onClick={() => setRefreshKey((key) => key + 1)} type="button" className="mt-4 rounded-lg bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white">Try again</button></div></div></main>;

  const role = session.membership.role;
  const client = role === "CLIENT";
  const finance = role === "FINANCE";
  const readOnly = session.access.readOnly;
  const canManageBanners = !readOnly && (role === "OPERATOR_ADMIN" || role === "OPERATIONS");
  const operations = home.operations;
  const kpis: KpiItem[] = client ? [
    { label: "My shipments", value: number(home.shipmentCount), hint: "All booked shipments", detail: `${number(home.bookedToday)} today`, tone: "indigo" },
    { label: "Booked this month", value: number(home.bookedThisMonth), hint: "Bookings since the start of this month", tone: "teal" },
    { label: "Available to book", value: home.credit ? money(home.credit.availableCapacityMinor) : "—", hint: home.credit ? "Credit and advance balance" : "Available with financial access", tone: "sky" },
    { label: "Amount owed", value: home.credit ? money(home.credit.totalOwedMinor) : "—", hint: home.credit ? "Unbilled and invoiced charges" : "Available with financial access", tone: "amber" }
  ] : finance && home.finance ? [
    { label: "Active credit accounts", value: number(home.finance.activeCreditAccounts), hint: "Facilities currently active", tone: "indigo" },
    { label: "Credit reviews", value: number(home.finance.pendingCreditReviews), hint: "Requests awaiting a decision", tone: "amber" },
    { label: "Total owed", value: money(home.finance.outstandingMinor), hint: "Unbilled and invoiced credit", tone: "sky" },
    { label: "Overdue", value: money(home.finance.overdueMinor), hint: `${number(home.finance.overdueStatements)} unpaid statements past due`, tone: "amber" }
  ] : [
    { label: "Booked today", value: number(home.bookedToday), hint: "New bookings today", detail: `${number(home.shipmentCount)} total bookings`, tone: "indigo" },
    { label: "In transit", value: number(home.inTransit), hint: "Latest tracking event shows movement", tone: "teal" },
    { label: "Amendments & cancellations", value: number(operations?.pendingChanges ?? 0), hint: `${number(operations?.pendingAmendments ?? 0)} amendments · ${number(operations?.pendingCancellations ?? 0)} cancellations`, tone: "amber" },
    { label: "Client queries", value: number(operations?.queriesThisWeek ?? 0), hint: "Received in the last 7 days", tone: "sky" }
  ];

  return <main className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
    <div className={`${pageShell} space-y-5 sm:space-y-6`}>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{client ? "My workspace" : finance ? "Finance overview" : "Workspace overview"}</h1><p className="mt-1 text-sm text-slate-600">{client ? "Your shipments and account at a glance." : finance ? "Credit balances and payment priorities for your branches." : "Shipments and client activity across your workspace."}</p></div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {!readOnly && !finance ? <Action href={`${base}/shipments/new`} icon={FiPlus} primary>Create shipment</Action> : null}
          {!readOnly ? <Action href={`${base}/tracking`} icon={FiMapPin}>Track shipment</Action> : null}
          {client && !readOnly ? <Action href={`${base}/contact`} icon={FiMessageSquare}>Contact us</Action> : null}
        </div>
      </header>

      <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.9fr)] lg:items-stretch" aria-label="Workspace overview">
        <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4">
          {kpis.map((item) => <KpiCard key={item.label} item={item} />)}
        </div>
        <FeatureCarousel banners={home.banners ?? []} images={bannerImages} canManage={canManageBanners} settingsHref={`${base}/settings`} />
      </section>

      {client ? <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.8fr)]">
        <BookingTrend rows={home.trend} />
        {home.credit ? <CreditUsage credit={home.credit} /> : <section className={`${panel} flex min-h-52 flex-col justify-between p-5 sm:p-6`}><div><h2 className="text-lg font-semibold text-slate-950">Your account</h2><p className="mt-2 text-sm leading-6 text-slate-600">Your shipment activity is shown here. Credit details are available to account members with financial access.</p></div><Link href={`${base}/rate-card`} className="mt-5 inline-flex w-fit items-center gap-1 text-sm font-semibold text-[#0D1282] hover:underline">View rate card <FiArrowRight aria-hidden="true" /></Link></section>}
      </section> : <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.9fr)]">
        <BookingTrend rows={home.trend} />
        {finance ? <section className={`${panel} p-5 sm:p-6`}><h2 className="text-lg font-semibold text-slate-950">Credit facilities</h2><p className="mt-1 text-sm text-slate-500">Current account status</p><div className="mt-5 space-y-3">{Object.entries(home.creditStatuses || {}).map(([status, count]) => <div key={status} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><span className="text-sm text-slate-700">{titleCase(status)}</span><strong className="tabular-nums text-slate-950">{number(count)}</strong></div>)}</div><Link href={`${base}/credit`} className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-[#0D1282]">Review credit <FiArrowRight aria-hidden="true" /></Link></section> : <AccountDonut rows={home.accountStatuses || []} />}
      </section>}

      <RecentShipments rows={home.recentShipments} base={base} client={client} />
    </div>
  </main>;
}
