"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FiChevronDown, FiDownload } from "react-icons/fi";
import { toast } from "react-toastify";
import CreditApprovalDialog from "@/components/credit/CreditApprovalDialog";
import {
  approveOperatorCredit,
  downloadOperatorCreditStatement,
  getOperatorClientCreditSummary,
  getOperatorCreditAccount,
  listOperatorCreditAccounts,
  listOperatorCreditLedger,
  listOperatorCreditPayments,
  listOperatorCreditStatements,
  requestOperatorCredit,
  recordOperatorOfflinePayment,
  rejectOperatorCredit,
  verifyOperatorOfflinePayment,
  type OperatorCreditAccountSummary,
  type OperatorCreditBusinessAccount,
  type OperatorCreditLedgerEntry,
  type OperatorCreditPagination,
  type OperatorCreditPayment,
  type OperatorCreditStatement
} from "@/lib/operatorCredit";
import { getOperatorSession, listOperatorBusinessAccounts, type OperatorSession } from "@/lib/operatorDirectory";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import OperatorCreditAccountPicker, { type OperatorCreditAccountOption } from "@/components/operators/OperatorCreditAccountPicker";

type AccountOption = OperatorCreditAccountOption;
type CreditRole = "staff" | "client";

const EMPTY_PAGINATION: OperatorCreditPagination = { page: 1, pageSize: 25, total: 0, totalPages: 0 };

function formatMoney(minor?: number | null) {
  if (!Number.isFinite(minor)) return "-";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format((minor ?? 0) / 100);
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date) : "-";
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular-nums text-slate-950 sm:text-2xl">{value}</p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

function EmptyRow({ children }: { children: string }) {
  return <p className="px-4 py-8 text-center text-sm text-slate-500">{children}</p>;
}

