"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { FiArrowDownRight, FiArrowRight, FiArrowUpRight, FiMinus } from "react-icons/fi";

// Shared surface for every dashboard panel: a soft double shadow over the
// #EEEDED page plane plus a hairline ring, so cards read as raised without the
// heavy inset/outset pairing of full neumorphism.
export const panelSurface =
"portal-theme-surface rounded-2xl bg-gradient-to-br from-white via-slate-50 to-slate-100 ring-1 ring-slate-900/[0.04] shadow border border-slate-100";
export const panelLift =
  "transition duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_2px_6px_rgba(15,23,42,0.05),0_20px_44px_-22px_rgba(13,18,130,0.40)]";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export function SectionCard({
  title,
  subtitle,
  icon: Icon,
  action,
  footnote,
  children,
  className = "",
  bodyClassName = ""
}: {
  title: string;
  subtitle?: string;
  icon?: IconType;
  action?: ReactNode;
  footnote?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex h-full min-w-0 flex-col ${panelSurface} ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-[#F0DE36]">
              <Icon aria-hidden="true" className="h-4 w-4" />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs leading-5 text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {action}
      </header>

      <div className={`min-w-0 flex-1 px-5 py-4 ${bodyClassName}`}>{children}</div>

      {footnote ? (
        <p className="border-t border-white/10 px-5 py-2.5 text-[11px] leading-5 text-slate-500">{footnote}</p>
      ) : null}
    </section>
  );
}

// Stat tile: label, value, one supporting line, and an optional signed delta
// against a named period.
export function KpiCard({
  icon: Icon,
  label,
  value,
  description,
  delta,
  href,
  emphasis = false
}: {
  icon: IconType;
  label: string;
  value: string;
  description: string;
  delta?: { current: number; previous: number; period: string };
  href?: string;
  emphasis?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        {/* <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-sm ${
            emphasis ? "bg-[#D71313]/10 text-[#D71313]" : "bg-[#F0DE36]/20 text-[#0D1282]"
          }`}
        >
          <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
        </span> */}
        {delta ? <DeltaBadge {...delta} /> : null}
      </div>
      <p className="mt-1.5 text-3xl font-bold leading-9 tracking-tight text-slate-900 tabular-nums">{value}</p>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>

      {/* {href ? (
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#0D1282]">
          Open
          <FiArrowRight aria-hidden="true" className="h-3 w-3" />
        </span>
      ) : null} */}
    </>
  );

  const shell = `flex h-full flex-col p-5 ${panelSurface}`;

  if (!href) return <article className={shell}>{body}</article>;

  return (
    <Link
      href={href}
      className={`${shell} ${panelLift} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/40 focus-visible:ring-offset-2`}
    >
      {body}
    </Link>
  );
}

// Direction × whether up is good. Every shipment metric here improves as it
// rises, so up is always the good direction on this dashboard.
function DeltaBadge({ current, previous, period }: { current: number; previous: number; period: string }) {
  const change = current - previous;
  const percent = previous > 0 ? Math.round((change / previous) * 100) : null;
  const Icon = change > 0 ? FiArrowUpRight : change < 0 ? FiArrowDownRight : FiMinus;
  const tone = change > 0 ? "text-emerald-300" : change < 0 ? "text-red-300" : "text-slate-300";
  const reading = percent === null
    ? `${change > 0 ? "+" : ""}${change}`
    : `${change > 0 ? "+" : ""}${percent}%`;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-semibold ${tone}`}
      title={`${change > 0 ? "+" : ""}${change} vs ${period}`}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      {change === 0 ? "No change" : reading}
      <span className="font-medium text-blue-200">vs {period}</span>
    </span>
  );
}

export const severityStyles = {
  info: { chip: "bg-white text-[#0D1282]", rail: "bg-[#4666ca]" },
  warning: { chip: "bg-white text-[#7a4f00]", rail: "bg-[#fab219]" },
  critical: { chip: "bg-white text-[#D71313]", rail: "bg-[#D71313]" }
} as const;

export function SeverityChip({ tone, children }: { tone: keyof typeof severityStyles; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${severityStyles[tone].chip}`}>
      {children}
    </span>
  );
}

