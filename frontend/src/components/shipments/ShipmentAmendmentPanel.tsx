"use client";

import { useState } from "react";
import {
  ShipmentAddress,
  ShipmentAmendmentInput,
  ShipmentAmendmentPreview,
  ShipmentDraft,
  ShipmentServiceType,
  shipmentContentTypeOptions
} from "@/lib/dpdLabels";
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
  canAmend: boolean;
  blockedReason: string;
  busy: boolean;
  onPreview: (input: ShipmentAmendmentInput) => Promise<ShipmentAmendmentPreview>;
  onSubmit: (input: ShipmentAmendmentInput) => Promise<void>;
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
  canAmend,
  blockedReason,
  busy,
  onPreview,
  onSubmit
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [addressForm, setAddressForm] = useState(address);
  const [parcels, setParcels] = useState<AmendmentParcelForm[]>(normalizeParcelList(parcelList));
  const [selectedServiceType, setSelectedServiceType] = useState<ShipmentServiceType>(serviceType);
  const [formError, setFormError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<ShipmentAmendmentPreview | null>(null);

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
    const input = buildInput();
    if (!input) return;
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
      await onSubmit(input);
      setOpen(false);
      setReason("");
      setPreview(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to submit the amendment request.");
    }
  }

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
          disabled={!canAmend || busy}
          className="h-10 rounded-4xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {open ? "Close" : "Request Amendment"}
        </button>
      </div>

      {!canAmend ? (
        <div className="px-5 py-4 text-sm font-semibold text-amber-700">{blockedReason}</div>
      ) : null}

      {open ? (
        <div className="space-y-5 p-5">
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
                  label={preview.fundingPreview.billingMode === "TEST" ? "Billing Mode" : "Available Capacity Now"}
                  value={preview.fundingPreview.billingMode === "TEST"
                    ? "Test - no account charge"
                    : formatMinorAmount(preview.fundingPreview.availableBookingCapacityMinor)}
                />
              </div>

              {preview.fundingPreview.billingMode === "TEST" ? (
                <p className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  This legacy test shipment does not update Customer Advance or Credit balances.
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
                <p className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                  {preview.fundingPreview.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {formError ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{formError}</div> : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void checkCharges()}
              disabled={busy || previewBusy}
              className="h-10 rounded-lg border border-blue-900 px-4 text-sm font-semibold text-blue-900 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              {previewBusy ? "Calculating..." : "Check Charges"}
            </button>
            <button
              type="button"
              onClick={() => void submitAmendment()}
              disabled={busy || previewBusy || !preview || !preview.fundingPreview.canFund}
              className="h-10 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {busy ? "Saving..." : "Submit Request"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
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
