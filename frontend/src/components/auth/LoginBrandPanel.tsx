"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  FiBarChart2,
  FiFileText,
  FiMapPin,
  FiPackage,
  FiUsers,
} from "react-icons/fi";

/** What the portal actually does, in the order a new client meets it. Each
 *  gets its own accent color, applied to both the icon and its label. */
const capabilities = [
  { icon: FiPackage, label: "Shipment", sublabel: "Management", color: "#0D1282" },
  { icon: FiMapPin, label: "Live Tracking", sublabel: "& POD", color: "#D81F26" },
  { icon: FiFileText, label: "Customs", sublabel: "Compliance", color: "#0F766E" },
  { icon: FiUsers, label: "Business", sublabel: "Accounts", color: "#B45309" },
  { icon: FiBarChart2, label: "Reports &", sublabel: "Analytics", color: "#7C3AED" }
];

/**
 * Dot coordinates for a simplified world map (Robinson projection), normalized
 * to a 400×166 viewBox. Generated once offline from real coastline data at a
 * deliberately low sampling rate- enough to read as continents at 42% panel
 * width, far short of the thousands of points a faithful map would need.
 * Source: https://github.com/johan/world.geo.json via the 'dotted-map' package.
 */
const WORLD_DOTS: [number, number][] = [
  [3.5, 0], [10.6, 0], [17.7, 0], [102.7, 0], [109.7, 0], [131, 0], [138.1, 0], [159.3, 0], [166.4, 0], [173.5, 0], [223, 0], [265.5, 0], [272.6, 0], [279.6, 0],
  [286.7, 0], [293.8, 0], [300.9, 0], [308, 0], [315, 0], [322.1, 0], [329.2, 0], [0, 6.1], [7.1, 6.1], [14.2, 6.1], [21.2, 6.1], [28.3, 6.1], [35.4, 6.1], [42.5, 6.1],
  [56.6, 6.1], [63.7, 6.1], [70.8, 6.1], [77.9, 6.1], [85, 6.1], [92, 6.1], [99.1, 6.1], [106.2, 6.1], [113.3, 6.1], [120.4, 6.1], [155.8, 6.1], [162.8, 6.1], [184.1, 6.1], [219.5, 6.1],
  [226.5, 6.1], [240.7, 6.1], [247.8, 6.1], [254.9, 6.1], [261.9, 6.1], [269, 6.1], [276.1, 6.1], [283.2, 6.1], [290.3, 6.1], [297.3, 6.1], [304.4, 6.1], [311.5, 6.1], [318.6, 6.1], [325.7, 6.1],
  [332.7, 6.1], [339.8, 6.1], [346.9, 6.1], [354, 6.1], [361.1, 6.1], [368.1, 6.1], [382.3, 6.1], [389.4, 6.1], [396.5, 6.1], [3.5, 12.3], [17.7, 12.3], [46, 12.3], [53.1, 12.3], [60.2, 12.3],
  [67.3, 12.3], [74.3, 12.3], [81.4, 12.3], [88.5, 12.3], [95.6, 12.3], [102.7, 12.3], [109.7, 12.3], [131, 12.3], [159.3, 12.3], [208.8, 12.3], [215.9, 12.3], [223, 12.3], [230.1, 12.3], [237.2, 12.3],
  [244.2, 12.3], [251.3, 12.3], [258.4, 12.3], [265.5, 12.3], [272.6, 12.3], [279.6, 12.3], [286.7, 12.3], [293.8, 12.3], [300.9, 12.3], [308, 12.3], [315, 12.3], [322.1, 12.3], [329.2, 12.3], [336.3, 12.3],
  [343.4, 12.3], [357.5, 12.3], [364.6, 12.3], [392.9, 12.3], [400, 12.3], [0, 18.4], [42.5, 18.4], [70.8, 18.4], [77.9, 18.4], [85, 18.4], [92, 18.4], [99.1, 18.4], [106.2, 18.4], [113.3, 18.4],
  [127.4, 18.4], [134.5, 18.4], [198.2, 18.4], [226.5, 18.4], [233.6, 18.4], [240.7, 18.4], [247.8, 18.4], [254.9, 18.4], [261.9, 18.4], [269, 18.4], [276.1, 18.4], [283.2, 18.4], [290.3, 18.4], [297.3, 18.4],
  [304.4, 18.4], [311.5, 18.4], [318.6, 18.4], [325.7, 18.4], [332.7, 18.4], [361.1, 18.4], [74.3, 24.5], [81.4, 24.5], [88.5, 24.5], [95.6, 24.5], [102.7, 24.5], [109.7, 24.5], [116.8, 24.5], [123.9, 24.5],
  [131, 24.5], [138.1, 24.5], [201.8, 24.5], [208.8, 24.5], [215.9, 24.5], [223, 24.5], [230.1, 24.5], [237.2, 24.5], [244.2, 24.5], [251.3, 24.5], [258.4, 24.5], [265.5, 24.5], [272.6, 24.5], [279.6, 24.5],
  [286.7, 24.5], [293.8, 24.5], [300.9, 24.5], [308, 24.5], [315, 24.5], [322.1, 24.5], [329.2, 24.5], [336.3, 24.5], [343.4, 24.5], [70.8, 30.7], [77.9, 30.7], [85, 30.7], [92, 30.7], [99.1, 30.7],
  [106.2, 30.7], [113.3, 30.7], [120.4, 30.7], [127.4, 30.7], [205.3, 30.7], [212.4, 30.7], [219.5, 30.7], [226.5, 30.7], [233.6, 30.7], [247.8, 30.7], [261.9, 30.7], [269, 30.7], [276.1, 30.7], [283.2, 30.7],
  [290.3, 30.7], [297.3, 30.7], [304.4, 30.7], [311.5, 30.7], [318.6, 30.7], [325.7, 30.7], [332.7, 30.7], [339.8, 30.7], [346.9, 30.7], [67.3, 36.8], [74.3, 36.8], [81.4, 36.8], [88.5, 36.8], [95.6, 36.8],
  [102.7, 36.8], [109.7, 36.8], [116.8, 36.8], [123.9, 36.8], [194.7, 36.8], [201.8, 36.8], [215.9, 36.8], [223, 36.8], [230.1, 36.8], [251.3, 36.8], [265.5, 36.8], [272.6, 36.8], [279.6, 36.8], [286.7, 36.8],
  [293.8, 36.8], [300.9, 36.8], [308, 36.8], [315, 36.8], [322.1, 36.8], [329.2, 36.8], [336.3, 36.8], [343.4, 36.8], [70.8, 42.9], [77.9, 42.9], [85, 42.9], [92, 42.9], [99.1, 42.9], [106.2, 42.9],
  [113.3, 42.9], [198.2, 42.9], [226.5, 42.9], [233.6, 42.9], [240.7, 42.9], [247.8, 42.9], [254.9, 42.9], [269, 42.9], [276.1, 42.9], [283.2, 42.9], [290.3, 42.9], [297.3, 42.9], [304.4, 42.9], [311.5, 42.9],
  [318.6, 42.9], [325.7, 42.9], [332.7, 42.9], [74.3, 49], [81.4, 49], [88.5, 49], [95.6, 49], [102.7, 49], [109.7, 49], [194.7, 49], [201.8, 49], [208.8, 49], [244.2, 49], [251.3, 49],
  [258.4, 49], [265.5, 49], [272.6, 49], [279.6, 49], [286.7, 49], [293.8, 49], [300.9, 49], [308, 49], [315, 49], [322.1, 49], [329.2, 49], [336.3, 49], [350.4, 49], [77.9, 55.2],
  [85, 55.2], [106.2, 55.2], [191.2, 55.2], [198.2, 55.2], [205.3, 55.2], [212.4, 55.2], [219.5, 55.2], [226.5, 55.2], [233.6, 55.2], [240.7, 55.2], [247.8, 55.2], [254.9, 55.2], [261.9, 55.2], [269, 55.2],
  [276.1, 55.2], [283.2, 55.2], [290.3, 55.2], [297.3, 55.2], [304.4, 55.2], [311.5, 55.2], [318.6, 55.2], [325.7, 55.2], [332.7, 55.2], [339.8, 55.2], [81.4, 61.3], [187.6, 61.3], [194.7, 61.3], [201.8, 61.3],
  [208.8, 61.3], [215.9, 61.3], [223, 61.3], [230.1, 61.3], [237.2, 61.3], [251.3, 61.3], [258.4, 61.3], [265.5, 61.3], [286.7, 61.3], [293.8, 61.3], [300.9, 61.3], [308, 61.3], [315, 61.3], [322.1, 61.3],
  [329.2, 61.3], [336.3, 61.3], [343.4, 61.3], [77.9, 67.4], [85, 67.4], [184.1, 67.4], [191.2, 67.4], [198.2, 67.4], [205.3, 67.4], [212.4, 67.4], [219.5, 67.4], [226.5, 67.4], [233.6, 67.4], [240.7, 67.4],
  [254.9, 67.4], [261.9, 67.4], [269, 67.4], [290.3, 67.4], [297.3, 67.4], [318.6, 67.4], [325.7, 67.4], [95.6, 73.6], [102.7, 73.6], [187.6, 73.6], [194.7, 73.6], [201.8, 73.6], [208.8, 73.6], [215.9, 73.6],
  [223, 73.6], [230.1, 73.6], [237.2, 73.6], [244.2, 73.6], [258.4, 73.6], [293.8, 73.6], [322.1, 73.6], [329.2, 73.6], [113.3, 79.7], [120.4, 79.7], [191.2, 79.7], [198.2, 79.7], [205.3, 79.7], [212.4, 79.7],
  [219.5, 79.7], [226.5, 79.7], [233.6, 79.7], [240.7, 79.7], [247.8, 79.7], [261.9, 79.7], [109.7, 85.8], [116.8, 85.8], [123.9, 85.8], [131, 85.8], [194.7, 85.8], [201.8, 85.8], [208.8, 85.8], [215.9, 85.8],
  [223, 85.8], [230.1, 85.8], [237.2, 85.8], [244.2, 85.8], [251.3, 85.8], [258.4, 85.8], [322.1, 85.8], [113.3, 92], [120.4, 92], [127.4, 92], [134.5, 92], [141.6, 92], [219.5, 92], [226.5, 92],
  [233.6, 92], [240.7, 92], [247.8, 92], [254.9, 92], [325.7, 92], [339.8, 92], [109.7, 98.1], [116.8, 98.1], [123.9, 98.1], [131, 98.1], [138.1, 98.1], [145.1, 98.1], [152.2, 98.1], [215.9, 98.1],
  [223, 98.1], [230.1, 98.1], [237.2, 98.1], [244.2, 98.1], [336.3, 98.1], [357.5, 98.1], [371.7, 98.1], [113.3, 104.2], [120.4, 104.2], [127.4, 104.2], [134.5, 104.2], [141.6, 104.2], [148.7, 104.2], [155.8, 104.2],
  [219.5, 104.2], [226.5, 104.2], [233.6, 104.2], [240.7, 104.2], [247.8, 104.2], [332.7, 104.2], [368.1, 104.2], [375.2, 104.2], [109.7, 110.4], [116.8, 110.4], [123.9, 110.4], [131, 110.4], [138.1, 110.4], [145.1, 110.4],
  [152.2, 110.4], [223, 110.4], [230.1, 110.4], [237.2, 110.4], [244.2, 110.4], [364.6, 110.4], [371.7, 110.4], [120.4, 116.5], [127.4, 116.5], [134.5, 116.5], [141.6, 116.5], [148.7, 116.5], [219.5, 116.5], [226.5, 116.5],
  [233.6, 116.5], [240.7, 116.5], [247.8, 116.5], [254.9, 116.5], [354, 116.5], [361.1, 116.5], [123.9, 122.6], [131, 122.6], [138.1, 122.6], [145.1, 122.6], [152.2, 122.6], [223, 122.6], [230.1, 122.6], [237.2, 122.6],
  [258.4, 122.6], [343.4, 122.6], [350.4, 122.6], [357.5, 122.6], [364.6, 122.6], [371.7, 122.6], [120.4, 128.8], [127.4, 128.8], [134.5, 128.8], [141.6, 128.8], [219.5, 128.8], [226.5, 128.8], [233.6, 128.8], [254.9, 128.8],
  [339.8, 128.8], [346.9, 128.8], [354, 128.8], [361.1, 128.8], [368.1, 128.8], [375.2, 128.8], [123.9, 134.9], [131, 134.9], [138.1, 134.9], [223, 134.9], [230.1, 134.9], [237.2, 134.9], [336.3, 134.9], [343.4, 134.9],
  [350.4, 134.9], [357.5, 134.9], [364.6, 134.9], [371.7, 134.9], [120.4, 141], [127.4, 141], [134.5, 141], [361.1, 141], [368.1, 141], [123.9, 147.1], [131, 147.1], [364.6, 147.1], [400, 147.1], [127.4, 153.3],
  [361.1, 153.3], [389.4, 153.3], [123.9, 159.4], [131, 159.4], [127.4, 165.5],
];

