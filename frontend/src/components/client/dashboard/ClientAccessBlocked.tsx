"use client";

import { FiAlertTriangle } from "react-icons/fi";
import Link from "next/link";
import type { ClientDashboardAccount } from "@/lib/clientDashboard";

export default function ClientAccessBlocked({ account }: { account: ClientDashboardAccount }) {
  const held = account.account.status === "suspended" && account.account.suspensionMode !== "SECURITY_LOCK";
  return (
    <section aria-labelledby="client-access-heading" className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
      <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-900">
            <FiAlertTriangle aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="client-access-heading" className="text-base font-semibold text-slate-950 sm:text-lg">{held ? "Business account on operational hold" : "Dashboard access is not ready"}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-700">
              {held
                ? account.account.suspensionMessage || "New bookings and account changes are paused. You can review records, pay existing dues and contact support."
                : `${account.account.company.companyName || account.account.accountId} cannot load the normal dashboard yet.`}
            </p>
            {!held && account.dashboardAccess.blockers.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {account.dashboardAccess.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul> : null}
          </div>
        </div>
        {held ? <nav aria-label="Available account actions" className="flex shrink-0 flex-wrap gap-2 lg:max-w-xs lg:justify-end">
          <Link href="/client/shipments" className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Shipments</Link>
          <Link href="/client/documents" className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Documents</Link>
          <Link href="/client/payments" className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Pay dues</Link>
          <Link href="/client/tickets" className="inline-flex min-h-10 items-center rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#171e91] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Contact support</Link>
        </nav> : null}
      </div>
    </section>
  );
}
