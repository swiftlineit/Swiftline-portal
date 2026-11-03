"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiArrowRight, FiSearch } from "react-icons/fi";
import OperatorPageLoading, { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { getOperatorContactQuery, listOperatorContactQueries, type OperatorContactQuery } from "@/lib/operatorContact";

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
};

function Header({ slug, detail = false }: { slug: string; detail?: boolean }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div><h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{detail ? "Client query" : "Client queries"}</h1>
      <p className="mt-1 text-sm text-slate-600 sm:text-base">{detail ? "Contact details and the message sent to your team." : "Questions and issues sent by your business account clients."}</p></div>
    <Link href={detail ? `/portal/${encodeURIComponent(slug)}/queries` : `/portal/${encodeURIComponent(slug)}`}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] hover:bg-slate-50"><FiArrowLeft aria-hidden="true" /> {detail ? "All queries" : "Workspace home"}</Link>
  </div>;
}

function AccessState({ error }: { error: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700">{error}</div>;
}

export default function OperatorQueriesPage({ operatorSlug, queryId }: { operatorSlug: string; queryId?: string }) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState<OperatorContactQuery | null>(null);
  const [queries, setQueries] = useState<OperatorContactQuery[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then(async (result) => {
      if (!active) return;
      setSession(result);
      if (!(["OPERATOR_ADMIN", "OPERATIONS"].includes(result.membership.role)) || result.access.readOnly) return;
      if (queryId) {
        const response = await getOperatorContactQuery(operatorSlug, queryId, controller.signal);
        if (active) setQuery(response.query);
      } else {
        const response = await listOperatorContactQueries(operatorSlug, page, appliedSearch, controller.signal);
        if (active) { setQueries(response.queries); setPagination(response.pagination); }
      }
      if (active) setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const canonical = (cause as { canonicalSlug?: unknown })?.canonicalSlug;
      if (typeof canonical === "string" && canonical !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(canonical)}/${queryId ? `queries/${encodeURIComponent(queryId)}` : "queries"}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load client queries.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, queryId, page, appliedSearch, router]);

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (search.trim() === appliedSearch && page === 1) return;
    setLoading(true);
    setPage(1);
    setAppliedSearch(search.trim());
  }

  if (loading && !session) return <OperatorPageLoading label={queryId ? "Loading client query" : "Loading client queries"} />;
  const permitted = session && ["OPERATOR_ADMIN", "OPERATIONS"].includes(session.membership.role) && !session.access.readOnly;
  const base = `/portal/${encodeURIComponent(operatorSlug)}/queries`;
  return <main className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] py-7 sm:py-10"><div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
    <Header slug={operatorSlug} detail={Boolean(queryId)} />
    {!permitted ? <AccessState error={error || "Only operator admin and operations staff can view client queries."} />
      : queryId ? <>
        {loading ? <div className="rounded-xl bg-white p-12"><OperatorLoadingIndicator label="Loading client query" /></div>
          : error || !query ? <AccessState error={error || "Query not found."} />
            : <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(250px,360px)] lg:items-stretch">
              <article className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 p-5 sm:p-7"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${query.kind === "ISSUE" ? "bg-amber-50 text-amber-900" : "bg-sky-50 text-sky-900"}`}>{query.kind === "ISSUE" ? "Issue" : "Help request"}</span>
                  <h2 className="mt-3 break-words text-xl font-semibold text-slate-950 sm:text-2xl">{query.subject}</h2><p className="mt-1 text-sm text-slate-600">Received {formatDate(query.createdAt)}</p></div>
                <div className="p-5 sm:p-7"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Message</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">{query.message}</p></div>
              </article>
              <aside className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="font-semibold text-slate-950">Contact details</h2>
                <dl className="mt-4 space-y-4 text-sm"><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business account</dt><dd className="mt-1 break-words font-medium text-slate-900">{query.businessAccountName}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Name</dt><dd className="mt-1 break-words text-slate-800">{query.contactName}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt><dd className="mt-1 break-all"><a className="text-[#0D1282] underline-offset-2 hover:underline" href={`mailto:${query.contactEmail}`}>{query.contactEmail}</a></dd></div>
                  {query.contactPhone ? <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Phone</dt><dd className="mt-1 text-slate-800">{query.contactPhone}</dd></div> : null}
                  {query.awbNumbers.length ? <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">AWB numbers</dt><dd className="mt-1 flex flex-wrap gap-1.5">{query.awbNumbers.map((awb) => <span key={awb} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-800">{awb}</span>)}</dd></div> : null}
                </dl>
              </aside>
            </div>}
      </> : <>
        <form onSubmit={applySearch} className="mb-5 flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <label htmlFor="query-search" className="sr-only">Search client queries</label>
          <div className="relative min-w-0 flex-1 basis-60"><FiSearch aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input id="query-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search account, contact, subject or AWB" className="min-h-11 w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10" /></div>
          <button className="min-h-11 rounded-lg border border-slate-300 bg-white px-5 text-sm font-semibold text-[#0D1282] hover:bg-slate-50">Search</button>
        </form>
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Client queries">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><h2 className="font-semibold text-slate-950">Messages</h2><span className="text-sm text-slate-600">{pagination.total} total</span></div>
          {loading ? <div className="py-16"><OperatorLoadingIndicator label="Loading client queries" /></div>
            : error ? <div className="p-6 text-sm text-rose-700">{error}</div>
              : queries.length === 0 ? <div className="px-5 py-16 text-center"><p className="font-semibold text-slate-900">No client queries found</p><p className="mt-1 text-sm text-slate-600">New messages will appear here.</p></div>
                : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600"><tr><th className="px-5 py-3">Subject</th><th className="px-4 py-3">Business account</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Received</th><th className="px-5 py-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-slate-200">{queries.map((item) => <tr key={item.id} className="align-top hover:bg-slate-50/70"><td className="max-w-72 px-5 py-4"><p className="break-words font-semibold text-slate-950">{item.subject}</p><span className={`mt-1 inline-block text-xs font-medium ${item.kind === "ISSUE" ? "text-amber-800" : "text-sky-800"}`}>{item.kind === "ISSUE" ? "Issue" : "Help request"}</span>{item.awbNumbers.length ? <p className="mt-1 truncate font-mono text-xs text-slate-500">{item.awbNumbers.join(", ")}</p> : null}</td><td className="max-w-52 break-words px-4 py-4 text-slate-800">{item.businessAccountName}</td><td className="px-4 py-4"><p className="font-medium text-slate-800">{item.contactName}</p><p className="mt-1 break-all text-xs text-slate-600">{item.contactEmail}</p></td><td className="whitespace-nowrap px-4 py-4 text-slate-700">{formatDate(item.createdAt)}</td><td className="px-5 py-4 text-right"><Link href={`${base}/${encodeURIComponent(item.id)}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 font-semibold text-[#0D1282] hover:bg-slate-50">View <FiArrowRight aria-hidden="true" /></Link></td></tr>)}</tbody></table></div>}
        </section>
        {pagination.totalPages > 1 ? <div className="mt-5 flex flex-wrap items-center justify-end gap-3 text-sm"><button type="button" disabled={page <= 1} onClick={() => { setLoading(true); setPage(page - 1); }} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 font-medium disabled:opacity-50">Previous</button><span className="text-slate-600">Page {page} of {pagination.totalPages}</span><button type="button" disabled={page >= pagination.totalPages} onClick={() => { setLoading(true); setPage(page + 1); }} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 font-medium disabled:opacity-50">Next</button></div> : null}
      </>}
  </div></main>;
}
