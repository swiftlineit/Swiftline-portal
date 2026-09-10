"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FiGlobe, FiMail, FiPhone } from "react-icons/fi";

export default function PublicHeader() {
  const pathname = usePathname();

  const isTrack = pathname?.startsWith("/track");
  const isBusiness = pathname?.startsWith("/request/business-account");
  const isBooking = pathname?.startsWith("/book-shipment-online");

  const desktopNavClass =
    "relative inline-flex h-11 items-center px-3 text-sm font-semibold transition-colors";

  const mobileNavClass =
    "relative inline-flex h-10 flex-1 items-center justify-center text-sm font-semibold transition-colors";

  return (
    <header className="border-b border-white/10 bg-[#10175A] text-white">
      {/* Main header row */}
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link
          href="/"
          aria-label="Swiftline Cargo & Express"
          className="flex min-w-0 shrink-0 items-center gap-3"
        >
          <Image
            src="/slc_white_logo.png"
            alt="Swiftline Cargo"
            width={96}
            height={60}
            priority
            className="h-10 w-auto object-contain sm:h-11"
          />

          <div className="hidden border-l border-white/15 pl-3 sm:block">
            <p className="text-[11px] font-bold tracking-[0.08em] text-white">
              SWIFTLINE CARGO
            </p>
            <p className="mt-0.5 text-[11px] text-white/65">
              and express logistic pvt. ltd.
            </p>
          </div>
        </Link>

        {/* Desktop primary navigation */}
        <nav
          aria-label="Public navigation"
          className="hidden items-center gap-5 md:flex"
        >
          <Link
            href="/book-shipment-online"
            className={`${desktopNavClass} ${isBooking ? "text-white" : "text-white/65 hover:text-white"}`}
          >
            Book shipment
            {isBooking ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 bg-[#d71920]" /> : null}
          </Link>
          <Link
            href="/track"
            className={`${desktopNavClass} ${
              isTrack ? "text-white" : "text-white/65 hover:text-white"
            }`}
          >
            Track

            {isTrack ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 bottom-0 h-0.5 bg-[#d71920]"
              />
            ) : null}
          </Link>

          <Link
            href="/request/business-account"
            className={`${desktopNavClass} ${
              isBusiness ? "text-white" : "text-white/65 hover:text-white"
            }`}
          >
            Business account

            {isBusiness ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 bottom-0 h-0.5 bg-[#d71920]"
              />
            ) : null}
          </Link>
        </nav>

        {/* Desktop utilities */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="hidden items-center gap-4 xl:flex">
            {/* Contact */}
            <div className="flex flex-col items-end gap-1 border-r border-white/15 pr-4 text-right">
              <a
                href="tel:+917027116600"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white transition hover:text-[#DFF1F1]"
              >
                <FiPhone
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-[#BBD5DA]"
                />
                +91 70271 16600
              </a>

              <a
                href="mailto:Info@swiftlinefreight.com"
                className="inline-flex items-center gap-1.5 text-[11px] text-white/60 transition hover:text-white"
              >
                <FiMail
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                />
                Info@swiftlinefreight.com
              </a>
            </div>

            {/* Website */}
            <a
              href="https://swiftlinefreight.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-3 text-xs font-medium text-white/85 transition hover:border-white/25 hover:bg-white/10 hover:text-white"
            >
              <FiGlobe
                aria-hidden="true"
                className="h-3.5 w-3.5 text-[#BBD5DA]"
              />
              swiftlinefreight.com
            </a>
          </div>

          {/* Compact call action */}
          <a
            href="tel:+917027116600"
            aria-label="Call +91 70271 16600"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-white/[0.06] text-white transition hover:bg-white/10 xl:hidden"
          >
            <FiPhone aria-hidden="true" className="h-4 w-4" />
          </a>

          {/* Sign in */}
          <Link
            href="/"
            className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-4 text-xs font-bold text-[#10175A] transition hover:bg-[#DFF1F1]"
          >
            Sign in
          </Link>
        </div>
      </div>

      {/* Mobile navigation */}
      <nav
        aria-label="Public mobile navigation"
        className="flex border-t border-white/10 bg-[#0C124B] px-4 md:hidden"
      >
        <Link href="/book-shipment-online" className={`${mobileNavClass} ${isBooking ? "text-white" : "text-white/55 hover:text-white"}`}>
          Book
          {isBooking ? <span aria-hidden="true" className="absolute inset-x-8 bottom-0 h-0.5 bg-[#d71920]" /> : null}
        </Link>
        <span aria-hidden="true" className="my-2.5 w-px bg-white/10" />
        <Link
          href="/track"
          className={`${mobileNavClass} ${
            isTrack ? "text-white" : "text-white/55 hover:text-white"
          }`}
        >
          Track

          {isTrack ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-8 bottom-0 h-0.5 bg-[#d71920]"
            />
          ) : null}
        </Link>

        <span aria-hidden="true" className="my-2.5 w-px bg-white/10" />

        <Link
          href="/request/business-account"
          className={`${mobileNavClass} ${
            isBusiness ? "text-white" : "text-white/55 hover:text-white"
          }`}
        >
          Business account

          {isBusiness ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-8 bottom-0 h-0.5 bg-[#d71920]"
            />
          ) : null}
        </Link>
      </nav>
    </header>
  );
}
