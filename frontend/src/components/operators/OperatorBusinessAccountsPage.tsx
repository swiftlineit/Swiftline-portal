"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiBriefcase, FiChevronLeft, FiPlus, FiSearch } from "react-icons/fi";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import { updateBusinessAccountStatus } from "@/lib/businessAccounts";
import {
  getOperatorSession,
  listOperatorBusinessAccounts,
  type OperatorBusinessAccount,
  type OperatorDirectoryPagination,
  type OperatorSession
} from "@/lib/operatorDirectory";

const PAGE_SIZE = 10;
const EMPTY_PAGINATION: OperatorDirectoryPagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "active":
    case "approved":
      return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "pending_review":
    case "draft":
    case "inactive":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "rejected":
    case "suspended":
    case "closed":
      return "bg-rose-50 text-rose-800 ring-rose-200";
    default:
      return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function contactName(account: OperatorBusinessAccount): string {
  return [account.contact?.firstName, account.contact?.lastName].filter(Boolean).join(" ") || "-";
}

function AccountStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass(status)}`}>
      {formatStatus(status)}
    </span>
  );
}

function AccountRowActions({
  account,
  href,
  canOpen,
  canManageStatus,
  busy,
  onApprove,
  onDeactivate,
  onActivate
}: {
  account: OperatorBusinessAccount;
  href: string;
  canOpen: boolean;
  canManageStatus: boolean;
  busy: boolean;
  onApprove: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
}) {
  const name = account.company?.companyName || "business account";
  const canApprove = account.status === "pending_review";
  const canDeactivate = account.status === "approved" || account.status === "active";
  const canActivate = account.status === "suspended";
  const kycVerified = account.kycReview?.overallStatus === "verified";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canOpen ? (
        <Link href={href} className="inline-flex min-h-9 items-center justify-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
          Details
        </Link>
      ) : null}
      {canManageStatus && canApprove ? (
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || account.kycReview?.overallStatus !== "verified"}
          title={account.kycReview?.overallStatus !== "verified" ? "KYC must be verified before approval." : undefined}
          aria-label={`Approve ${name}`}
          className="inline-flex min-h-9 items-center justify-center rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Approve
        </button>
      ) : null}
      {canManageStatus && canDeactivate ? (
        <button
          type="button"
          onClick={onDeactivate}
          disabled={busy}
          aria-label={`Deactivate ${name}`}
          className="inline-flex min-h-9 items-center justify-center rounded-md border border-rose-300 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-wait disabled:opacity-50"
        >
          Deactivate
        </button>
      ) : null}
      {canManageStatus && canActivate ? (
        <button
          type="button"
          onClick={onActivate}
          disabled={busy || !kycVerified}
          title={!kycVerified ? "KYC must be verified before this account can be activated." : undefined}
          aria-label={`Activate ${name}`}
          className="inline-flex min-h-9 items-center justify-center rounded-md border border-emerald-300 px-3 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Activate
        </button>
      ) : null}
      {!canOpen && !canManageStatus ? <span className="text-sm text-slate-500">View only</span> : null}
    </div>
  );
}

function Pagination({
  pagination,
  onPageChange
}: {
  pagination: OperatorDirectoryPagination;
  onPageChange: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);

  return (
    <nav aria-label="Business account pagination" className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:px-5">
      <p className="text-xs text-slate-600">Showing {start}–{end} of {pagination.total}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={pagination.page <= 1}
          className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45"
        >Previous</button>
        <button
          type="button"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={pagination.page >= pagination.totalPages}
          className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45"
        >Next</button>
      </div>
    </nav>
  );
}

export default function OperatorBusinessAccountsPage({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [accounts, setAccounts] = useState<OperatorBusinessAccount[]>([]);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [updatingAccountId, setUpdatingAccountId] = useState("");
  const [pendingStatusChange, setPendingStatusChange] = useState<{
    account: OperatorBusinessAccount;
    status: "active" | "suspended";
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    Promise.all([
      getOperatorSession(operatorSlug, controller.signal),
      listOperatorBusinessAccounts(operatorSlug, {
        page,
        pageSize: PAGE_SIZE,
        search: appliedSearch || undefined
      }, controller.signal)
    ]).then(([session, result]) => {
      if (!active) return;
      setOperator(session);
      setAccounts(result.accounts);
      setPagination(result.pagination);
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object"
        ? cause as { status?: unknown; canonicalSlug?: unknown }
        : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/business-accounts`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load business accounts.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [appliedSearch, operatorSlug, page, refreshKey, router]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setPage(1);
    setAppliedSearch(search.trim());
  }

  function retryLoad() {
    setLoading(true);
    setError("");
    setRefreshKey((value) => value + 1);
  }

  async function changeAccountStatus(account: OperatorBusinessAccount, status: "approved" | "active" | "suspended") {
    setUpdatingAccountId(account._id);
    setError("");
    setNotice("");
    try {
      const result = await updateBusinessAccountStatus(account.accountId, status, operatorSlug);
      setAccounts((current) => current.map((item) => item._id === account._id
        ? { ...item, status: result.account.status, kycReview: { overallStatus: result.account.kycReview?.overallStatus } }
        : item));
      const action = status === "approved" ? "approved" : status === "active" ? "activated" : "deactivated";
      setNotice(result.message || `Business account ${action}.`);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update this business account.");
      return false;
    } finally {
      setUpdatingAccountId("");
    }
  }

  async function confirmStatusChange() {
    if (!pendingStatusChange) return;
    const { account, status } = pendingStatusChange;
    const updated = await changeAccountStatus(account, status);
    if (updated) setPendingStatusChange(null);
  }

  function changePage(nextPage: number) {
    setLoading(true);
    setError("");
    setPage(nextPage);
  }

  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const canCreate = Boolean(
    !supportReadOnly && operator && !operator.access.readOnly &&
    ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role)
  );
  const canOpen = Boolean(
    !supportReadOnly && operator && !operator.access.readOnly &&
    ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role)
  );
  const canManageStatus = Boolean(
    !supportReadOnly && operator && !operator.access.readOnly &&
    operator.membership.role === "OPERATOR_ADMIN"
  );

  return (
    <main className="min-h-[calc(100dvh-8rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
      <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-3xl">Business accounts</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">Accounts available within this operator workspace.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Link href={base} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
              <FiChevronLeft aria-hidden="true" className="h-4 w-4" /> Workspace home
            </Link>
            {canCreate ? (
              <Link href={`${base}/business-accounts/new`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                <FiPlus aria-hidden="true" className="h-4 w-4" /> Create business account
              </Link>
            ) : null}
          </div>
        </header>

        {supportReadOnly || operator?.access.readOnly ? (
          <p className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Swiftline support access is read only.</p>
        ) : null}

        {notice ? <p role="status" className="mt-5 rounded-md border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}

        <section aria-label="Business account directory" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <form onSubmit={submitSearch} className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-end sm:p-5">
            <div className="min-w-0 flex-1">
              <label htmlFor="operator-business-account-search" className="mb-2 block text-sm font-medium text-slate-700">Search business accounts</label>
              <div className="relative">
                <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input id="operator-business-account-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Company, account ID, contact"
                  className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" />
              </div>
            </div>
            <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
              <FiSearch aria-hidden="true" className="h-4 w-4" /> Search
            </button>
          </form>

          {error ? (
            <div role="alert" className="flex flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <p className="font-semibold text-slate-900">Could not load business accounts</p>
                <p className="mt-1 text-sm leading-5 text-slate-700">{error}</p>
              </div>
              <button type="button" onClick={retryLoad} className="min-h-10 shrink-0 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Try again</button>
            </div>
          ) : loading ? (
            <div aria-label="Loading business accounts" className="animate-pulse space-y-3 p-4 sm:p-5">
              {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-14 rounded-md bg-slate-100" />)}
            </div>
          ) : accounts.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <FiBriefcase aria-hidden="true" className="mx-auto h-6 w-6 text-slate-500" />
              <p className="mt-3 text-sm font-semibold text-slate-900">No business accounts found</p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-5 text-slate-600">Try a different search or create an account for this operator.</p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-slate-200 sm:hidden">
                {accounts.map((account) => {
                  const accountHref = `${base}/business-accounts/${encodeURIComponent(account.accountId)}`;
                  const name = account.company?.companyName || "Business account";
                  return (
                    <li key={account._id} className="space-y-3 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-slate-950">{name}</p>
                          <p className="mt-1 text-xs tabular-nums text-slate-600">{account.accountId}</p>
                        </div>
                        <AccountStatus status={account.status} />
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <div className="min-w-0"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</dt><dd className="mt-1 break-words text-slate-800">{contactName(account)}<span className="block text-slate-600">{account.contact?.email || "No email"}</span></dd></div>
                        <div className="min-w-0"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Branch</dt><dd className="mt-1 break-words text-slate-800">{account.assignedBranch?.name || "Unassigned"}</dd></div>
                        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">KYC</dt><dd className="mt-1 text-slate-700">{formatStatus(account.kycReview?.overallStatus || "not_started")}</dd></div>
                      </dl>
                      <div className="border-t border-slate-200 pt-3">
                        <AccountRowActions
                          account={account}
                          href={accountHref}
                          canOpen={canOpen}
                          canManageStatus={canManageStatus}
                          busy={updatingAccountId === account._id}
                          onApprove={() => void changeAccountStatus(account, "approved")}
                          onDeactivate={() => setPendingStatusChange({ account, status: "suspended" })}
                          onActivate={() => setPendingStatusChange({ account, status: "active" })}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="min-w-[900px] w-full text-left text-sm">
                  <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                    <tr>
                      <th scope="col" className="px-5 py-3">Business account</th>
                      <th scope="col" className="px-5 py-3">Primary contact</th>
                      <th scope="col" className="px-5 py-3">Assigned branch</th>
                      <th scope="col" className="px-5 py-3">KYC</th>
                      <th scope="col" className="px-5 py-3">Status</th>
                      <th scope="col" className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {accounts.map((account) => {
                      const accountHref = `${base}/business-accounts/${encodeURIComponent(account.accountId)}`;
                      const name = account.company?.companyName || "Business account";
                      return (
                        <tr key={account._id} className="align-top hover:bg-slate-50/70">
                          <td className="px-5 py-4"><p className="font-semibold text-slate-950">{name}</p><p className="mt-1 text-xs tabular-nums text-slate-600">{account.accountId}</p></td>
                          <td className="px-5 py-4"><p className="font-medium text-slate-800">{contactName(account)}</p><p className="mt-1 break-all text-xs text-slate-600">{account.contact?.email || "No email"}</p></td>
                          <td className="px-5 py-4 text-slate-700">{account.assignedBranch?.name || "Unassigned"}</td>
                          <td className="px-5 py-4 text-slate-700">{formatStatus(account.kycReview?.overallStatus || "not_started")}</td>
                          <td className="px-5 py-4"><AccountStatus status={account.status} /></td>
                          <td className="px-5 py-4"><div className="flex justify-end"><AccountRowActions
                            account={account}
                            href={accountHref}
                            canOpen={canOpen}
                            canManageStatus={canManageStatus}
                            busy={updatingAccountId === account._id}
                            onApprove={() => void changeAccountStatus(account, "approved")}
                            onDeactivate={() => setPendingStatusChange({ account, status: "suspended" })}
                            onActivate={() => setPendingStatusChange({ account, status: "active" })}
                          /></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination pagination={pagination} onPageChange={changePage} />
            </>
          )}
        </section>
        {!error && !loading ? <p aria-live="polite" className="mt-3 text-sm text-slate-600">{pagination.total} {pagination.total === 1 ? "account" : "accounts"}</p> : null}
        {operator?.membership.role === "CLIENT" ? <p className="mt-4 text-xs text-slate-500">Your account list is limited to the business accounts assigned to your login.</p> : null}
      </div>
      {pendingStatusChange ? (
        <ConfirmDialog
          title={pendingStatusChange.status === "active" ? "Activate business account?" : "Deactivate business account?"}
          description={pendingStatusChange.status === "active"
            ? <>This will reactivate <span className="font-semibold text-slate-900">{pendingStatusChange.account.company?.companyName || pendingStatusChange.account.accountId}</span> for new shipment bookings.</>
            : <>This will suspend <span className="font-semibold text-slate-900">{pendingStatusChange.account.company?.companyName || pendingStatusChange.account.accountId}</span> and block new shipment bookings until it is activated again.</>}
          confirmLabel={pendingStatusChange.status === "active" ? "Activate account" : "Deactivate account"}
          tone={pendingStatusChange.status === "active" ? "primary" : "danger"}
          busy={updatingAccountId === pendingStatusChange.account._id}
          busyLabel={pendingStatusChange.status === "active" ? "Activating..." : "Deactivating..."}
          onConfirm={() => void confirmStatusChange()}
          onCancel={() => setPendingStatusChange(null)}
        />
      ) : null}
    </main>
  );
}