// Cards sit on a light panelSurface now, so empty states default to the light
// (dark-text) tone. The dark tone remains available for any genuinely dark
// surface, but none currently exist.
export function EmptyState({
  icon: Icon,
  title,
  message,
  actionLabel,
  actionHref,
  surface = "light"
}: {
  icon: IconType;
  title: string;
  message: string;
  actionLabel?: string;
  actionHref?: string;
  surface?: "light" | "dark";
}) {
  const onLight = surface === "light";

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl  shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)]">
        <Icon aria-hidden="true" className="h-6 w-6" />
      </span>
      <p className={`text-sm font-semibold ${onLight ? "text-slate-900" : "text-white"}`}>{title}</p>
      <p className={`max-w-xs text-xs leading-5 ${onLight ? "text-slate-500" : "text-slate-300"}`}>{message}</p>
      {actionLabel && actionHref ? (
        <Link
          href={actionHref}
          className={`mt-1 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
            onLight
              ? "bg-[#0D1282] text-white shadow-[#0D1282]/20 hover:bg-[#0a0d63] focus-visible:ring-[#0D1282]/40"
              : "bg-[#F0DE36] text-[#0D1282] shadow-[#0D1282]/30 hover:bg-[#e0cf2e] focus-visible:ring-white/40"
          }`}
        >
          {actionLabel}
          <FiArrowRight aria-hidden="true" className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

// ── loading placeholders ──────────────────────────────────────────────────────

// Skeletons render inside dark cards almost everywhere now, but the
// pre-session bootstrap mocks the light sidebar/header chrome too, so this
// takes the same light/dark toggle as EmptyState.
export function Shimmer({ className = "", surface = "dark" }: { className?: string; surface?: "light" | "dark" }) {
  return <span className={`block animate-pulse rounded-md ${surface === "dark" ? "bg-white/15" : "bg-slate-200/80"} ${className}`} />;
}

export function KpiCardSkeleton() {
  return (
    <div className={`flex h-full flex-col p-5 ${panelSurface}`}>
      <Shimmer className="h-10 w-10 rounded-xl" />
      <Shimmer className="mt-4 h-3 w-24" />
      <Shimmer className="mt-2 h-7 w-20" />
      <Shimmer className="mt-2 h-3 w-32" />
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3.5">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-start gap-3">
          <Shimmer className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <Shimmer className="h-3 w-2/3" />
            <Shimmer className="mt-2 h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Mirrors the pipeline chart's row grid, so the card keeps its height when the
// real bars arrive.
export function BarsSkeleton({ rows = 6 }: { rows?: number }) {
  const widths = ["w-11/12", "w-9/12", "w-full", "w-4/12", "w-6/12", "w-3/12", "w-2/12", "w-1/12"];
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 px-1.5 py-2 sm:grid-cols-[minmax(0,9rem)_1fr_auto]"
        >
          <Shimmer className="h-3 w-20" />
          <Shimmer className={`h-3 rounded-r-[4px] ${widths[index % widths.length]}`} />
          <Shimmer className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

// Column widths and heights mirror the real trend chart so the card does not
// resize when the data lands.
export function ColumnsSkeleton() {
  const heights = ["h-1/3", "h-2/3", "h-1/2", "h-3/4", "h-2/5", "h-1/6", "h-1/2", "h-4/5", "h-3/5", "h-2/5", "h-2/3", "h-1/4", "h-3/5", "h-1/2"];
  return (
    <div className="mt-8 flex h-44 items-end gap-1">
      {heights.map((height, index) => (
        <div key={index} className="flex h-full min-w-0 flex-1 items-end justify-center">
          <Shimmer className={`w-full max-w-6 rounded-t-[4px] ${height}`} />
        </div>
      ))}
    </div>
  );
}
