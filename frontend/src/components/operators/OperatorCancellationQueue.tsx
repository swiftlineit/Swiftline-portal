"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FiAlertCircle, FiCheck, FiX } from "react-icons/fi";
import {
  approveOperatorShipmentCancellation,
  listOperatorShipmentCancellations,
  OperatorCancellationRequestError,
  rejectOperatorShipmentCancellation,
  type OperatorCancellationQueueItem
} from "@/lib/operatorCancellations";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";

const PAGE_SIZE = 50;

function money(minor: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function titleCase(value: string) {
  return (value || "Unknown").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseRupees(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

function requestError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The cancellation action could not be completed.";
}

export default function OperatorCancellationQueue({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [cancellations, setCancellations] = useState<OperatorCancellationQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [openId, setOpenId] = useState("");
  const [reviewMode, setReviewMode] = useState<"approve" | "reject">("approve");
  const [feeRupees, setFeeRupees] = useState<Record<string, string>>({});
  const [feeReasons, setFeeReasons] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [settlementConfirmed, setSettlementConfirmed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fetchQueue = useCallback(async (signal?: AbortSignal) => {
    const [operator, result] = await Promise.all([
      getOperatorSession(operatorSlug, signal),
      listOperatorShipmentCancellations(operatorSlug, page, signal)
    ]);
    return { operator, result };
  }, [operatorSlug, page]);

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const { operator, result } = await fetchQueue(signal);
    setSession(operator);
    setCancellations(result.cancellations);
    setTotal(result.pagination.total);
    setTotalPages(Math.max(1, result.pagination.totalPages));
    setError("");
    return result.cancellations;
  }, [fetchQueue]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchQueue(controller.signal).then(({ operator, result }) => {
      if (!active || controller.signal.aborted) return;
      setSession(operator);
      setCancellations(result.cancellations);
      setTotal(result.pagination.total);
      setTotalPages(Math.max(1, result.pagination.totalPages));
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/cancellations`);
        return;
      }
      setError(requestError(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [fetchQueue, router]);

  function openReview(item: OperatorCancellationQueueItem, mode: "approve" | "reject") {
    setError("");
    setNotice("");
    if (openId === item.id && reviewMode === mode) {
      setOpenId("");
      return;
    }
    setOpenId(item.id);
    setReviewMode(mode);
    if (!(item.id in feeRupees)) setFeeRupees((value) => ({ ...value, [item.id]: "0.00" }));
    setSettlementConfirmed((value) => ({ ...value, [item.id]: false }));
  }

  async function handleApprove(item: OperatorCancellationQueueItem) {
    if (busyId) return;
    const feeBaseMinor = parseRupees(feeRupees[item.id] ?? "0.00");
    if (feeBaseMinor === null) {
      setError("Enter a non-negative fee with no more than two decimal places.");
      return;
    }
    if (feeBaseMinor > 0 && (feeReasons[item.id] ?? "").trim().length < 5) {
      setError("Explain the cancellation fee in at least 5 characters.");
      return;
    }
    if (!settlementConfirmed[item.id]) {
      setError("Confirm the credit settlement before approving this cancellation.");
      return;
    }
    setBusyId(item.id);
    setError("");
    try {
      await approveOperatorShipmentCancellation(operatorSlug, item.id, {
        feeBaseMinor,
        feeReason: (feeReasons[item.id] ?? "").trim(),
        reviewNote: (reviewNotes[item.id] ?? "").trim()
      });
      setNotice(`Cancellation for ${item.trackingNumber || "the shipment"} completed. A credit note was generated.`);
      setOpenId("");
      const remaining = await loadQueue();
      if (!remaining.length && page > 1) setPage((value) => value - 1);
    } catch (cause) {
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/cancellations`);
        return;
      }
      setError(requestError(cause));
    } finally {
      setBusyId("");
    }
  }

  async function handleReject(item: OperatorCancellationQueueItem) {
    if (busyId) return;
    const reviewNote = (reviewNotes[item.id] ?? "").trim();
    if (reviewNote.length < 5) {
      setError("Enter a rejection reason in at least 5 characters.");
      return;
    }
    setBusyId(item.id);
    setError("");
    try {
      await rejectOperatorShipmentCancellation(operatorSlug, item.id, reviewNote);
      setNotice(`Cancellation request for ${item.trackingNumber || "the shipment"} was declined.`);
      setOpenId("");
      const remaining = await loadQueue();
      if (!remaining.length && page > 1) setPage((value) => value - 1);
    } catch (cause) {
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/cancellations`);
        return;
      }
      setError(requestError(cause));
    } finally {
      setBusyId("");
    }
  }

  const canReview = !supportReadOnly && Boolean(session && ["OPERATOR_ADMIN", "OPERATIONS", "FINANCE"].includes(session.membership.role));
  const start = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-950">Cancellation review</h1>
            <p className="mt-2 max-w-2xl text-sm leading-5 text-slate-600">Review client requests, decide any fee for this case, and record the credit settlement.</p>
          </div>
          <div className="flex items-center gap-3">
            {total ? <p className="text-sm font-medium tabular-nums text-slate-600">{total} pending {total === 1 ? "request" : "requests"}</p> : null}
          </div>
        </div>

        {error ? <div role="alert" className="mt-5 rounded-md border border-rose-200 bg-white p-4 text-sm leading-5 text-rose-800">{error}</div> : null}
        {notice ? <div role="status" className="mt-5 rounded-md border border-emerald-200 bg-white p-4 text-sm leading-5 text-emerald-800">{notice}</div> : null}

        <section aria-label="Pending cancellation requests" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {loading ? (
            <div aria-label="Loading cancellation requests" className="animate-pulse space-y-3 p-4 sm:p-5">
              {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 rounded-md bg-slate-100" />)}
            </div>
          ) : cancellations.length ? (
            <ol className="divide-y divide-slate-200">
              {cancellations.map((item) => {
                const feeMinor = parseRupees(feeRupees[item.id] ?? "0.00");
                const actionOpen = openId === item.id;
                return (
                  <li key={item.id} id={`cancellation-${item.id}`} className="p-4 sm:p-5">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h2 className="break-all text-base font-semibold text-slate-950">{item.trackingNumber || "AWB pending"}</h2>
                          <span className="inline-flex min-h-7 items-center rounded-full bg-amber-50 px-2.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">Awaiting review</span>
                        </div>
                        <p className="mt-1 break-words text-sm text-slate-700">{item.accountName}{item.accountId ? ` · ${item.accountId}` : ""}</p>
                        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Destination</dt><dd className="mt-1 break-words text-slate-800">{item.destination}</dd></div>
                          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Branch and status</dt><dd className="mt-1 break-words text-slate-800">{item.branch?.name || "Branch unavailable"} · {titleCase(item.currentStatus)}</dd></div>
                          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Original invoice</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{money(item.originalAmountMinor)}</dd></div>
                          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Requested</dt><dd className="mt-1 text-slate-800">{dateTime(item.requestedAt)}</dd></div>
                        </dl>
                        <div className="mt-4 rounded-md bg-slate-50 px-3 py-3 text-sm leading-5 text-slate-700 sm:px-4">
                          <p className="font-medium text-slate-900">Client reason</p>
                          <p className="mt-1 whitespace-pre-wrap">{item.reason}</p>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row lg:min-w-[150px] lg:flex-col">
                        <button type="button" onClick={() => openReview(item, "approve")} aria-expanded={actionOpen && reviewMode === "approve"} aria-controls={`cancellation-review-${item.id}`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-3 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                          <FiCheck aria-hidden="true" className="h-4 w-4" /> Review and approve
                        </button>
                        <button type="button" onClick={() => openReview(item, "reject")} aria-expanded={actionOpen && reviewMode === "reject"} aria-controls={`cancellation-review-${item.id}`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                          <FiX aria-hidden="true" className="h-4 w-4" /> Decline
                        </button>
                      </div>
                    </div>

                    {actionOpen ? (
                      <div id={`cancellation-review-${item.id}`} className="mt-5 border-t border-slate-200 pt-5">
                        {reviewMode === "approve" ? (
                          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
                            <div className="space-y-4">
                              <div>
                                <label htmlFor={`cancellation-fee-${item.id}`} className="mb-1.5 block text-sm font-medium text-slate-800">Cancellation fee before GST</label>
                                <div className="relative max-w-sm">
                                  <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₹</span>
                                  <input id={`cancellation-fee-${item.id}`} type="number" min="0" max={(item.originalAmountMinor / 100).toFixed(2)} step="0.01" inputMode="decimal" value={feeRupees[item.id] ?? "0.00"} onChange={(event) => setFeeRupees((value) => ({ ...value, [item.id]: event.target.value }))} disabled={Boolean(busyId)} className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-sm tabular-nums text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-50" />
                                </div>
                                <p className="mt-1.5 max-w-xl text-xs leading-5 text-slate-500">Leave at ₹0.00 to waive the fee. GST is calculated when applicable; the total fee cannot exceed the original invoice.</p>
                              </div>
                              {feeMinor && feeMinor > 0 ? <div>
                                <label htmlFor={`cancellation-fee-reason-${item.id}`} className="mb-1.5 block text-sm font-medium text-slate-800">Reason for fee</label>
                                <textarea id={`cancellation-fee-reason-${item.id}`} value={feeReasons[item.id] ?? ""} onChange={(event) => setFeeReasons((value) => ({ ...value, [item.id]: event.target.value }))} minLength={5} maxLength={500} rows={2} required disabled={Boolean(busyId)} className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-50" />
                                <p className="mt-1.5 text-xs text-slate-500">Explain why this cancellation fee applies.</p>
                              </div> : null}
                              <div>
                                <label htmlFor={`cancellation-review-note-${item.id}`} className="mb-1.5 block text-sm font-medium text-slate-800">Review note <span className="font-normal text-slate-500">(optional)</span></label>
                                <textarea id={`cancellation-review-note-${item.id}`} value={reviewNotes[item.id] ?? ""} onChange={(event) => setReviewNotes((value) => ({ ...value, [item.id]: event.target.value }))} maxLength={500} rows={2} disabled={Boolean(busyId)} className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-50" />
                              </div>
                            </div>
                            <div className="flex flex-col justify-between gap-4 rounded-md bg-slate-50 p-4">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">Credit settlement</p>
                                <p className="mt-1 text-sm leading-5 text-slate-600">Approval reverses the original invoice through a credit note and applies the approved fee to the operator account.</p>
                              </div>
                              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 bg-white p-3 text-sm leading-5 text-slate-700">
                                <input type="checkbox" checked={Boolean(settlementConfirmed[item.id])} onChange={(event) => setSettlementConfirmed((value) => ({ ...value, [item.id]: event.target.checked }))} disabled={Boolean(busyId)} className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-400 accent-[#0D1282] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]" />
                                <span>I verified the cancellation and credit settlement details.</span>
                              </label>
                              <button type="button" onClick={() => void handleApprove(item)} disabled={Boolean(busyId) || !settlementConfirmed[item.id] || feeMinor === null} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50">
                                <FiCheck aria-hidden="true" className="h-4 w-4" />{busyId === item.id ? "Completing cancellation…" : "Approve cancellation"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="max-w-2xl space-y-4">
                            <div>
                              <label htmlFor={`cancellation-rejection-note-${item.id}`} className="mb-1.5 block text-sm font-medium text-slate-800">Reason for declining</label>
                              <textarea id={`cancellation-rejection-note-${item.id}`} value={reviewNotes[item.id] ?? ""} onChange={(event) => setReviewNotes((value) => ({ ...value, [item.id]: event.target.value }))} minLength={5} maxLength={500} rows={3} required disabled={Boolean(busyId)} className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-50" />
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                              <button type="button" onClick={() => { setOpenId(""); setError(""); }} disabled={Boolean(busyId)} className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:opacity-50">Keep request pending</button>
                              <button type="button" onClick={() => void handleReject(item)} disabled={Boolean(busyId) || (reviewNotes[item.id] ?? "").trim().length < 5} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-800 transition hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
                                <FiX aria-hidden="true" className="h-4 w-4" />{busyId === item.id ? "Declining request…" : "Confirm decline"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="px-5 py-12 text-center sm:py-16">
              <FiCheck aria-hidden="true" className="mx-auto h-7 w-7 text-emerald-700" />
              <h2 className="mt-3 text-base font-semibold text-slate-950">No cancellation requests need review</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-5 text-slate-600">New requests from this operator’s clients will appear here. Shipment charges stay unchanged until staff complete an approval.</p>
            </div>
          )}
          {!loading && totalPages > 1 ? (
            <nav aria-label="Cancellation request pagination" className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="text-xs text-slate-600">Showing {start}–{end} of {total}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page <= 1} className="min-h-9 flex-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none">Previous</button>
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.min(totalPages, value + 1)); }} disabled={page >= totalPages} className="min-h-9 flex-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none">Next</button>
              </div>
            </nav>
          ) : null}
        </section>
        {!canReview && !loading && !error ? <div role="alert" className="mt-5 rounded-md border border-rose-200 bg-white p-4 text-sm text-rose-800"><FiAlertCircle aria-hidden="true" className="mr-2 inline h-4 w-4" />This cancellation review page is for operator staff.</div> : null}
      </main>
    </div>
  );
}
