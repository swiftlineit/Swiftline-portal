"use client";

import Link from "next/link";
import { FiArrowRight } from "react-icons/fi";
import type { QuickLink } from "@/lib/dashboardOverview";

export default function AdminQuickAccess({
  links,
}: {
  links: QuickLink[];
}) {
  if (!links.length) return null;

  return (
    <>
      <style jsx>{`
        @keyframes adminArrowNudge {
          0%,
          100% {
            transform: translateX(0);
          }

          50% {
            transform: translateX(4px);
          }
        }
      `}</style>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-5">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-slate-900">
            Quick access
          </h2>

          <p className="mt-0.5 text-[11px] text-slate-400">
            Modules available to your role
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {links.map((link, index) => (
            <Link
              key={`${link.href}:${index}`}
              href={link.href}
              className="group flex min-h-33 flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/40 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#0D1282]/25 hover:bg-white hover:shadow-[0_10px_26px_-18px_rgba(13,18,130,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/20 focus-visible:ring-offset-2"
            >
              <div>
                <h3 className="text-[13px] font-semibold text-slate-900 transition-colors duration-200 group-hover:text-[#0D1282]">
                  {link.label}
                </h3>

                <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-slate-500">
                  {link.description}
                </p>
              </div>

              <div className="mt-4 flex justify-end">
                <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white text-[#0D1282] transition-all duration-200 group-hover:border-[#0D1282] group-hover:bg-[#0D1282] group-hover:text-white group-hover:shadow-[0_5px_14px_-7px_rgba(13,18,130,0.55)]">
                  <FiArrowRight
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-[adminArrowNudge_1.6s_ease-in-out_infinite] transition-transform duration-200 group-hover:animate-none group-hover:translate-x-0.5"
                  />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
