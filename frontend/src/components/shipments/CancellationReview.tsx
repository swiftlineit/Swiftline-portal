"use client";

import { useMemo, useState } from "react";
import {
  FiCheck,
  FiChevronDown,
  FiDownload,
  FiEye,
  FiPrinter,
  FiXCircle,
} from "react-icons/fi";
import {
  approveShipmentCancellation,
  downloadCancellationPdf,
  openCancellationPdf,
  printCancellationPdf,
  rejectShipmentCancellation,
  type ShipmentCancellation,
} from "@/lib/shipmentCancellations";

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});
const DEFAULT_FEE_RUPEES = "700.00";

export default function CancellationReview({
  cancellation,
  onChanged,
}: {
  cancellation: ShipmentCancellation;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [feeRupees, setFeeRupees] = useState(DEFAULT_FEE_RUPEES);
  const [feeReason, setFeeReason] = useState("");
  const [carrierReference, setCarrierReference] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [carrierConfirmed, setCarrierConfirmed] = useState(false);
  const [settlementConfirmed, setSettlementConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Walk-in refunds leave the company outside the portal, so how the money went
  // back is recorded here and saved with the approval.
  const [refundMethod, setRefundMethod] = useState<
    "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE"
  >("UPI");
  const [refundReference, setRefundReference] = useState("");

  const isIndividual = cancellation.customerType === "INDIVIDUAL";

  const amounts = useMemo(() => {
    if (!feeRupees.trim()) return null;
    const requestedBaseMinor = Math.round(Number(feeRupees) * 100);
    if (!Number.isInteger(requestedBaseMinor) || requestedBaseMinor < 0)
      return null;
    const noGst = cancellation.taxTreatment === "NO_GST";
    const requestedGstMinor = noGst ? 0 : Math.round(requestedBaseMinor * 0.18);
    const requestedTotalMinor = requestedBaseMinor + requestedGstMinor;
    if (requestedTotalMinor <= cancellation.originalAmountMinor) {
      return {
        requestedBaseMinor,
        feeBaseMinor: requestedBaseMinor,
        feeGstMinor: requestedGstMinor,
        feeTotalMinor: requestedTotalMinor,
        refundMinor: cancellation.originalAmountMinor - requestedTotalMinor,
        capped: false,
      };
    }
    const feeBaseMinor = noGst
      ? cancellation.originalAmountMinor
      : Math.round((cancellation.originalAmountMinor * 100) / 118);
    return {
      requestedBaseMinor,
      feeBaseMinor,
      feeGstMinor: cancellation.originalAmountMinor - feeBaseMinor,
      feeTotalMinor: cancellation.originalAmountMinor,
      refundMinor: 0,
      capped: true,
    };
  }, [cancellation.originalAmountMinor, cancellation.taxTreatment, feeRupees]);

  async function approve() {
    if (!amounts)
      return setError(
        "Enter a valid cancellation fee of INR 0.00 or more before any applicable GST.",
      );
    if (amounts.requestedBaseMinor > 70000 && feeReason.trim().length < 5) {
      return setError("Explain the additional carrier or handling fee.");
    }
    if (!carrierConfirmed || !settlementConfirmed) {
      return setError(
        "Confirm both carrier cancellation and the financial settlement before approval.",
      );
    }
    // The server rejects the approval without this, so catch it here rather than
    // letting the reviewer lose the form to a failed request.
    const refundRequired = isIndividual && amounts.refundMinor > 0;
    if (refundRequired && !refundReference.trim() && refundMethod !== "CASH") {
      return setError(
        "Enter the reference for the refund payment, or select cash.",
      );
    }
    setBusy("approve");
    setError("");
    try {
      await approveShipmentCancellation(cancellation.id, {
        feeBaseMinor: amounts.requestedBaseMinor,
        feeReason,
        carrierConfirmed: true,
        settlementConfirmed: true,
        carrierReference,
        reviewNote,
        ...(refundRequired
          ? {
              refundPayout: {
                method: refundMethod,
                reference: refundReference.trim(),
              },
            }
          : {}),
      });
      await onChanged();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Cancellation approval could not be completed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function reject() {
    if (reviewNote.trim().length < 5)
      return setError("Enter a clear reason for rejection.");
    setBusy("reject");
    setError("");
    try {
      await rejectShipmentCancellation(cancellation.id, reviewNote);
      await onChanged();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Cancellation rejection could not be saved.",
      );
    } finally {
      setBusy("");
    }
  }

  async function documentAction(
    type: "credit-note" | "fee-invoice",
    action: "view" | "download" | "print",
  ) {
    setBusy(type + action);
    setError("");
    try {
      if (action === "download")
        await downloadCancellationPdf(cancellation.id, type, "admin");
      else if (action === "print")
        await printCancellationPdf(cancellation.id, type, "admin");
      else await openCancellationPdf(cancellation.id, type, "admin");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The document could not be opened.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-4 border-b border-slate-200 pb-5 sm:grid-cols-2">
        <Value label="Cancellation Reason" value={cancellation.reason} />
        <Value
          label="Original Shipment Charge"
          value={money.format(cancellation.originalAmountMinor / 100)}
        />
        <Value
          label="Requested By"
          value={`${cancellation.requesterType.toLowerCase()} - ${cancellation.requesterRole.replaceAll("_", " ")}`}
        />
        <Value
          label="Status At Request"
          value={cancellation.shipmentStatusAtRequest.replaceAll("_", " ")}
        />
      </div>

      {cancellation.status !== "REQUESTED" ? (
        <CompletedReview
          cancellation={cancellation}
          busy={busy}
          error={error}
          onDocument={documentAction}
        />
      ) : (
        <>
          <div className="inline-flex rounded-xl border border-slate-300 p-1">
            <ModeButton
              active={mode === "approve"}
              onClick={() => {
                setMode("approve");
                setError("");
              }}
            >
              Approve
            </ModeButton>
            <ModeButton
              active={mode === "reject"}
              onClick={() => {
                setMode("reject");
                setError("");
              }}
            >
              Reject
            </ModeButton>
          </div>

          {mode === "approve" ? (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Cancellation Fee Before GST (INR)">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={feeRupees}
                    onChange={(event) => {
                      if (/^\d*(?:\.\d{0,2})?$/.test(event.target.value))
                        setFeeRupees(event.target.value);
                    }}
                    className="field"
                  />
                </Field>
                <Field label="Carrier Cancellation Reference">
                  <input
                    value={carrierReference}
                    onChange={(event) =>
                      setCarrierReference(event.target.value)
                    }
                    maxLength={120}
                    placeholder="Optional carrier reference"
                    className="field"
                  />
                </Field>
              </div>
              {amounts?.requestedBaseMinor &&
              amounts.requestedBaseMinor > 70000 ? (
                <Field label="Reason For Additional Fee">
                  <textarea
                    value={feeReason}
                    onChange={(event) => setFeeReason(event.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="Explain the additional carrier or handling fee"
                    className="field py-2"
                  />
                </Field>
              ) : null}
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-4">
                <Amount
                  label={cancellation.taxTreatment === "NO_GST" ? "Cancellation Fee" : "Fee Before GST"}
                  value={amounts?.feeBaseMinor ?? 0}
                />
                <Amount label={cancellation.taxTreatment === "NO_GST" ? "GST" : "GST (18%)"} value={cancellation.taxTreatment === "NO_GST" ? null : amounts?.feeGstMinor ?? 0} />
                <Amount label="Fee Total" value={amounts?.feeTotalMinor ?? 0} />
                <Amount
                  label="Refundable Amount"
                  value={amounts?.refundMinor ?? 0}
                  emphasis
                />
              </div>
              {isIndividual && (amounts?.refundMinor ?? 0) > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    Refund Payment-{" "}
                    {money.format((amounts?.refundMinor ?? 0) / 100)}
                  </p>
                  <p className="mt-1 text-sm text-amber-800">
                    This customer paid at the counter, so the refund leaves a
                    company account rather than the portal. Record how it was
                    paid back before completing the cancellation.
                  </p>
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <Field label="Refund Method">
                      <div className="relative">
                        <select
                          value={refundMethod}
                          onChange={(event) =>
                            setRefundMethod(
                              event.target.value as typeof refundMethod,
                            )
                          }
                          className="field appearance-none pr-9!"
                        >
                          <option value="UPI">UPI</option>
                          <option value="BANK_TRANSFER">Bank transfer</option>
                          <option value="CASH">Cash</option>
                          <option value="CARD">Card</option>
                          <option value="CHEQUE">Cheque</option>
                        </select>
                        <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-amber-600" />
                      </div>
                    </Field>
                    <Field label="Refund Reference">
                      <input
                        value={refundReference}
                        onChange={(event) =>
                          setRefundReference(event.target.value)
                        }
                        maxLength={80}
                        placeholder={
                          refundMethod === "CASH"
                            ? "Receipt number (optional)"
                            : "UTR or transaction reference"
                        }
                        className="field"
                      />
                    </Field>
                  </div>
                </div>
              ) : null}
              {amounts?.capped ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  The shipment charge is below the requested cancellation fee.
                  The fee is capped at the shipment charge and no extra amount
                  will be collected.
                </p>
              ) : null}
              <Field label="Review Note">
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="Optional internal review note"
                  className="field py-2"
                />
              </Field>
              <Confirmation
                checked={carrierConfirmed}
                onChange={setCarrierConfirmed}
                text="Carrier cancellation has been confirmed."
              />
              <Confirmation
                checked={settlementConfirmed}
                onChange={setSettlementConfirmed}
                text={`I confirm the fee of ${money.format((amounts?.feeTotalMinor ?? 0) / 100)} and refund of ${money.format((amounts?.refundMinor ?? 0) / 100)}.`}
              />
              {error ? <ErrorMessage message={error} /> : null}
              <button
                type="button"
                onClick={() => void approve()}
                disabled={Boolean(busy) || !amounts}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                <FiCheck aria-hidden="true" />{" "}
                {busy === "approve" ? "Completing..." : "Approve And Complete"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Rejection Reason">
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={3}
                  minLength={5}
                  maxLength={500}
                  placeholder="Explain why this cancellation cannot be approved"
                  className="field py-2"
                />
              </Field>
              {error ? <ErrorMessage message={error} /> : null}
              <button
                type="button"
                onClick={() => void reject()}
                disabled={Boolean(busy) || reviewNote.trim().length < 5}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                <FiXCircle aria-hidden="true" />{" "}
                {busy === "reject" ? "Rejecting..." : "Reject Request"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CompletedReview({
  cancellation,
  busy,
  error,
  onDocument,
}: {
  cancellation: ShipmentCancellation;
  busy: string;
  error: string;
  onDocument: (
    type: "credit-note" | "fee-invoice",
    action: "view" | "download" | "print",
  ) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Value
          label="Cancellation Fee"
          value={
            cancellation.feeTotalMinor === null
              ? "Not applicable"
              : money.format(cancellation.feeTotalMinor / 100)
          }
        />
        <Value
          label="Refundable Amount"
          value={
            cancellation.refundableAmountMinor === null
              ? "Not applicable"
              : money.format(cancellation.refundableAmountMinor / 100)
          }
        />
        <Value
          label="Review Note"
          value={cancellation.reviewNote || "No review note"}
        />
      </div>
      {cancellation.status === "COMPLETED" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Document
            title="GST Credit Note"
            type="credit-note"
            busy={busy}
            onDocument={onDocument}
          />
          <Document
            title="Cancellation Fee Invoice"
            type="fee-invoice"
            busy={busy}
            onDocument={onDocument}
          />
        </div>
      ) : null}
      {error ? <ErrorMessage message={error} /> : null}
    </div>
  );
}

function Document({
  title,
  type,
  busy,
  onDocument,
}: {
  title: string;
  type: "credit-note" | "fee-invoice";
  busy: string;
  onDocument: (
    type: "credit-note" | "fee-invoice",
    action: "view" | "download" | "print",
  ) => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <p className="font-semibold text-slate-950">{title}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(
          [
            ["view", FiEye, "View"],
            ["download", FiDownload, "Download"],
            ["print", FiPrinter, "Print"],
          ] as const
        ).map(([action, Icon, label]) => (
          <button
            key={action}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void onDocument(type, action)}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-blue-900 disabled:opacity-50"
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded-lg px-4 text-sm font-semibold ${active ? "bg-blue-900 text-white" : "text-slate-600"}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      <span>{label}</span>
      <div className="mt-2 [&_.field]:w-full [&_.field]:rounded-xl [&_.field]:border [&_.field]:border-slate-300 [&_.field]:bg-white [&_.field]:px-3 [&_.field]:text-sm [&_.field]:font-normal [&_.field]:text-slate-950 [&_.field]:outline-none [&_.field]:focus:border-blue-900 [&_input.field]:h-10 [&_select.field]:h-10">
        {children}
      </div>
    </label>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-1 wrap-break-words text-sm font-semibold capitalize text-slate-950">
        {value}
      </p>
    </div>
  );
}

function Amount({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number | null;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`border-b border-r border-slate-200 p-3 last:border-r-0 sm:border-b-0 ${emphasis ? "bg-blue-950 text-white" : "bg-white"}`}
    >
      <p
        className={`text-xs font-semibold uppercase ${emphasis ? "text-blue-100" : "text-slate-500"}`}
      >
        {label}
      </p>
      <p className="mt-2 font-semibold">{value === null ? "-" : money.format(value / 100)}</p>
    </div>
  );
}

function Confirmation({
  checked,
  onChange,
  text,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  text: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm font-medium text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded"
      />
      <span>{text}</span>
    </label>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}
