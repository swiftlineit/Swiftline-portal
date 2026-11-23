"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import {
  ShipmentAddress,
  ShipmentAmendmentInput,
  ShipmentAmendment,
  ShipmentAmendmentPreview,
  ShipmentDraft,
  ShipmentServiceType,
  shipmentContentTypeOptions
} from "@/lib/dpdLabels";
import type { CsbType } from "@/lib/csbType";
import { ParcelItemsEditor } from "@/components/shipments/ParcelItemsEditor";
import {
  composeContentsDescription,
  normalizeParcelItems as normalizeContentItems,
  type ParcelItem
} from "@/lib/parcelItems";
import { findRestrictedCategories, isRestrictedDescription } from "@/lib/restrictedGoods";

type Props = {
  address: ShipmentAddress;
  parcelList: ShipmentDraft["parcelList"];
  serviceType: ShipmentServiceType;
  csbType?: CsbType;
  canAmend: boolean;
  blockedReason: string;
  busy: boolean;
  prepaidPaymentRequired?: boolean;
  walletTopUpHref?: string;
  onPreview: (input: ShipmentAmendmentInput) => Promise<ShipmentAmendmentPreview>;
  onSubmit: (input: ShipmentAmendmentInput) => Promise<ShipmentAmendment | void>;
  onSecurePayment?: (amendment: ShipmentAmendment, preview: ShipmentAmendmentPreview) => Promise<void>;
  onLoadPendingAmendment?: () => Promise<ShipmentAmendment | null>;
};

function text(value?: string | null) {
  return value ?? "";
}

type AmendmentParcelForm = {
  sequence: number;
  weightKg: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  shipmentContentType: ShipmentDraft["parcelList"][number]["shipmentContentType"];
  items: ParcelItem[];
  contentsDescription: string;
  shipmentReference1: string;
  shipmentReference2: string;
};

function comparable(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return value;
}

function normalizeParcelList(parcelList: ShipmentDraft["parcelList"]) {
  return parcelList.map((parcel, index) => ({
    sequence: parcel.sequence || index + 1,
    weightKg: Number(parcel.weightKg) || 0,
    lengthCm: parcel.lengthCm ?? null,
    widthCm: parcel.widthCm ?? null,
    heightCm: parcel.heightCm ?? null,
    shipmentContentType: parcel.shipmentContentType || "PARCEL",
    items: normalizeContentItems(parcel),
    contentsDescription: parcel.contentsDescription || "",
    shipmentReference1: parcel.shipmentReference1 || "",
    shipmentReference2: parcel.shipmentReference2 || ""
  }));
}

function formatMinorAmount(amountMinor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(amountMinor / 100);
}

