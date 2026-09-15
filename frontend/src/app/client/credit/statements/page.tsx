"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FiDownload, FiFileText, FiRefreshCw } from "react-icons/fi";
import { toast } from "react-toastify";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import CreditRestrictionAlert from "@/components/credit/CreditRestrictionAlert";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange, type DateRange } from "@/lib/dateRange";
import {
  closeClientCycle,
  listClientStatements,
  openAuthenticatedFile,
  type CreditStatement,
} from "@/lib/creditBilling";
import {
  getClientDashboard,
  type ClientDashboardAccount,
} from "@/lib/clientDashboard";
import {
  getClientCreditAccount,
  type CreditAccount,
} from "@/lib/creditAccounts";
import { formatDashboardDate } from "@/lib/dateFormat";
import { useClientUser } from "@/lib/useClientUser";

function money(valueMinor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(valueMinor / 100);
}

function Status({ value }: { value: CreditStatement["status"] }) {
  const tone =
    value === "PAID"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : value === "OVERDUE"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-amber-200 bg-amber-50 text-amber-700";
  return (
    <span
      className={`inline-flex border px-2 py-1 text-xs font-semibold ${tone}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

export default function ClientCreditStatementsPage() {
  const { user, loading: userLoading } = useClientUser();
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [statements, setStatements] = useState<CreditStatement[]>([]);
  const [creditAccount, setCreditAccount] = useState<CreditAccount | null>(
    null,
  );
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const selectedAccount = useMemo(
    () =>
      accounts.find((item) => item.account.id === businessAccountId) ?? null,
    [accounts, businessAccountId],
  );

  const loadStatements = useCallback(
    async (accountId: string, filter: DateRange) => {
      const [statementResult, creditResult] = await Promise.all([
        listClientStatements(accountId, { dateRange: filter }),
        getClientCreditAccount(accountId),
      ]);
      setStatements(statementResult.statements);
      setCreditAccount(creditResult.creditAccount);
    },
    [],
  );

  // Discovers the eligible business accounts once per signed-in user.
  useEffect(() => {
    if (!user) return;
    let active = true;
    void (async () => {
      try {
        const dashboard = await getClientDashboard();
        const eligible = dashboard.accounts.filter((item) =>
          ["account_owner", "account_admin", "finance"].includes(
            item.membership.role,
          ),
        );
        const firstId = eligible[0]?.account.id ?? "";
        if (!active) return;
        setAccounts(eligible);
        setBusinessAccountId(firstId);
        if (!firstId)
          toast.error("Your account role cannot access credit statements.");
      } catch (caught) {
        if (active)
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Statements could not be loaded.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [user]);

  // Re-fetches statements whenever the selected account or date filter changes.
  useEffect(() => {
    if (!businessAccountId) return;
    setLoading(true);
    loadStatements(businessAccountId, dateRange)
      .catch((caught) =>
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Statements could not be loaded.",
        ),
      )
      .finally(() => setLoading(false));
  }, [businessAccountId, dateRange, loadStatements]);

  async function closeCycle() {
    if (!businessAccountId) return;
    setBusy(true);
    try {
      const result = await closeClientCycle(businessAccountId);
      toast.success(result.message);
      await loadStatements(businessAccountId, dateRange);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "The billing cycle could not be closed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (userLoading || !user) return <ClientDashboardLoading />;

  return (
    <div className="mx-auto max-w-8xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">
            Credit Statements
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Review shipment invoices grouped for credit collection.
          </p>
        </div>
        <div className="flex gap-2">
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <Link
            href={
              businessAccountId
                ? `/client/credit/ledger?businessAccountId=${businessAccountId}`
                : "/client/credit/ledger"
            }
            className="inline-flex h-10 rounded-4xl items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <FiFileText /> Account Statement & Ledger
          </Link>
          {selectedAccount?.membership.role === "finance" ? (
            <button
              type="button"
              onClick={() => void closeCycle()}
              disabled={busy}
              className="inline-flex h-10 items-center gap-2 bg-blue-900 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              <FiRefreshCw className={busy ? "animate-spin" : ""} /> Close
              Completed Cycle
            </button>
          ) : null}
        </div>
      </div>

      {accounts.length > 1 ? (
        <select
          value={businessAccountId}
          onChange={(event) => setBusinessAccountId(event.target.value)}
          className="h-11 w-full max-w-md border border-slate-300 bg-white px-3 text-sm font-semibold"
        >
          {accounts.map((account) => (
            <option key={account.account.id} value={account.account.id}>
              {account.account.company.companyName} ({account.account.accountId}
              )
            </option>
          ))}
        </select>
      ) : null}

      <CreditRestrictionAlert
        restriction={creditAccount?.restriction}
        gracePeriodDays={creditAccount?.gracePeriodDays}
      />

      <section
        id="statements-list"
        className="overflow-x-auto border border-slate-200 bg-white rounded-2xl"
      >
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Statement</th>
              <th className="px-4 py-3">Period</th>
              <th className="px-4 py-3">Due Date</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Outstanding</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {statements.map((statement) => (
              <tr
                key={statement.id}
                className="border-b border-slate-100 last:border-0"
              >
                <td className="px-4 py-4 font-semibold text-slate-950">
                  {statement.statementNumber}
                </td>
                <td className="px-4 py-4 text-slate-600">
                  {formatDashboardDate(statement.periodStart)} to{" "}
                  {formatDashboardDate(
                    new Date(
                      new Date(statement.periodEnd).getTime() - 1,
                    ).toISOString(),
                  )}
                </td>
                <td className="px-4 py-4 text-slate-700">
                  {formatDashboardDate(statement.dueAt)}
                </td>
                <td className="px-4 py-4 text-right font-medium">
                  {money(statement.totalAmountMinor)}
                </td>
                <td className="px-4 py-4 text-right font-semibold">
                  {money(statement.outstandingAmountMinor)}
                </td>
                <td className="px-4 py-4">
                  <Status value={statement.status} />
                </td>
                <td className="px-4 py-4">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/client/credit/statements/${statement.id}?businessAccountId=${businessAccountId}`}
                      className="inline-flex h-8 items-center border rounded-lg hover:bg-blue-900 hover:text-white border-slate-300 px-3 font-semibold text-blue-900"
                    >
                      View
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        void openAuthenticatedFile(
                          `/api/v1/client/credit/statements/${statement.id}/pdf?businessAccountId=${businessAccountId}&download=1`,
                          `${statement.statementNumber.replaceAll("/", "-")}.pdf`,
                        )
                      }
                      className="flex h-8 w-8 items-center rounded-lg justify-center border border-slate-300 text-blue-900 hover:bg-blue-900 hover:text-white"
                      title="Download PDF"
                    >
                      <FiDownload />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !statements.length ? (
          <p className="p-10 text-center text-sm text-slate-500">
            No credit statements have been generated for this account.
          </p>
        ) : null}
        {loading ? (
          <p className="p-10 text-center text-sm font-semibold text-slate-500">
            Loading statements...
          </p>
        ) : null}
      </section>
    </div>
  );
}
