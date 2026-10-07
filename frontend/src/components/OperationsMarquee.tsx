"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import {
  isNewAdvisory,
  listClientRegulatoryUpdates,
  listClientServiceDisruptions,
  listRegulatoryUpdates,
  listServiceDisruptions,
  regulatoryUpdateCategoryLabels,
  serviceDisruptionTypeLabels,
  type RegulatoryUpdate,
  type ServiceDisruption,
} from "@/lib/operationsAdvisory";
import { listActiveBookingPauses, listClientBookingPauses, type BookingPause } from "@/lib/bookingPause";

const CAROUSEL_INTERVAL_MS = 6_000;

type MarqueeItem = {
  key: string;
  label: string;
  title: string;
  detail: string;
  dotClass: string;
  isNew: boolean;
};

export default function OperationsMarquee({
  variant = "client",
}: {
  variant?: "client" | "staff";
}) {
  const [disruptions, setDisruptions] = useState<ServiceDisruption[]>([]);
  const [regulatoryUpdates, setRegulatoryUpdates] = useState<
    RegulatoryUpdate[]
  >([]);
  const [bookingPauses, setBookingPauses] = useState<BookingPause[]>([]);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  function formatPauseWindow(pause: BookingPause) {
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return `${fmt(pause.startAt)} – ${fmt(pause.endAt)}`;
  }

  const load = useCallback(async () => {
    try {
      const [disruptionResult, regulatoryResult, pauseResult] =
        variant === "client"
          ? await Promise.all([
              listClientServiceDisruptions(),
              listClientRegulatoryUpdates(),
              listClientBookingPauses().catch(() => ({ pauses: [] as BookingPause[] })),
            ])
          : await Promise.all([
              listServiceDisruptions({ scope: "live" }),
              listRegulatoryUpdates({ active: true }),
              listActiveBookingPauses().catch(() => ({ pauses: [] as BookingPause[] })),
            ]);

      setDisruptions(disruptionResult.disruptions);

      setRegulatoryUpdates(
        regulatoryResult.updates.filter(
          (update) => update.status !== "EXPIRED",
        ),
      );

      setBookingPauses((pauseResult as { pauses: BookingPause[] }).pauses ?? []);

      setReady(true);
    } catch {
      // The advisory surface is decorative: a network failure must never take
      // down the header it sits in, so it stays empty until the next poll.
    } finally {
      setNow(Date.now());
    }
  }, [variant]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 60_000);

    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load]);

  const items = useMemo<MarqueeItem[]>(
    () => [
      ...bookingPauses.map((pause) => ({
        key: `pause:${pause.id}`,
        label: "Booking paused",
        title: pause.countries.includes("ALL")
          ? `Bookings paused for all destinations - ${formatPauseWindow(pause)}`
          : `Bookings paused for ${pause.countryLabels.join(", ")} - ${formatPauseWindow(pause)}`,
        detail: pause.reason,
        dotClass: "bg-[#D71313]",
        isNew: isNewAdvisory(pause.createdAt, now),
      })),
      ...disruptions.map((disruption) => ({
        key: `disruption:${disruption.id}`,
        label: serviceDisruptionTypeLabels[disruption.type],
        title: disruption.title,
        detail: disruption.message,
        dotClass:
          disruption.severity === "CRITICAL"
            ? "bg-red-500"
            : disruption.severity === "WARNING"
              ? "bg-amber-500"
              : "bg-emerald-500",
        isNew: isNewAdvisory(disruption.createdAt, now),
      })),
      ...regulatoryUpdates.map((update) => ({
        key: `regulatory:${update.id}`,
        label: regulatoryUpdateCategoryLabels[update.category],
        title: update.title,
        detail: update.customerImpact,
        dotClass:
          update.status === "ACTIVE" ? "bg-emerald-500" : "bg-amber-500",
        isNew: isNewAdvisory(update.createdAt, now),
      })),
    ],
    [disruptions, regulatoryUpdates, bookingPauses, now],
  );

  useEffect(() => {
    if (!items.length) return;

    setActiveIndex((current) => {
      if (current >= items.length) return 0;
      return current;
    });
  }, [items.length]);

  useEffect(() => {
    if (items.length <= 1) return;

    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % items.length);
    }, CAROUSEL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [items.length]);

  const showPrevious = () => {
    setActiveIndex((current) =>
      current === 0 ? items.length - 1 : current - 1,
    );
  };

  const showNext = () => {
    setActiveIndex((current) => (current + 1) % items.length);
  };

  if (!ready || !items.length) return null;

  const advisoryHref =
    variant === "client"
      ? "/client/operations-calendar"
      : "/dashboard/operations-advisory";

  return (
    <div
      role="status"
      data-portal-theme-scope
      data-portal-theme-advisory
      className="relative shrink-0 overflow-hidden rounded-xl border border-[#DDE0EE] bg-[#F7F8FC]"
    >
      {/* Soft brand-tinted background */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div data-portal-theme-advisory-gradient className="absolute inset-0 bg-[linear-gradient(110deg,_#ffffff_0%,_#f8f8fd_42%,_#f1f2fb_72%,_#eceef9_100%)]" />

        <div className="absolute -left-20 -top-24 h-52 w-52 rounded-full bg-[#0D1282]/[0.035] blur-3xl" />

        <div className="absolute left-[38%] -top-16 h-32 w-60 rounded-full bg-[#0D1282]/[0.025] blur-3xl" />

        <div className="absolute -bottom-24 right-[10%] h-48 w-48 rounded-full bg-[#0D1282]/[0.045] blur-3xl" />

        {/* subtle arc */}
        <div className="absolute -right-12 -top-20 h-48 w-48 rounded-full border border-[#0D1282]/[0.045]" />
        <div className="absolute -right-5 -top-12 h-36 w-36 rounded-full border border-[#0D1282]/[0.04]" />

        {/* Operations / route abstract */}
        <div className="absolute right-32 top-1/2 hidden h-16 w-48 -translate-y-1/2 xl:block">
          <span className="absolute left-0 right-3 top-1/2 h-px bg-[#0D1282]/[0.07]" />

          <span className="absolute left-0 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-[#0D1282]/15 bg-white" />

          <span className="absolute left-[38%] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#0D1282]/15" />

          <span className="absolute left-[67%] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#0D1282]/15" />

          <span className="absolute right-0 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full border border-[#0D1282]/[0.07]" />

          <span className="absolute right-[6px] top-1/2 h-6 w-6 -translate-y-1/2 rounded-full border border-[#0D1282]/[0.08]" />

          <span className="absolute right-[14px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-[#0D1282]/15" />
        </div>
      </div>

      <div className="relative flex min-h-[76px] items-center gap-3 px-4 py-3 sm:min-h-[80px] sm:gap-4 sm:px-5 lg:px-6">
        {/* Carousel */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div
            className="advisory-track flex w-full transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              transform: `translateX(-${activeIndex * 100}%)`,
            }}
          >
            {items.map((item) => (
              <AdvisorySlide key={item.key} item={item} />
            ))}
          </div>
        </div>

        <Link
          href={advisoryHref}
          className="relative z-10 inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-[#D8DBEA] bg-white/90 px-3 text-[11px] font-semibold text-[#0D1282] transition-colors duration-200 hover:border-[#0D1282]/20 hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/20 sm:h-10 sm:px-3.5 sm:text-xs"
        >
          View
        </Link>

        {/* Navigation */}
        {items.length > 1 ? (
          <div className="relative z-10 flex shrink-0 items-center gap-2 sm:gap-3">
            <span className="hidden text-[11px] font-semibold tabular-nums text-[#777C98] sm:block">
              <span className="text-[#0D1282]">
                {String(activeIndex + 1).padStart(2, "0")}
              </span>

              <span className="mx-1 text-[#B7BACE]">/</span>

              {String(items.length).padStart(2, "0")}
            </span>

            <div className="flex items-center overflow-hidden rounded-lg border border-[#D8DBEA] bg-white/90">
              <button
                type="button"
                onClick={showPrevious}
                aria-label="Previous advisory"
                className="flex h-9 w-9 items-center justify-center text-[#737892] transition-colors duration-200 hover:bg-[#0D1282]/5 hover:text-[#0D1282] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0D1282]/20 sm:h-10 sm:w-10"
              >
                <FiChevronLeft
                  aria-hidden="true"
                  className="h-[18px] w-[18px]"
                />
              </button>

              <span className="h-5 w-px bg-[#E1E3EC]" />

              <button
                type="button"
                onClick={showNext}
                aria-label="Next advisory"
                className="flex h-9 w-9 items-center justify-center text-[#737892] transition-colors duration-200 hover:bg-[#0D1282]/5 hover:text-[#0D1282] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0D1282]/20 sm:h-10 sm:w-10"
              >
                <FiChevronRight
                  aria-hidden="true"
                  className="h-[18px] w-[18px]"
                />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Progress */}
      {items.length > 1 ? (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#0D1282]/5">
          <div
            key={activeIndex}
            className="advisory-progress h-full origin-left animate-[advisoryProgress_6s_linear_forwards] bg-[#0D1282]/75"
          />
        </div>
      ) : null}

      <style jsx>{`
        @keyframes advisoryProgress {
          from {
            transform: scaleX(0);
          }

          to {
            transform: scaleX(1);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .advisory-track {
            transition-duration: 0.01ms !important;
          }

          .advisory-progress {
            animation-duration: 0.01ms !important;
          }
        }
      `}</style>
    </div>
  );
}