function CreditSelect({
  id,
  value,
  onChange,
  children,
  disabled = false
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="min-h-11 w-full appearance-none rounded-md border border-slate-300 bg-white py-2 pl-3 pr-12 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
      >
        {children}
      </select>
      <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

export default function OperatorCreditPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const selectedIdRef = useRef("");
  const [selectedAccount, setSelectedAccount] = useState<AccountOption | null>(null);
  const selectedAccountRef = useRef<AccountOption | null>(null);
  const [creditAccount, setCreditAccount] = useState<OperatorCreditAccountSummary | null>(null);
  const [businessAccount, setBusinessAccount] = useState<OperatorCreditBusinessAccount | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [statements, setStatements] = useState<OperatorCreditStatement[]>([]);
  const [ledger, setLedger] = useState<OperatorCreditLedgerEntry[]>([]);
  const [payments, setPayments] = useState<OperatorCreditPayment[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingCredit, setLoadingCredit] = useState(false);
  const [error, setError] = useState("");
  const [requestAmount, setRequestAmount] = useState("");
  const [requestReason, setRequestReason] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"BANK_TRANSFER" | "UPI" | "CASH" | "CHEQUE">("BANK_TRANSFER");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentBusy, setPaymentBusy] = useState("");
  const [downloadingStatement, setDownloadingStatement] = useState("");
  const [accountsRefreshKey, setAccountsRefreshKey] = useState(0);
  const [creditRefreshKey, setCreditRefreshKey] = useState(0);

  const role = operator?.membership.role;
  const creditRole: CreditRole = role === "CLIENT" ? "client" : "staff";

  useEffect(() => {
    let active = true;
    getOperatorSession(operatorSlug).then((session) => {
      if (!active) return;
      setOperator(session);
      setError("");
    }).catch((cause: unknown) => {
      if (!active) return;
      const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
      if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/credit`);
        return;
      }
      const message = cause instanceof Error ? cause.message : "Unable to verify operator access.";
      setError(message);
      toast.error(message);
    }).finally(() => { if (active) setLoadingSession(false); });
    return () => { active = false; };
  }, [operatorSlug, router]);

  useEffect(() => {
    if (!role) return;
    let active = true;
    const load = async () => {
      try {
        let nextAccounts: AccountOption[];
        if (role === "CLIENT") {
          const result = await listOperatorBusinessAccounts(operatorSlug, { page: 1, pageSize: 100 });
          nextAccounts = result.accounts.map((account) => ({
            id: account._id,
            accountId: account.accountId,
            companyName: account.company?.companyName || account.accountId
          }));
          if (!active) return;
          setPagination({ page: 1, pageSize: 100, total: nextAccounts.length, totalPages: 1 });
        } else {
          const result = await listOperatorCreditAccounts(operatorSlug, page, 25, search);
          nextAccounts = result.creditAccounts.map((row) => ({
            id: row.businessAccount.id,
            accountId: row.businessAccount.accountId,
            companyName: row.businessAccount.companyName,
            creditStatus: row.creditAccount.status
          }));
          if (!active) return;
          setPagination(result.pagination);
        }
        if (!active) return;
        setError("");
        setAccounts(nextAccounts);
        const currentId = selectedIdRef.current;
        const matchingAccount = nextAccounts.find((account) => account.id === currentId) ?? null;
        const nextAccount = matchingAccount ?? selectedAccountRef.current ?? nextAccounts[0] ?? null;
        const nextId = currentId && nextAccount?.id === currentId ? currentId : nextAccount?.id ?? "";
        if (nextAccount) {
          selectedAccountRef.current = nextAccount;
          setSelectedAccount(nextAccount);
        }
        if (nextId !== currentId) setLoadingCredit(Boolean(nextId));
        if (!nextId) setLoadingCredit(false);
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
      } catch (cause) {
        if (active) {
          const message = cause instanceof Error ? cause.message : "Unable to load credit accounts.";
          setError(message);
          toast.error(message);
        }
      } finally {
        if (active) setLoadingAccounts(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [role, operatorSlug, page, search, accountsRefreshKey]);

  function searchAccounts(query: string) {
    if (query === search && page === 1) return;
    setLoadingAccounts(true);
    setPage(1);
    setSearch(query);
  }

  function selectAccount(account: AccountOption) {
    selectedAccountRef.current = account;
    selectedIdRef.current = account.id;
    setSelectedAccount(account);
    if (account.id === selectedId) return;
    setLoadingCredit(true);
    setSelectedId(account.id);
  }

  useEffect(() => {
    if (!role || !selectedId) return;
    let active = true;
    const isClient = role === "CLIENT";
    const load = async () => {
      try {
        let canReadFinancials = true;
        if (isClient) {
          const summary = await getOperatorClientCreditSummary(operatorSlug, selectedId);
          if (!active) return;
          setError("");
          setCreditAccount(summary.creditAccount);
          setBusinessAccount(summary.creditAccount.businessAccount ?? null);
          setPermissions(summary.permissions);
          canReadFinancials = summary.financialAccess;
        } else {
          const detail = await getOperatorCreditAccount(operatorSlug, selectedId);
          if (!active) return;
          setError("");
          setCreditAccount(detail.creditAccount);
          setBusinessAccount(detail.businessAccount);
          setPermissions(["viewCreditDetails"]);
        }
        if (!canReadFinancials) {
          setStatements([]);
          setLedger([]);
          setPayments([]);
          return;
        }
        const [statementResult, ledgerResult, paymentResult] = await Promise.all([
          listOperatorCreditStatements(operatorSlug, selectedId, isClient ? "client" : "staff"),
          listOperatorCreditLedger(operatorSlug, selectedId, isClient ? "client" : "staff"),
          listOperatorCreditPayments(operatorSlug, selectedId, isClient ? "client" : "staff")
        ]);
        if (!active) return;
        setStatements(statementResult.statements);
        setLedger(ledgerResult.entries);
        setPayments(paymentResult.payments);
      } catch (cause) {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : "Unable to load this credit account.";
        setError(message);
        toast.error(message);
        setStatements([]);
        setLedger([]);
        setPayments([]);
      } finally {
        if (active) setLoadingCredit(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [role, selectedId, operatorSlug, creditRefreshKey]);

  async function handleCreditRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(requestAmount);
    if (!selectedId || !Number.isFinite(amount) || amount <= 0 || !requestReason.trim()) {
      toast.error("Enter a valid requested limit and explain why the facility is needed.");
      return;
    }
    setRequesting(true);
    try {
      const result = await requestOperatorCredit(operatorSlug, {
        businessAccountId: selectedId,
        requestedCreditLimitMinor: Math.round(amount * 100),
        reason: requestReason.trim()
      });
      toast.success(result.message);
      setRequestAmount("");
      setRequestReason("");
      if (role) {
        setLoadingCredit(true);
        setCreditRefreshKey((value) => value + 1);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to submit the credit request.");
    } finally {
      setRequesting(false);
    }
  }

  async function downloadStatement(statement: OperatorCreditStatement) {
    if (!selectedId) return;
    setDownloadingStatement(statement.id);
    setError("");
    try {
      const blob = await downloadOperatorCreditStatement(operatorSlug, selectedId, statement.id, creditRole);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${statement.statementNumber.replaceAll("/", "-")}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to download this credit statement.");
    } finally {
      setDownloadingStatement("");
    }
  }

  async function handleReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || rejectionReason.trim().length < 5) {
      toast.error("Enter a reason of at least five characters.");
      return;
    }
    setRejecting(true);
    try {
      const result = await rejectOperatorCredit(operatorSlug, selectedId, rejectionReason.trim());
      toast.success(result.message);
      setRejectionReason("");
      setAccountsRefreshKey((value) => value + 1);
      setCreditRefreshKey((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to reject the credit request.");
    } finally {
      setRejecting(false);
    }
  }

  async function handleOfflinePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = Math.round(Number(paymentAmount) * 100);
    if (!selectedId || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid payment amount.");
      return;
    }
    if (amountMinor > 50_000_000) {
      toast.error("A single offline payment cannot exceed INR 5,00,000.");
      return;
    }
    if (paymentReference.trim().length < 3) {
      toast.error("Enter the bank, UPI, cash, or cheque reference.");
      return;
    }
    setPaymentBusy("record");
    try {
      const result = await recordOperatorOfflinePayment(operatorSlug, selectedId, {
        amountMinor,
        method: paymentMethod,
        externalReference: paymentReference.trim(),
        notes: paymentNotes.trim()
      });
      toast.success(result.message);
      setPaymentAmount("");
      setPaymentReference("");
      setPaymentNotes("");
      setCreditRefreshKey((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to record the offline payment.");
    } finally {
      setPaymentBusy("");
    }
  }

  async function verifyPayment(paymentId: string) {
    if (!selectedId) return;
    setPaymentBusy(paymentId);
    try {
      const result = await verifyOperatorOfflinePayment(operatorSlug, selectedId, paymentId);
      toast.success(result.message);
      setCreditRefreshKey((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to verify the offline payment.");
    } finally {
      setPaymentBusy("");
    }
  }

  if (loadingSession) return <OperatorPageLoading label="Checking operator access…" />;

  const canViewFinancials = !role || role !== "CLIENT" || permissions.includes("viewCreditDetails");
  const showRequestForm = role === "CLIENT" && permissions.includes("requestCredit") && ["NOT_REQUESTED", "REJECTED"].includes(creditAccount?.status ?? "");
  const canDownloadStatement = role !== "CLIENT" || canViewFinancials;
  const canDecideCredit = operator?.access.mode === "MEMBER" && (role === "OPERATOR_ADMIN" || role === "FINANCE");
  const offlinePaymentsPanel = (
    <section aria-labelledby="credit-payments-heading" className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
        <h2 id="credit-payments-heading" className="font-semibold text-slate-950">Offline payments</h2>
        <p className="mt-1 text-sm leading-5 text-slate-600">{canDecideCredit ? "Record and verify payments received outside the portal." : "Payment records entered and verified by the operator finance team."}</p>
      </div>
      {canDecideCredit ? <form onSubmit={handleOfflinePayment} className="grid gap-3 border-b border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 sm:p-5">
        <label className="text-sm font-medium text-slate-700">Amount received (INR)<input type="number" min="0.01" max="500000" step="0.01" required value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus:border-[#0D1282]" /></label>
        <div className="min-w-0">
          <label htmlFor="operator-credit-payment-method" className="mb-1.5 block text-sm font-medium text-slate-700">Payment method</label>
          <CreditSelect id="operator-credit-payment-method" value={paymentMethod} onChange={(value) => setPaymentMethod(value as typeof paymentMethod)}><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option></CreditSelect>
        </div>
        <label className="text-sm font-medium text-slate-700">Payment reference<input required minLength={3} maxLength={160} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus:border-[#0D1282]" /></label>
        <label className="text-sm font-medium text-slate-700">Notes (optional)<input maxLength={500} value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus:border-[#0D1282]" /></label>
        <button type="submit" disabled={Boolean(paymentBusy)} className="min-h-10 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2 sm:justify-self-start">{paymentBusy === "record" ? "Recording…" : "Record and apply payment"}</button>
      </form> : null}
      {payments.length ? <div className="divide-y divide-slate-200">{payments.slice(0, 8).map((payment) => <div key={payment.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{payment.externalReference || payment.internalReference}</p><p className="mt-1 text-xs text-slate-500">{payment.method.replace(/_/g, " ")} · {formatDate(payment.verifiedAt || payment.createdAt)}</p></div><div className="shrink-0 text-right"><p className="text-sm font-semibold tabular-nums">{formatMoney(payment.amountMinor)}</p><p className="mt-1 text-xs text-slate-500">{formatStatus(payment.status)}</p>{canDecideCredit && payment.status === "PENDING_VERIFICATION" ? <button type="button" disabled={Boolean(paymentBusy)} onClick={() => void verifyPayment(payment.id)} className="mt-2 min-h-8 rounded-md border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 disabled:opacity-50">{paymentBusy === payment.id ? "Verifying…" : "Verify"}</button> : null}</div></div>)}</div> : <EmptyRow>No payments recorded yet.</EmptyRow>}
    </section>
  );

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Credit and statements</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Review credit balances, payment history, and shipment charges for this operator workspace.</p>
        </header>

        {role && role !== "CLIENT" ? <section aria-label="Select a business account" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
          <div className="max-w-2xl">
            <label htmlFor="operator-credit-account" className="mb-1.5 block text-sm font-semibold text-slate-800">Business account</label>
            <OperatorCreditAccountPicker
              selected={selectedAccount}
              accounts={accounts}
              pagination={pagination}
              loading={loadingAccounts}
              page={page}
              onSelect={selectAccount}
              onSearch={searchAccounts}
              onPageChange={(nextPage) => { setLoadingAccounts(true); setPage(nextPage); }}
            />
          </div>
        </section> : null}

        {role && (loadingAccounts || loadingCredit) ? <div role="status" aria-busy="true" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><span className="sr-only">Loading credit details</span><div className="animate-pulse space-y-4"><div className="h-5 w-48 rounded bg-slate-100" /><div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-20 rounded bg-slate-100" />)}</div><div className="h-40 rounded bg-slate-100" /></div></div> : null}

        {!loadingAccounts && !loadingCredit && !accounts.length && !error ? <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center"><h2 className="font-semibold text-slate-900">No credit accounts available</h2><p className="mt-2 text-sm text-slate-600">Approved business accounts will appear here when the operator enables credit review.</p></div> : null}

        {!loadingAccounts && !loadingCredit && selectedAccount && creditAccount ? (
          <>
            <section aria-labelledby="credit-summary-heading" className="space-y-4">
              <div className="flex flex-col justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:p-5"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business account</p><h2 id="credit-summary-heading" className="mt-1 truncate text-lg font-semibold text-slate-950">{businessAccount?.companyName || selectedAccount.companyName}</h2><p className="mt-1 text-sm text-slate-600">{businessAccount?.accountId || selectedAccount.accountId} <span aria-hidden="true">·</span> {formatStatus(creditAccount.status)}</p></div><span className="inline-flex min-h-9 w-fit shrink-0 items-center rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700">{creditAccount.paymentTermsDays}-day terms <span aria-hidden="true" className="mx-1.5">·</span> {creditAccount.billingCycle.toLowerCase()} billing</span></div>
              <div className="grid grid-cols-1 divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
                <Metric label="Approved credit" value={formatMoney(creditAccount.approvedCreditLimitMinor)} />
                <Metric label="Used credit" value={formatMoney(creditAccount.usedCreditMinor)} />
                <Metric label="Available credit" value={formatMoney(creditAccount.availableCreditMinor)} />
                <Metric label="Amount owed" value={formatMoney(creditAccount.totalOwedMinor)} detail={creditAccount.billing?.overdueAmountMinor ? `${formatMoney(creditAccount.billing.overdueAmountMinor)} overdue` : "No overdue statement balance"} />
              </div>
              {creditAccount.restriction && creditAccount.restriction.level !== "NONE" ? <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Credit restriction: {formatStatus(creditAccount.restriction.level)}{creditAccount.restriction.message ? ` - ${creditAccount.restriction.message}` : ""}</div> : null}
            </section>

            {showRequestForm ? <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div className="max-w-2xl"><h2 className="text-base font-semibold text-slate-950">Request a credit facility</h2><p className="mt-1 text-sm text-slate-600">The operator reviews the request. Booking on credit is available only after the facility is approved and activated.</p><form onSubmit={handleCreditRequest} className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-slate-700">Requested limit (INR)<input type="number" min="1" step="0.01" required value={requestAmount} onChange={(event) => setRequestAmount(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-md border border-slate-300 px-3 outline-none focus:border-[#0D1282]" /></label><label className="text-sm font-medium text-slate-700 sm:row-span-2">Reason<textarea required minLength={10} maxLength={500} value={requestReason} onChange={(event) => setRequestReason(event.target.value)} className="mt-1.5 min-h-28 w-full rounded-md border border-slate-300 p-3 outline-none focus:border-[#0D1282]" /></label><div className="flex flex-col items-start gap-2"><button type="submit" disabled={requesting} className="min-h-11 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50">{requesting ? "Submitting…" : "Submit request"}</button></div></form></div></section> : null}

            {canViewFinancials && canDecideCredit ? (
              <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,6fr)_minmax(0,4fr)]">
                <section aria-labelledby="credit-decision-heading" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
                  <h2 id="credit-decision-heading" className="text-base font-semibold text-slate-950">Credit decision</h2>
                  <p className="mt-1 text-sm leading-5 text-slate-600">Review the client’s request and set the facility terms for this operator account.</p>
                  {creditAccount.requestReason ? <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-3"><p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Client’s reason</p><p className="mt-1 text-sm leading-5 text-amber-950">{creditAccount.requestReason}</p></div> : null}
                  {["PENDING_REVIEW", "APPROVED", "ACTIVE"].includes(creditAccount.status) ? <>
                    <button type="button" onClick={() => setShowApproval(true)} className="mt-4 min-h-10 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white">{creditAccount.status === "ACTIVE" ? "Edit credit terms" : "Review and approve"}</button>
                    {creditAccount.status === "PENDING_REVIEW" ? <form onSubmit={handleReject} className="mt-5 space-y-2 border-t border-slate-200 pt-4">
                      <label htmlFor="operator-credit-rejection" className="block text-sm font-semibold text-slate-800">Reject request</label>
                      <textarea id="operator-credit-rejection" value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} minLength={5} maxLength={500} required rows={2} className="w-full rounded-md border border-slate-300 p-3 text-sm outline-none focus:border-[#0D1282]" placeholder="Explain the decision to the client" />
                      <button type="submit" disabled={rejecting} className="min-h-10 rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-800 disabled:opacity-50">{rejecting ? "Rejecting…" : "Reject request"}</button>
                    </form> : null}
                  </> : <p className="mt-4 rounded-md bg-slate-50 px-3.5 py-3 text-sm leading-5 text-slate-600">No credit request is waiting for review. The operator client can submit a request from its workspace.</p>}
                </section>
                {offlinePaymentsPanel}
              </div>
            ) : null}

            {canViewFinancials ? (
              <>
                <section aria-labelledby="credit-statements-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5"><div><h2 id="credit-statements-heading" className="font-semibold text-slate-950">Tax invoices and statements</h2><p className="mt-1 text-sm text-slate-600">Credit statements total the tax invoice charges for booked shipments.</p></div><p className="text-sm text-slate-600">{creditAccount.billing?.nextDueAt ? `Next due ${formatDate(creditAccount.billing.nextDueAt)}` : "No upcoming due date"}</p></div>
                  {statements.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Statement</th><th className="px-4 py-3">Issued</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Outstanding</th><th className="px-4 py-3">Status</th>{canDownloadStatement ? <th className="px-4 py-3">Document</th> : null}</tr></thead><tbody className="divide-y divide-slate-200">{statements.map((statement) => <tr key={statement.id}><td className="px-4 py-3 font-semibold text-slate-900">{statement.statementNumber}</td><td className="px-4 py-3">{formatDate(statement.issuedAt)}</td><td className="px-4 py-3">{formatDate(statement.dueAt)}</td><td className="px-4 py-3 tabular-nums">{formatMoney(statement.totalAmountMinor)}</td><td className="px-4 py-3 tabular-nums">{formatMoney(statement.outstandingAmountMinor)}</td><td className="px-4 py-3">{formatStatus(statement.status)}</td>{canDownloadStatement ? <td className="px-4 py-3"><button type="button" onClick={() => void downloadStatement(statement)} disabled={downloadingStatement === statement.id} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 disabled:opacity-50"><FiDownload aria-hidden="true" />{downloadingStatement === statement.id ? "Preparing…" : "PDF"}</button></td> : null}</tr>)}</tbody></table></div> : <EmptyRow>There are no credit statements for this account yet.</EmptyRow>}
                </section>

                {!canDecideCredit ? offlinePaymentsPanel : null}
                <section aria-labelledby="credit-ledger-heading" className="overflow-hidden rounded-lg border border-slate-200 bg-white"><div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="credit-ledger-heading" className="font-semibold text-slate-950">Credit ledger</h2><p className="mt-1 text-sm text-slate-600">Auditable record of credit, booking, and payment changes.</p></div>{ledger.length ? <div className="divide-y divide-slate-200">{ledger.slice(0, 8).map((entry) => <div key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{entry.description}</p><p className="mt-1 truncate text-xs text-slate-500">{entry.reference} · {formatDate(entry.createdAt)}</p></div><p className="shrink-0 text-sm font-semibold tabular-nums">{formatMoney(entry.amountMinor)}</p></div>)}</div> : <EmptyRow>No ledger entries yet.</EmptyRow>}</section>
              </>
            ) : <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">Your business account role does not have permission to view statements or payment details.</div>}
          </>
        ) : null}

      </main>
      {showApproval && creditAccount && selectedAccount ? <CreditApprovalDialog
        account={{ ...creditAccount, businessAccount: { companyName: selectedAccount.companyName, accountId: selectedAccount.accountId } }}
        approve={(businessAccountId, input) => approveOperatorCredit(operatorSlug, businessAccountId, input)}
        onClose={() => setShowApproval(false)}
        onSaved={async (message) => {
          setShowApproval(false);
          toast.success(message);
          setAccountsRefreshKey((value) => value + 1);
          setCreditRefreshKey((value) => value + 1);
        }}
        variant="operator"
      /> : null}
    </div>
  );
}
