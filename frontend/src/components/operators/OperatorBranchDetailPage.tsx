"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiChevronDown, FiChevronLeft, FiDownload, FiEdit3, FiEye, FiSearch, FiX } from "react-icons/fi";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import {
  formatBranchLabel,
  branchDocumentUrl,
  branchStatuses,
  branchStatusTransitions,
  deleteBranchDraft,
  fetchBranchFileObjectUrl,
  updateBranchStatus,
  type BranchStatus
} from "@/lib/branches";
import { updateBusinessAccountStatus } from "@/lib/businessAccounts";
import {
  getOperatorBranchDetails,
  getOperatorSession,
  listOperatorBranchUsers,
  listOperatorBusinessAccounts,
  type OperatorBranchDetails,
  type OperatorBranchUser,
  type OperatorBusinessAccount,
  type OperatorDirectoryPagination,
  type OperatorSession
} from "@/lib/operatorDirectory";

const PAGE_SIZE = 20;
const EMPTY_PAGINATION: OperatorDirectoryPagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };
type BranchTab = "overview" | "accounts" | "users";

const branchStatusActions: Record<BranchStatus, string> = {
  DRAFT: "Move to draft", ACTIVE: "Activate", INACTIVE: "Deactivate", SUSPENDED: "Suspend", CLOSED: "Close"
};

