"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FiClock, FiFileText } from "react-icons/fi";
import ShipmentAmendmentPanel from "@/components/shipments/ShipmentAmendmentPanel";
import type { ShipmentDraft, ShipmentServiceType } from "@/lib/dpdLabels";
import {
  getOperatorShipmentAmendments,
  OperatorAmendmentRequestError,
  previewOperatorShipmentAmendment,
  requestOperatorShipmentAmendment,
  type OperatorShipmentAmendment
} from "@/lib/operatorAmendments";
import type { ShipmentAddress } from "@/lib/dpdLabels";

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusText(status: OperatorShipmentAmendment["status"]) {
  if (status === "REQUESTED") return "Awaiting operator review";
  if (status === "APPROVED" || status === "APPLIED") return "Approved and applied";
  return "Declined by operator staff";
}

export default function OperatorShipmentAmendmentPanel({
  operatorSlug,
  draftId,
  address,
  parcelList,
  serviceType
}: {
  operatorSlug: string;
  draftId: string;
  address: ShipmentAddress;
  parcelList: ShipmentDraft["parcelList"];
  serviceType: ShipmentServiceType;
}) {
  const router = useRouter();
  const [canRequest, setCanRequest] = useState(false);
  const [eligibilityMessage, setEligibilityMessage] = useState("");
  const [amendments, setAmendments] = useState<OperatorShipmentAmendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchStatus = useCallback((signal?: AbortSignal) => (
    getOperatorShipmentAmendments(operatorSlug, draftId, signal)
  ), [operatorSlug, draftId]);

  const applyStatus = useCallback((result: Awaited<ReturnType<typeof fetchStatus>>) => {
    setCanRequest(result.canRequest);
    setEligibilityMessage(result.eligibilityMessage);
    setAmendments(result.amendments);
    setError("");
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchStatus(controller.signal).then((result) => {
      if (active && !controller.signal.aborted) applyStatus(result);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (cause instanceof OperatorAmendmentRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load amendment status.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [applyStatus, draftId, fetchStatus, router]);

  async function refreshStatus() {
    try {
      applyStatus(await fetchStatus());
    } catch (cause) {
      if (cause instanceof OperatorAmendmentRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
      } else {
        setError(cause instanceof Error ? cause.message : "Unable to refresh amendment status.");
      }
    }
  }

  async function preview(input: Parameters<typeof previewOperatorShipmentAmendment>[2]) {
    const result = await previewOperatorShipmentAmendment(operatorSlug, draftId, input);
    return { pricingImpact: result.pricingImpact, fundingPreview: result.fundingPreview };
  }

  async function submit(input: Parameters<typeof requestOperatorShipmentAmendment>[2]) {
    setBusy(true);
    setError("");
    try {
      await requestOperatorShipmentAmendment(operatorSlug, draftId, input);
      await refreshStatus();
    } catch (cause) {
      if (cause instanceof OperatorAmendmentRequestError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/shipments/${encodeURIComponent(draftId)}`);
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  const latest = amendments[0] ?? null;

  return (
    <section aria-labelledby="operator-amendments-heading" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-start gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
        <FiFileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[#0D1282]" />
        <div className="min-w-0">
          <h2 id="operator-amendments-heading" className="text-base font-semibold text-slate-950">Shipment amendments</h2>
          <p className="mt-1 text-sm leading-5 text-slate-600">Request a correction to shipment details. Operator staff review every request before any invoice or credit change.</p>
        </div>
      </div>

      {error ? <p role="alert" className="border-b border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:px-5">{error}</p> : null}
      {loading ? <div aria-label="Loading amendment status" className="m-4 h-14 animate-pulse rounded-md bg-slate-100 sm:m-5" /> : null}

      {!loading && latest ? (
        <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <FiClock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">{statusText(latest.status)}</p>
              <p className="mt-1 text-xs tabular-nums text-slate-500">Requested {formatDate(latest.requestedAt)}</p>
              {latest.reviewNote ? <p className="mt-2 text-sm leading-5 text-slate-700">{latest.reviewNote}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {!loading ? (
        <div className="p-4 sm:p-5">
          <ShipmentAmendmentPanel
            address={address}
            parcelList={parcelList}
            serviceType={serviceType}
            canAmend={canRequest}
            blockedReason={eligibilityMessage}
            busy={busy}
            onPreview={preview}
            onSubmit={submit}
          />
          {!canRequest && !latest && eligibilityMessage ? <p className="mt-3 text-sm leading-5 text-slate-600">{eligibilityMessage}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
