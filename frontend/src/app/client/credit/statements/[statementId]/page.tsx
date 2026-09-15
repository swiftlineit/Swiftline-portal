"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  FiChevronDown,
  FiDownload,
  FiPrinter,
  FiRefreshCw,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import CreditRestrictionAlert from "@/components/credit/CreditRestrictionAlert";
import {
  createClientOnlinePayment,
  getClientStatement,
  openAuthenticatedFile,
  printAuthenticatedPdf,
  submitClientOfflinePayment,
  verifyClientOnlinePayment,
  MAX_OFFLINE_PAYMENT_RUPEES,
  type CreditStatement,
} from "@/lib/creditBilling";
import { formatDashboardDate } from "@/lib/dateFormat";
import { useClientUser } from "@/lib/useClientUser";
import {
  acceptPaymentTerms,
  getClientCreditAccount,
  getPaymentTerms,
  type CreditAccount,
  type PaymentTerms,
} from "@/lib/creditAccounts";

function money(valueMinor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(valueMinor / 100);
}

function loadRazorpay() {
  return new Promise<boolean>((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default function ClientCreditStatementDetailPage() {
  const { user, loading: userLoading } = useClientUser();
  const params = useParams<{ statementId: string }>();
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [statement, setStatement] = useState<CreditStatement | null>(null);
  const [creditAccount, setCreditAccount] = useState<CreditAccount | null>(
    null,
  );
  const [paymentMode, setPaymentMode] = useState<"ONLINE" | "OFFLINE">(
    "ONLINE",
  );
  const [amountRupees, setAmountRupees] = useState("");
  const [method, setMethod] = useState<
    "BANK_TRANSFER" | "UPI" | "CASH" | "CHEQUE"
  >("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const load = useCallback(
    async (accountId: string) => {
      const [statementResult, creditResult] = await Promise.all([
        getClientStatement(accountId, params.statementId),
        getClientCreditAccount(accountId),
      ]);
      setStatement(statementResult.statement);
      setCreditAccount(creditResult.creditAccount);
      setAmountRupees(
        String(statementResult.statement.outstandingAmountMinor / 100),
      );
    },
    [params.statementId],
  );

  useEffect(() => {
    if (!user) return;
    const initialLoad = window.setTimeout(() => {
      const accountId =
        new URLSearchParams(window.location.search).get("businessAccountId") ||
        "";
      setBusinessAccountId(accountId);
      if (!accountId) {
        toast.error("Business account is missing from this statement link.");
        setLoading(false);
        return;
      }
      void load(accountId)
        .catch((caught) =>
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Statement could not be loaded.",
          ),
        )
        .finally(() => setLoading(false));
      void getPaymentTerms()
        .then((result) => setPaymentTerms(result.terms))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [load, user]);

  async function payOnline() {
    if (!statement) return;
    const amountMinor = Math.round(Number(amountRupees) * 100);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid payment amount.");
      return;
    }
    setBusy(true);
    try {
      if (!termsAccepted || !paymentTerms)
        throw new Error(
          "Read and accept the current payment terms before paying.",
        );
      await acceptPaymentTerms({
        businessAccountId,
        termsVersion: paymentTerms.version,
        paymentReference: statement.statementNumber,
      });
      const created = await createClientOnlinePayment({
        businessAccountId,
        requestedStatementId: statement.id,
        amountMinor,
      });
      if (
        !created.razorpay.keyId ||
        !created.payment.razorpayOrderId ||
        !(await loadRazorpay()) ||
        !window.Razorpay
      ) {
        throw new Error(
          "Razorpay checkout is not available. Try again shortly.",
        );
      }
      new window.Razorpay({
        key: created.razorpay.keyId,
        amount: created.payment.amountMinor,
        currency: created.payment.currency,
        name: "Swiftline",
        description: statement.statementNumber,
        order_id: created.payment.razorpayOrderId,
        theme: { color: "#1e3a8a" },
        modal: {
          ondismiss: () =>
            toast.success("Checkout closed without completing payment."),
        },
        handler: (checkout) => {
          void (async () => {
            try {
              const verified = await verifyClientOnlinePayment(checkout);
              toast.success(verified.message);
              await load(businessAccountId);
            } catch (caught) {
              toast.error(
                caught instanceof Error
                  ? caught.message
                  : "Payment confirmation failed.",
              );
            }
          })();
        },
      }).open();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Payment could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitOffline(event: FormEvent) {
    event.preventDefault();
    if (!statement) return;
    const amountMinor = Math.round(Number(amountRupees) * 100);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid payment amount.");
      return;
    }
    if (amountMinor > MAX_OFFLINE_PAYMENT_RUPEES * 100) {
      toast.error(
        `A single offline payment cannot exceed ${money(MAX_OFFLINE_PAYMENT_RUPEES * 100)}.`,
      );
      return;
    }
    if (reference.trim().length < 3) {
      toast.error("Enter the bank, UPI, cash, or cheque reference.");
      return;
    }
    setBusy(true);
    try {
      if (!termsAccepted || !paymentTerms)
        throw new Error(
          "Read and accept the current payment terms before submitting payment.",
        );
      await acceptPaymentTerms({
        businessAccountId,
        termsVersion: paymentTerms.version,
        paymentReference: statement.statementNumber,
      });
      const result = await submitClientOfflinePayment({
        businessAccountId,
        requestedStatementId: statement.id,
        amountMinor,
        method,
        externalReference: reference.trim(),
        notes: notes.trim(),
      });
      toast.success(result.message);
      setReference("");
      setNotes("");
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Offline payment could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (userLoading || !user) return <ClientDashboardLoading />;
  const pdfPath = statement
    ? `/api/v1/client/credit/statements/${statement.id}/pdf?businessAccountId=${businessAccountId}`
    : "";

  return (
    <div className="mx-auto max-w-8xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">
            {statement?.statementNumber || "Credit Statement"}
          </h1>
          {statement ? (
            <p className="mt-1 text-sm text-slate-600">
              {formatDashboardDate(statement.periodStart)} to{" "}
              {formatDashboardDate(
                new Date(
                  new Date(statement.periodEnd).getTime() - 1,
                ).toISOString(),
              )}
            </p>
          ) : null}
        </div>
        {statement ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void openAuthenticatedFile(pdfPath)}
              className="inline-flex rounded-4xl h-10 items-center gap-2 border border-slate-300 px-4 text-sm font-semibold text-blue-900"
            >
              View
            </button>
            <button
              type="button"
              onClick={() =>
                void openAuthenticatedFile(
                  `${pdfPath}&download=1`,
                  `${statement.statementNumber.replaceAll("/", "-")}.pdf`,
                )
              }
              className="inline-flex rounded-4xl h-10 items-center gap-2 border border-slate-300 px-4 text-sm font-semibold text-blue-900"
            >
              <FiDownload /> Download
            </button>
            <button
              type="button"
              onClick={() => void printAuthenticatedPdf(pdfPath)}
              className="inline-flex rounded-4xl h-10 items-center gap-2 border border-slate-300 px-4 text-sm font-semibold text-blue-900"
            >
              <FiPrinter /> Print
            </button>
          </div>
        ) : null}
      </div>

      <CreditRestrictionAlert
        restriction={creditAccount?.restriction}
        gracePeriodDays={creditAccount?.gracePeriodDays}
      />
      {loading ? (
        <div className="flex h-48 items-center justify-center border border-slate-200 bg-white text-sm text-slate-500">
          <FiRefreshCw className="mr-2 animate-spin" /> Loading statement...
        </div>
      ) : null}

      {statement ? (
        <>
          <section className="grid border border-slate-200 bg-white rounded-2xl sm:grid-cols-2 lg:grid-cols-4">
            <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r">
              <p className="text-xs font-semibold uppercase text-slate-500">
                Issued
              </p>
              <p className="mt-2 font-semibold">
                {formatDashboardDate(statement.issuedAt)}
              </p>
            </div>
            <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r">
              <p className="text-xs font-semibold uppercase text-slate-500">
                Due
              </p>
              <p className="mt-2 font-semibold">
                {formatDashboardDate(statement.dueAt)}
              </p>
            </div>
            <div className="border-b border-slate-200 p-5 sm:border-b-0 lg:border-r">
              <p className="text-xs font-semibold uppercase text-slate-500">
                Settled
              </p>
              <p className="mt-2 font-semibold">
                {money(
                  statement.paidAmountMinor + statement.creditAdjustmentMinor,
                )}
              </p>
            </div>
            <div className="bg-blue-950 p-5 text-white">
              <p className="text-xs font-semibold uppercase text-blue-200">
                Outstanding
              </p>
              <p className="mt-2 text-xl font-semibold">
                {money(statement.outstandingAmountMinor)}
              </p>
            </div>
          </section>

          {statement.adjustments.length ? (
            <section className="overflow-x-auto border border-slate-200 rounded-2xl bg-white">
              <div className="border-b border-slate-200 p-5">
                <h2 className="font-semibold text-slate-950">
                  Billing Adjustments
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Approved shipment updates recorded after an earlier statement
                  was issued.
                </p>
              </div>
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.adjustments.map((adjustment) => (
                    <tr
                      key={adjustment.adjustmentId}
                      className="border-t border-slate-100"
                    >
                      <td className="px-4 py-4">{adjustment.description}</td>
                      <td
                        className={`px-4 py-4 text-right font-semibold ${adjustment.amountMinor < 0 ? "text-emerald-700" : "text-slate-950"}`}
                      >
                        {adjustment.amountMinor > 0 ? "+" : ""}
                        {money(adjustment.amountMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="overflow-x-auto border border-slate-200 rounded-2xl bg-white">
            <div className="border-b border-slate-200 p-5">
              <h2 className="font-semibold text-slate-950">
                Billing Documents
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                GST, where applicable, is contained in each invoice and is not
                charged again here.
              </p>
            </div>
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Issued</th>
                  <th className="px-4 py-3 text-center">Revision</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line) => (
                  <tr
                    key={
                      line.shipmentInvoiceId ?? line.cancellationFeeInvoiceId
                    }
                    className="border-t border-slate-100"
                  >
                    <td className="px-4 py-4 font-semibold">
                      {line.invoiceNumber}
                    </td>
                    <td className="px-4 py-4">
                      {formatDashboardDate(line.invoiceIssuedAt)}
                    </td>
                    <td className="px-4 py-4 text-center">
                      {line.sourceType === "SHIPMENT_INVOICE"
                        ? line.invoiceRevision
                        : "-"}
                    </td>
                    <td className="px-4 py-4 text-right font-semibold">
                      {money(line.outstandingAmountMinor)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Link
                        href={
                          line.sourceType === "SHIPMENT_INVOICE"
                            ? `/client/shipments/${line.shipmentDraftId}/invoice`
                            : `/client/shipments/${line.shipmentDraftId}`
                        }
                        className="font-semibold text-blue-900"
                      >
                        {line.sourceType === "SHIPMENT_INVOICE"
                          ? "View Invoice"
                          : "View Cancellation"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {statement.outstandingAmountMinor > 0 ? (
            <section
              id="statement-payment"
              className="border border-slate-200 rounded-2xl bg-white p-5"
            >
              <div className="flex gap-1 border-b border-slate-200 pb-4">
                <button
                  type="button"
                  onClick={() => setPaymentMode("ONLINE")}
                  className={`h-9 px-4 text-sm font-semibold ${paymentMode === "ONLINE" ? "bg-blue-900 text-white rounded" : "text-slate-600"}`}
                >
                  Pay Online
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMode("OFFLINE")}
                  className={`h-9 px-4 text-sm font-semibold ${paymentMode === "OFFLINE" ? "bg-blue-900 rounded text-white" : "text-slate-600"}`}
                >
                  Record Offline Payment
                </button>
              </div>
              <label className="mt-4 block max-w-sm text-sm font-semibold text-slate-700">
                Amount (INR)
                <input
                  type="number"
                  min="0.01"
                  max={MAX_OFFLINE_PAYMENT_RUPEES}
                  step="0.01"
                  value={amountRupees}
                  onChange={(event) => setAmountRupees(event.target.value)}
                  className="mt-2 h-11 w-full border border-slate-300 rounded-lg px-3 font-normal"
                />
                <p className="mt-1 text-xs font-normal text-slate-500">
                  Maximum {money(MAX_OFFLINE_PAYMENT_RUPEES * 100)} per payment.
                </p>
              </label>
              <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  I have read and accept the current{" "}
                  <Link
                    href="/client/credit/payment-terms"
                    target="_blank"
                    className="font-semibold text-blue-900 underline"
                  >
                    payment terms
                  </Link>
                  .
                </span>
              </label>
              {paymentMode === "ONLINE" ? (
                <button
                  type="button"
                  onClick={() => void payOnline()}
                  disabled={busy}
                  className="mt-4 h-10 bg-white border text-black border-blue-800 px-5 rounded-lg text-sm font-semibold hover:bg-blue-900 hover:text-white disabled:opacity-60"
                >
                  {busy ? "Starting..." : "Pay with Razorpay"}
                </button>
              ) : (
                <form
                  onSubmit={submitOffline}
                  className="mt-4 grid gap-4 sm:grid-cols-2"
                >
                  <label className="text-sm font-semibold text-slate-700">
                    Method
                    <div className="relative mt-2">
                      <select
                        value={method}
                        onChange={(event) =>
                          setMethod(event.target.value as typeof method)
                        }
                        className="h-11 w-full appearance-none rounded-lg border border-slate-300 bg-white pl-3 pr-9 font-normal"
                      >
                        <option value="BANK_TRANSFER">Bank Transfer</option>
                        <option value="UPI">UPI</option>
                        <option value="CASH">Cash</option>
                        <option value="CHEQUE">Cheque</option>
                      </select>
                      <FiChevronDown
                        aria-hidden="true"
                        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                      />
                    </div>
                  </label>
                  <label className="text-sm font-semibold text-slate-700">
                    Payment Reference
                    <input
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      className="mt-2 h-11 w-full border border-slate-300 px-3 font-normal rounded-lg"
                      placeholder="UTR, cheque or receipt number"
                    />
                  </label>
                  <label className="text-sm font-semibold text-slate-700 sm:col-span-2">
                    Note
                    <textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      rows={3}
                      className="mt-2 w-full border border-slate-300  rounded-lg p-3 font-normal"
                      placeholder="Optional payment note"
                    />
                  </label>
                  <button
                    disabled={busy}
                    className="h-10 w-fit border border-blue-800 hover:bg-blue-900  hover:text-white px-5 text-sm font-semibold rounded-lg disabled:opacity-60"

                  >
                    {busy ? "Submitting..." : "Submit for Verification"}
                  </button>
                </form>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
