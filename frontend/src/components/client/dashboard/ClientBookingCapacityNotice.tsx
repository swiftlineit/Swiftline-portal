"use client";

import Link from "next/link";
import { FiCreditCard, FiInfo } from "react-icons/fi";

export default function ClientBookingCapacityNotice() {
  return (
    <section role="status" className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-200 text-blue-950">
            <FiInfo aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Pay when you confirm a shipment</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-700">
              Pay the full shipment amount online when you confirm a booking. You can review every payment in the payments ledger.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col">
          <Link href="/client/dpd-labels" className="inline-flex h-10 items-center justify-center gap-2 rounded-4xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800">
            <FiCreditCard aria-hidden="true" /> Book and pay online
          </Link>
          <Link href="/client/payments#payments-ledger" className="inline-flex h-10 items-center justify-center gap-2 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-blue-900 hover:border-blue-300">
            <FiCreditCard aria-hidden="true" /> View payments
          </Link>
        </div>
      </div>
    </section>
  );
}
