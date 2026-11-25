"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DashboardLoading } from "@/components/DashboardShell";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange } from "@/lib/dateRange";
import Pagination from "@/components/ui/Pagination";
import {
  approveShipmentAmendment,
  listShipmentAmendments,
  rejectShipmentAmendment,
  ShipmentAmendment,
  ShipmentAmendmentPricingEstimate,
  type CounterPaymentInput
} from "@/lib/dpdLabels";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { formatMoney, getVolumetricFormula } from "@/lib/shipmentPricing";
import InfoTooltip from "@/components/ui/InfoTooltip";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { FiChevronDown } from "react-icons/fi";

const emptyPagination = { page: 1, limit: 50, total: 0, totalPages: 1 };

function formatStatus(status: ShipmentAmendment["status"]) {
  return status.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: ShipmentAmendment["status"]) {
  if (["REQUESTED", "AWAITING_PAYMENT"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "PAYMENT_SECURED") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "APPROVED" || status === "APPLIED") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-red-200 bg-red-50 text-red-700";
}

function titleize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatChangedField(fieldName: string) {
  if (fieldName === "serviceType") return "Service Type";

  if (fieldName.startsWith("consigneeEnteredAddress.")) {
    return titleize(fieldName.replace("consigneeEnteredAddress.", ""));
  }

  const parcelMatch = fieldName.match(/^parcelList\.(\d+)\.(.+)$/);
  if (parcelMatch) {
    if (parcelMatch[2] === "items") return `Parcel ${Number(parcelMatch[1]) + 1} Contents`;
    const fieldLabel = parcelMatch[2] === "weightKg" ? "Actual Weight KG" : titleize(parcelMatch[2]);
    return `Parcel ${Number(parcelMatch[1]) + 1} ${fieldLabel}`;
  }

  return titleize(fieldName);
}

function collectRequestedFields(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectRequestedFields(item, prefix ? `${prefix}.${index}` : String(index)));
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return collectRequestedFields(nested, path);
    return [path];
  });
}

function getChangedFields(amendment: ShipmentAmendment) {
  const previewChanges = amendment.changePreview?.length ? amendment.changePreview : amendment.appliedChanges;
  const fields = previewChanges.length
    ? previewChanges.map((change) => change.fieldName)
    : amendment.appliedChanges.length
      ? amendment.appliedChanges.map((change) => change.fieldName)
      : collectRequestedFields(amendment.requestedChanges);

  return [...new Set(fields)].map(formatChangedField);
}

function formatCharge(value?: number | null) {
  return typeof value === "number" ? formatMoney(value) : "Not available";
}

function formatMinorAmount(value: number) {
  return formatMoney(value / 100);
}

function getChargeTone(deltaAmount?: number) {
  if (!deltaAmount) return "text-slate-500";
  return deltaAmount > 0 ? "text-red-700" : "text-emerald-700";
}

function formatChangeValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);
  if (typeof value === "string" && /^[A-Z_]+$/.test(value)) return titleize(value.toLowerCase());
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (!item || typeof item !== "object") return `${index + 1}. ${String(item)}`;
      const row = item as Record<string, unknown>;
      const quantity = Number(row.quantity) || 0;
      const unitRate = Number(row.unitRate) || 0;
      const amount = quantity * unitRate;
      return `${index + 1}. ${String(row.description || "Item")} | HS: ${String(row.hsnCode || "Not set")} | Unit: ${String(row.unitType || "Not set")} | Qty: ${quantity} | Rate: ${unitRate.toFixed(2)} | Amount: ${amount.toFixed(2)}`;
    }).join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function AmendmentReviewModal({
  amendment,
  busy,
  error,
  onClose,
  onReview
}: {
  amendment: ShipmentAmendment;
  busy: boolean;
  error: string;
  onClose: () => void;
  onReview: (action: "approve" | "reject", note: string, counterPayment?: CounterPaymentInput) => Promise<void>;
}) {
  const [note, setNote] = useState(amendment.reviewNote ?? "");
  const pricingImpact = amendment.pricingImpact;
  const currentPricing = pricingImpact?.current;
  const requestedPricing = pricingImpact?.requested;
  const isRequested = ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"].includes(amendment.status);
  const requestReducesCharge = (amendment.fundingPreview?.deltaAmountMinor ?? 0) < 0;
  const requestIncreasesCharge = (amendment.fundingPreview?.deltaAmountMinor ?? 0) > 0;
  const paymentNotSecured = (amendment.paymentAmountMinor ?? 0) > 0
    && !["SECURED", "COMPLETED"].includes(amendment.paymentStatus ?? "NOT_REQUIRED");

  const counterDeltaMinor = amendment.customerType === "INDIVIDUAL" && requestReducesCharge
    ? amendment.fundingPreview?.deltaAmountMinor ?? 0
    : 0;
  const [counterMethod, setCounterMethod] = useState<CounterPaymentInput["method"]>("UPI");
  const [counterReference, setCounterReference] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="amendment-review-title">
      <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto bg-white shadow-xl rounded-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">Shipment Amendment</p>
            <h2 id="amendment-review-title" className="mt-1 text-xl font-semibold text-slate-950">
              {isRequested ? "Review Requested Changes" : "Amendment Details"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {amendment.shipmentId} | {formatDashboardDateTime(amendment.requestedAt)}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-sm font-semibold text-slate-500 hover:text-slate-900 disabled:cursor-not-allowed">
            Close
          </button>
        </div>

        <div className="space-y-6 p-5">
          <div className="grid gap-4 border-b border-slate-200 pb-5 sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs font-semibold uppercase text-slate-500">Consignee</p><p className="mt-1 font-semibold text-slate-900">{amendment.consignee}</p></div>
            <div><p className="text-xs font-semibold uppercase text-slate-500">Branch</p><p className="mt-1 font-semibold text-slate-900">{amendment.branch?.name || "Not set"}</p><p className="text-xs text-slate-500">{amendment.branch?.code || ""}</p></div>
            <div><p className="text-xs font-semibold uppercase text-slate-500">Requested By</p><p className="mt-1 font-semibold capitalize text-slate-900">{amendment.actorRole}</p></div>
            <div><p className="text-xs font-semibold uppercase text-slate-500">Status</p><span className={`mt-1 inline-block border px-2 text-xs py-2 rounded font-semibold uppercase ${statusTone(amendment.status)}`}>{formatStatus(amendment.status)}</span></div>
          </div>

          {amendment.reason ? (
            <div><h3 className="text-sm font-semibold text-slate-950">Reason</h3><p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{amendment.reason}</p></div>
          ) : null}

          <div>
            <h3 className="text-sm font-semibold text-slate-950">Field Comparison</h3>
            <div className="mt-3 overflow-x-auto border border-slate-200 rounded-2xl">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
                  <tr><th className="px-4 py-3">Field</th><th className="px-4 py-3">Existing Value</th><th className="px-4 py-3">Requested Value</th></tr>
                </thead>
                <tbody>
                  {amendment.changePreview.map((change) => (
                    <tr key={change.fieldName} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-4 py-3 font-semibold text-slate-800">{formatChangedField(change.fieldName)}</td>
                      <td className="whitespace-pre-line px-4 py-3 text-slate-600">{formatChangeValue(change.originalValue)}</td>
                      <td className="whitespace-pre-line px-4 py-3 font-semibold text-blue-950">{formatChangeValue(change.newValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {pricingImpact && currentPricing && requestedPricing ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Charge Comparison</h3>
              <div className="mt-3 grid gap-3 md:grid-cols-2 rounded-2xl">
                <PricingSummary title="Existing Charges" estimate={currentPricing} />
                <PricingSummary title="Requested Charges" estimate={requestedPricing} emphasize />
              </div>
              <p className={`mt-3 text-sm font-semibold ${getChargeTone(pricingImpact.deltaAmount)}`}>
                Charge difference: {pricingImpact.deltaAmount >= 0 ? "+" : ""}{formatMoney(pricingImpact.deltaAmount)}
              </p>

              <div className="mt-3 overflow-x-auto border border-slate-200 rounded-2xl">
                <table className="min-w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-100 uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Parcel</th><th className="px-3 py-3">Actual KG</th><th className="px-3 py-3"><span className="inline-flex items-center gap-1">Volumetric KG<InfoTooltip text={getVolumetricFormula()} /></span></th><th className="px-3 py-3">Chargeable KG</th><th className="px-3 py-3">Rate Slab</th><th className="px-3 py-3">Rate / KG</th><th className="px-3 py-3">Max Box KG</th><th className="px-3 py-3">Base Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requestedPricing.parcels.map((requestedParcel, index) => {
                      const currentParcel = currentPricing.parcels[index];
                      return (
                        <tr key={requestedParcel.sequence} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-3 py-3 font-semibold text-slate-900">{requestedParcel.sequence}</td>
                          <ComparisonValue oldValue={currentParcel?.actualWeightKg} newValue={requestedParcel.actualWeightKg} />
                          <ComparisonValue oldValue={currentParcel?.volumetricWeightKg} newValue={requestedParcel.volumetricWeightKg} />
                          <ComparisonValue oldValue={currentParcel?.chargeableWeightKg} newValue={requestedParcel.chargeableWeightKg} />
                          <ComparisonText oldValue={formatRateSlab(currentParcel)} newValue={formatRateSlab(requestedParcel)} />
                          <ComparisonMoney oldValue={currentParcel?.chargesPerKg} newValue={requestedParcel.chargesPerKg} />
                          <ComparisonValue oldValue={currentParcel?.maxBoxKg} newValue={requestedParcel.maxBoxKg} />
                          <ComparisonMoney oldValue={currentParcel?.baseAmount} newValue={requestedParcel.baseAmount} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {requestedPricing.missingRate ? <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">Approval is blocked because an applicable rate slab is missing.</p> : null}
              {requestedPricing.exceedsMaxBoxKg ? <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">One or more parcels exceed the configured maximum box weight.</p> : null}
            </div>
          ) : null}

          {amendment.fundingPreview ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Funding at Request</h3>
              {amendment.fundingPreview.billingMode === "TEST" ? (
                <p className="mt-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  This is a test shipment. Approval does not change payment records or customer balances.
                </p>
              ) : (
                <div className="mt-3 grid gap-3 border border-slate-200 bg-slate-50 rounded-2xl p-4 sm:grid-cols-3">
                  <FundingMetric
                    label="Payment Source"
                    value={amendment.fundingPreview.billingMode === "DIRECT" ? "Online payment" : "Business account"}
                  />
                  <FundingMetric
                    label={requestIncreasesCharge ? "Additional Payment" : requestReducesCharge ? "Charge Reduction" : "Charge Difference"}
                    value={formatMinorAmount(Math.abs(amendment.fundingPreview.deltaAmountMinor))}
                  />
                  <FundingMetric
                    label="Payment Status"
                    value={amendment.paymentStatus === "SECURED" || amendment.paymentStatus === "COMPLETED"
                      ? "Verified"
                      : requestIncreasesCharge ? "Awaiting payment" : "No payment due"}
                  />
                </div>
              )}
              {requestIncreasesCharge && paymentNotSecured ? (
                <p className="mt-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  For a price increase, confirm the online payment is verified before approval. Rejecting starts a refund to the original payment method. For a price decrease, record the customer refund before approving.
                </p>
              ) : null}
              {!amendment.fundingPreview.canFund ? (
                <p className="border border-t-0 border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                  {amendment.fundingPreview.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {amendment.billingAdjustment && amendment.fundingPreview?.billingMode !== "TEST" ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Applied Billing Adjustment</h3>
              <div className="mt-3 grid gap-3 border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2  rounded-2xl lg:grid-cols-4">
                <FundingMetric
                  label="Amount paid or returned"
                  value={formatMinorAmount(amendment.billingAdjustment.deltaAmountMinor < 0
                    ? Math.abs(amendment.billingAdjustment.deltaAmountMinor)
                    : amendment.billingAdjustment.deltaAmountMinor)}
                />
                <FundingMetric label="Revised charge" value={formatMinorAmount(amendment.billingAdjustment.amendedAmountMinor)} />
              </div>
            </div>
          ) : null}

          {!isRequested && amendment.reviewNote ? (
            <div><h3 className="text-sm font-semibold text-slate-950">Review Note</h3><p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{amendment.reviewNote}</p></div>
          ) : null}

          {isRequested ? (
            <div className="border-t border-slate-200 pt-5">
              <label className="block"><span className="text-xs font-semibold uppercase text-slate-500">Review Note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={500} placeholder="Optional note for the amendment record" className="mt-2 w-full border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-900" /></label>

              {counterDeltaMinor !== 0 ? (
                <div className="mt-4 border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    {counterDeltaMinor > 0 ? "Additional Amount Collected" : "Amount Refunded"}
                    {"- "}
                    {formatMinorAmount(Math.abs(counterDeltaMinor))}
                  </p>
                  <p className="mt-1 text-sm text-amber-800">
                    Record the completed payout to the individual customer before approving this reduction.
                  </p>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-amber-900">Method</span>
                      <select
                        value={counterMethod}
                        onChange={(event) => setCounterMethod(event.target.value as CounterPaymentInput["method"])}
                        className="mt-2 h-10 w-full border border-amber-300 bg-white px-3 text-sm outline-none focus:border-amber-500"
                      >
                        <option value="UPI">UPI</option>
                        <option value="BANK_TRANSFER">Bank transfer</option>
                        <option value="CASH">Cash</option>
                        <option value="CARD">Card</option>
                        <option value="CHEQUE">Cheque</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-amber-900">Reference</span>
                      <input
                        value={counterReference}
                        onChange={(event) => setCounterReference(event.target.value)}
                        maxLength={80}
                        placeholder={counterMethod === "CASH" ? "Receipt number (optional)" : "UTR or transaction reference"}
                        className="mt-2 h-10 w-full border border-amber-300 bg-white px-3 text-sm outline-none focus:border-amber-500"
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {error ? <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <button type="button" onClick={() => void onReview("reject", note)} disabled={busy} className="h-10 border border-red-300 px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400">Reject</button>
                <button
                  type="button"
                  onClick={() => void onReview(
                    "approve",
                    note,
                    counterDeltaMinor !== 0
                      ? { method: counterMethod, reference: counterReference.trim() }
                      : undefined
                  )}
                  disabled={busy || requestedPricing?.missingRate || amendment.fundingPreview?.canFund === false || paymentNotSecured}
                  className="h-10 bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {busy ? "Processing..." : "Approve Amendment"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FundingMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function PricingSummary({ title, estimate, emphasize = false }: { title: string; estimate: ShipmentAmendmentPricingEstimate; emphasize?: boolean }) {
  return (
    <div className={`border p-4 rounded-2xl ${emphasize ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"}`}>
      <p className="text-xs font-semibold uppercase text-slate-500">{title}</p>
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div><p className="text-xs text-slate-500">Base</p><p className="mt-1 font-semibold text-slate-900">{formatMoney(estimate.baseAmount)}</p></div>
        <div><p className="text-xs text-slate-500">GST{estimate.gstRate > 0 ? ` (${estimate.gstRate * 100}%)` : ""}</p><p className="mt-1 font-semibold text-slate-900">{estimate.gstRate === 0 ? "-" : formatMoney(estimate.gstAmount)}</p></div>
        <div><p className="text-xs text-slate-500">Total</p><p className="mt-1 font-semibold text-slate-950">{formatMoney(estimate.totalAmount)}</p></div>
      </div>
    </div>
  );
}

function ComparisonValue({ oldValue, newValue }: { oldValue?: number | null; newValue?: number | null }) {
  return <td className="px-3 py-3"><span className="text-slate-500">{typeof oldValue === "number" ? oldValue.toFixed(3) : "Not set"}</span><span className="mx-2 text-slate-300">to</span><span className="font-semibold text-slate-900">{typeof newValue === "number" ? newValue.toFixed(3) : "Not set"}</span></td>;
}

function ComparisonMoney({ oldValue, newValue }: { oldValue?: number | null; newValue?: number | null }) {
  return <td className="px-3 py-3"><span className="text-slate-500">{typeof oldValue === "number" ? formatMoney(oldValue) : "No rate"}</span><span className="mx-2 text-slate-300">to</span><span className="font-semibold text-slate-900">{typeof newValue === "number" ? formatMoney(newValue) : "No rate"}</span></td>;
}

function ComparisonText({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  return <td className="px-3 py-3"><span className="text-slate-500">{oldValue}</span><span className="mx-2 text-slate-300">to</span><span className="font-semibold text-slate-900">{newValue}</span></td>;
}

function formatRateSlab(parcel?: ShipmentAmendmentPricingEstimate["parcels"][number]) {
  if (!parcel || parcel.rateFromKg === null || parcel.rateToKg === null) return "No rate";
  return `${parcel.rateFromKg}-${parcel.rateToKg} KG`;
}

export default function AmendmentsPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [amendments, setAmendments] = useState<ShipmentAmendment[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [status, setStatus] = useState("");
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [page, setPage] = useState(1);
  const [dataLoading, setDataLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [selectedAmendment, setSelectedAmendment] = useState<ShipmentAmendment | null>(null);

  const fetchAmendments = useCallback(() => {
    return listShipmentAmendments({ status, dateRange, page });
  }, [status, dateRange, page]);

  const loadAmendments = useCallback(async () => {
    setDataLoading(true);
    setError("");

    try {
      const result = await fetchAmendments();
      setAmendments(result.amendments);
      setPagination(result.pagination);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load amendments.");
    } finally {
      setDataLoading(false);
    }
  }, [fetchAmendments]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void fetchAmendments()
      .then((result) => {
        if (!active) return;
        setAmendments(result.amendments);
        setPagination(result.pagination);
        setError("");
      })
      .catch((caughtError) => {
        if (!active) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load amendments.");
      })
      .finally(() => {
        if (active) setDataLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchAmendments, user]);

  async function reviewAmendment(
    amendmentId: string,
    action: "approve" | "reject",
    note: string,
    counterPayment?: CounterPaymentInput
  ) {
    setBusyId(amendmentId);
    setReviewError("");

    try {
      if (action === "approve") {
        await approveShipmentAmendment(amendmentId, note, counterPayment);
      } else {
        await rejectShipmentAmendment(amendmentId, note);
      }

      await loadAmendments();
      setSelectedAmendment(null);
    } catch (caughtError) {
      setReviewError(caughtError instanceof Error ? caughtError.message : "Unable to review amendment.");
    } finally {
      setBusyId("");
    }
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Amendments</h1>
          <p className="mt-1 text-sm text-slate-500">Review client and admin shipment amendment requests.</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeFilter
            value={dateRange}
            onChange={(value) => {
              setDataLoading(true);
              setDateRange(value);
              setPage(1);
            }}
          />
          <div className="relative">
            <select
              value={status}
              onChange={(event) => {
                setDataLoading(true);
                setStatus(event.target.value);
                setPage(1);
              }}
              className="h-10 w-full appearance-none border border-slate-300 rounded-xl bg-white px-3 pr-9 text-sm font-semibold text-slate-700 outline-none focus:border-blue-900"
            >
              <option value="">All Status</option>
              <option value="REQUESTED">Requested</option>
              <option value="AWAITING_PAYMENT">Awaiting Payment</option>
              <option value="PAYMENT_SECURED">Payment Secured</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="APPLIED">Applied</option>
            </select>
            <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
      </div>

      {error ? <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}

      <div className="overflow-x-auto border border-slate-200 bg-white rounded-2xl">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Shipment ID</th>
              <th className="px-4 py-3">Consignee</th>
              <th className="px-4 py-3">Branch</th>
              <th className="px-4 py-3">Changed Fields</th>
              <th className="px-4 py-3">Old Charge</th>
              <th className="px-4 py-3">New Charge</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {dataLoading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">Loading amendments...</td></tr>
            ) : amendments.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No amendments found.</td></tr>
            ) : amendments.map((amendment) => {
              const changedFields = getChangedFields(amendment);
              const currentCharge = amendment.pricingImpact?.current.totalAmount;
              const requestedCharge = amendment.pricingImpact?.requested.totalAmount;
              const deltaAmount = amendment.pricingImpact?.deltaAmount;

              return (
                <tr key={amendment.id} id={`amendment-${amendment.id}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/shipments/${amendment.shipmentDraftId}`} className="font-semibold text-blue-900 hover:text-blue-700">
                      {amendment.shipmentId}
                    </Link>
                    <p className="mt-1 text-xs text-slate-500">{formatDashboardDateTime(amendment.requestedAt)}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{amendment.consignee || "Not set"}</p>
                    <p className="mt-1 text-xs capitalize text-slate-500">{amendment.actorRole} request</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{amendment.branch?.name || "Not set"}</p>
                    <p className="mt-1 text-xs text-slate-500">{amendment.branch?.code || amendment.branch?.city || "Not set"}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-sm flex-wrap gap-2">
                      {changedFields.slice(0, 4).map((field) => (
                        <span key={field} className="  px-2 py-1 text-xs font-semibold text-slate-600">
                          {field}
                        </span>
                      ))}
                      {changedFields.length > 4 ? (
                        <span className="px-2 py-1 text-xs font-semibold text-slate-500">
                          +{changedFields.length - 4} more
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800">{formatCharge(currentCharge)}</p>
                    {amendment.pricingImpact?.current.missingRate ? (
                      <p className="mt-1 text-xs font-semibold text-amber-700">Rate missing</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-950">{formatCharge(requestedCharge)}</p>
                    {typeof deltaAmount === "number" ? (
                      <p className={`mt-1 text-xs font-semibold ${getChargeTone(deltaAmount)}`}>
                        {deltaAmount >= 0 ? "+" : ""}{formatMoney(deltaAmount)}
                      </p>
                    ) : null}
                    {amendment.pricingImpact?.requested.exceedsMaxBoxKg ? (
                      <p className="mt-1 text-xs font-semibold text-amber-700">Max box exceeded</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`border px-2 py-1 rounded-xl text-xs font-semibold uppercase tracking-wide ${statusTone(amendment.status)}`}>
                      {formatStatus(amendment.status)}
                    </span>
                    {amendment.reason ? <p className="mt-2 max-w-xs text-xs text-slate-500">{amendment.reason}</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        setReviewError("");
                        setSelectedAmendment(amendment);
                      }}
                      className="font-semibold text-blue-900 hover:text-blue-700"
                    >
                      {["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"].includes(amendment.status) ? "Review" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        onPageChange={setPage}
      />

      {selectedAmendment ? (
        <AmendmentReviewModal
          key={selectedAmendment.id}
          amendment={selectedAmendment}
          busy={busyId === selectedAmendment.id}
          error={reviewError}
          onClose={() => {
            if (busyId) return;
            setReviewError("");
            setSelectedAmendment(null);
          }}
          onReview={(action, note, counterPayment) => reviewAmendment(selectedAmendment.id, action, note, counterPayment)}
        />
      ) : null}
    </>
  );
}
