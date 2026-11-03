"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiEye, FiSearch, FiUsers } from "react-icons/fi";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";
import {
  getOperatorSession,
  listOperatorUsers,
  type OperatorDirectoryPagination,
  type OperatorSession,
  type OperatorUserDirectoryRow,
  type OperatorUserDirectoryResult
} from "@/lib/operatorDirectory";

const PAGE_SIZE = 20;
const EMPTY_PAGINATION: OperatorDirectoryPagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };

function humanize(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayName(user: OperatorUserDirectoryRow["user"]): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.name || user.email || "Portal user";
}

function statusTone(status: string): string {
  switch (status.toLowerCase()) {
    case "active": return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "invited": return "bg-sky-50 text-sky-800 ring-sky-200";
    case "suspended":
    case "removed":
    case "declined": return "bg-rose-50 text-rose-800 ring-rose-200";
    case "pending_approval": return "bg-amber-50 text-amber-800 ring-amber-200";
    default: return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function formatLastLogin(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function UserRows({ users, audience, operatorName, operatorSlug }: {
  users: OperatorUserDirectoryRow[];
  audience: "team" | "clients";
  operatorName: string;
  operatorSlug: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-4 py-3 sm:px-5">User</th>
            <th scope="col" className="px-4 py-3">Role</th>
            <th scope="col" className="px-4 py-3">Company / designation</th>
            <th scope="col" className="px-4 py-3">Status</th>
            <th scope="col" className="px-4 py-3">Last login</th>
            <th scope="col" className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {users.length ? users.map((entry) => {
            const name = displayName(entry.user);
            const companyName = audience === "clients"
              ? entry.account?.companyName || entry.account?.accountId || "Account name unavailable"
              : operatorName;
            const profileHref = "/portal/" + encodeURIComponent(operatorSlug) + "/users/" + audience + "/" + encodeURIComponent(entry._id);
            return (
              <tr key={entry._id} className="align-top transition-colors hover:bg-slate-50/80">
                <td className="max-w-[22rem] px-4 py-4 sm:px-5">
                  <p className="break-words font-semibold text-slate-950">{name}</p>
                  <p className="mt-1 break-all text-sm text-slate-600">{entry.user.email || "No login email available"}</p>
                  {entry.user.phone ? <p className="mt-1 text-xs text-slate-600">{entry.user.phone}</p> : null}
                </td>
                <td className="px-4 py-4 font-medium text-slate-800">{humanize(entry.role)}</td>
                <td className="max-w-[19rem] px-4 py-4">
                  <p className="break-words font-medium text-slate-900">{companyName}</p>
                  {entry.user.designation ? <p className="mt-1 break-words text-xs text-slate-600">{entry.user.designation}</p> : null}
                </td>
                <td className="px-4 py-4">
                  <span className={"inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset " + statusTone(entry.membershipStatus)}>{humanize(entry.membershipStatus)}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-slate-700">{formatLastLogin(entry.user.lastLogin)}</td>
                <td className="px-4 py-4 text-right">
                  <Link
                    href={profileHref}
                    aria-label={"View profile for " + name}
                    className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:border-[#0D1282]/30 hover:bg-[#0D1282]/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
                  >
                    <FiEye aria-hidden="true" className="h-4 w-4" /> View
                  </Link>
                </td>
              </tr>
            );
          }) : (
            <tr>
              <td colSpan={6} className="px-5 py-10 text-center">
                <FiUsers aria-hidden="true" className="mx-auto h-5 w-5 text-slate-500" />
                <p className="mt-3 text-sm font-semibold text-slate-900">No {audience === "team" ? "operator team users" : "business account users"} found</p>
                <p className="mt-1 text-sm leading-5 text-slate-600">Try a different search or check back when users have been invited.</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
function Pagination({
  label,
  pagination,
  onPageChange
}: {
  label: string;
  pagination: OperatorDirectoryPagination;
  onPageChange: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);

  return (
    <nav aria-label={`${label} pagination`} className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:px-5">
      <p className="text-xs text-slate-600">Showing {start}–{end} of {pagination.total}</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPageChange(pagination.page - 1)} disabled={pagination.page <= 1} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Previous</button>
        <button type="button" onClick={() => onPageChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">Next</button>
      </div>
    </nav>
  );
}

export default function OperatorUsersPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [result, setResult] = useState<OperatorUserDirectoryResult | null>(null);
  const [teamPage, setTeamPage] = useState(1);
  const [clientPage, setClientPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then(async (session) => {
      if (!active) return;
      setOperator(session);
      if (session.membership.role !== "OPERATOR_ADMIN" || session.access.mode !== "MEMBER" || session.access.readOnly) return;
      const users = await listOperatorUsers(operatorSlug, {
        teamPage,
        clientPage,
        pageSize: PAGE_SIZE,
        search: appliedSearch || undefined
      }, controller.signal);
      if (!active) return;
      setResult(users);
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object"
        ? cause as { status?: unknown; canonicalSlug?: unknown }
        : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug && requestError.canonicalSlug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/users`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load operator users.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [appliedSearch, clientPage, operatorSlug, refreshKey, router, teamPage]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setTeamPage(1);
    setClientPage(1);
    setAppliedSearch(search.trim());
  }

  function retryUsers() {
    setLoading(true);
    setError("");
    setRefreshKey((value) => value + 1);
  }

  function changeTeamPage(page: number) {
    setLoading(true);
    setError("");
    setTeamPage(page);
  }

  function changeClientPage(page: number) {
    setLoading(true);
    setError("");
    setClientPage(page);
  }

  const base = `/portal/${encodeURIComponent(operatorSlug)}`;

  if (operator && (
    operator.membership.role !== "OPERATOR_ADMIN" ||
    operator.access.mode !== "MEMBER" ||
    operator.access.readOnly
  )) {
    return (
      <main className="min-h-[calc(100dvh-8rem)] bg-[#EEEDED] py-8 text-slate-900 sm:py-10">
        <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
          <section role="alert" className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
            <h1 className="text-xl font-semibold text-slate-950">Users</h1>
            <p className="mt-2 text-sm leading-5 text-slate-700">Use an active operator administrator login to view this directory.</p>
          </section>
        </div>
      </main>
    );
  }

  const teamUsers = result?.teamUsers ?? [];
  const clientUsers = result?.clientUsers ?? [];
  const teamPagination = result?.teamPagination ?? EMPTY_PAGINATION;
  const clientPagination = result?.clientPagination ?? EMPTY_PAGINATION;

  return (
    <main className="min-h-[calc(100dvh-8rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
      <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
        <header className="mt-5 flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-3xl">Users</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">Operator team members and users connected to the operator’s business accounts.</p>
          </div>
          <Link href={base} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-end rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:self-auto"><FiArrowLeft aria-hidden="true" className="h-4 w-4" /> Workspace home</Link>
        </header>

        <form onSubmit={submitSearch} className="mt-5 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end sm:p-5">
          <div className="min-w-0 flex-1">
            <label htmlFor="operator-users-search" className="mb-2 block text-sm font-medium text-slate-700">Search both user lists</label>
            <div className="relative">
              <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input id="operator-users-search" type="search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, account name or account ID" className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" />
            </div>
          </div>
          <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiSearch aria-hidden="true" className="h-4 w-4" /> Search</button>
        </form>

        {error ? (
          <div role="alert" className="mt-5 flex flex-col gap-3 rounded-xl border border-rose-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div><p className="font-semibold text-slate-900">Could not load users</p><p className="mt-1 text-sm leading-5 text-slate-700">{error}</p></div>
            <button type="button" onClick={retryUsers} className="min-h-10 shrink-0 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Try again</button>
          </div>
        ) : null}

        {loading ? (
          <OperatorLoadingIndicator label="Loading users…" className="mt-5 min-h-[calc(100dvh-22rem)]" />
        ) : !error ? (
          <div className="mt-7 space-y-7">
            <section id="operator-team-users" aria-labelledby="operator-team-users-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
                <div><h2 id="operator-team-users-heading" className="text-base font-semibold text-slate-950">Operator team</h2><p className="mt-1 text-sm text-slate-600">People with staff access to this operator workspace.</p></div>
                <span className="text-sm font-semibold tabular-nums text-slate-700">{teamPagination.total}</span>
              </header>
              <UserRows users={teamUsers} audience="team" operatorName={operator?.operator.companyName || "Operator team"} operatorSlug={operatorSlug} />
              <Pagination label="Operator team users" pagination={teamPagination} onPageChange={changeTeamPage} />
            </section>

            <section id="operator-client-users" aria-labelledby="operator-client-users-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
                <div><h2 id="operator-client-users-heading" className="text-base font-semibold text-slate-950">Business account users</h2><p className="mt-1 text-sm text-slate-600">People invited to or active in the operator’s client businesses.</p></div>
                <span className="text-sm font-semibold tabular-nums text-slate-700">{clientPagination.total}</span>
              </header>
              <UserRows users={clientUsers} audience="clients" operatorName={operator?.operator.companyName || "Operator"} operatorSlug={operatorSlug} />
              <Pagination label="Business account users" pagination={clientPagination} onPageChange={changeClientPage} />
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
