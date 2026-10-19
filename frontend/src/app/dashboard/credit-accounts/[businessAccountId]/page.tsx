"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FiDownload, FiRefreshCw, FiChevronDown, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { creditLedgerFunding, creditLedgerLabel } from "@/lib/creditLedgerLabels";
import { DashboardLoading } from "@/components/DashboardShell";
import CreditSummaryCards from "@/components/credit/CreditSummaryCards";
import CreditRestrictionAlert from "@/components/credit/CreditRestrictionAlert";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import Pagination from "@/components/ui/Pagination";
import { emptyDateRange } from "@/lib/dateRange";
import {
  closeAdminCycle,
  ledgerExportRanges,
  listAdminCreditPayments,
  listAdminLedger,
  listAdminStatements,
  openAuthenticatedFile,
  recordAdminOfflinePayment,
  verifyAdminOfflinePayment,
  withLedgerExportRange,
  writeOffAdminStatement,
  MAX_OFFLINE_PAYMENT_RUPEES,
  type CreditLedgerEntry,
  type CreditListPagination,
  type CreditPayment,
  type CreditStatement
} from "@/lib/creditBilling";
import {
  closeCreditAccount,
  getAdminCreditAccount,
  reactivateCreditAccount,
  suspendCreditAccount,
  type AwaitingCollection,
  type CreditAccount
} from "@/lib/creditAccounts";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/dateFormat";
import { CREDIT_VIEW_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { useDialog } from "@/lib/useDialog";

// Formats a minor-unit (paise) integer as an INR currency string.
function money(valueMinor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(valueMinor / 100);
}

// Converts a SCREAMING_SNAKE_CASE enum value into "Title Case" for display.
function title(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

const emptyListPagination: CreditListPagination = { page: 1, limit: 20, total: 0, totalPages: 1 };
const statementStatuses = ["ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"];
const paymentStatuses = ["CREATED", "PENDING_VERIFICATION", "PROCESSING", "VERIFIED", "FAILED"];

export default function AdminCreditAccountDetailPage() {
  // Operations reads statements, payments, and the ledger. Recording payments,
  // writing off, closing cycles, and lifecycle changes stay with finance.
  const { user, loading: userLoading } = useAdminUser(CREDIT_VIEW_AREA);
  const canSettle = user?.role === "admin" || user?.role === "finance";
  const params = useParams<{ businessAccountId: string }>();
  const accountId = params.businessAccountId;

  // Core data for the page: account details, statements, payments, ledger.
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [statements, setStatements] = useState<CreditStatement[]>([]);
  const [payments, setPayments] = useState<CreditPayment[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [awaitingCollection, setAwaitingCollection] = useState<AwaitingCollection | null>(null);

  // Independent filter + pagination state for each of the three tables below.
  const [statementStatus, setStatementStatus] = useState("");
  const [statementRange, setStatementRange] = useState(emptyDateRange);
  const [statementPage, setStatementPage] = useState(1);
  const [statementPagination, setStatementPagination] = useState(emptyListPagination);
  const [paymentStatus, setPaymentStatus] = useState("");
  const [paymentRange, setPaymentRange] = useState(emptyDateRange);
  const [paymentPage, setPaymentPage] = useState(1);
  const [paymentPagination, setPaymentPagination] = useState(emptyListPagination);
  const [ledgerRange, setLedgerRange] = useState(emptyDateRange);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPagination, setLedgerPagination] = useState(emptyListPagination);
  // The export period is chosen only when the export dialog is opened.
  const [exportRange, setExportRange] = useState("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // "Record Offline Payment" form state.
  const [statementId, setStatementId] = useState("");
  const [amountRupees, setAmountRupees] = useState("");
  const [method, setMethod] = useState<"BANK_TRANSFER" | "UPI" | "CASH" | "CHEQUE">("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  // Page-level UI state.
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [highlightStatements, setHighlightStatements] = useState(false);
  const [highlightLedger, setHighlightLedger] = useState(false);
  const exportDialogRef = useDialog<HTMLDivElement>(exportDialogOpen, () => {
    if (busy !== "ledger-export") setExportDialogOpen(false);
  });

  // Loads the account, statements, payments, and ledger together, then
  // pre-fills the payment form with the oldest outstanding statement.
  const load = useCallback(async () => {
    const [accountResult, statementResult, paymentResult, ledgerResult] = await Promise.all([
      getAdminCreditAccount(accountId),
      listAdminStatements(accountId, { status: statementStatus, dateRange: statementRange, page: statementPage, limit: 10 }),
      listAdminCreditPayments(accountId, { status: paymentStatus, dateRange: paymentRange, page: paymentPage, limit: 10 }),
      listAdminLedger(accountId, { dateRange: ledgerRange, page: ledgerPage, limit: 20 })
    ]);

    setAccount(accountResult.creditAccount);
    setAwaitingCollection(accountResult.awaitingCollection);
    setStatements(statementResult.statements);
    setStatementPagination(statementResult.pagination);
    setPayments(paymentResult.payments);
    setPaymentPagination(paymentResult.pagination);
    setLedger(ledgerResult.entries);
    setLedgerPagination(ledgerResult.pagination);

    const unpaid = statementResult.statements.find((item) => item.outstandingAmountMinor > 0);
    setStatementId((current) => current || unpaid?.id || "");
    setAmountRupees((current) => current || (unpaid ? String(unpaid.outstandingAmountMinor / 100) : ""));
  }, [accountId, statementStatus, statementRange, statementPage, paymentStatus, paymentRange, paymentPage, ledgerRange, ledgerPage]);

  // Initial load and any re-fetch triggered by a filter or page change below.
  useEffect(() => {
    if (!user) return;

    const initialLoad = window.setTimeout(() => {
      void load()
        .catch((caught) => toast.error(caught instanceof Error ? caught.message : "Credit account could not be loaded."))
        .finally(() => setLoading(false));
    }, 0);

    return () => window.clearTimeout(initialLoad);
  }, [load, user]);

  // Follow section links after the account data has loaded, then briefly mark
  // the destination so staff can spot the section they selected.
  useEffect(() => {
    if (loading) return;
    const highlightFromHash = () => {
      const hash = window.location.hash;
      const targetId = hash === "#billing-statements" || hash === "#statements"
        ? "billing-statements"
        : hash === "#credit-ledger"
          ? "credit-ledger"
          : null;
      if (!targetId) return;

      const element = document.getElementById(targetId);
      if (element) {
        window.requestAnimationFrame(() => {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        if (targetId === "billing-statements") {
          setHighlightStatements(true);
          window.setTimeout(() => setHighlightStatements(false), 2800);
        } else {
          setHighlightLedger(true);
          window.setTimeout(() => setHighlightLedger(false), 2800);
        }
      }
    };
    highlightFromHash();
    window.addEventListener("hashchange", highlightFromHash);
    return () => window.removeEventListener("hashchange", highlightFromHash);
  }, [loading]);

  // Closes the currently completed billing cycle.
  async function closeCycle() {
    setBusy("cycle");
    try {
      const result = await closeAdminCycle(accountId);
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Billing cycle could not be closed.");
    } finally {
      setBusy("");
    }
  }

  // Validates and submits the "Record Offline Payment" form.
  async function recordPayment(event: FormEvent) {
    event.preventDefault();

    const amountMinor = Math.round(Number(amountRupees) * 100);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid payment amount.");
      return;
    }
    if (amountMinor > MAX_OFFLINE_PAYMENT_RUPEES * 100) {
      toast.error(`A single offline payment cannot exceed ${money(MAX_OFFLINE_PAYMENT_RUPEES * 100)}.`);
      return;
    }
    if (reference.trim().length < 3) {
      toast.error("Enter the offline payment reference.");
      return;
    }

    setBusy("payment");
    try {
      const result = await recordAdminOfflinePayment(accountId, {
        requestedStatementId: statementId,
        amountMinor,
        method,
        externalReference: reference.trim(),
        notes: notes.trim()
      });
      toast.success(result.message);
      setReference("");
      setNotes("");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Offline payment could not be recorded.");
    } finally {
      setBusy("");
    }
  }

  // Shared handler for suspend / reactivate / close lifecycle actions,
  // each of which requires the admin to type a reason first.
  async function runLifecycle(kind: "suspend" | "reactivate" | "close") {
    const reason = window.prompt(`Reason to ${kind} this credit facility:`)?.trim();
    if (!reason) return;
    if (reason.length < 5) {
      toast.error("Provide a reason of at least 5 characters.");
      return;
    }

    setBusy(kind);
    try {
      const action = kind === "suspend" ? suspendCreditAccount : kind === "reactivate" ? reactivateCreditAccount : closeCreditAccount;
      const result = await action(accountId, reason);
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The credit facility could not be updated.");
    } finally {
      setBusy("");
    }
  }

  // Writes off some or all of a statement's outstanding balance.
  async function writeOff(statement: CreditStatement) {
    const rupees = window
      .prompt(`Write-off amount (INR) for ${statement.statementNumber}:`, String(statement.outstandingAmountMinor / 100))
      ?.trim();
    if (!rupees) return;

    const amountMinor = Math.round(Number(rupees) * 100);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid write-off amount.");
      return;
    }

    const reason = window.prompt("Reason for the write-off:")?.trim();
    if (!reason || reason.length < 5) {
      toast.error("Provide a write-off reason of at least 5 characters.");
      return;
    }

    setBusy(`writeoff:${statement.id}`);
    try {
      const result = await writeOffAdminStatement(accountId, statement.id, { amountMinor, reason });
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The statement could not be written off.");
    } finally {
      setBusy("");
    }
  }

  // Verifies a pending offline payment so it's applied to the account.
  async function verify(paymentId: string) {
    setBusy(paymentId);
    try {
      const result = await verifyAdminOfflinePayment(accountId, paymentId);
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Offline payment could not be verified.");
    } finally {
      setBusy("");
    }
  }

  async function exportLedger() {
    setBusy("ledger-export");
    try {
      await openAuthenticatedFile(
        withLedgerExportRange(`/api/v1/credit-accounts/${accountId}/ledger/export`, exportRange),
        "credit-account-ledger.csv"
      );
      setExportDialogOpen(false);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The ledger could not be exported.");
    } finally {
      setBusy("");
    }
  }

  if (userLoading || !user) return <DashboardLoading />;

  return (
    <div className="mx-auto max-w-8xl space-y-5">
      {/* Page header: account identity + lifecycle actions */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {/* <Link href="/dashboard/credit-accounts" className="text-sm font-semibold text-blue-900">
              Back to credit accounts
            </Link> */}
            <h1 className="mt-2 text-2xl font-semibold text-slate-950">
              {account?.businessAccount?.companyName || "Credit Account"}
            </h1>
            <p className="mt-1 text-sm text-slate-500">{account?.businessAccount?.accountId}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setExportDialogOpen(true)}
              className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-blue-900 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20"
            >
              <FiDownload /> Export Ledger
            </button>

            {canSettle ? (
              <button
                type="button"
                onClick={() => void closeCycle()}
                disabled={busy === "cycle"}
                className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-blue-900 disabled:opacity-60"
              >
                <FiRefreshCw className={busy === "cycle" ? "animate-spin" : ""} /> Close Completed Cycle
              </button>
            ) : null}

            {/* Lifecycle actions are conditional on the account's current status */}
            {canSettle && account?.status === "ACTIVE" ? (
              <button
                type="button"
                onClick={() => void runLifecycle("suspend")}
                disabled={busy === "suspend"}
                className="inline-flex h-10 items-center gap-2 rounded-4xl border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-800 disabled:opacity-60"
              >
                {busy === "suspend" ? "Suspending..." : "Suspend"}
              </button>
            ) : null}

            {canSettle && account?.status === "SUSPENDED" ? (
              <button
                type="button"
                onClick={() => void runLifecycle("reactivate")}
                disabled={busy === "reactivate"}
                className="inline-flex h-10 items-center gap-2 rounded-4xl border border-emerald-300 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 disabled:opacity-60"
              >
                {busy === "reactivate" ? "Reactivating..." : "Reactivate"}
              </button>
            ) : null}

            {canSettle && account && ["APPROVED", "ACTIVE", "SUSPENDED", "EXPIRED", "REJECTED"].includes(account.status) ? (
              <button
                type="button"
                onClick={() => void runLifecycle("close")}
                disabled={busy === "close"}
                className="inline-flex h-10 items-center gap-2 rounded-4xl border border-red-300 bg-red-50 px-4 text-sm font-semibold text-red-700 disabled:opacity-60"
              >
                {busy === "close" ? "Closing..." : "Close"}
              </button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm font-semibold   rounded-xl  text-slate-500">Loading credit account...</div>
        ) : null}

        {/* Account summary + any active restriction notice */}
        {account ? <CreditSummaryCards account={account} /> : null}

        {/* Charges that exist but cannot be billed yet. Absent from every
            balance above, so without this line the money is invisible. */}
        {awaitingCollection && awaitingCollection.count > 0 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">{money(awaitingCollection.valueMinor)}</span>
            <span>
              across {awaitingCollection.count} shipment{awaitingCollection.count === 1 ? "" : "s"} awaiting collection
            </span>
            {awaitingCollection.oldestIssuedAt ? (
              <span className="text-amber-700">· oldest booked {formatDashboardDate(awaitingCollection.oldestIssuedAt)}</span>
            ) : null}
            <span className="w-full text-xs text-amber-700">
              Billing starts at collection, so these are not yet on any statement.
            </span>
          </div>
        ) : null}
        {account ? <CreditRestrictionAlert restriction={account.restriction} gracePeriodDays={account.gracePeriodDays} /> : null}

        {/* Billing statements table */}
        <section
          id="billing-statements"
          className={`overflow-x-auto border bg-white rounded-2xl scroll-mt-6 transition-all duration-500 ${highlightStatements ? "border-amber-400 ring-4 ring-amber-200 shadow-lg" : "border-slate-200"}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5">
            <div>
              <h2 className="font-semibold text-slate-950">Billing Statements</h2>
              <p className="mt-1 text-sm text-slate-500">Finalized shipment invoices grouped by completed billing period.</p>
            </div>
            <div className="flex items-center gap-2">
              <DateRangeFilter
                value={statementRange}
                onChange={(value) => {
                  setStatementRange(value);
                  setStatementPage(1);
                }}
              />
              <div className="relative">
                <select
                  value={statementStatus}
                  onChange={(event) => {
                    setStatementStatus(event.target.value);
                    setStatementPage(1);
                  }}
                  className="h-10 appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-11 text-sm font-semibold text-slate-700 outline-none focus:border-blue-900"
                >
                  <option value="">All Status</option>
                  {statementStatuses.map((item) => (
                    <option key={item} value={item}>{title(item)}</option>
                  ))}
                </select>
                <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </div>
          </div>
          <table className="min-w-full text-left text-sm">
            <thead className=" text-xs uppercase text-slate-900 bg-gray-100">
              <tr>
                <th className="px-4 py-3">Statement</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Outstanding</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((statement) => (
                <tr key={statement.id} className="border-t border-slate-100">
                  <td className="px-4 py-4 font-semibold">{statement.statementNumber}</td>
                  <td className="px-4 py-4 text-slate-600">
                    {formatDashboardDate(statement.periodStart)} to{" "}
                    {formatDashboardDate(new Date(new Date(statement.periodEnd).getTime() - 1).toISOString())}
                  </td>
                  <td className="px-4 py-4">{formatDashboardDate(statement.dueAt)}</td>
                  <td className="px-4 py-4 text-right">{money(statement.totalAmountMinor)}</td>
                  <td className="px-4 py-4 text-right font-semibold">{money(statement.outstandingAmountMinor)}</td>
                  <td className="px-4 py-4">{title(statement.status)}</td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`/dashboard/credit-accounts/${accountId}/statements/${statement.id}`} className="font-semibold text-blue-900">
                        View
                      </Link>
                      {canSettle && statement.outstandingAmountMinor > 0 ? (
                        <button
                          type="button"
                          onClick={() => void writeOff(statement)}
                          disabled={busy === `writeoff:${statement.id}`}
                          className="font-semibold text-red-700 disabled:opacity-60"
                        >
                          Write off
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!statements.length && !loading ? <p className="p-8 text-center text-sm text-slate-500">No billing statements yet.</p> : null}
          <div className="border-t border-slate-200 px-5 py-3">
            <Pagination
              page={statementPagination.page}
              totalPages={statementPagination.totalPages}
              total={statementPagination.total}
              onPageChange={setStatementPage}
            />
          </div>
        </section>

        {/* Payment reconciliation table + offline payment form */}
        <section id="payment-verification" className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="overflow-x-auto border border-slate-200 bg-white rounded-2xl">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <h2 className="font-semibold text-slate-950">Payment Reconciliation</h2>
                <p className="mt-1 text-sm text-slate-500">Verify submitted offline payments and review applied payments.</p>
              </div>
              <div className="flex items-center gap-2">
                <DateRangeFilter
                  value={paymentRange}
                  onChange={(value) => {
                    setPaymentRange(value);
                    setPaymentPage(1);
                  }}
                />
                <div className="relative">
                  <select
                    value={paymentStatus}
                    onChange={(event) => {
                      setPaymentStatus(event.target.value);
                      setPaymentPage(1);
                    }}
                    className="h-10 appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-11 text-sm font-semibold text-slate-700 outline-none focus:border-blue-900"
                  >
                    <option value="">All Status</option>
                    {paymentStatuses.map((item) => (
                      <option key={item} value={item}>{title(item)}</option>
                    ))}
                  </select>
                  <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              </div>
            </div>
            <table className="min-w-full text- text-sm">
              <thead className="text-xs uppercase text-left text-slate-900 bg-gray-100">
                <tr>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3 ">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-slate-100">
                    <td className="px-4 py-4">
                      <p className="font-semibold">{payment.internalReference}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatDashboardDateTime(payment.createdAt)}
                        {payment.externalReference ? ` | ${payment.externalReference}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-4">{title(payment.method)}</td>
                    <td className="px-4 py-4 text-right font-semibold">{money(payment.amountMinor)}</td>
                    <td className="px-4 py-4">{title(payment.status)}</td>
                    <td className="px-4 py-4 text-right">
                      {canSettle && payment.status === "PENDING_VERIFICATION" ? (
                        <button
                          type="button"
                          onClick={() => void verify(payment.id)}
                          disabled={busy === payment.id}
                          className="h-8 bg-emerald-600 px-3 font-semibold text-white disabled:opacity-60"
                        >
                          Verify
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!payments.length ? <p className="p-8 text-center text-sm text-slate-500">No statement payments recorded.</p> : null}
            <div className="border-t border-slate-200 px-5 py-3">
              <Pagination
                page={paymentPagination.page}
                totalPages={paymentPagination.totalPages}
                total={paymentPagination.total}
                onPageChange={setPaymentPage}
              />
            </div>
          </div>

         {canSettle ? (
         <form onSubmit={recordPayment} className="h-fit border border-slate-200 bg-white p-5 rounded-2xl">
            <h2 className="font-semibold text-slate-950">Record Offline Payment</h2>
            <p className="mt-3 text-sm ">Admin-recorded payments are verified and allocated immediately.</p>

            <label className="mt-4 block text-sm font-semibold text-slate-700 ">
             
              <div className="relative mt-2">
                <select
                  value={statementId}
                  onChange={(event) => {
                    setStatementId(event.target.value);
                    const selected = statements.find((item) => item.id === event.target.value);
                    if (selected) setAmountRupees(String(selected.outstandingAmountMinor / 100));
                  }}
                  className="h-11 w-full border border-slate-300 bg-white px-3 pr-11 font-normal rounded-xl appearance-none"
                >
                  <option value="">Oldest outstanding first</option>
                  {statements
                    .filter((item) => item.outstandingAmountMinor > 0)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.statementNumber} - {money(item.outstandingAmountMinor)}
                      </option>
                    ))}
                </select>
                <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </label>

            <label className="mt-4 block text-sm font-semibold text-slate-700">
              
              <input
                type="number"
                min="0.01"
                max={MAX_OFFLINE_PAYMENT_RUPEES}
                step="0.01"
                value={amountRupees}
                onChange={(event) => setAmountRupees(event.target.value)}
                className="mt-2 h-11 w-full border border-slate-300 px-3 font-normal rounded-xl"
                placeholder="Payment amount in INR"
              />
              <p className="mt-1 text-xs font-normal text-slate-500">
                Maximum {money(MAX_OFFLINE_PAYMENT_RUPEES * 100)} per payment.
              </p>
            </label>

            <label className="mt-4 block text-sm font-semibold text-slate-700">
           
              <div className="relative mt-2">
                <select
                  value={method}
                  onChange={(event) => setMethod(event.target.value as typeof method)}
                  className="h-11 w-full border border-slate-300 bg-white px-3 pr-11 font-normal rounded-xl appearance-none"
                  aria-label="Payment method"
                >
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                  <option value="UPI">UPI</option>
                  <option value="CASH">Cash</option>
                  <option value="CHEQUE">Cheque</option>
                </select>
                <FiChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </label>

            <label className="mt-4 block text-sm font-semibold text-slate-700">
            
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="UTR, receipt or cheque number"
                className="mt-2 h-11 w-full border border-slate-300 px-3 font-normal rounded-xl"
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-slate-700">
       
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                className="mt-2 w-full border border-slate-300 p-3 rounded-2xl font-normal"
                placeholder="Optional notes for the payment"
              />
            </label>

            <button
              disabled={busy === "payment"}
              className="mt-4 h-10 bg-green-500 px-5 text-sm font-semibold rounded-4xl text-white disabled:opacity-60"
            >
              {busy === "payment" ? "Applying..." : "Record and Apply"}
            </button>
          </form>
         ) : null}
        </section>

        {/* Credit ledger table */}
        <section
          id="credit-ledger"
          className={`overflow-x-auto border bg-white rounded-xl scroll-mt-6 transition-all duration-500 ${highlightLedger ? "border-amber-400 ring-4 ring-amber-200 shadow-lg" : "border-slate-200"}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5">
            <div>
              <h2 className="font-semibold text-slate-950">Credit Ledger</h2>
              <p className="mt-1 text-sm text-slate-500">Latest financial movements and resulting balances.</p>
            </div>
            <DateRangeFilter
              value={ledgerRange}
              onChange={(value) => {
                setLedgerRange(value);
                setLedgerPage(1);
              }}
            />
          </div>
          <table className="min-w-full text-left text-sm">
            <thead className=" text-xs uppercase text-slate-900 bg-gray-100">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Activity</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-right">Available Credit</th>
                <th className="px-4 py-3 text-right">Advance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => {
                const activity = creditLedgerLabel(entry.type);
                const funding = creditLedgerFunding(entry);
                return (
                <tr key={entry.id} className="border-t border-slate-100">
                  <td className="whitespace-nowrap px-4 py-4">{formatDashboardDateTime(entry.createdAt)}</td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{activity.label}</p>
                      {/* Which pot the shipment was paid from, on the rows that record it. */}
                      {funding ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                          {funding}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 max-w-md text-xs text-slate-500">{activity.detail || entry.description}</p>
                  </td>
                  <td className="px-4 py-4">{entry.reference}</td>
                  <td
                    className={`px-4 py-4 text-right font-semibold ${
                      activity.direction === "credit"
                        ? "text-emerald-700"
                        : activity.direction === "charge"
                          ? "text-slate-900"
                          : "text-slate-500"
                    }`}
                  >
                    {money(entry.amountMinor)}
                  </td>
                  <td className="px-4 py-4 text-right">{money(entry.availableCreditAfterMinor)}</td>
                  <td className="px-4 py-4 text-right">{money(entry.availableAdvanceAfterMinor)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-slate-200 px-5 py-3">
            <Pagination
              page={ledgerPagination.page}
              totalPages={ledgerPagination.totalPages}
              total={ledgerPagination.total}
              onPageChange={setLedgerPage}
            />
          </div>
        </section>

        {exportDialogOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && busy !== "ledger-export") {
                setExportDialogOpen(false);
              }
            }}
          >
            <div
              ref={exportDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="ledger-export-title"
              aria-describedby="ledger-export-description"
              tabIndex={-1}
              className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                <div>
                  <h2 id="ledger-export-title" className="text-lg font-semibold text-slate-950">Export credit ledger</h2>
                  <p id="ledger-export-description" className="mt-1 text-sm text-slate-500">
                    Choose the period to include in the CSV file.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setExportDialogOpen(false)}
                  disabled={busy === "ledger-export"}
                  aria-label="Close export dialog"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20 disabled:opacity-50"
                >
                  <FiX aria-hidden="true" />
                </button>
              </div>

              <div className="px-5 py-4">
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-semibold text-slate-700">Reporting period</legend>
                  {ledgerExportRanges.map((option) => {
                    const selected = exportRange === option.value;
                    return (
                      <label
                        key={option.value || "all-time"}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 text-sm transition ${selected ? "border-[#0D1282] bg-[#0D1282]/5 text-slate-900" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                      >
                        <input
                          type="radio"
                          name="ledger-export-period"
                          value={option.value}
                          checked={selected}
                          onChange={() => setExportRange(option.value)}
                          className="h-4 w-4 accent-[#0D1282]"
                        />
                        <span className="font-medium">{option.label}</span>
                      </label>
                    );
                  })}
                </fieldset>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
                <button
                  type="button"
                  onClick={() => setExportDialogOpen(false)}
                  disabled={busy === "ledger-export"}
                  className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void exportLedger()}
                  disabled={busy === "ledger-export"}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0a0d63] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/30 disabled:cursor-wait disabled:opacity-60"
                >
                  <FiDownload aria-hidden="true" />
                  {busy === "ledger-export" ? "Preparing CSV..." : "Download CSV"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
    </div>
  );
}