function AdvisorySlide({ item }: { item: MarqueeItem }) {
  return (
    <div className="w-full shrink-0">
      <div className="min-w-0 xl:pr-44">
        {/* LINE 1 */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-25 ${item.dotClass}`}
            />

            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${item.dotClass}`}
            />
          </span>

          <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] text-[#0D1282] sm:text-[11px]">
            Live advisory
          </span>

          <span className="h-3.5 w-px shrink-0 bg-[#0D1282]/15" />

          <span className="min-w-0 truncate text-[9px] font-semibold uppercase tracking-[0.08em] text-[#676C84] sm:text-[11px]">
            {item.label}
          </span>

          {item.isNew ? (
            <>
              <span className="hidden h-1 w-1 shrink-0 rounded-full bg-[#B8BBCB] sm:block" />

              <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.08em] text-red-600 sm:text-[10px]">
                New
              </span>
            </>
          ) : null}
        </div>

        {/* LINE 2 */}
        <div className="mt-1.5 flex min-w-0 items-baseline gap-2.5">
          <h3 className="min-w-0 shrink truncate text-[12px] font-semibold leading-5 tracking-[-0.015em] text-[#171A2E] sm:text-[17px] sm:leading-6 lg:text-lg">
            {item.title}
          </h3>

          <span className="hidden shrink-0 text-[#B6B9C9] sm:inline">
            -
          </span>

          <p className="hidden min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-[#666B82] sm:block lg:text-sm">
            {item.detail}
          </p>
        </div>
      </div>
    </div>
  );
}