function formatMoney(minor?: number): string {
  return minor == null ? "-" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

function branchStatusClass(status: BranchStatus | string): string {
  switch (status) {
    case "ACTIVE": return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "DRAFT":
    case "INACTIVE": return "bg-amber-50 text-amber-800 ring-amber-200";
    case "SUSPENDED":
    case "CLOSED": return "bg-rose-50 text-rose-800 ring-rose-200";
    default: return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function operatorUserStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "active": return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "invited": return "bg-amber-50 text-amber-800 ring-amber-200";
    case "suspended":
    case "removed": return "bg-rose-50 text-rose-800 ring-rose-200";
    default: return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function businessAccountName(account: OperatorBusinessAccount): string {
  const companyName = account.company?.companyName?.trim();
  if (companyName) return companyName;
  const contactName = [account.contact?.firstName, account.contact?.lastName].filter(Boolean).join(" ").trim();
  return contactName || account.accountId;
}

function DetailField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm leading-6 text-slate-900">{value?.trim() || "-"}</dd>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-950 sm:px-5">{title}</h2>
      <dl className="grid gap-x-5 gap-y-4 p-4 sm:grid-cols-2 sm:p-5">{children}</dl>
    </section>
  );
}

function TextList({ values, emptyLabel = "Not configured" }: { values?: string[]; emptyLabel?: string }) {
  if (!values?.length) return <span className="text-sm text-slate-600">{emptyLabel}</span>;
  return (
    <ul className="flex flex-wrap gap-2">
      {values.map((value) => <li key={value} className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{formatBranchLabel(value)}</li>)}
    </ul>
  );
}

function DirectoryPagination({
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
    <nav aria-label="Directory pages" className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p className="text-sm text-slate-600">Showing {start}–{end} of {pagination.total}</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPageChange(pagination.page - 1)} disabled={pagination.page <= 1} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Previous</button>
        <button type="button" onClick={() => onPageChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Next</button>
      </div>
    </nav>
  );
}

function LoadingRows() {
  return <div aria-label="Loading directory" className="animate-pulse space-y-3 p-4 sm:p-5">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-12 rounded-md bg-slate-100" />)}</div>;
}

function BranchAccountRows({ accounts, operatorSlug, canOpen, canManage, busy, onStatusChange }: {
  accounts: OperatorBusinessAccount[];
  operatorSlug: string;
  canOpen: boolean;
  canManage: boolean;
  busy: boolean;
  onStatusChange: (account: OperatorBusinessAccount, status: "active" | "suspended") => void;
}) {
  const router = useRouter();
  function actions(account: OperatorBusinessAccount) {
    const canDeactivate = account.status === "approved" || account.status === "active";
    const canActivate = account.status === "suspended";
    return <span className="relative inline-flex">
      <select value="" aria-label={`Actions for ${account.company?.companyName || account.accountId}`} disabled={busy || (!canOpen && !canManage)}
        onChange={(event) => {
          if (event.target.value === "details") router.push(`/portal/${encodeURIComponent(operatorSlug)}/business-accounts/${encodeURIComponent(account.accountId)}`);
          if (event.target.value === "activate") onStatusChange(account, "active");
          if (event.target.value === "deactivate") onStatusChange(account, "suspended");
        }} className="min-h-9 min-w-28 appearance-none rounded-md border border-slate-300 bg-white pl-3 pr-8 text-sm font-semibold text-[#0D1282] focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20 disabled:opacity-50">
        <option value="">Actions</option>
        {canOpen ? <option value="details">Details</option> : null}
        {canManage && canDeactivate ? <option value="deactivate">Deactivate</option> : null}
        {canManage && canActivate ? <option value="activate" disabled={account.kycReview?.overallStatus !== "verified"}>{account.kycReview?.overallStatus === "verified" ? "Activate" : "Activate (KYC required)"}</option> : null}
      </select><FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0D1282]" />
    </span>;
  }
  return <>
    <div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[900px] border-collapse text-left text-sm">
      <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600"><tr>
        <th className="px-4 py-3">Business account</th><th className="px-4 py-3">Available credit</th><th className="px-4 py-3">Outstanding</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">KYC status</th><th className="px-4 py-3">Created</th><th className="px-4 py-3 text-right">Actions</th>
      </tr></thead>
      <tbody>{accounts.map((account) => <tr key={account._id} className="border-t border-slate-200 align-middle">
        <td className="px-4 py-4"><p className="font-semibold text-slate-950">{businessAccountName(account)}</p><p className="mt-1 text-xs text-slate-600">{account.accountId}</p></td>
        <td className="px-4 py-4 tabular-nums text-slate-800">{formatMoney(account.creditSummary?.availableCreditMinor)}</td>
        <td className="px-4 py-4 tabular-nums text-slate-800">{formatMoney(account.creditSummary?.outstandingMinor)}</td>
        <td className="px-4 py-4 text-slate-700">{formatBranchLabel(account.status)}</td>
        <td className="px-4 py-4 text-slate-700">{formatBranchLabel(account.kycReview?.overallStatus || "documents_pending")}</td>
        <td className="px-4 py-4 text-slate-700">{new Date(account.createdAt).toLocaleDateString("en-IN")}</td>
        <td className="px-4 py-4 text-right">{actions(account)}</td>
      </tr>)}</tbody>
    </table></div>
    <ul className="divide-y divide-slate-200 lg:hidden">{accounts.map((account) => <li key={account._id} className="space-y-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-950">{businessAccountName(account)}</p><p className="mt-1 text-xs text-slate-600">{account.accountId}</p></div>{actions(account)}</div>
      <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-500">Available credit</dt><dd className="font-medium tabular-nums">{formatMoney(account.creditSummary?.availableCreditMinor)}</dd></div><div><dt className="text-slate-500">Outstanding</dt><dd className="font-medium tabular-nums">{formatMoney(account.creditSummary?.outstandingMinor)}</dd></div><div><dt className="text-slate-500">Status</dt><dd>{formatBranchLabel(account.status)}</dd></div><div><dt className="text-slate-500">KYC</dt><dd>{formatBranchLabel(account.kycReview?.overallStatus || "documents_pending")}</dd></div><div><dt className="text-slate-500">Created</dt><dd>{new Date(account.createdAt).toLocaleDateString("en-IN")}</dd></div></dl>
    </li>)}</ul>
  </>;
}