export default function ShipmentAmendmentPanel({
  address,
  parcelList,
  serviceType,
  csbType,
  canAmend,
  blockedReason,
  busy,
  prepaidPaymentRequired = false,
  walletTopUpHref,
  onPreview,
  onSubmit,
  onSecurePayment,
  onLoadPendingAmendment
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [addressForm, setAddressForm] = useState(address);
  const [parcels, setParcels] = useState<AmendmentParcelForm[]>(normalizeParcelList(parcelList));
  const [selectedServiceType, setSelectedServiceType] = useState<ShipmentServiceType>(serviceType);
  const [formError, setFormError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<ShipmentAmendmentPreview | null>(null);
  const [pendingPaymentAmendment, setPendingPaymentAmendment] = useState<ShipmentAmendment | null>(null);
  const [pendingPaymentPreview, setPendingPaymentPreview] = useState<ShipmentAmendmentPreview | null>(null);
  const [activeAmendment, setActiveAmendment] = useState<ShipmentAmendment | null>(null);
  useEffect(() => {
    let mounted = true;
    if (onLoadPendingAmendment) {
      void onLoadPendingAmendment().then((amendment) => {
        if (!mounted || !amendment) return;
        setActiveAmendment(amendment);
        if (amendment.status === "AWAITING_PAYMENT" && amendment.fundingPreview && amendment.pricingImpact) {
          setPendingPaymentAmendment(amendment);
          setPendingPaymentPreview({
            pricingImpact: amendment.pricingImpact,
            fundingPreview: amendment.fundingPreview
          });
        }
      }).catch((error: unknown) => {
        if (mounted) toast.error(error instanceof Error ? error.message : "Unable to check pending amendments.");
      });
    }
    return () => { mounted = false; };
  }, [onLoadPendingAmendment]);

  function clearPreview() {
    setPreview(null);
    setFormError("");
  }

  function updateAddress(field: keyof ShipmentAddress, value: string) {
    setAddressForm((current) => ({ ...current, [field]: value }));
    clearPreview();
  }

  function updateParcel(index: number, field: keyof ShipmentDraft["parcelList"][number], value: string) {
    setParcels((current) => current.map((parcel, parcelIndex) => {
      if (parcelIndex !== index) return parcel;

      if (field === "weightKg" || field === "lengthCm" || field === "widthCm" || field === "heightCm") {
        return { ...parcel, [field]: value === "" ? null : Number(value) };
      }

      return { ...parcel, [field]: value };
    }));
    clearPreview();
  }

  function updateParcelItems(index: number, items: ParcelItem[]) {
    setParcels((current) => current.map((parcel, parcelIndex) => (
      parcelIndex === index
        ? { ...parcel, items, contentsDescription: composeContentsDescription(items) }
        : parcel
    )));
    clearPreview();
  }

  function buildChangedAddress() {
    return Object.entries(addressForm).reduce<Partial<ShipmentAddress>>((changes, [field, value]) => {
      const key = field as keyof ShipmentAddress;
      if (JSON.stringify(comparable(address[key])) !== JSON.stringify(comparable(value))) {
        return { ...changes, [key]: value };
      }

      return changes;
    }, {});
  }

  function parcelsChanged() {
    return JSON.stringify(normalizeParcelList(parcelList).map((parcel) => ({
      ...parcel,
      lengthCm: comparable(parcel.lengthCm),
      widthCm: comparable(parcel.widthCm),
      heightCm: comparable(parcel.heightCm)
    }))) !== JSON.stringify(parcels.map((parcel) => ({
      ...parcel,
      lengthCm: comparable(parcel.lengthCm),
      widthCm: comparable(parcel.widthCm),
      heightCm: comparable(parcel.heightCm)
    })));
  }

  function buildInput(): ShipmentAmendmentInput | null {
    const restrictedParcel = parcels.findIndex((parcel) =>
      parcel.items.some((item) => isRestrictedDescription(item.description))
      || isRestrictedDescription(parcel.contentsDescription)
    );
    if (restrictedParcel >= 0) {
      const parcel = parcels[restrictedParcel]!;
      const categories = [
        ...parcel.items.flatMap((item) => findRestrictedCategories(item.description)),
        ...findRestrictedCategories(parcel.contentsDescription)
      ].filter((category, index, all) => all.indexOf(category) === index).join(", ");
      setFormError(`Parcel ${restrictedParcel + 1}: ${categories} is a restricted item and cannot be shipped.`);
      return null;
    }

    const changedAddress = buildChangedAddress();
    const changes: ShipmentAmendmentInput["changes"] = {};

    if (selectedServiceType !== serviceType) changes.serviceType = selectedServiceType;
    if (Object.keys(changedAddress).length) changes.consigneeEnteredAddress = changedAddress;
    // Parcel amendments are submitted as a full parcel list so approval can safely replace the parcel set.
    if (parcelsChanged()) {
      changes.parcelList = parcels.map((parcel) => ({
        ...parcel,
        items: parcel.items.map((item) => ({
          description: item.description.trim(),
          hsnCode: item.hsnCode.trim(),
          unitType: item.unitType.trim(),
          quantity: Number(item.quantity) || 0,
          unitRate: Number(item.unitRate) || 0
        })),
        contentsDescription: composeContentsDescription(parcel.items)
      }));
    }

    if (!changes.serviceType && !changes.consigneeEnteredAddress && !changes.parcelList) {
      setFormError("Change at least one shipment detail before submitting an amendment.");
      return null;
    }

    return {
      reason,
      changes
    };
  }

  async function checkCharges() {
    const input = buildInput();
    if (!input) return;

    setPreviewBusy(true);
    setFormError("");
    try {
      const result = await onPreview(input);
      setPreview(result);
    } catch (error) {
      setPreview(null);
      setFormError(error instanceof Error ? error.message : "Unable to calculate amended charges.");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function submitAmendment() {
    if (pendingPaymentAmendment) {
      if (!pendingPaymentPreview || !onSecurePayment) {
        setFormError("Amendment payment could not be resumed. Refresh and contact your Swiftline team.");
        return;
      }
      setFormError("");
      try {
        await onSecurePayment(pendingPaymentAmendment, pendingPaymentPreview);
        setActiveAmendment({ ...pendingPaymentAmendment, status: "PAYMENT_SECURED", paymentStatus: "SECURED" });
        setPendingPaymentAmendment(null);
        setPendingPaymentPreview(null);
        setOpen(false);
        setReason("");
        setPreview(null);
        toast.success("Amendment payment secured. The request is waiting for staff review.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Amendment payment is still pending.";
        setFormError(message);
        toast.error(message);
      }
      return;
    }

    if (!preview) {
      setFormError("Check the amended charges before submitting this request.");
      return;
    }
    if (!preview.fundingPreview.canFund) {
      setFormError(preview.fundingPreview.message);
      return;
    }

    setFormError("");
    try {
      const input = buildInput();
      if (!input) return;
      const amendment = await onSubmit(input);
      if (amendment) setActiveAmendment(amendment);
      if (prepaidPaymentRequired && preview.fundingPreview.deltaAmountMinor > 0) {
        if (!amendment || !onSecurePayment) {
          throw new Error("The amendment request was saved, but payment could not be started. Refresh and contact your Swiftline team.");
        }
        setPendingPaymentAmendment(amendment);
        setPendingPaymentPreview(preview);
        await onSecurePayment(amendment, preview);
        setActiveAmendment({ ...amendment, status: "PAYMENT_SECURED", paymentStatus: "SECURED" });
        setPendingPaymentAmendment(null);
        setPendingPaymentPreview(null);
      }
      setOpen(false);
      setReason("");
      setPreview(null);
      toast.success(prepaidPaymentRequired && preview.fundingPreview.deltaAmountMinor > 0
        ? "Amendment payment secured. The request is waiting for staff review."
        : "Amendment request submitted successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to submit the amendment request.";
      setFormError(message);
      toast.error(message);
    }
  }

  const pendingPaymentAmountMinor = pendingPaymentAmendment?.paymentAmountMinor ?? 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Shipment Amendment</h2>
          <p className="mt-1 text-sm text-slate-600">
            Request changes to consignee, delivery address, parcel details, and delivery instructions before warehouse scan in.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={!canAmend || busy || Boolean(activeAmendment && activeAmendment.status !== "AWAITING_PAYMENT")}
          className="h-10 rounded-4xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pendingPaymentAmendment ? "Secure payment" : activeAmendment ? "Request in progress" : open ? "Close" : "Request Amendment"}
        </button>
      </div>

      {activeAmendment ? (
        <div className="border-b border-blue-100 bg-blue-50 px-5 py-3 text-sm text-blue-950" role="status">
          {activeAmendment.status === "AWAITING_PAYMENT"
            ? "This amendment is waiting for payment. Add wallet funds first if the available balance is too low."
            : activeAmendment.status === "PAYMENT_SECURED"
              ? "Payment is secured. This amendment is waiting for staff review."
              : "An amendment request is already waiting for staff review."}
        </div>
      ) : null}

      {!canAmend ? (
        <div className="px-5 py-4 text-sm font-semibold text-amber-700">{blockedReason}</div>
      ) : null}

      {open ? (
        <div className="space-y-5 p-5">
          {pendingPaymentAmendment ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
              {pendingPaymentAmountMinor > 0
                ? `${formatMinorAmount(pendingPaymentAmountMinor)} is due for this saved amendment. This payment will not change if you edit the form.`
                : "This amendment is saved and waiting for review."}
              {pendingPaymentAmountMinor > 0 && walletTopUpHref ? (
                <Link href={walletTopUpHref} className="ml-1 underline underline-offset-2">
                  Add wallet funds
                </Link>
              ) : null}
            </div>
          ) : null}
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional amendment reason"
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-blue-900"
            />
          </label>

          <div>
            <h3 className="text-sm font-semibold text-slate-950">Consignee and Address</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <AmendmentInput label="Company" value={text(addressForm.companyName)} onChange={(value) => updateAddress("companyName", value)} />
              <AmendmentInput label="Contact" value={text(addressForm.contactName)} onChange={(value) => updateAddress("contactName", value)} />
              <AmendmentInput label="Email" value={text(addressForm.email)} onChange={(value) => updateAddress("email", value)} />
              <AmendmentInput label="Mobile" value={text(addressForm.mobileNumber)} onChange={(value) => updateAddress("mobileNumber", value)} />
              <AmendmentInput label="Address Line 1" value={text(addressForm.addressLine1)} onChange={(value) => updateAddress("addressLine1", value)} />
              <AmendmentInput label="Address Line 2" value={text(addressForm.addressLine2)} onChange={(value) => updateAddress("addressLine2", value)} />
              <AmendmentInput label="Town / City" value={text(addressForm.townOrCity)} onChange={(value) => updateAddress("townOrCity", value)} />
              <AmendmentInput label="Postcode" value={text(addressForm.postcode)} onChange={(value) => updateAddress("postcode", value)} />
              <AmendmentInput label="County" value={text(addressForm.county)} onChange={(value) => updateAddress("county", value)} />
              <AmendmentInput label="Country Code" value={text(addressForm.countryCode)} onChange={(value) => updateAddress("countryCode", value)} />
              <label className="md:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery Instructions</span>
                <textarea
                  value={text(addressForm.deliveryInstructions)}
                  onChange={(event) => updateAddress("deliveryInstructions", event.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-900"
                />
              </label>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-950">Parcel Details</h3>
            <label className="mt-3 block max-w-xs">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Service Type</span>
              <select
                value={selectedServiceType}
                onChange={(event) => {
                  setSelectedServiceType(event.target.value as ShipmentServiceType);
                  clearPreview();
                }}
                className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white pl-3 pr-8 text-sm text-slate-900 outline-none focus:border-blue-900"
              >
                <option value="COURIER">Courier</option>
                <option value="CARGO">Cargo</option>
              </select>
            </label>
            <div className="mt-3 space-y-3">
              {parcels.map((parcel, index) => (
                <div key={parcel.sequence} className="grid gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-5">
                  <AmendmentInput label="Actual Weight KG" type="number" value={String(parcel.weightKg)} onChange={(value) => updateParcel(index, "weightKg", value)} />
                  <AmendmentInput label="Length CM" type="number" value={String(parcel.lengthCm ?? "")} onChange={(value) => updateParcel(index, "lengthCm", value)} />
                  <AmendmentInput label="Width CM" type="number" value={String(parcel.widthCm ?? "")} onChange={(value) => updateParcel(index, "widthCm", value)} />
                  <AmendmentInput label="Height CM" type="number" value={String(parcel.heightCm ?? "")} onChange={(value) => updateParcel(index, "heightCm", value)} />
                  <label>
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Content Type</span>
                    <select
                      value={parcel.shipmentContentType}
                      onChange={(event) => updateParcel(index, "shipmentContentType", event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white pl-3 pr-8 text-sm text-slate-900 outline-none focus:border-blue-900"
                    >
                      {shipmentContentTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="md:col-span-5 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <ParcelItemsEditor
                      items={parcel.items}
                      onChange={(items) => updateParcelItems(index, items)}
                      parcelLabel={`Parcel ${index + 1}`}
                      enforceItemValueLimit={csbType !== "CSB_V"}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {preview ? (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <ChargeMetric label="Current Charge" value={formatMinorAmount(preview.fundingPreview.previousAmountMinor)} />
                <ChargeMetric label="New Charge" value={formatMinorAmount(preview.fundingPreview.amendedAmountMinor)} />
                <ChargeMetric
                  label="Difference"
                  value={`${preview.fundingPreview.deltaAmountMinor > 0 ? "+" : ""}${formatMinorAmount(preview.fundingPreview.deltaAmountMinor)}`}
                  tone={preview.fundingPreview.deltaAmountMinor > 0 ? "text-red-700" : preview.fundingPreview.deltaAmountMinor < 0 ? "text-emerald-700" : "text-slate-950"}
                />
                <ChargeMetric
                  label={preview.fundingPreview.billingMode === "TEST"
                    ? "Billing Mode"
                    : preview.fundingPreview.billingMode === "PREPAID"
                      ? "Available Wallet"
                      : preview.fundingPreview.billingMode === "DIRECT" && preview.fundingPreview.deltaAmountMinor > 0
                        ? "Payment Due"
                        : "Available Capacity Now"}
                  value={preview.fundingPreview.billingMode === "TEST"
                    ? "Test - no account charge"
                    : preview.fundingPreview.billingMode === "DIRECT" && preview.fundingPreview.deltaAmountMinor > 0
                      ? formatMinorAmount(preview.fundingPreview.deltaAmountMinor)
                    : formatMinorAmount(preview.fundingPreview.availableBookingCapacityMinor)}
                />
              </div>

              {preview.fundingPreview.billingMode === "TEST" ? (
                <p className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  This legacy test shipment does not update Customer Advance or Credit balances.
                </p>
              ) : preview.fundingPreview.billingMode === "PREPAID" || preview.fundingPreview.billingMode === "DIRECT" ? (
                <p className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  {preview.fundingPreview.deltaAmountMinor > 0
                    ? preview.fundingPreview.billingMode === "PREPAID"
                      ? "The additional amount is reserved from the business wallet. Staff approval completes the charge; rejection releases the reserved amount."
                      : "Pay the additional amount through Razorpay before approval."
                    : preview.fundingPreview.deltaAmountMinor < 0
                      ? preview.fundingPreview.billingMode === "PREPAID"
                        ? "Only the price difference will be credited to the business wallet."
                        : "The approved reduction must be refunded before the amendment is applied."
                      : "No additional payment is required."}
                </p>
              ) : preview.fundingPreview.adjustment ? (
                <div className="grid gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2">
                  {preview.fundingPreview.deltaAmountMinor >= 0 ? (
                    <>
                      <FundingItem label="Customer Advance Used" amountMinor={preview.fundingPreview.adjustment.advanceUsedMinor} />
                      <FundingItem label="Credit Used" amountMinor={preview.fundingPreview.adjustment.creditUsedMinor} />
                    </>
                  ) : (
                    <>
                      <FundingItem label="Credit Reduced" amountMinor={preview.fundingPreview.adjustment.creditReducedMinor} />
                      <FundingItem label="Customer Advance Refunded" amountMinor={preview.fundingPreview.adjustment.advanceRefundedMinor} />
                    </>
                  )}
                </div>
              ) : null}

              {!preview.fundingPreview.canFund ? (
                <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                  <p>{preview.fundingPreview.message}</p>
                  {preview.fundingPreview.billingMode === "PREPAID" && walletTopUpHref ? (
                    <Link href={walletTopUpHref} className="mt-1 inline-block text-blue-900 underline underline-offset-2">
                      Go to Payments to add wallet funds
                    </Link>
                  ) : preview.fundingPreview.billingMode === "PREPAID" ? (
                    <p className="mt-1 font-medium">Ask the business account client to add wallet funds, then check the charges again.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {formError ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{formError}</div> : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void checkCharges()}
              disabled={busy || previewBusy || Boolean(pendingPaymentAmendment)}
              className="h-10 rounded-lg border border-blue-900 px-4 text-sm font-semibold text-blue-900 hover:border-blue-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-600"
            >
              {previewBusy ? "Calculating..." : "Check Charges"}
            </button>
            <button
              type="button"
              onClick={() => void submitAmendment()}
              disabled={busy || previewBusy || (!pendingPaymentAmendment && (!preview || !preview.fundingPreview.canFund))}
              className="h-10 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {busy ? "Saving..." : pendingPaymentAmendment ? "Retry Payment" : prepaidPaymentRequired && (preview?.fundingPreview.deltaAmountMinor ?? 0) > 0 ? "Submit and Pay" : "Submit Request"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={Boolean(pendingPaymentAmendment)}
              className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ChargeMetric({ label, value, tone = "text-slate-950" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-base font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function FundingItem({ label, amountMinor }: { label: string; amountMinor: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-600">{label}</span>
      <span className="font-semibold text-slate-900">{formatMinorAmount(amountMinor)}</span>
    </div>
  );
}

function AmendmentInput({
  label,
  value,
  onChange,
  type = "text",
  onBlur
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  onBlur?: () => void;
}) {
  return (
    <label>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="mt-2 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-blue-900"
      />
    </label>
  );
}
