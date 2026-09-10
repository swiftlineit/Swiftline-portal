"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getDashboardBannerImage,
  getDashboardBanners,
  type DashboardBanner as DashboardBannerData,
} from "@/lib/dashboardBanner";

type BannerSlide = {
  banner: DashboardBannerData;
  imageSrc: string;
};

export default function DashboardBanner() {
  const [slides, setSlides] = useState<BannerSlide[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];

    async function load() {
      setLoading(true);
      setError("");

      try {
        const result = await getDashboardBanners();

        const visibleBanners = result.banners.filter(
          (banner) => banner.visible,
        );

        const loadedSlides = await Promise.all(
          visibleBanners.map(async (banner) => {
            const image = await getDashboardBannerImage(banner.id);
            const imageSrc = URL.createObjectURL(image);

            objectUrls.push(imageSrc);

            return {
              banner,
              imageSrc,
            };
          }),
        );

        if (!active) return;

        setSlides(loadedSlides);
        setCurrentIndex(0);
      } catch (caught) {
        if (!active) return;

        setError(
          caught instanceof Error
            ? caught.message
            : "Banner could not be loaded.",
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    const timer = window.setTimeout(() => void load(), 0);

    return () => {
      active = false;
      window.clearTimeout(timer);

      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (slides.length < 2 || isPaused) return undefined;

    const timer = window.setInterval(() => {
      setCurrentIndex((index) => (index + 1) % slides.length);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [isPaused, slides.length]);

  const slide = slides[currentIndex] ?? null;

  const slideLabel = useMemo(() => {
    if (!slide) return "Dashboard banner";

    return slide.banner.heading || "Swiftline dashboard update";
  }, [slide]);

  /*
   * Keep the shared dashboard hero background visible while checking
   * for banners instead of introducing a separate loading surface.
   */
  if (loading) {
    return (
      <div
        aria-label="Loading dashboard banner"
        className="relative h-full min-h-52.5 w-full overflow-hidden bg-transparent sm:min-h-55 lg:min-h-[240px]"
      >
        <div className="absolute inset-0 animate-pulse bg-[#0D1282]/[0.012]" />
      </div>
    );
  }

  /*
   * When no banner exists, continue the parent's shared background and
   * use the empty right side for a subtle straight logistics-route abstract.
   */
  if (!slide) {
    return (
      <div
        aria-label="No dashboard banner"
        className="relative h-full min-h-52.5 w-full overflow-hidden bg-transparent sm:min-h-55 lg:min-h-[240px]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          {/* Soft depth from the right */}
          <div className="absolute inset-y-0 right-0 w-[78%] bg-[linear-gradient(110deg,transparent_0%,rgba(13,18,130,0.015)_42%,rgba(13,18,130,0.045)_100%)]" />

          <div className="absolute right-[5%] top-1/2 h-32 w-[52%] -translate-y-1/2 rounded-full bg-[#0D1282]/[0.025] blur-3xl" />

          {/* Desktop straight logistics route */}
          <div className="absolute right-[5%] top-1/2 hidden h-[120px] w-[76%] -translate-y-1/2 lg:block">
            {/* Main straight route */}
            <span className="absolute left-[4%] right-[6%] top-1/2 h-px -translate-y-1/2 bg-[#0D1282]/10" />

            {/* Start node */}
            <span className="absolute left-[2%] top-1/2 flex h-4 w-4 -translate-y-1/2 rotate-45 items-center justify-center rounded-[3px] border border-[#0D1282]/15 bg-white/80">
              <span className="h-1.5 w-1.5 rounded-[1px] bg-[#0D1282]/30" />
            </span>

            {/* Checkpoint 1 */}
            <span className="absolute left-[29%] top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 rotate-45 items-center justify-center rounded-[3px] border border-[#0D1282]/15 bg-[#f7f8ff]">
              <span className="h-1 w-1 rounded-[1px] bg-[#0D1282]/35" />
            </span>

            {/* Checkpoint 2 */}
            <span className="absolute left-[52%] top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 rotate-45 items-center justify-center rounded-[3px] border border-[#0D1282]/15 bg-[#f7f8ff]">
              <span className="h-1 w-1 rounded-[1px] bg-[#0D1282]/35" />
            </span>

            {/* Checkpoint 3 */}
            <span className="absolute left-[74%] top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 rotate-45 items-center justify-center rounded-[3px] border border-[#0D1282]/15 bg-[#f7f8ff]">
              <span className="h-1 w-1 rounded-[1px] bg-[#0D1282]/35" />
            </span>

            {/* Destination */}
            <span className="absolute right-[1%] top-1/2 flex h-9 w-9 -translate-y-1/2 rotate-45 items-center justify-center rounded-[7px] border border-[#0D1282]/15 bg-white/65">
              <span className="flex h-5 w-5 items-center justify-center rounded-[4px] bg-[#0D1282]/[0.07]">
                <span className="h-2 w-2 rounded-xs bg-[#0D1282]/35" />
              </span>
            </span>

            {/* Upper secondary straight route */}
            <span className="absolute right-[14%] top-[22%] h-px w-[30%] bg-[#0D1282]/[0.055]" />

            <span className="absolute right-[43%] top-[22%] h-2.5 w-2.5 -translate-y-1/2 rotate-45 rounded-xs border border-[#0D1282]/10 bg-white/55" />

            <span className="absolute right-[27%] top-[22%] h-1.5 w-1.5 -translate-y-1/2 rotate-45 bg-[#0D1282]/15" />

            <span className="absolute right-[14%] top-[22%] h-2.5 w-2.5 -translate-y-1/2 rotate-45 rounded-xs border border-[#0D1282]/10 bg-white/55" />

            {/* Lower secondary straight route */}
            <span className="absolute right-[20%] top-[78%] h-px w-[38%] bg-[#0D1282]/[0.05]" />

            <span className="absolute right-[56%] top-[78%] h-2 w-2 -translate-y-1/2 rotate-45 border border-[#0D1282]/10 bg-white/60" />

            <span className="absolute right-[40%] top-[78%] h-1.5 w-1.5 -translate-y-1/2 rotate-45 bg-[#0D1282]/15" />

            <span className="absolute right-[28%] top-[78%] h-1 w-1 -translate-y-1/2 rotate-45 bg-[#0D1282]/10" />

            <span className="absolute right-[19%] top-[78%] h-2 w-2 -translate-y-1/2 rotate-45 border border-[#0D1282]/10 bg-white/60" />

            {/* Small vertical markers for subtle structure */}
            <span className="absolute left-[29.5%] top-[31%] h-5 w-px bg-[#0D1282]/4.5" />

            <span className="absolute left-[52.5%] top-[58%] h-5 w-px bg-[#0D1282]/4" />

            <span className="absolute left-[74.5%] top-[30%] h-5 w-px bg-[#0D1282]/4" />
          </div>

          {/* Tablet simplified straight route */}
          <div className="absolute right-7 top-1/2 hidden w-[58%] -translate-y-1/2 items-center md:flex lg:hidden">
            <span className="h-2.5 w-2.5 shrink-0 rotate-45 rounded-xs border border-[#0D1282]/15 bg-white/70" />

            <span className="h-px flex-1 bg-[#0D1282]/10" />

            <span className="mx-2 h-3 w-3 shrink-0 rotate-45 rounded-xs border border-[#0D1282]/15 bg-white/70" />

            <span className="h-px w-16 shrink-0 bg-[#0D1282]/10" />

            <span className="ml-2 h-5 w-5 shrink-0 rotate-45 rounded-[4px] border border-[#0D1282]/15 bg-white/70" />
          </div>
        </div>

        {error ? (
          <p className="absolute bottom-4 right-4 z-20 max-w-sm rounded-lg border border-red-100 bg-white/90 px-3 py-2 text-xs font-medium text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-label="Dashboard banner"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      className="group relative h-full min-h-52.5 overflow-hidden bg-slate-900 sm:min-h-55 lg:min-h-[240px]"
    >
      {/* Banner image */}
      <img
        src={slide.imageSrc}
        alt={slideLabel}
        className="absolute inset-0 h-full w-full object-fill transition-transform duration-700 ease-out group-hover:scale-[1.025]"
      />

     

      {/* Banner copy */}
      <div className="relative z-10 flex h-full min-h-52.5 flex-col justify-end px-5 py-5 text-white sm:min-h-55 sm:px-6 sm:py-6 lg:min-h-60 lg:px-7 lg:py-7">
        <div className="max-w-130">
          {slide.banner.heading ? (
            <h2 className="text-[19px] font-semibold leading-[1.2] tracking-[-0.02em] text-white drop-shadow-sm sm:text-[21px] lg:text-[22px]">
              {slide.banner.heading}
            </h2>
          ) : null}

          {slide.banner.description ? (
            <p className="mt-1.5 line-clamp-2 max-w-120 text-[13px] leading-5 text-white/85 sm:text-sm">
              {slide.banner.description}
            </p>
          ) : null}

          {slides.length > 1 ? (
            <div
              className="mt-4 flex items-center gap-1.5"
              aria-label={`Banner ${currentIndex + 1} of ${slides.length}`}
            >
              {slides.map((item, index) => (
                <button
                  key={item.banner.id}
                  type="button"
                  onClick={() => setCurrentIndex(index)}
                  aria-label={`Show banner ${index + 1}`}
                  aria-current={
                    index === currentIndex ? "true" : undefined
                  }
                  className={`h-1.5 rounded-full transition-all duration-200 ${
                    index === currentIndex
                      ? "w-7 bg-white"
                      : "w-1.5 bg-white/45 hover:bg-white/75"
                  }`}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="absolute left-4 right-4 top-4 z-30 rounded-lg border border-red-100 bg-white/95 px-3 py-2 text-xs font-medium text-red-700 shadow-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}