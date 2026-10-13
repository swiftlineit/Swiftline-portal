"use client";

import { useEffect, useState } from "react";
import { DashboardLoading } from "@/components/DashboardShell";
import { Branch, listBranches } from "@/lib/branches";
import {
  CounterSalePayment,
  CounterSalesTotals,
  listCounterSales,
} from "@/lib/counterSales";
import { formatMinorMoney } from "@/lib/dashboardOverview";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { COUNTER_SALES_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { FiChevronDown } from "react-icons/fi";

const methodLabels: Record<CounterSalePayment["method"], string> = {
  CASH: "Cash",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  CARD: "Card",
  CHEQUE: "Cheque",
};

export default function CounterSalesPage() {
  const { user, loading } = useAdminUser(COUNTER_SALES_AREA);
  const [payments, setPayments] = useState<CounterSalePayment[]>([]);
  const [totals, setTotals] = useState<CounterSalesTotals>({
    collectedMinor: 0,
    refundedMinor: 0,
    netMinor: 0,
  });
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [direction, setDirection] = useState<"" | "COLLECTED" | "REFUNDED">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;

    // `active` guards against a slower earlier request overwriting the results of
    // a newer one when filters are changed quickly.
    let active = true;

    async function load() {
      setBusy(true);
      setError("");
      try {
        const result = await listCounterSales({
          branchId,
          direction,
          from,
          to,
        });
        if (!active) return;
        setPayments(result.payments);
        setTotals(result.totals);
      } catch (caughtError) {
        if (!active) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Counter sales could not be loaded.",
        );
      } finally {
        if (active) setBusy(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [branchId, direction, from, to, user]);

  useEffect(() => {
    if (!user) return;
    // The branch filter is a convenience: the server scopes the rows regardless.
    listBranches("", "ACTIVE")
      .then((result) => setBranches(result.branches))
      .catch(() => setBranches([]));
  }, [user]);

  if (loading || !user) return <DashboardLoading />;

  return (
    <div className="mx-auto max-w-8xl">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Counter Sales</h1>
        <p className="mt-1 text-sm text-slate-500">
          Money taken from, and refunded to, individual customers. These
          shipments are paid in full before booking and never appear on a credit
          statement.
        </p>
      </div>

      <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-4">
        <label className="block text-sm font-semibold text-slate-700">
          Branch
          <div className="relative mt-2">
            <select
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              className="h-10 w-full appearance-none rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-normal outline-none focus:border-blue-900"
            >
              <option value="">All branches</option>
              {branches.map((branch) => (
                <option key={branch._id} value={branch._id}>
                  {branch.code} - {branch.name}
                </option>
              ))}
            </select>
            <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
          </div>
        </label>

        <label className="block text-sm font-semibold text-slate-700">
          Direction
          <div className="relative mt-2">
            <select
              value={direction}
              onChange={(event) =>
                setDirection(
                  event.target.value as "" | "COLLECTED" | "REFUNDED",
                )
              }
              className="h-10 w-full appearance-none rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-normal outline-none focus:border-blue-900"
            >
              <option value="">Collected and refunded</option>
              <option value="COLLECTED">Collected only</option>
              <option value="REFUNDED">Refunded only</option>
            </select>
            <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
          </div>
        </label>

        <label className="block text-sm font-semibold text-slate-700">
          From
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-2 h-10 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal outline-none focus:border-blue-900"
          />
        </label>

        <label className="block text-sm font-semibold text-slate-700">
          To
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="mt-2 h-10 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal outline-none focus:border-blue-900"
          />
        </label>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Collected
          </p>
          <p className="mt-1 text-lg font-semibold text-emerald-700">
            {formatMinorMoney(totals.collectedMinor)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Refunded
          </p>
          <p className="mt-1 text-lg font-semibold text-red-700">
            {formatMinorMoney(totals.refundedMinor)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Net
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {formatMinorMoney(totals.netMinor)}
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="bg-slate-100 text-black">
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Recorded
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Customer
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Tracking
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Branch
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Method
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-xs font-semibold uppercase tracking-wide">
                  Reference
                </th>
                <th className="whitespace-nowrap px-4 py-3.5 text-right text-xs font-semibold uppercase tracking-wide">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {busy ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-slate-500"
                  >
                    Loading counter sales...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-slate-500"
                  >
                    No counter sales for this filter.
                  </td>
                </tr>
              ) : (
                payments.map((payment, index) => (
                  <tr
                    key={payment.id}
                    className={`border-b border-slate-100 last:border-0 ${index % 2 === 0 ? "bg-white" : "bg-[#FAFAFA]"}`}
                  >
                    <td className="px-4 py-4 text-slate-600">
                      {formatDashboardDateTime(payment.recordedAt)}
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-slate-900">
                        {payment.customerName || "Not recorded"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {payment.customerMobile}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {payment.trackingNumber || "-"}
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {payment.branch?.code ?? "-"}
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {methodLabels[payment.method]}
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {payment.reference || "-"}
                    </td>
                    <td
                      className={`px-4 py-4 text-right font-semibold ${
                        payment.direction === "COLLECTED"
                          ? "text-emerald-700"
                          : "text-red-700"
                      }`}
                    >
                      {payment.direction === "COLLECTED" ? "+" : "-"}
                      {formatMinorMoney(payment.amountMinor)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
