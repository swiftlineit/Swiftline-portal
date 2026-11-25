"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FiChevronDown, FiExternalLink } from "react-icons/fi";
import {
  getBranchFinanceSummary,
  type BranchFinanceSummary
} from "@/lib/branchReporting";
import { formatCompactMoney, titleCase } from "@/lib/dashboardOverview";
import { formatDashboardDateTime } from "@/lib/dateFormat";

type PeriodPreset = "TODAY" | "THIS_MONTH" | "FINANCIAL_YEAR" | "CUSTOM";

const paymentMethodLabels: Record<BranchFinanceSummary["individual"]["methods"][number]["method"], string> = {
  CASH: "Cash",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  CARD: "Card",
  CHEQUE: "Cheque"
};

function indiaToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function presetRange(preset: Exclude<PeriodPreset, "CUSTOM">) {
  const today = indiaToday();
  if (preset === "TODAY") return { from: today, to: today };
  if (preset === "THIS_MONTH") return { from: `${today.slice(0, 7)}-01`, to: today };

  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const financialYearStart = month >= 4 ? year : year - 1;
  return { from: `${financialYearStart}-04-01`, to: today };
}

function FinanceTile({
  label,
  amountMinor,
  currency,
  value,
  tone = "text-[#0D1282]"
}: {
  label: string;
  amountMinor?: number;
  currency?: string;
  value?: string | number;
  tone?: string;
}) {
  const display = amountMinor === undefined
    ? value ?? "-"
    : formatCompactMoney(amountMinor, currency);
  const exact = amountMinor === undefined ? undefined : formatMoneyMinor(amountMinor, currency);

  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-2 truncate text-lg font-bold ${tone}`} title={exact}>{display}</p>
    </div>
  );
}

function formatMoneyMinor(amountMinor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

export default function BranchFinanceSection({ branchId }: { branchId: string }) {
  const initialRange = presetRange("THIS_MONTH");
  const [preset, setPreset] = useState<PeriodPreset>("THIS_MONTH");
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [summary, setSummary] = useState<BranchFinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!from || !to) return;
    let active = true;

    async function loadSummary() {
      setLoading(true);
      setError("");
      try {
        const result = await getBranchFinanceSummary(branchId, from, to);
        if (active) setSummary(result);
      } catch (caughtError) {
        if (active) {
          setError(caughtError instanceof Error ? caughtError.message : "Branch finance could not be loaded.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadSummary();
    return () => { active = false; };
  }, [branchId, from, to]);

  function changePreset(next: PeriodPreset) {
    setPreset(next);
    if (next !== "CUSTOM") {
      const range = presetRange(next);
      setFrom(range.from);
      setTo(range.to);
    }
  }

  const currency = summary?.currency ?? "INR";

  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-52 text-sm font-semibold text-slate-700">
            Reporting period
            <div className="relative mt-2">
              <select
                value={preset}
                onChange={(event) => changePreset(event.target.value as PeriodPreset)}
                className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-normal outline-none focus:border-[#0D1282]"
              >
                <option value="TODAY">Today</option>
                <option value="THIS_MONTH">This month</option>
                <option value="FINANCIAL_YEAR">This financial year</option>
                <option value="CUSTOM">Custom</option>
              </select>
              <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            </div>
          </label>

          {preset === "CUSTOM" ? (
            <>
              <label className="block text-sm font-semibold text-slate-700">
                From
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-2 block h-10 rounded-lg border border-slate-300 px-3 text-sm font-normal outline-none focus:border-[#0D1282]"
                />
              </label>
              <label className="block text-sm font-semibold text-slate-700">
                To
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  max={indiaToday()}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-2 block h-10 rounded-lg border border-slate-300 px-3 text-sm font-normal outline-none focus:border-[#0D1282]"
                />
              </label>
            </>
          ) : null}

          <p className="pb-2 text-xs text-slate-500">
            Period figures use India-local calendar days. Credit exposure is the current balance.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      ) : null}

      {loading && !summary ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 shadow-sm">
          Loading branch finance…
        </div>
      ) : summary ? (
        <>
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-bold text-[#0D1282]">Business Accounts</h2>
              <p className="mt-1 text-sm text-slate-500">Invoices are historical shipment documents. New bookings are paid in full online or recorded against cash already received.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <FinanceTile label="Business Shipments" value={summary.business.shipments.toLocaleString("en-IN")} />
              <FinanceTile label="Amount Invoiced" amountMinor={summary.business.invoicedMinor} currency={currency} />
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-base font-bold text-[#0D1282]">Individual Shipments</h2>
              <p className="mt-1 text-sm text-slate-500">Money collected from and refunded to walk-in customers during the selected period.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <FinanceTile label="Individual Shipments" value={summary.individual.shipments.toLocaleString("en-IN")} />
              <FinanceTile label="Gross Collected" amountMinor={summary.individual.collectedMinor} currency={currency} tone="text-emerald-700" />
              <FinanceTile label="Refunded" amountMinor={summary.individual.refundedMinor} currency={currency} tone="text-red-700" />
              <FinanceTile label="Net Received" amountMinor={summary.individual.netMinor} currency={currency} />
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-5 py-4">
                <h3 className="font-bold text-slate-900">Payment Method Breakdown</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3 text-right">Collected</th>
                      <th className="px-4 py-3 text-right">Refunded</th>
                      <th className="px-4 py-3 text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.individual.methods.map((method) => (
                      <tr key={method.method} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 font-semibold text-slate-900">{paymentMethodLabels[method.method]}</td>
                        <td className="px-4 py-3 text-right text-emerald-700">{formatMoneyMinor(method.collectedMinor, currency)}</td>
                        <td className="px-4 py-3 text-right text-red-700">{formatMoneyMinor(method.refundedMinor, currency)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-900">{formatMoneyMinor(method.netMinor, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div>
                  <h3 className="font-bold text-slate-900">Recent Individual Transactions</h3>
                  <p className="mt-1 text-sm text-slate-500">Latest collections and refunds in this period.</p>
                </div>
                <Link href="/dashboard/counter-sales" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0D1282] hover:underline">
                  View all Counter Sales <FiExternalLink className="h-4 w-4" />
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Recorded</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Tracking</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Direction</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.individual.recentPayments.length ? summary.individual.recentPayments.map((payment) => (
                      <tr key={payment.id} className="border-b border-slate-100 last:border-0">
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDashboardDateTime(payment.recordedAt)}</td>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-900">{payment.customerName || "Not recorded"}</p>
                          <p className="text-xs text-slate-500">{payment.customerMobile}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{payment.trackingNumber || "-"}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{paymentMethodLabels[payment.method]}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${payment.direction === "COLLECTED" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                            {titleCase(payment.direction)}
                          </span>
                        </td>
                        <td className={`whitespace-nowrap px-4 py-3 text-right font-semibold ${payment.direction === "COLLECTED" ? "text-emerald-700" : "text-red-700"}`}>
                          {payment.direction === "COLLECTED" ? "+" : "−"}{formatMoneyMinor(payment.amountMinor, currency)}
                        </td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No individual transactions in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

        </>
      ) : null}
    </section>
  );
}
