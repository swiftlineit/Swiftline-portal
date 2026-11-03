"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiCheck, FiClock, FiFileText, FiX } from "react-icons/fi";
import {
  approveOperatorShipmentAmendment,
  listOperatorShipmentAmendments,
  OperatorAmendmentRequestError,
  rejectOperatorShipmentAmendment,
  type OperatorAmendmentQueueItem
} from "@/lib/operatorAmendments";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";

const PAGE_SIZE = 25;

function money(minor: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "Not set";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item != null && item !== "")
      .map(([key, item]) => `${key}: ${formatValue(item)}`)
      .join(" · ") || "Not set";
  }
  return "Not set";
}

function fieldLabel(fieldName: string) {
  return fieldName.replace(/^consigneeEnteredAddress\./, "Consignee ")
    .replace(/^parcelList\.(\d+)\./, "Parcel $1 · ")
    .replaceAll(".", " · ")
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function requestError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The amendment action could not be completed.";
}

export default function OperatorAmendmentQueue({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [amendments, setAmendments] = useState<OperatorAmendmentQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [openId, setOpenId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fetchQueue = useCallback(async (signal?: AbortSignal) => {
    const [operator, result] = await Promise.all([
      getOperatorSession(operatorSlug, signal),
      listOperatorShipmentAmendments(operatorSlug, page, signal)
    ]);
    return { operator, result };
  }, [operatorSlug, page]);

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const { operator, result } = await fetchQueue(signal);
    setSession(operator);
    setAmendments(result.amendments);
    setTotal(result.pagination.total);
    setTotalPages(Math.max(1, result.pagination.totalPages));
    setError("");
    return result.amendments;
  }, [fetchQueue]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchQueue(controller.signal).then(({ operator, result }) => {
      if (!active || controller.signal.aborted) return;
      setSession(operator);
      setAmendments(result.amendments);
      setTotal(result.pagination.total);
      setTotalPages(Math.max(1, result.pagination.totalPages));
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (cause instanceof OperatorAmendmentRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/amendments`);
        return;
      }
      setError(requestError(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [fetchQueue, router]);

  function openReview(id: string) {
    setError("");
    setNotice("");
    setOpenId((current) => current === id ? "" : id);
  }

  async function finishAction(item: OperatorAmendmentQueueItem, action: "approve" | "reject") {
    if (busyId) return;
    const note = (notes[item.id] ?? "").trim();
    if (action === "reject" && note.length < 5) {
      setError("Enter a reason for declining in at least five characters.");
      return;
    }
    setBusyId(item.id);
    setError("");
    try {
      if (action === "approve") await approveOperatorShipmentAmendment(operatorSlug, item.id, note);
      else await rejectOperatorShipmentAmendment(operatorSlug, item.id, note);
      setNotice(action === "approve"
        ? `Amendment for ${item.trackingNumber || "the shipment"} was approved. Its invoice and credit balance were updated.`
        : `Amendment request for ${item.trackingNumber || "the shipment"} was declined.`);
      setOpenId("");
      const remaining = await loadQueue();
      if (!remaining.length && page > 1) setPage((value) => value - 1);
    } catch (cause) {
      if (cause instanceof OperatorAmendmentRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/amendments`);
        return;
      }
      setError(requestError(cause));
    } finally {
      setBusyId("");
    }
  }

  const canReview = !supportReadOnly && Boolean(session && ["OPERATOR_ADMIN", "OPERATIONS"].includes(session.membership.role));
  const start = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-950">Amendment review</h1>
            <p className="mt-2 max-w-2xl text-sm leading-5 text-slate-600">Review requested shipment changes and their credit impact before applying them.</p>
          </div>
          <div className="flex items-center gap-3">
            {total ? <p className="text-sm font-medium tabular-nums text-slate-600">{total} pending {total === 1 ? "request" : "requests"}</p> : null}
          </div>
        </div>

        {error ? <div role="alert" className="mt-5 rounded-md border border-rose-200 bg-white p-4 text-sm leading-5 text-rose-800">{error}</div> : null}
        {notice ? <div role="status" className="mt-5 rounded-md border border-emerald-200 bg-white p-4 text-sm leading-5 text-emerald-800">{notice}</div> : null}

        <section aria-label="Pending shipment amendments" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {loading ? (
            <div aria-label="Loading amendments" className="animate-pulse space-y-3 p-4 sm:p-5">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-40 rounded-md bg-slate-100" />)}</div>
          ) : amendments.length ? (
            <ol className="divide-y divide-slate-200">
              {amendments.map((item) => {
                const isOpen = openId === item.id;
                const deltaMinor = item.pricingImpact ? Math.round(item.pricingImpact.deltaAmount * 100) : null;
                return (
                  <li key={item.id} id={`amendment-${item.id}`} className="p-4 sm:p-5">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments/${encodeURIComponent(item.shipmentDraftId)}`} className="break-all font-semibold text-[#0D1282] underline-offset-2 hover:underline">{item.trackingNumber || item.dpdShipmentId}</Link>
                          <span className="inline-flex items-center gap-1 text-xs text-slate-500"><FiClock aria-hidden="true" className="h-3.5 w-3.5" />{formatDate(item.requestedAt)}</span>
                        </div>
                        <div className="mt-2 grid gap-x-5 gap-y-1 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                          <p className="break-words"><span className="font-medium text-slate-800">Account:</span> {item.accountName} ({item.accountId})</p>
                          <p className="break-words"><span className="font-medium text-slate-800">Consignee:</span> {item.consignee}</p>
                          <p className="break-words"><span className="font-medium text-slate-800">Branch:</span> {item.branch?.name || "Unknown"}</p>
                          <p className="break-words"><span className="font-medium text-slate-800">Reason:</span> {item.reason || "No reason provided"}</p>
                        </div>
                        {deltaMinor !== null ? <p className={`mt-3 text-sm font-semibold ${deltaMinor > 0 ? "text-amber-800" : deltaMinor < 0 ? "text-emerald-800" : "text-slate-700"}`}>Charge change: {deltaMinor > 0 ? "+" : deltaMinor < 0 ? "−" : ""}{money(Math.abs(deltaMinor))}</p> : <p className="mt-3 text-sm text-slate-600">No charge impact recorded.</p>}
                      </div>
                      {canReview ? (
                        <div className="flex shrink-0 flex-col gap-2 sm:flex-row xl:flex-col">
                          <button type="button" onClick={() => openReview(item.id)} aria-expanded={isOpen} aria-controls={`amendment-review-${item.id}`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                            <FiFileText aria-hidden="true" className="h-4 w-4" /> Review changes
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {isOpen ? (
                      <div id={`amendment-review-${item.id}`} className="mt-5 border-t border-slate-200 pt-5">
                        <h2 className="text-sm font-semibold text-slate-950">Requested changes</h2>
                        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                          {item.changePreview.map((change) => (
                            <div key={change.fieldName} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-3">
                              <dt className="break-words text-xs font-semibold uppercase tracking-wide text-slate-500">{fieldLabel(change.fieldName)}</dt>
                              <dd className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                                <div className="min-w-0"><span className="block text-xs text-slate-500">Current</span><p className="mt-0.5 break-words text-slate-700">{formatValue(change.originalValue)}</p></div>
                                <div className="min-w-0"><span className="block text-xs text-slate-500">Requested</span><p className="mt-0.5 break-words font-medium text-slate-900">{formatValue(change.newValue)}</p></div>
                              </dd>
                            </div>
                          ))}
                        </dl>
                        {item.pricingImpact ? (
                          <div className="mt-4 grid gap-3 rounded-md bg-slate-50 p-4 sm:grid-cols-3">
                            <div><p className="text-xs font-semibold uppercase text-slate-500">Current invoice</p><p className="mt-1 font-semibold tabular-nums text-slate-900">{money(Math.round(item.pricingImpact.current.totalAmount * 100))}</p></div>
                            <div><p className="text-xs font-semibold uppercase text-slate-500">Requested invoice</p><p className="mt-1 font-semibold tabular-nums text-slate-900">{money(Math.round(item.pricingImpact.requested.totalAmount * 100))}</p></div>
                            <div><p className="text-xs font-semibold uppercase text-slate-500">Funding status</p><p className="mt-1 font-semibold text-slate-900">{item.fundingPreview?.canFund ? "Can be funded" : item.fundingPreview?.message || "Pending calculation"}</p></div>
                          </div>
                        ) : null}
                        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
                          <div>
                            <label htmlFor={`amendment-note-${item.id}`} className="mb-1.5 block text-sm font-medium text-slate-800">Review note <span className="font-normal text-slate-500">(optional on approval)</span></label>
                            <textarea id={`amendment-note-${item.id}`} value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={500} rows={3} disabled={Boolean(busyId)} className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-50" />
                            <p className="mt-1 text-xs leading-5 text-slate-500">A note is required when declining the request.</p>
                          </div>
                          <div className="flex flex-col justify-end gap-2 sm:flex-row lg:flex-col">
                            <button type="button" onClick={() => void finishAction(item, "reject")} disabled={Boolean(busyId) || (notes[item.id] ?? "").trim().length < 5} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-800 transition hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
                              <FiX aria-hidden="true" className="h-4 w-4" />{busyId === item.id ? "Declining…" : "Decline amendment"}
                            </button>
                            <button type="button" onClick={() => void finishAction(item, "approve")} disabled={Boolean(busyId) || item.fundingPreview?.canFund === false} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50">
                              <FiCheck aria-hidden="true" className="h-4 w-4" />{busyId === item.id ? "Applying…" : "Approve and apply"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="px-5 py-12 text-center sm:py-16">
              <FiCheck aria-hidden="true" className="mx-auto h-7 w-7 text-emerald-700" />
              <h2 className="mt-3 text-base font-semibold text-slate-950">No amendment requests need review</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-5 text-slate-600">New requests from this operator’s clients will appear here. Invoices and credit change only after approval.</p>
            </div>
          )}

          {!loading && totalPages > 1 ? (
            <nav aria-label="Amendment request pagination" className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="text-xs text-slate-600">Showing {start}–{end} of {total}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page <= 1} className="min-h-9 flex-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none">Previous</button>
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.min(totalPages, value + 1)); }} disabled={page >= totalPages} className="min-h-9 flex-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none">Next</button>
              </div>
            </nav>
          ) : null}
        </section>
        {!canReview && !loading && !error ? <p role="status" className="mt-5 rounded-md border border-slate-200 bg-white p-4 text-sm leading-5 text-slate-700">This is a read-only amendment list. Only operator administrators and operations staff may apply changes.</p> : null}
      </main>
    </div>
  );
}
