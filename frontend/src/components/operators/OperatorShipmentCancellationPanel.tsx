"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FiAlertCircle, FiCheckCircle, FiDownload, FiFileText, FiRefreshCw } from "react-icons/fi";
import {
  downloadOperatorCancellationDocument,
  getOperatorShipmentCancellation,
  OperatorCancellationRequestError,
  requestOperatorShipmentCancellation,
  type OperatorShipmentCancellation
} from "@/lib/operatorCancellations";

function formatMoney(minor: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function requestError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The cancellation request could not be completed.";
}

export default function OperatorShipmentCancellationPanel({
  operatorSlug,
  draftId
}: {
  operatorSlug: string;
  draftId: string;
}) {
  const router = useRouter();
  const [cancellation, setCancellation] = useState<OperatorShipmentCancellation | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [eligibilityMessage, setEligibilityMessage] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorShipmentCancellation(operatorSlug, draftId, controller.signal).then((result) => {
      if (!active) return;
      setCancellation(result.cancellation);
      setCanRequest(result.canRequest);
      setEligibilityMessage(result.eligibilityMessage);
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
        return;
      }
      setError(requestError(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, draftId, router, refreshKey]);

  async function handleRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy("request");
    setError("");
    try {
      const result = await requestOperatorShipmentCancellation(operatorSlug, draftId, reason.trim());
      setCancellation(result.cancellation);
      setCanRequest(false);
      setReason("");
    } catch (cause) {
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
        return;
      }
      setError(requestError(cause));
    } finally {
      setBusy("");
    }
  }

  async function handleDownload(document: "credit-note" | "fee-invoice") {
    if (!cancellation) return;
    setBusy(document);
    setError("");
    try {
      await downloadOperatorCancellationDocument(operatorSlug, cancellation.id, document);
    } catch (cause) {
      if (cause instanceof OperatorCancellationRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
        return;
      }
      setError(requestError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section aria-labelledby="operator-cancellation-heading" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-start gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
        <FiAlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[#0D1282]" />
        <div className="min-w-0">
          <h2 id="operator-cancellation-heading" className="text-base font-semibold text-slate-950">Shipment cancellation</h2>
          <p className="mt-1 text-sm leading-5 text-slate-600">Requests are reviewed by your operator. Charges and documents remain in place until the review is completed.</p>
        </div>
        <button
          type="button"
          onClick={() => { setLoading(true); setRefreshKey((value) => value + 1); }}
          disabled={loading || Boolean(busy)}
          aria-label="Refresh cancellation status"
          className="ml-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FiRefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error ? <p role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:px-5">{error}</p> : null}

      {loading ? (
        <div aria-label="Loading cancellation status" className="animate-pulse space-y-3 p-4 sm:p-5">
          <div className="h-5 w-40 rounded bg-slate-100" />
          <div className="h-12 rounded bg-slate-100" />
        </div>
      ) : (
        <div className="p-4 sm:p-5">
          {cancellation ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold ring-1 ring-inset ${
                  cancellation.status === "COMPLETED"
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                    : cancellation.status === "REJECTED"
                      ? "bg-rose-50 text-rose-800 ring-rose-200"
                      : "bg-amber-50 text-amber-900 ring-amber-200"
                }`}>
                  {cancellation.status === "REQUESTED" ? "Awaiting operator review" : cancellation.status === "COMPLETED" ? "Cancelled" : "Request declined"}
                </span>
                <span className="text-xs text-slate-500">Requested {formatDate(cancellation.requestedAt)}</span>
              </div>
              <dl className="grid gap-3 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-3 sm:p-4">
                <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Original invoice</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{formatMoney(cancellation.originalAmountMinor)}</dd></div>
                {cancellation.status === "COMPLETED" ? <>
                  <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Cancellation fee</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{formatMoney(cancellation.feeTotalMinor ?? 0)}</dd></div>
                  <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Credit released</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{formatMoney(cancellation.refundableAmountMinor ?? 0)}</dd></div>
                </> : null}
              </dl>
              <div className="rounded-md border border-slate-200 px-3 py-3 text-sm leading-5 text-slate-700 sm:px-4">
                <p className="font-medium text-slate-900">Your reason</p>
                <p className="mt-1 whitespace-pre-wrap">{cancellation.reason}</p>
                {cancellation.status === "REJECTED" && cancellation.reviewNote ? <>
                  <p className="mt-3 font-medium text-slate-900">Operator response</p>
                  <p className="mt-1 whitespace-pre-wrap">{cancellation.reviewNote}</p>
                </> : null}
              </div>
              {cancellation.status === "COMPLETED" ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  {cancellation.creditNoteId ? <button type="button" onClick={() => void handleDownload("credit-note")} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50"><FiFileText aria-hidden="true" className="h-4 w-4" />{busy === "credit-note" ? "Preparing credit note…" : "Download credit note"}<FiDownload aria-hidden="true" className="h-4 w-4" /></button> : null}
                  {cancellation.cancellationFeeInvoiceId ? <button type="button" onClick={() => void handleDownload("fee-invoice")} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50"><FiFileText aria-hidden="true" className="h-4 w-4" />{busy === "fee-invoice" ? "Preparing fee invoice…" : "Download fee invoice"}<FiDownload aria-hidden="true" className="h-4 w-4" /></button> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!cancellation && !canRequest ? (
            <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-5 text-slate-700 sm:p-4">
              <FiCheckCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <p>{eligibilityMessage || "A cancellation request is not available for this shipment."}</p>
            </div>
          ) : null}

          {canRequest ? (
            <form onSubmit={(event) => void handleRequest(event)} className={`${cancellation ? "mt-5 border-t border-slate-200 pt-5" : ""} space-y-4`}>
              {cancellation?.status === "REJECTED" ? <p className="text-sm leading-5 text-slate-600">You may submit a new request if you still need to cancel this shipment.</p> : null}
              <div>
                <label htmlFor={`cancellation-reason-${draftId}`} className="mb-1.5 block text-sm font-medium text-slate-800">Reason for cancellation</label>
                <textarea
                  id={`cancellation-reason-${draftId}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={5}
                  maxLength={500}
                  required
                  rows={3}
                  aria-describedby={`cancellation-help-${draftId}`}
                  className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
                />
                <p id={`cancellation-help-${draftId}`} className="mt-1.5 text-xs leading-5 text-slate-500">Operator staff will review the request and any financial adjustment before the invoice or credit balance changes. {500 - reason.length} characters remaining.</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-slate-500">Minimum 5 characters. Maximum 500.</p>
                <button type="submit" disabled={busy === "request" || reason.trim().length < 5} className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
                  {busy === "request" ? "Submitting request…" : "Request cancellation"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      )}
    </section>
  );
}