function BranchUserRows({ users, operatorSlug, branchId }: { users: OperatorBranchUser[]; operatorSlug: string; branchId: string }) {
  const name = (entry: OperatorBranchUser) => entry.user?.name || [entry.user?.firstName, entry.user?.lastName].filter(Boolean).join(" ") || "User unavailable";
  const profilePath = (entry: OperatorBranchUser) => `/portal/${encodeURIComponent(operatorSlug)}/branches/${encodeURIComponent(branchId)}/users/${encodeURIComponent(entry._id)}`;
  const companyDesignation = (entry: OperatorBranchUser) => (
    <div className="min-w-0">
      {entry.account?.companyName ? <p className="font-medium text-slate-900">{entry.account.companyName}</p> : null}
      {entry.user?.designation ? <p className={entry.account?.companyName ? "mt-1 text-xs text-slate-600" : "text-slate-700"}>{entry.user.designation}</p> : null}
      {!entry.account?.companyName && !entry.user?.designation ? <span className="text-slate-500">-</span> : null}
    </div>
  );
  const viewProfile = (entry: OperatorBranchUser) => (
    <Link href={profilePath(entry)} aria-label={`View profile for ${name(entry)}`} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 font-semibold text-[#0D1282] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
      <FiEye aria-hidden="true" /> View profile
    </Link>
  );
  return <>
    <div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[900px] border-collapse text-left text-sm">
      <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600"><tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Company designation</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Last login</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
      <tbody>{users.map((entry) => <tr key={entry._id} className="border-t border-slate-200">
        <td className="px-4 py-4"><p className="font-semibold text-slate-950">{name(entry)}</p><p className="break-all text-xs text-slate-600">{entry.user?.email || "-"}</p><p className="text-xs text-slate-600">{entry.user?.phone || "-"}</p></td>
        <td className="px-4 py-4">{formatBranchLabel(entry.role)}</td>
        <td className="px-4 py-4">{companyDesignation(entry)}</td>
        <td className="px-4 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${operatorUserStatusClass(entry.membershipStatus)}`}>{formatBranchLabel(entry.membershipStatus)}</span></td>
        <td className="px-4 py-4">{entry.user?.lastLogin ? new Date(entry.user.lastLogin).toLocaleString("en-IN") : "Never"}</td>
        <td className="px-4 py-4 text-right">{viewProfile(entry)}</td>
      </tr>)}</tbody>
    </table></div>
    <ul className="divide-y divide-slate-200 lg:hidden">{users.map((entry) => <li key={entry._id} className="space-y-2 px-4 py-4 text-sm">
      <div className="flex items-start justify-between gap-3"><p className="font-semibold text-slate-950">{name(entry)}</p><span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${operatorUserStatusClass(entry.membershipStatus)}`}>{formatBranchLabel(entry.membershipStatus)}</span></div>
      <p className="break-all text-slate-600">{entry.user?.email || "-"} · {entry.user?.phone || "-"}</p>
      <p className="text-slate-700">{formatBranchLabel(entry.role)}</p>
      {entry.account?.companyName ? <p className="font-medium text-slate-900">{entry.account.companyName}</p> : null}
      {entry.user?.designation ? <p className="text-slate-600">{entry.user.designation}</p> : null}
      <p className="text-slate-600">Last login: {entry.user?.lastLogin ? new Date(entry.user.lastLogin).toLocaleString("en-IN") : "Never"}</p>
      {viewProfile(entry)}
    </li>)}</ul>
  </>;
}
export default function OperatorBranchDetailPage({ operatorSlug, branchId, initialTab = "overview" }: { operatorSlug: string; branchId: string; initialTab?: BranchTab }) {
  const router = useRouter();
  const supportReadOnly = useOperatorSupportReadOnly();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [branch, setBranch] = useState<OperatorBranchDetails | null>(null);
  const [activeTab, setActiveTab] = useState<BranchTab>(initialTab);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [accounts, setAccounts] = useState<OperatorBusinessAccount[]>([]);
  const [accountsPagination, setAccountsPagination] = useState(EMPTY_PAGINATION);
  const [accountSearch, setAccountSearch] = useState("");
  const [appliedAccountSearch, setAppliedAccountSearch] = useState("");
  const [accountPage, setAccountPage] = useState(1);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState("");
  const [accountsRetryKey, setAccountsRetryKey] = useState(0);
  const [branchUsers, setBranchUsers] = useState<OperatorBranchUser[]>([]);
  const [usersPagination, setUsersPagination] = useState(EMPTY_PAGINATION);
  const [userSearch, setUserSearch] = useState("");
  const [appliedUserSearch, setAppliedUserSearch] = useState("");
  const [userPage, setUserPage] = useState(1);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [usersRetryKey, setUsersRetryKey] = useState(0);
  const [statusBusy, setStatusBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingBranchDelete, setPendingBranchDelete] = useState(false);
  const [pendingAccountStatus, setPendingAccountStatus] = useState<{ account: OperatorBusinessAccount; status: "active" | "suspended" } | null>(null);
  const [openingDocument, setOpeningDocument] = useState<number | null>(null);
  const [previewDocument, setPreviewDocument] = useState<{ url: string; title: string } | null>(null);
  const closePreviewButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!previewDocument) return;
    closePreviewButton.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPreviewDocument(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      URL.revokeObjectURL(previewDocument.url);
    };
  }, [previewDocument]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.all([
      getOperatorSession(operatorSlug, controller.signal),
      getOperatorBranchDetails(operatorSlug, branchId, controller.signal)
    ]).then(([session, result]) => {
      if (!active) return;
      setOperator(session);
      setBranch(result.branch);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/branches/${encodeURIComponent(branchId)}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load branch details.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, branchId, retryKey, router]);

  useEffect(() => {
    if (activeTab !== "accounts") return;
    let active = true;
    const controller = new AbortController();
    listOperatorBusinessAccounts(operatorSlug, {
      page: accountPage,
      pageSize: PAGE_SIZE,
      branchId,
      search: appliedAccountSearch || undefined
    }, controller.signal).then((result) => {
      if (!active) return;
      setAccounts(result.accounts);
      setAccountsPagination(result.pagination);
    }).catch((cause: unknown) => {
      if (active && !controller.signal.aborted) setAccountsError(cause instanceof Error ? cause.message : "Unable to load assigned business accounts.");
    }).finally(() => { if (active) setAccountsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [activeTab, operatorSlug, branchId, accountPage, appliedAccountSearch, accountsRetryKey]);

  useEffect(() => {
    if (activeTab !== "users") return;
    let active = true;
    const controller = new AbortController();
    listOperatorBranchUsers(operatorSlug, branchId, {
      page: userPage,
      pageSize: PAGE_SIZE,
      search: appliedUserSearch || undefined
    }, controller.signal).then((result) => {
      if (!active) return;
      setBranchUsers(result.users);
      setUsersPagination(result.pagination);
    }).catch((cause: unknown) => {
      if (active && !controller.signal.aborted) setUsersError(cause instanceof Error ? cause.message : "Unable to load users assigned to this branch.");
    }).finally(() => { if (active) setUsersLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [activeTab, operatorSlug, branchId, userPage, appliedUserSearch, usersRetryKey]);

  const branchesPath = `/portal/${encodeURIComponent(operatorSlug)}/branches`;
  const canManage = Boolean(operator?.membership.role === "OPERATOR_ADMIN" && !operator.access.readOnly && !supportReadOnly);
  const canOpenAccounts = Boolean(operator && ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role));

  async function changeBranchStatus(nextStatus: BranchStatus) {
    if (!branch || !canManage || !branchStatuses.includes(branch.status as BranchStatus)
      || !branchStatusTransitions[branch.status as BranchStatus].includes(nextStatus)) return;
    setStatusBusy(true); setError(""); setNotice("");
    try {
      await updateBranchStatus(branch._id, nextStatus, operatorSlug);
      setBranch((current) => current ? { ...current, status: nextStatus } : current);
      setNotice(`Branch ${formatBranchLabel(nextStatus).toLowerCase()}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update branch status."); }
    finally { setStatusBusy(false); }
  }

  async function removeDraftBranch() {
    if (!branch || !canManage || branch.status !== "DRAFT") return;
    setStatusBusy(true); setError("");
    try { await deleteBranchDraft(branch._id, operatorSlug); router.push(branchesPath); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to delete this draft branch."); setPendingBranchDelete(false); }
    finally { setStatusBusy(false); }
  }

  async function changeAccountStatus() {
    if (!pendingAccountStatus || !canManage) return;
    setStatusBusy(true); setAccountsError(""); setNotice("");
    try {
      const { account, status } = pendingAccountStatus;
      const result = await updateBusinessAccountStatus(account.accountId, status, operatorSlug);
      setAccounts((current) => current.map((item) => item._id === account._id ? { ...item, status: result.account.status } : item));
      setNotice(result.message || `Business account ${status === "active" ? "activated" : "deactivated"}.`);
      setPendingAccountStatus(null);
    } catch (cause) { setAccountsError(cause instanceof Error ? cause.message : "Unable to update this business account."); setPendingAccountStatus(null); }
    finally { setStatusBusy(false); }
  }

  async function openBranchDocument(index: number, download: boolean, filename: string, title: string) {
    if (!branch) return;
    setOpeningDocument(index); setError("");
    try {
      const url = await fetchBranchFileObjectUrl(branchDocumentUrl(branch._id, index, operatorSlug) + (download ? "?download=1" : ""));
      if (download) {
        const link = document.createElement("a");
        link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        setPreviewDocument({ url, title });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to open branch document."); }
    finally { setOpeningDocument(null); }
  }

  function selectTab(tab: BranchTab) {
    if (tab === "accounts") { setAccountsLoading(true); setAccountsError(""); }
    if (tab === "users") { setUsersLoading(true); setUsersError(""); }
    setActiveTab(tab);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const tabs: BranchTab[] = ["overview", "accounts", "users"];
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(activeTab);
    const next = tabs[(currentIndex + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next);
    document.getElementById(`branch-tab-${next}`)?.focus();
  }

  function submitAccountSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccountsLoading(true);
    setAccountsError("");
    setAccountPage(1);
    setAppliedAccountSearch(accountSearch.trim());
  }

  function submitUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUsersLoading(true);
    setUsersError("");
    setUserPage(1);
    setAppliedUserSearch(userSearch.trim());
  }

  if (loading) {
    return <OperatorPageLoading label="Loading branch details…" />;
  }

  return (
    <main className="min-h-[calc(100dvh-8rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
      <div className="mx-auto w-full max-w-[1440px] space-y-5 px-3 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-3xl">{branch?.name || "Branch details"}</h1>
              {branch ? <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${branchStatusClass(branch.status)}`}>{formatBranchLabel(branch.status)}</span> : null}
            </div>
            {branch ? <p className="mt-2 text-sm leading-6 text-slate-700">{branch.code}{branch.labelCode ? ` · ${branch.labelCode}` : ""}{branch.address?.city ? ` · ${branch.address.city}` : ""}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={branchesPath} className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50"><FiChevronLeft aria-hidden="true" className="h-4 w-4" /> Back to branches</Link>
            {canManage && branch ? <>
              <span className="relative inline-flex">
                <select value={`current:${branch.status}`} disabled={statusBusy || (!branchStatusTransitions[branch.status as BranchStatus]?.length && branch.status !== "DRAFT")}
                  aria-label={`Change status for ${branch.name}`}
                  onChange={(event) => {
                    if (event.target.value === "delete") setPendingBranchDelete(true);
                    else if (event.target.value.startsWith("status:")) void changeBranchStatus(event.target.value.slice(7) as BranchStatus);
                  }} className="min-h-10 appearance-none rounded-md border border-slate-300 bg-white pl-3 pr-9 text-sm font-semibold text-[#0D1282] focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20 disabled:opacity-50">
                  <option value={`current:${branch.status}`}>{statusBusy ? "Updating..." : formatBranchLabel(branch.status)}</option>
                  {(branchStatusTransitions[branch.status as BranchStatus] || []).map((nextStatus) => <option key={nextStatus} value={`status:${nextStatus}`}>{branchStatusActions[nextStatus]}</option>)}
                  {branch.status === "DRAFT" ? <option value="delete">Delete draft</option> : null}
                </select><FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0D1282]" />
              </span>
              <Link href={`/portal/${encodeURIComponent(operatorSlug)}/branches/${encodeURIComponent(branch._id)}/edit`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#10166F]"><FiEdit3 aria-hidden="true" className="h-4 w-4" /> Edit branch</Link>
            </> : null}
          </div>
        </header>

        {notice ? <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p> : null}
        {error ? <section role="alert" className="flex flex-col gap-3 rounded-md border border-rose-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm leading-5 text-rose-900">{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); setRetryKey((current) => current + 1); }} className="inline-flex min-h-9 items-center justify-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button></section> : null}
        {supportReadOnly || operator?.access.readOnly ? <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Swiftline support access is read only.</p> : null}

        {branch ? (
          <>
            <div role="tablist" aria-label="Branch sections" className="flex gap-1 overflow-x-auto border-b border-slate-300">
              {([ ["overview", "Overview"], ["accounts", "Business accounts"], ["users", "Users"] ] as const).map(([tab, label]) => (
                <button key={tab} id={`branch-tab-${tab}`} type="button" role="tab" tabIndex={activeTab === tab ? 0 : -1} aria-selected={activeTab === tab} aria-controls={`branch-panel-${tab}`} onClick={() => selectTab(tab)} onKeyDown={handleTabKeyDown} className={`min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D1282] sm:px-4 ${activeTab === tab ? "border-[#0D1282] text-[#0D1282]" : "border-transparent text-slate-600 hover:border-slate-400 hover:text-slate-950"}`}>{label}</button>
              ))}
            </div>

            <section id="branch-panel-overview" role="tabpanel" aria-labelledby="branch-tab-overview" hidden={activeTab !== "overview"} className="space-y-4">
              <div className="grid gap-4 xl:grid-cols-2">
                <DetailSection title="Location and branch identity">
                  <DetailField label="Branch name" value={branch.name} />
                  <DetailField label="Branch code" value={branch.code} />
                  <DetailField label="Station code" value={branch.labelCode} />
                  <DetailField label="Opening date" value={branch.openingDate ? new Date(branch.openingDate).toLocaleDateString() : ""} />
                  <div className="sm:col-span-2"><DetailField label="Address" value={[branch.address?.address, branch.address?.city, branch.address?.stateOrProvince, branch.address?.postalCode, branch.address?.countryName].filter(Boolean).join(", ")} /></div>
                  {branch.description ? <div className="sm:col-span-2"><DetailField label="Description" value={branch.description} /></div> : null}
                </DetailSection>
                <DetailSection title="Contact and billing">
                  <DetailField label="Contact email" value={branch.contact?.email} />
                  <DetailField label="Contact phone" value={branch.contact?.phone} />
                  <DetailField label="Base currency" value={branch.baseCurrency} />
                  <DetailField label="GSTIN" value={branch.gstin} />
                  <DetailField label="Invoice SAC code" value={branch.invoiceSacCode} />
                  <DetailField label="Activated" value={branch.activatedAt ? new Date(branch.activatedAt).toLocaleDateString() : "Not activated"} />
                </DetailSection>
              </div>

              <section className="rounded-md border border-slate-200 bg-white">
                <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-950 sm:px-5">Operating setup</h2>
                <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
                  <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Services</h3><TextList values={branch.operations?.supportedServices} /></div>
                  <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Shipment coverage</h3><TextList values={branch.operations?.shipmentCoverage} /></div>
                  <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Operating countries</h3><TextList values={branch.operations?.operatingCountries} emptyLabel="All countries" /></div>
                  <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Working days</h3><TextList values={branch.operations?.workingDays} /></div>
                </div>
                {branch.phoneNumbers?.length ? <div className="border-t border-slate-200 px-4 py-4 sm:px-5"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Additional phone numbers</h3><ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{branch.phoneNumbers.map((phone, index) => <li key={`${phone.number}-${index}`} className="text-sm text-slate-800">{phone.label ? `${phone.label}: ` : ""}{phone.number || "-"}</li>)}</ul></div> : null}
              </section>

              {branch.documents?.length ? (
                <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
                  <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-950 sm:px-5">Branch documents</h2>
                  <ul className="divide-y divide-slate-200">{branch.documents.map((item, index) => { const title = item.title || item.fileName; return <li key={`${item.fileName}-${index}`} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className="min-w-0"><button type="button" onClick={() => void openBranchDocument(index, false, item.fileName, title)} disabled={openingDocument === index} className="break-words text-left text-sm font-semibold text-[#0D1282] underline-offset-4 hover:underline disabled:opacity-50">{title}</button><p className="mt-1 text-xs text-slate-600">{formatBranchLabel(item.type)} · Added {new Date(item.uploadedAt).toLocaleDateString("en-IN")}</p></div><div className="flex shrink-0 gap-2"><button type="button" onClick={() => void openBranchDocument(index, false, item.fileName, title)} disabled={openingDocument === index} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 disabled:opacity-50"><FiEye aria-hidden="true" /> Preview</button><button type="button" onClick={() => void openBranchDocument(index, true, item.fileName, title)} disabled={openingDocument === index} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 disabled:opacity-50"><FiDownload aria-hidden="true" /> Download</button></div></li>; })}</ul>
                </section>
              ) : null}
              <p className="text-xs text-slate-600">Updated {new Date(branch.updatedAt).toLocaleString()}</p>
            </section>

            <section id="branch-panel-accounts" role="tabpanel" aria-labelledby="branch-tab-accounts" hidden={activeTab !== "accounts"} className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
                <div><h2 className="font-semibold text-slate-950">Assigned business accounts</h2><p className="mt-1 text-sm text-slate-600">Accounts assigned to {branch.name}.</p></div>
                <form onSubmit={submitAccountSearch} className="flex w-full gap-2 sm:max-w-md">
                  <label className="relative min-w-0 flex-1"><span className="sr-only">Search assigned business accounts</span><FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} maxLength={100} placeholder="Company, account ID, or contact" className="min-h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20" /></label>
                  <button type="submit" className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50">Search</button>
                </form>
              </div>
              {accountsError ? <div role="alert" className="flex flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-5"><p className="text-sm text-rose-800">{accountsError}</p><button type="button" onClick={() => { setAccountsLoading(true); setAccountsError(""); setAccountsRetryKey((current) => current + 1); }} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button></div> : accountsLoading ? <LoadingRows /> : accounts.length === 0 ? <div className="px-5 py-12 text-center"><p className="text-sm font-semibold text-slate-900">No assigned business accounts</p><p className="mt-2 text-sm text-slate-600">Accounts assigned to this branch will appear here.</p></div> : <BranchAccountRows accounts={accounts} operatorSlug={operatorSlug} canOpen={canOpenAccounts} canManage={canManage} busy={statusBusy} onStatusChange={(account, nextStatus) => setPendingAccountStatus({ account, status: nextStatus })} />}
              {!accountsLoading && !accountsError ? <DirectoryPagination pagination={accountsPagination} onPageChange={(nextPage) => { setAccountsLoading(true); setAccountsError(""); setAccountPage(nextPage); }} /> : null}
            </section>

            <section id="branch-panel-users" role="tabpanel" aria-labelledby="branch-tab-users" hidden={activeTab !== "users"} className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
                <div><h2 className="font-semibold text-slate-950">Users with branch access</h2><p className="mt-1 text-sm text-slate-600">Operator team members and clients with access to {branch.name}.</p></div>
                <form onSubmit={submitUserSearch} className="flex w-full gap-2 sm:max-w-sm">
                  <label className="relative min-w-0 flex-1"><span className="sr-only">Search assigned users</span><FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} maxLength={100} placeholder="Name, email, or role" className="min-h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20" /></label>
                  <button type="submit" className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50">Search</button>
                </form>
              </div>
              {usersError ? <div role="alert" className="flex flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-5"><p className="text-sm text-rose-800">{usersError}</p><button type="button" onClick={() => { setUsersLoading(true); setUsersError(""); setUsersRetryKey((current) => current + 1); }} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button></div> : usersLoading ? <LoadingRows /> : branchUsers.length === 0 ? <div className="px-5 py-12 text-center"><p className="text-sm font-semibold text-slate-900">No users with access</p><p className="mt-2 text-sm text-slate-600">Team members and account clients with branch access will appear here.</p></div> : <BranchUserRows users={branchUsers} operatorSlug={operatorSlug} branchId={branchId} />}
              {!usersLoading && !usersError ? <DirectoryPagination pagination={usersPagination} onPageChange={(nextPage) => { setUsersLoading(true); setUsersError(""); setUserPage(nextPage); }} /> : null}
            </section>
          </>
        ) : null}
      </div>
      {pendingBranchDelete ? <ConfirmDialog title="Delete draft branch?" description={<>The draft branch <strong>{branch?.name}</strong> will be permanently removed if it has no dependent accounts.</>} confirmLabel="Delete draft" busy={statusBusy} onConfirm={removeDraftBranch} onCancel={() => setPendingBranchDelete(false)} /> : null}
      {pendingAccountStatus ? <ConfirmDialog title={pendingAccountStatus.status === "active" ? "Activate business account?" : "Deactivate business account?"} description={pendingAccountStatus.status === "active" ? <>This restores shipment booking for <strong>{pendingAccountStatus.account.company?.companyName || pendingAccountStatus.account.accountId}</strong>.</> : <>This blocks new shipment bookings for <strong>{pendingAccountStatus.account.company?.companyName || pendingAccountStatus.account.accountId}</strong> until it is activated again.</>} confirmLabel={pendingAccountStatus.status === "active" ? "Activate account" : "Deactivate account"} busy={statusBusy} onConfirm={changeAccountStatus} onCancel={() => setPendingAccountStatus(null)} /> : null}
      {previewDocument ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="branch-document-preview-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewDocument(null); }}><section className="flex h-[min(92vh,900px)] w-full max-w-6xl flex-col overflow-hidden rounded-md bg-white shadow-2xl"><header className="flex min-h-14 items-center justify-between gap-4 border-b border-slate-200 px-4 sm:px-5"><h2 id="branch-document-preview-title" className="truncate text-sm font-semibold text-slate-950">{previewDocument.title}</h2><button ref={closePreviewButton} type="button" aria-label="Close document preview" onClick={() => setPreviewDocument(null)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]"><FiX aria-hidden="true" /></button></header><iframe title={`Preview of ${previewDocument.title}`} src={previewDocument.url} className="min-h-0 flex-1 bg-slate-100" /></section></div> : null}
    </main>
  );
}