const DOT_RADIUS = 1.35;

const WORLD_DOTS_PATH = WORLD_DOTS.map(([x, y]) => {
  const r = DOT_RADIUS;
  return `M${x - r},${y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 -${r * 2},0`;
}).join(" ");

// Delhi, India
const FLIGHT_ORIGIN = { x: 248, y: 74 };
// London, United Kingdom
const FLIGHT_DEST = { x: 191, y: 42 };
const FLIGHT_CTRL = { x: 228, y: 12 };

const FLIGHT_PATH = `M${FLIGHT_ORIGIN.x},${FLIGHT_ORIGIN.y} Q${FLIGHT_CTRL.x},${FLIGHT_CTRL.y} ${FLIGHT_DEST.x},${FLIGHT_DEST.y}`;

function bezierAt(t: number) {
  const mt = 1 - t;
  return {
    x:
      mt * mt * FLIGHT_ORIGIN.x +
      2 * mt * t * FLIGHT_CTRL.x +
      t * t * FLIGHT_DEST.x,
    y:
      mt * mt * FLIGHT_ORIGIN.y +
      2 * mt * t * FLIGHT_CTRL.y +
      t * t * FLIGHT_DEST.y,
  };
}

function bezierAngle(t: number) {
  const mt = 1 - t;
  const dx =
    2 * mt * (FLIGHT_CTRL.x - FLIGHT_ORIGIN.x) +
    2 * t * (FLIGHT_DEST.x - FLIGHT_CTRL.x);

  const dy =
    2 * mt * (FLIGHT_CTRL.y - FLIGHT_ORIGIN.y) +
    2 * t * (FLIGHT_DEST.y - FLIGHT_CTRL.y);

  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

const PLANE_T = 0.58;
const PLANE_POS = bezierAt(PLANE_T);
const PLANE_ANGLE = bezierAngle(PLANE_T);

const PLANE_PATH =
  "M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3l4 7";

const SLIDE_COUNT = 3;
const AUTOPLAY_DELAY_MS = 3000;

function WorldMapBackdrop() {
  return (
    <svg
      viewBox="0 0 400 166"
      aria-hidden="true"
      className="pointer-events-none absolute right-4 top-[30%] hidden w-[44%] max-w-lg -translate-y-1/2 xl:block"
    >
      <defs>
        <radialGradient id="world-map-fade" cx="54%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.65" />
          <stop offset="60%" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="world-map-mask">
          <rect width="400" height="166" fill="url(#world-map-fade)" />
        </mask>
      </defs>

      <g mask="url(#world-map-mask)">
        <path d={WORLD_DOTS_PATH} fill="#0D1282" fillOpacity="0.5" />
      </g>

      <path
        d={FLIGHT_PATH}
        fill="none"
        stroke="#D81F26"
        strokeOpacity="0.65"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="2 6"
      />

      <circle cx={FLIGHT_ORIGIN.x} cy={FLIGHT_ORIGIN.y} r="2.6" fill="#D81F26" />
      <circle cx={FLIGHT_DEST.x} cy={FLIGHT_DEST.y} r="2.6" fill="#0D1282" />

      <g
        transform={`translate(${PLANE_POS.x.toFixed(1)}, ${PLANE_POS.y.toFixed(
          1
        )}) rotate(${PLANE_ANGLE.toFixed(1)}) scale(0.95) translate(-12,-12)`}
      >
        <path
          d={PLANE_PATH}
          fill="#D81F26"
          stroke="#D81F26"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export function LoginBrandPanel() {
  const [activeSlide, setActiveSlide] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateAutoplay = () => setAutoplayEnabled(!reducedMotion.matches);

    updateAutoplay();
    reducedMotion.addEventListener("change", updateAutoplay);
    return () => reducedMotion.removeEventListener("change", updateAutoplay);
  }, []);

  useEffect(() => {
    if (!autoplayEnabled || isPaused) return;

    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % SLIDE_COUNT);
    }, AUTOPLAY_DELAY_MS);

    return () => window.clearInterval(timer);
  }, [autoplayEnabled, isPaused]);

  const showPreviousSlide = () => {
    setActiveSlide((current) => (current - 1 + SLIDE_COUNT) % SLIDE_COUNT);
  };

  const showNextSlide = () => {
    setActiveSlide((current) => (current + 1) % SLIDE_COUNT);
  };

  const slideClassName = (index: number) =>
    `col-start-1 row-start-1 flex h-full min-h-0 w-full flex-col transition-[opacity,transform,filter] duration-500 ease-out motion-reduce:transition-none ${
      activeSlide === index
        ? "relative z-10 translate-x-0 opacity-100 blur-0"
        : "pointer-events-none translate-x-5 opacity-0 blur-[2px]"
    }`;

  const panelGradient =
    "bg-[linear-gradient(135deg,#ffffff_0%,#f4f6ff_56%,#fff4f4_100%)]";

  return (
    <section
      aria-label="Swiftline portal highlights"
      aria-roledescription="carousel"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsPaused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          showPreviousSlide();
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          showNextSlide();
        }
      }}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStartX.current === null) return;
        const distance = (event.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
        touchStartX.current = null;
        if (Math.abs(distance) < 48) return;
        if (distance > 0) showPreviousSlide();
        else showNextSlide();
      }}
      className={`relative order-2 flex w-full min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_44px_-22px_rgba(13,18,130,0.20)] transition-colors duration-500 sm:p-5 lg:order-1 lg:self-stretch ${activeSlide === 0 ? "h-auto" : "h-[min(480px,65svh)] min-h-100 lg:h-auto lg:min-h-0"} ${panelGradient}`}
    >
      {activeSlide === 0 ? (
        <>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <span className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-[#0D1282]/8 blur-3xl" />
            <span className="absolute -bottom-28 left-[28%] h-64 w-64 rounded-full bg-[#D81F26]/7 blur-3xl" />
          </div>

          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-24 top-36 hidden overflow-hidden lg:block xl:bottom-26"
          >
            <span className="absolute left-[3%] top-1/2 -translate-y-1/2 whitespace-nowrap text-[clamp(22rem,25vw,30rem)] font-semibold leading-none tracking-[-0.04em] text-[#0D1282]/[0.022]">
              SLC
            </span>
          </div>
        </>
      ) : null}

      {activeSlide === 0 ? <WorldMapBackdrop /> : null}

      <div className="relative flex h-full min-h-0 w-full flex-col">
        <div className="grid min-h-0 flex-1 px-1 py-0.5">
          <div className={slideClassName(0)} aria-hidden={activeSlide !== 0} inert={activeSlide !== 0}>
            <div className="flex shrink-0 flex-col gap-3">
              <p className="hidden text-[11px] font-semibold uppercase tracking-[0.22em] text-[#0D1282]/70 lg:block">
                Secure international logistics
              </p>

              <h1 className="max-w-xl text-[clamp(1.65rem,8vw,2.25rem)] font-bold leading-[1.06] tracking-tight text-[#0D1282] sm:text-[clamp(1.85rem,5vw,2.55rem)] lg:text-[clamp(2rem,3.2vw,2.5rem)]">
                Every Parcel.
                <br />
                A Promise.
                <br />
                <span className="text-[#D81F26]">Swiftly Delivered.</span>
              </h1>

              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-1 w-9 rounded-full bg-[#0D1282]" />
                <span className="h-1 w-4 rounded-full bg-[#D81F26]" />
              </div>

              <p className="max-w-xl text-[13px] leading-5.5 text-slate-600 sm:text-[14px]">
                Your trusted logistics partner for secure, reliable and compliant international
                courier and cargo solutions.
              </p>

              <p className="text-[13px] font-semibold text-[#0D1282] sm:text-[14px]">
                One Platform. <span className="text-[#D81F26]">Complete Control.</span>
              </p>

              <div className="flex shrink-0 flex-wrap gap-3">
                <Link
                  href="/track"
                  className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[#0D1282]/25 bg-white px-4 text-[13px] font-semibold text-[#0D1282] transition-colors hover:border-[#0D1282] hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] focus-visible:ring-offset-2 sm:px-5"
                >
                  Track Shipment
                </Link>
                <Link
                  href="/book-shipment-online"
                  className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#0D1282] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[#0a0f6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] focus-visible:ring-offset-2 sm:px-5"
                >
                  Ship Now
                </Link>
              </div>
            </div>

            <ul className="mt-auto grid grid-cols-2 gap-2.5 pt-5 sm:grid-cols-3 lg:grid-cols-5 lg:gap-3">
              {capabilities.map(({ icon: Icon, label, sublabel, color }) => (
                <li
                  key={label}
                  className="rounded-xl border border-white/80 bg-white/75 px-2.5 py-3 text-center shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)] backdrop-blur-sm transition last:col-span-2 hover:-translate-y-0.5 hover:border-[#0D1282]/20 hover:bg-white/90 sm:last:col-span-1"
                >
                  <span
                    className="mx-auto flex h-7 w-7 items-center justify-center rounded-lg sm:h-8 sm:w-8"
                    style={{ color }}
                  >
                    <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                  </span>

                  <span className="mt-1.5 block text-[10px] font-semibold leading-snug sm:text-[10.5px]">
                    {label}
                    <br />
                    {sublabel}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className={slideClassName(1)} aria-hidden={activeSlide !== 1}>
            <h2 className="shrink-0 text-[clamp(1.45rem,7vw,2rem)] font-bold leading-[1.08] tracking-tight text-[#0D1282] lg:text-[2rem]">
              Create a shipment.
              <br />
              <span className="text-[#D81F26]">Track every step.</span>
            </h2>

            <p className="mt-2.5 max-w-2xl shrink-0 text-[13px] leading-5 text-slate-600 sm:text-[14px]">
              Book your international shipments and follow their progress in one place.
              Access your Swiftline AWB, track key milestones and view proof of delivery.
            </p>
            <div className="-mx-1 mt-4 sm:-mx-2 lg:-mx-3">
              <Image
                src="/login/sliderr.png"
                alt="Swiftline shipment import and manual creation alongside the shipment tracking journey"
                width={1916}
                height={821}
                sizes="(min-width: 1440px) 850px, (min-width: 1024px) 58vw, 100vw"
                className="h-auto w-full object-contain"
              />
            </div>
          </div>

          <div className={slideClassName(2)} aria-hidden={activeSlide !== 2}>
            <h2 className="shrink-0 text-[clamp(1.45rem,7vw,2rem)] font-bold leading-[1.08] tracking-tight text-[#0D1282] lg:text-[2rem]">
              Your business accounts.
              <br />
              <span className="text-[#D81F26]">Your credit, in view.</span>
            </h2>

            <p className="mt-2.5 max-w-2xl shrink-0 text-[13px] leading-5 text-slate-600 sm:text-[14px]">
              View your account&apos;s shipping rates and stay informed about your credit.
              Check approved limits, available balances and payment details in one place.
            </p>
            <div className="-mx-1 mt-4 sm:-mx-2 lg:-mx-3">
              <Image
                src="/login/sliderrr.png"
                alt="Swiftline account rate card and credit account showing approved limits, balances and statements"
                width={1916}
                height={821}
                sizes="(min-width: 1440px) 850px, (min-width: 1024px) 58vw, 100vw"
                className="h-auto w-full object-contain"
              />
            </div>
          </div>
        </div>

        <div className="relative z-20 mt-3 flex shrink-0 items-center justify-start px-1 pt-1">
          <div className="flex items-center gap-2" aria-label="Choose a slide">
            {Array.from({ length: SLIDE_COUNT }, (_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setActiveSlide(index)}
                aria-label={`Show slide ${index + 1} of ${SLIDE_COUNT}`}
                aria-current={activeSlide === index ? "true" : undefined}
                className={`h-2 rounded-full transition-[width,background-color] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] focus-visible:ring-offset-2 motion-reduce:transition-none ${
                  activeSlide === index
                    ? "w-7 bg-[#0D1282]"
                    : "w-2 bg-slate-300 hover:bg-slate-400"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
