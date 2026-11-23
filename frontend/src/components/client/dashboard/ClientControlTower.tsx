"use client";

import Link from "next/link";
import {
  FiAlertTriangle,
  FiArrowRight,
  FiCheckCircle,
  FiPackage,
  FiShield,
  FiTruck
} from "react-icons/fi";
import {
  severityStyles,
  type AttentionItem,
  type ClientOverviewSummary
} from "@/lib/clientOverview";

/**
 * The five-second answer: where the shipments are, what is broken, what is
 * needed from the customer, what lands today, and what is owed.
 *
 * Every figure arrives counted from the server, so nothing here does arithmetic
 * over a list it had to download first.
 */

type Tone = "neutral" | "good" | "warn" | "bad";

const toneStyles: Record<Tone, string> = {
  neutral: "text-slate-900",
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700"
};

function StatCard({
  label,
  value,
  tone = "neutral",
  href,
  hint
}: {
  label: string;
  value: string | number;
  tone?: Tone;
  href?: string;
  hint?: string;
}) {
  const body = (
    <>
      <p className={`text-2xl font-semibold tabular-nums ${toneStyles[tone]}`}>{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </>
  );

  const shared = "rounded-2xl border border-slate-200 bg-white px-4 py-3";

  // Only cards that lead somewhere useful become links, so a pointer cursor
  // never promises a page that does not exist.
  return href ? (
    <Link href={href} className={`${shared} block transition hover:border-[#0D1282]/40 hover:shadow-sm`}>
      {body}
    </Link>
  ) : (
    <div className={shared}>{body}</div>
  );
}

export function ClientSummaryCards({ summary }: {
  summary: ClientOverviewSummary;
}) {
  return (
    <section aria-label="Shipment summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Total Shipments" value={summary.totalShipments} href="/client/shipments" />
      <StatCard label="In Transit" value={summary.inTransit} href="/client/shipments" />
      <StatCard label="Out for Delivery" value={summary.outForDelivery} href="/client/shipments" />
      <StatCard
        label="Delivered Today"
        value={summary.deliveredToday}
        tone={summary.deliveredToday ? "good" : "neutral"}
        href="/client/shipments"
      />
      <StatCard
        label="Delayed"
        value={summary.delayed}
        tone={summary.delayed ? "warn" : "neutral"}
        href="/client/exceptions"
      />
      <StatCard
        label="Customs Hold"
        value={summary.customsHold}
        tone={summary.customsHold ? "bad" : "neutral"}
        href="/client/exceptions"
      />
      <StatCard
        label="Exceptions"
        value={summary.exceptions}
        tone={summary.exceptions ? "warn" : "neutral"}
        href="/client/exceptions"
      />
      <StatCard
        label="Action Required"
        value={summary.actionRequired}
        tone={summary.actionRequired ? "bad" : "neutral"}
        href="/client/actions"
      />
      <StatCard label="Open Claims" value={summary.openClaims} href="/client/claims" />
      <StatCard label="Open Tickets" value={summary.openTickets} href="/client/tickets" />
    </section>
  );
}

function itemIcon(item: AttentionItem) {
  if (item.kind === "ACTION") return FiAlertTriangle;
  if (/customs/i.test(item.label)) return FiShield;
  if (/delivery|consignee/i.test(item.label)) return FiTruck;
  return FiPackage;
}

export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Needs Your Attention
        </h2>
        {items.length ? (
          <Link href="/client/actions" className="text-xs font-semibold text-[#0D1282] hover:underline">
            View all
          </Link>
        ) : null}
      </div>

      {!items.length ? (
        <div className="px-4 py-10 text-center">
          <FiCheckCircle aria-hidden="true" className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 text-sm font-semibold text-slate-800">Nothing needs you right now</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Every shipment is moving normally and nothing is waiting on your side. Anything that
            stops- a customs hold, an address problem, a document request- appears here first.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => {
            const Icon = itemIcon(item);
            const tone = severityStyles[item.severity];

            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden="true" className={`mt-1 h-8 w-1 shrink-0 rounded-full ${tone.bar}`} />
                <Icon aria-hidden="true" className="mt-1.5 h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{item.label}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{item.detail}</p>
                </div>
                <Link
                  href={item.href}
                  className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-4xl border border-[#0D1282]/30 px-3 py-1.5 text-xs font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5"
                >
                  {item.actionLabel}
                  <FiArrowRight aria-hidden="true" className="h-3 w-3" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Placeholder shown while the first overview call is in flight. */
export function ControlTowerSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="h-7 w-14 animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="h-3 w-40 animate-pulse rounded bg-slate-100" />
        </div>
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 px-4 py-4">
            <div className="h-8 w-1 animate-pulse rounded-full bg-slate-100" />
            <div className="flex-1">
              <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

