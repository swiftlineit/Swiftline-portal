"use client";

import Link from "next/link";
import { FiCreditCard, FiInfo } from "react-icons/fi";
import type { ClientPrepaidAccount } from "@/lib/clientDashboard";

export default function ClientBookingCapacityNotice({
  wallet
}: {
  wallet?: ClientPrepaidAccount;
}) {
  if (!wallet || wallet.availableBalanceMinor > 0) return null;

  return (
    <section role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-200 text-amber-900">
            <FiInfo aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Pay before confirming a shipment</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-700">
              You can add money to the business wallet or pay securely by Razorpay when you confirm a shipment. Shipments cannot be booked until the full amount is paid.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col">
          <Link href="/client/dpd-labels" className="inline-flex h-10 items-center justify-center gap-2 rounded-4xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800">
            <FiCreditCard aria-hidden="true" /> Book and pay online
          </Link>
          <Link href="/client/payments#add-money" className="inline-flex h-10 items-center justify-center gap-2 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-blue-900 hover:border-blue-300">
            <FiCreditCard aria-hidden="true" /> Add wallet funds
          </Link>
        </div>
      </div>
    </section>
  );
}
