"use client";

import { useState } from "react";
import { FiAlertTriangle, FiDownload, FiEye, FiPrinter, FiXCircle } from "react-icons/fi";
import {
  downloadCancellationPdf,
  openCancellationPdf,
  printCancellationPdf,
  type ShipmentCancellation
} from "@/lib/shipmentCancellations";

const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export default function ShipmentCancellationPanel({
  cancellation,
  canRequest,
  blockedReason,
  audience,
  busy,
  error,
  onRequest
}: {
  cancellation: ShipmentCancellation | null;
  canRequest: boolean;
  blockedReason: string;
  audience: "client" | "admin";
  busy: boolean;
  error: string;
  onRequest: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [documentBusy, setDocumentBusy] = useState("");
  const [documentError, setDocumentError] = useState("");

  async function openDocument(type: "credit-note" | "fee-invoice", action: "view" | "download" | "print") {
    setDocumentBusy(type + action);
    setDocumentError("");
    try {
      if (action === "download") await downloadCancellationPdf(cancellation!.id, type, audience);
      else if (action === "print") await printCancellationPdf(cancellation!.id, type, audience);
      else await openCancellationPdf(cancellation!.id, type, audience);
    } catch (documentActionError) {
      setDocumentError(documentActionError instanceof Error
        ? documentActionError.message
        : "The financial document could not be opened.");
    } finally {
      setDocumentBusy("");
    }
  }

  if (cancellation) {
    const statusTone = cancellation.status === "COMPLETED"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : cancellation.status === "REJECTED"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-amber-200 bg-amber-50 text-amber-800";
    return (
      <section className="border border-slate-200 bg-white rounded-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-950">Shipment Cancellation</h2>
            <p className="mt-1 text-sm text-slate-500">Swiftline review, refund, and financial document history.</p>
          </div>
          <span className={"border px-2.5 py-1 text-xs rounded-4xl font-semibold uppercase " + statusTone}>
            {cancellation.status}
          </span>
        </div>
        <div className="grid gap-5 p-5 md:grid-cols-3">
          <Value  label="Reason " value={cancellation.reason} />
          <Value
            label="Cancellation Fee"
            value={cancellation.feeTotalMinor === null ? "Pending review" : currency.format(cancellation.feeTotalMinor / 100)}
          />
          <Value
            label="Refundable Amount"
            value={cancellation.refundableAmountMinor === null
              ? "Pending review"
              : currency.format(cancellation.refundableAmountMinor / 100)}
          />
        </div>
        {cancellation.status === "REQUESTED" ? (
          <div className="border-t border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
            Amendments and shipment progression are paused while Swiftline reviews this request.
          </div>
        ) : null}
        {cancellation.status === "REJECTED" && cancellation.reviewNote ? (
          <div className="border-t border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
            {cancellation.reviewNote}
          </div>
        ) : null}
        {cancellation.status === "COMPLETED" ? (
          <div className="border-t border-slate-200 p-5">
            <div className="grid gap-4 lg:grid-cols-2">
              <DocumentActions
                title="Invoice cancellation adjustment"
                description="This document reverses the original shipment invoice and applicable GST. It does not add wallet funds."
                type="credit-note"
                busy={documentBusy}
                onAction={openDocument}
              />
              <DocumentActions title="Cancellation Fee Invoice" type="fee-invoice" busy={documentBusy} onAction={openDocument} />
            </div>
            {documentError ? <p className="mt-3 text-sm font-semibold text-red-700">{documentError}</p> : null}
          </div>
        ) : null}
        {cancellation.status === "REJECTED" && canRequest ? (
          <div className="border-t border-slate-200 p-5">
            {!formOpen ? (
              <button
                type="button"
                onClick={() => setFormOpen(true)}
                className="h-10 border border-red-300 px-4 text-sm font-semibold text-red-700 hover:bg-red-50"
              >
                Request Again
              </button>
            ) : (
              <CancellationRequestForm
                reason={reason}
                setReason={setReason}
                busy={busy}
                error={error}
                onRequest={onRequest}
                onClose={() => setFormOpen(false)}
              />
            )}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="border border-slate-200 bg-white rounded-2xl">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2">
            <FiXCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Cancel Shipment</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {audience === "client"
              ? "Cancellation is available before parcel collection."
              : "An admin exception is available until Warehouse Scan In."}
            {" An INR 700 fee plus 18% GST applies."}
            {" After approval and carrier confirmation, prepaid refunds return to the original payment method or, for business-wallet bookings, to the wallet. Staff records refunds for cash bookings."}
          </p>
          {!canRequest ? (
            <p className="mt-3 flex items-start gap-2 text-sm font-medium text-amber-800">
              <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {blockedReason}
            </p>
          ) : null}
        </div>
        {canRequest && !formOpen ? (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="h-10 border border-red-300 rounded-4xl px-4 text-sm font-semibold text-red-700 hover:bg-red-50"
          >
            Request Cancellation
          </button>
        ) : null}
      </div>
      {formOpen ? (
        <div className="border-t border-slate-200 bg-slate-50 p-5">
          <CancellationRequestForm
            reason={reason}
            setReason={setReason}
            busy={busy}
            error={error}
            onRequest={onRequest}
            onClose={() => setFormOpen(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

function CancellationRequestForm({
  reason,
  setReason,
  busy,
  error,
  onRequest,
  onClose
}: {
  reason: string;
  setReason: (reason: string) => void;
  busy: boolean;
  error: string;
  onRequest: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <form onSubmit={async (event) => { event.preventDefault(); await onRequest(reason); }}>
      <label className="block max-w-2xl text-sm font-semibold text-slate-700">
        Cancellation reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          minLength={5}
          maxLength={500}
          required
          placeholder="Explain why this shipment should be cancelled"
          className="mt-2 w-full border rounded-xl border-slate-300 bg-white px-3 py-2 font-normal outline-none focus:border-blue-900"
        />
      </label>
      {error ? <p className="mt-3 text-sm font-semibold text-red-700">{error}</p> : null}
      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={busy || reason.trim().length < 5}
          className="h-10 bg-red-600 px-4 text-sm font-semibold rounded-xl text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Submitting..." : "Submit Request"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="h-10 border border-slate-300 rounded-xl bg-white px-4 text-sm font-semibold text-slate-700"
        >
          Keep Shipment
        </button>
      </div>
    </form>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-semibold uppercase text-slate-500">{label}</p><p className="mt-2 text-sm font-semibold text-slate-950">{value}</p></div>;
}

function DocumentActions({
  title,
  description,
  type,
  busy,
  onAction
}: {
  title: string;
  description?: string;
  type: "credit-note" | "fee-invoice";
  busy: string;
  onAction: (type: "credit-note" | "fee-invoice", action: "view" | "download" | "print") => Promise<void>;
}) {
  return (
    <div className="border border-slate-200 p-4">
      <p className="font-semibold text-slate-950">{title}</p>
      {description ? <p className="mt-1 text-sm leading-5 text-slate-600">{description}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {([
          ["view", FiEye, "View"],
          ["download", FiDownload, "Download"],
          ["print", FiPrinter, "Print"]
        ] as const).map(([action, Icon, label]) => (
          <button
            key={action}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void onAction(type, action)}
            className="inline-flex h-9 items-center gap-2 border border-slate-300 px-3 rounded-4xl  text-sm font-semibold text-blue-900 hover:bg-slate-50 disabled:opacity-50"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
