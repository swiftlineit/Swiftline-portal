"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiChevronDown, FiChevronLeft, FiEdit3, FiEye, FiPlus, FiSearch } from "react-icons/fi";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import {
  branchStatuses,
  formatBranchLabel,
  type BranchStatus
} from "@/lib/branches";
import {
  getOperatorSession,
  listOperatorBranches,
  type OperatorBranch,
  type OperatorBranchDirectoryQuery,
  type OperatorDirectoryPagination,
  type OperatorSession
} from "@/lib/operatorDirectory";

const PAGE_SIZE = 20;
const EMPTY_PAGINATION: OperatorDirectoryPagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };

function statusClasses(status: string): string {
  switch (status) {
    case "ACTIVE": return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "DRAFT":
    case "INACTIVE": return "bg-amber-50 text-amber-800 ring-amber-200";
    case "SUSPENDED":
    case "CLOSED": return "bg-rose-50 text-rose-800 ring-rose-200";
    default: return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClasses(status)}`}>{formatBranchLabel(status)}</span>;
}

type BranchRowActionProps = {
  branch: OperatorBranch;
  operatorSlug: string;
  canManage: boolean;
};

function BranchRowActions({ branch, operatorSlug, canManage }: BranchRowActionProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Link href={`/portal/${encodeURIComponent(operatorSlug)}/branches/${encodeURIComponent(branch._id)}`}
        aria-label={`View ${branch.name} details`}
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
        <FiEye aria-hidden="true" className="h-4 w-4" /> Details
      </Link>
      {canManage ? (
          <Link href={`/portal/${encodeURIComponent(operatorSlug)}/branches/${encodeURIComponent(branch._id)}/edit`}
            aria-label={`Edit ${branch.name}`}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
            <FiEdit3 aria-hidden="true" className="h-4 w-4" /> Edit
          </Link>
      ) : null}
    </div>
  );
}

function BranchTableRow({ branch, ...actions }: BranchRowActionProps) {
  return (
    <tr className="border-t border-slate-200 align-top">
      <td className="px-4 py-4 sm:px-5">
        <p className="font-semibold text-slate-950">{branch.name}</p>
        <p className="mt-1 text-sm text-slate-600">{branch.address?.stateOrProvince || "State not set"}</p>
      </td>
      <td className="px-4 py-4 text-sm text-slate-700 sm:px-5">
        <p className="break-all">{branch.contact?.email || "-"}</p>
        <p className="mt-1">{branch.contact?.phone || "-"}</p>
      </td>
      <td className="px-4 py-4 sm:px-5"><StatusBadge status={branch.status} /></td>
      <td className="px-4 py-4 text-slate-700 sm:px-5">{branch.openingDate ? new Date(branch.openingDate).toLocaleDateString("en-IN") : "-"}</td>
      <td className="px-4 py-4 text-right sm:px-5">
        <BranchRowActions branch={branch} {...actions} />
      </td>
    </tr>
  );
}

function BranchMobileRow({ branch, ...actions }: BranchRowActionProps) {
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold text-slate-950">{branch.name}</p>
          <p className="mt-1 break-words text-sm text-slate-600">{branch.address?.stateOrProvince || "State not set"}</p>
        </div>
        <StatusBadge status={branch.status} />
      </div>
      <p className="break-all text-sm text-slate-700">{branch.contact?.email || "No contact email"} · {branch.contact?.phone || "No contact number"}</p>
      <p className="text-sm text-slate-700">Opened {branch.openingDate ? new Date(branch.openingDate).toLocaleDateString("en-IN") : "Not set"}</p>
      <div className="flex justify-start">
        <BranchRowActions branch={branch} {...actions} />
      </div>
    </li>
  );
}

export default function OperatorBranchesPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const supportReadOnly = useOperatorSupportReadOnly();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [branches, setBranches] = useState<OperatorBranch[]>([]);
  const [pagination, setPagination] = useState<OperatorDirectoryPagination>(EMPTY_PAGINATION);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [status, setStatus] = useState<BranchStatus | "">("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const query: OperatorBranchDirectoryQuery = {
      page,
      pageSize: PAGE_SIZE,
      search: appliedSearch || undefined,
      status: status || undefined
    };
    Promise.all([
      getOperatorSession(operatorSlug, controller.signal),
      listOperatorBranches(operatorSlug, query, controller.signal)
    ]).then(([session, result]) => {
      if (!active) return;
      setOperator(session);
      setBranches(result.branches);
      setPagination(result.pagination);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object"
        ? cause as { status?: unknown; canonicalSlug?: unknown }
        : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/branches`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load branches.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [operatorSlug, page, appliedSearch, status, router]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setPage(1);
    setAppliedSearch(search.trim());
  }

  const canManage = Boolean(
    !supportReadOnly && operator && !operator.access.readOnly && operator.membership.role === "OPERATOR_ADMIN"
  );
  const dashboardPath = `/portal/${encodeURIComponent(operatorSlug)}`;

  return (
    <main className="min-h-[calc(100dvh-8rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
      <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Branches</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Manage the locations used by your business accounts and shipment workflows.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Link href={dashboardPath} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
              <FiChevronLeft aria-hidden="true" className="h-4 w-4" /> Workspace home
            </Link>
            {canManage ? (
              <Link href={`${dashboardPath}/branches/new`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                <FiPlus aria-hidden="true" className="h-4 w-4" /> Create branch
              </Link>
            ) : null}
          </div>
        </header>

        {error ? (
          <section role="alert" className="mt-5 flex flex-col gap-3 rounded-lg border border-rose-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-5 text-rose-900">{error}</p>
            <Link href={`/?next=${encodeURIComponent(`${dashboardPath}/branches`)}`} className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Sign in or return to the portal</Link>
          </section>
        ) : null}

        {supportReadOnly || operator?.access.readOnly ? (
          <p className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Swiftline support access is read only. Branch changes are disabled.</p>
        ) : null}

        <section aria-label="Branch directory" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <form onSubmit={submitSearch} className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-end sm:p-5">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">Search branches</span>
              <span className="relative block">
                <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Name, code, or city"
                  className="min-h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20" />
              </span>
            </label>
            <label className="sm:w-48">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">Status</span>
              <span className="relative block">
                <select value={status} onChange={(event) => { setLoading(true); setError(""); setPage(1); setStatus(event.target.value as BranchStatus | ""); }}
                  className="min-h-10 w-full appearance-none rounded-md border border-slate-300 bg-white pl-3 pr-10 text-sm text-slate-900 focus:border-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20">
                  <option value="">All statuses</option>
                  {branchStatuses.map((value) => <option key={value} value={value}>{formatBranchLabel(value)}</option>)}
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
              </span>
            </label>
            <button type="submit" className="min-h-10 rounded-md border border-slate-300 bg-slate-50 px-4 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Search</button>
          </form>

          {loading ? (
            <div aria-label="Loading branches" className="animate-pulse space-y-3 p-4 sm:p-5">
              {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-12 rounded-md bg-slate-100" />)}
            </div>
          ) : branches.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm font-semibold text-slate-900">No branches found</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-5 text-slate-600">{appliedSearch || status ? "Adjust the filters and search again." : "Create a branch to configure your operating locations."}</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    <tr><th scope="col" className="px-4 py-3 sm:px-5">Branch</th><th scope="col" className="px-4 py-3 sm:px-5">Contact</th><th scope="col" className="px-4 py-3 sm:px-5">Status</th><th scope="col" className="px-4 py-3 sm:px-5">Opening date</th><th scope="col" className="px-4 py-3 text-right sm:px-5">Actions</th></tr>
                  </thead>
                  <tbody>{branches.map((branch) => <BranchTableRow key={branch._id} branch={branch} operatorSlug={operatorSlug} canManage={canManage} />)}</tbody>
                </table>
              </div>
              <ul className="divide-y divide-slate-200 md:hidden">{branches.map((branch) => <BranchMobileRow key={branch._id} branch={branch} operatorSlug={operatorSlug} canManage={canManage} />)}</ul>
              {pagination.totalPages > 1 ? (
                <nav aria-label="Branch pages" className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <p className="text-sm text-slate-600">Showing {(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setLoading(true); setPage((current) => current - 1); }} disabled={pagination.page <= 1} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Previous</button>
                    <button type="button" onClick={() => { setLoading(true); setPage((current) => current + 1); }} disabled={pagination.page >= pagination.totalPages} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Next</button>
                  </div>
                </nav>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
