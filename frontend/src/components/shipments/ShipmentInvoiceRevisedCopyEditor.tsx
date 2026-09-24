"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { FiPrinter, FiX } from "react-icons/fi";
import {
  getShipmentLevelInvoiceLines,
  shipmentInvoiceParcelDescription,
  type ShipmentInvoice,
} from "@/lib/shipmentInvoices";
import type { ShipmentChargeLine } from "@/lib/shipmentCostEstimate";

/**
 * WYSIWYG editor for a document-only revised copy of a tax invoice.
 *
 * It renders the same invoice paper as ShipmentInvoicePage, but every field
 * is editable inline so the result on screen is exactly what the saved
 * document will look like. Only the logo and the tracking number stay locked.
 *
 * `onSave` receives the edited document and a reason for the audit trail. The
 * caller persists it into the revised-copies collection. The real invoice is
 * never written.
 */

// All numbers are kept as raw strings while editing so a field can be freely
// cleared and retyped (a controlled `type="number"` input snaps "" back to 0,
// which is what produced the stuck "01" values). Parsing happens only for the
// live totals and on save.
type ParcelDraft = {
  sequence: number;
  description: string;
  actual: string;
  volumetric: string;
  chargeable: string;
  rate: string;
  amount: string;
  len: string;
  wid: string;
  hei: string;
};

type LineDraft = { label: string; amount: string; kind: "CHARGE" | "DEDUCTION" };

function str(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function parseNum(value: string) {
  if (value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMinor(value: string) {
  return Math.round(parseNum(value) * 100);
}

function splitTax(taxableMinor: number, gstRatePercent: number, taxType: "CGST_SGST" | "IGST") {
  const rate = Number.isFinite(gstRatePercent) && gstRatePercent > 0 ? gstRatePercent : 0;
  const taxMinor = Math.round((taxableMinor * rate) / 100);
  if (taxType === "CGST_SGST") {
    const cgst = Math.floor(taxMinor / 2);
    return { cgst, sgst: taxMinor - cgst, igst: 0, taxMinor };
  }
  return { cgst: 0, sgst: 0, igst: taxMinor, taxMinor };
}

function safeMoney(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value: string) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(value))
    .replaceAll("/", "-");
}

function stringifyRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).map(([key, val]) => [key, str(val)])) as Record<string, string>;
}

function initParcels(invoice: ShipmentInvoice): ParcelDraft[] {
  return (invoice.shipment.parcels ?? []).map((parcel) => ({
    sequence: parcel.sequence,
    description: shipmentInvoiceParcelDescription(parcel),
    actual: str(parcel.actualWeightKg),
    volumetric: str(parcel.volumetricWeightKg),
    chargeable: str(parcel.chargeableWeightKg),
    rate: parcel.chargesPerKg === null ? "" : str(parcel.chargesPerKg),
    amount: str(parcel.baseAmount),
    len: parcel.lengthCm === null ? "" : str(parcel.lengthCm),
    wid: parcel.widthCm === null ? "" : str(parcel.widthCm),
    hei: parcel.heightCm === null ? "" : str(parcel.heightCm),
  }));
}

function initLines(invoice: ShipmentInvoice): LineDraft[] {
  return getShipmentLevelInvoiceLines(invoice.pricingSnapshot).map((line) => ({
    label: line.label,
    amount: (line.amountMinor / 100).toFixed(2),
    kind: line.kind === "DEDUCTION" ? "DEDUCTION" : "CHARGE",
  }));
}

export default function ShipmentInvoiceRevisedCopyEditor({
  initial,
  copyId,
  saving = false,
  onSave,
  onCancel,
}: {
  initial: ShipmentInvoice;
  copyId?: string;
  saving?: boolean;
  onSave: (invoice: ShipmentInvoice, copyId: string | undefined, changeReason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(initial.invoiceNumber);
  const [issuedAt, setIssuedAt] = useState(initial.issuedAt.slice(0, 10));
  const [currency, setCurrency] = useState(initial.currency);
  const [sacCode, setSacCode] = useState(initial.sacCode);
  const [description, setDescription] = useState(initial.description);
  const [supplier, setSupplier] = useState<Record<string, string>>(() => stringifyRecord(initial.supplier));
  const [customer, setCustomer] = useState<Record<string, string>>(() => stringifyRecord(initial.customer));
  const [origin, setOrigin] = useState(str(initial.shipment.origin));
  const [destination, setDestination] = useState(str(initial.shipment.destination));
  const [deliveryAddress, setDeliveryAddress] = useState(str(initial.shipment.deliveryAddress));
  const [consigneeName, setConsigneeName] = useState(str(initial.shipment.consigneeName));
  const [customerReference, setCustomerReference] = useState(str(initial.shipment.customerReference));
  const [sourceInvoiceNumber, setSourceInvoiceNumber] = useState(str(initial.shipment.sourceInvoiceNumber));
  const [serviceType, setServiceType] = useState(str(initial.shipment.serviceType));
  const [serviceCode, setServiceCode] = useState(str(initial.shipment.serviceCode));
  const [parcels, setParcels] = useState<ParcelDraft[]>(() => initParcels(initial));
  const [lines, setLines] = useState<LineDraft[]>(() => initLines(initial));
  const [taxable, setTaxable] = useState((initial.taxableValueMinor / 100).toFixed(2));
  const [gstRate, setGstRate] = useState(String(initial.gstRatePercent));
  const [taxType, setTaxType] = useState<"CGST_SGST" | "IGST">(initial.taxType);
  const [changeReason, setChangeReason] = useState("");
  const [error, setError] = useState("");

  const totals = useMemo(() => {
    const taxableMinor = toMinor(taxable);
    const split = splitTax(taxableMinor, parseNum(gstRate), taxType);
    return { taxableMinor, ...split, totalMinor: taxableMinor + split.taxMinor };
  }, [taxable, gstRate, taxType]);

  const noGst = parseNum(gstRate) === 0;

  // Printing isolates the invoice paper: the class is picked up by the print
  // stylesheet below and removed once the print dialog closes.
  useEffect(() => {
    const cleanup = () => document.body.classList.remove("printing-revised");
    window.addEventListener("afterprint", cleanup);
    return () => {
      window.removeEventListener("afterprint", cleanup);
      cleanup();
    };
  }, []);

  function handlePrint() {
    document.body.classList.add("printing-revised");
    window.print();
  }

  function patchParcel(index: number, patch: Partial<ParcelDraft>) {
    setParcels((prev) => prev.map((parcel, i) => (i === index ? { ...parcel, ...patch } : parcel)));
  }

  function recalcFromRows() {
    const boxesTotal = parcels.reduce((sum, parcel) => sum + parseNum(parcel.amount), 0);
    const linesTotal = lines.reduce(
      (sum, line) => sum + (line.kind === "DEDUCTION" ? -parseNum(line.amount) : parseNum(line.amount)),
      0,
    );
    setTaxable((boxesTotal + linesTotal).toFixed(2));
  }

  function handleSave() {
    setError("");
    if (!invoiceNumber.trim()) {
      setError("Invoice number is required on the revised document.");
      return;
    }
    if (changeReason.trim().length < 3) {
      setError("Enter a short reason for this revised copy.");
      return;
    }
    const taxableMinor = toMinor(taxable);
    const rate = parseNum(gstRate);
    if (taxableMinor < 0 || rate < 0) {
      setError("Taxable value and GST rate must be zero or more.");
      return;
    }
    const rowTaxableMinor = parcels.reduce((sum, parcel) => sum + toMinor(parcel.amount), 0)
      + lines.reduce(
        (sum, line) => sum + (line.kind === "DEDUCTION" ? -toMinor(line.amount) : toMinor(line.amount)),
        0,
      );
    if (taxableMinor !== rowTaxableMinor) {
      setError("Taxable value must match the box and charge rows. Use Recalculate taxable from rows before saving.");
      return;
    }
    const split = splitTax(taxableMinor, rate, taxType);

    const sourceParcels = initial.shipment.parcels ?? [];
    const editedParcels = parcels.map((parcel) => {
      const source = sourceParcels.find((candidate) => candidate.sequence === parcel.sequence)
        ?? ({} as (typeof sourceParcels)[number]);
      // The preview shows one description line per box. Split it back onto the
      // stored items so HSN / quantity / rate details survive the round trip.
      const parts = parcel.description.split(",").map((part) => part.trim()).filter(Boolean);
      const sourceItems = source.items ?? [];
      const items = parts.length
        ? parts.map((part, itemIndex) => ({ ...(sourceItems[itemIndex] ?? {}), description: part }))
        : (source.items ?? []);
      return {
        ...source,
        sequence: parcel.sequence,
        actualWeightKg: parseNum(parcel.actual),
        volumetricWeightKg: parseNum(parcel.volumetric),
        chargeableWeightKg: parseNum(parcel.chargeable),
        chargesPerKg: parcel.rate.trim() === "" ? null : parseNum(parcel.rate),
        baseAmount: parseNum(parcel.amount),
        lengthCm: parcel.len.trim() === "" ? null : parseNum(parcel.len),
        widthCm: parcel.wid.trim() === "" ? null : parseNum(parcel.wid),
        heightCm: parcel.hei.trim() === "" ? null : parseNum(parcel.hei),
        contentsDescription: parcel.description,
        items,
      };
    });

    // Keep original FREIGHT/GST pricing entries untouched; only the rows the
    // preview shows are rebuilt from the edited lines.
    const originalLines = initial.pricingSnapshot?.lines ?? [];
    const kept = originalLines.filter((line) => line.code === "FREIGHT" || line.code === "GST");
    const edited: ShipmentChargeLine[] = lines
      .filter((line) => line.label.trim())
      .map((line, index) => ({
        code: `CHARGE_${index + 1}` as ShipmentChargeLine["code"],
        label: line.label.trim(),
        kind: line.kind === "DEDUCTION" ? ("DEDUCTION" as const) : ("CHARGE" as const),
        amount: parseNum(line.amount),
        amountMinor: toMinor(line.amount),
        basis: "Edited on the revised document copy",
      }));

    const next: ShipmentInvoice = {
      ...initial,
      invoiceNumber: invoiceNumber.trim(),
      issuedAt: issuedAt ? new Date(`${issuedAt}T00:00:00`).toISOString() : initial.issuedAt,
      currency: currency.trim() || initial.currency,
      supplier: { ...initial.supplier, ...supplier },
      customer: { ...initial.customer, ...customer },
      // Tracking number stays locked: the revised copy must still point at the
      // same shipment, so the original reference is always kept.
      shipment: {
        ...initial.shipment,
        origin,
        destination,
        deliveryAddress,
        consigneeName,
        customerReference,
        sourceInvoiceNumber,
        serviceType,
        serviceCode,
        parcels: editedParcels,
        parcelCount: editedParcels.length,
        shipmentReference: str(initial.shipment.shipmentReference),
      } as unknown as ShipmentInvoice["shipment"],
      sacCode,
      description,
      taxableValueMinor: taxableMinor,
      gstRatePercent: rate,
      taxTreatment: rate === 0 ? "NO_GST" : "GST_APPLICABLE",
      taxType,
      cgstAmountMinor: split.cgst,
      sgstAmountMinor: split.sgst,
      igstAmountMinor: split.igst,
      totalTaxAmountMinor: split.taxMinor,
      totalAmountMinor: taxableMinor + split.taxMinor,
      pricingSnapshot: {
        ...(initial.pricingSnapshot ?? {}),
        lines: [...kept, ...edited],
      },
    };
    void (async () => {
      try {
        await onSave(next, copyId, changeReason.trim());
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to save the revised copy.");
      }
    })();
  }

  return (
    <div className="revised-copy-editor fixed inset-0 z-50 overflow-y-auto bg-slate-950/60 p-4">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-xl">
        <div>
          <h2 className="text-base font-bold text-slate-950">Editing revised copy</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Click any value on the invoice below and type — what you see is what the saved document looks like.
            Document only: the real invoice is never changed. Logo and tracking number stay locked.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handlePrint}
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiPrinter aria-hidden="true" />
            Print
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-10 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {saving ? "Saving..." : "Save revised copy"}
          </button>
        </div>
      </div>

      <div className="no-print mx-auto mb-4 max-w-[210mm] rounded-2xl bg-white px-5 py-4 shadow-xl">
        <label htmlFor="revised-copy-reason" className="block text-sm font-bold text-slate-950">
          Reason for this revision
        </label>
        <textarea
          id="revised-copy-reason"
          value={changeReason}
          onChange={(event) => setChangeReason(event.target.value)}
          maxLength={500}
          rows={2}
          placeholder="For example: corrected clearance charge after final weight review"
          className="mt-2 w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-blue-700 focus:ring-2 focus:ring-blue-100"
        />
      </div>

      {error ? (
        <div
          className="no-print fixed inset-x-4 top-4 z-[80] mx-auto flex max-w-xl items-start gap-3 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 shadow-2xl"
          role="alert"
          aria-live="assertive"
        >
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
            className="shrink-0 rounded-lg p-1 text-red-700 hover:bg-red-100"
          >
            <FiX aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <article className="revised-paper invoice-sheet mx-auto min-h-[297mm] max-w-[210mm] bg-white p-10 text-slate-950 shadow-xl">
        <header className="flex items-start justify-between gap-8 border-b-2 border-slate-950 pb-4">
          <Image
            src="/swiftline-invoice-logo.png"
            alt="Swiftline Cargo and Express Logistics"
            width={180}
            height={120}
            priority
            className="h-[120px] w-[180px] shrink-0 object-contain object-left"
          />
          <div className="min-w-0 pt-3 text-right">
            <h1 className="text-lg font-bold text-amber-800">REVISED DOCUMENT</h1>
            <p className="mt-3 text-xs">
              <strong>Invoice No:</strong>{" "}
              <EditText value={invoiceNumber} onChange={setInvoiceNumber} align="right" className="w-44 font-semibold" />
            </p>
            <p className="mt-1 text-xs">
              <strong>Date:</strong>{" "}
              <input
                type="date"
                value={issuedAt}
                onChange={(event) => setIssuedAt(event.target.value)}
                className="rounded border border-transparent px-1 text-right text-xs outline-none hover:border-blue-300 focus:border-blue-600 focus:bg-blue-50/40"
              />{" "}
              <span className="text-slate-400">({formatDate(issuedAt ? new Date(`${issuedAt}T00:00:00`).toISOString() : initial.issuedAt)})</span>
            </p>
            <p className="mt-1 text-xs">
              <strong>AWB / Tracking No.:</strong> {str(initial.shipment.shipmentReference) || "Not provided"}{" "}
              <span className="text-slate-400">(locked)</span>
            </p>
          </div>
        </header>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <label className="inline-flex items-center gap-1">
            <span className="font-semibold text-slate-500">SAC:</span>
            <EditText value={sacCode} onChange={setSacCode} className="w-24" />
          </label>
          <label className="inline-flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0 font-semibold text-slate-500">Description:</span>
            <EditText value={description} onChange={setDescription} className="min-w-0 flex-1" />
          </label>
        </div>

        <section className="mt-5 grid grid-cols-2 gap-4">
          <div className="min-h-36 border border-slate-300 p-4 text-xs">
            <p className="font-semibold uppercase text-slate-500">Supplier / Shipper Branch</p>
            <EditText value={supplier.legalName ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, legalName: value }))} className="mt-3 text-sm font-bold" />
            <EditArea value={supplier.address ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, address: value }))} rows={2} className="mt-2 leading-5" />
            <p className="mt-2 font-semibold">
              GSTIN:{" "}
              <EditText value={supplier.gstin ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, gstin: value }))} className="w-40 tracking-wider" />
            </p>
            <p className="mt-1 flex items-center gap-1 text-slate-600">
              <EditText value={supplier.email ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, email: value }))} className="min-w-0 flex-1" />
              <span>|</span>
              <EditText value={supplier.phone ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, phone: value }))} className="w-28" />
            </p>
            <details className="no-print mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-blue-900">More supplier fields</summary>
              <div className="mt-2 grid gap-1">
                {[
                  ["branchName", "Branch name"],
                  ["branchCode", "Branch code"],
                  ["state", "State"],
                ].map(([key, label]) => (
                  <label key={key} className="grid grid-cols-[110px_1fr] items-center gap-1">
                    <span className="text-[11px] text-slate-500">{label}</span>
                    <EditText value={supplier[key] ?? ""} onChange={(value) => setSupplier((prev) => ({ ...prev, [key]: value }))} />
                  </label>
                ))}
              </div>
            </details>
          </div>
          <div className="min-h-36 border border-slate-300 p-4 text-xs">
            <p className="font-semibold uppercase text-slate-500">Bill To / Customer</p>
            <EditText value={customer.companyName ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, companyName: value }))} className="mt-3 text-sm font-bold" />
            <EditArea value={customer.billingAddress ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, billingAddress: value }))} rows={2} className="mt-2 leading-5" />
            <p className="mt-2 font-semibold">
              GSTIN:{" "}
              <EditText value={customer.gstin ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, gstin: value }))} className="w-40 tracking-wider" />
            </p>
            <p className="mt-1 flex items-center gap-1 text-slate-600">
              <EditText value={customer.email ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, email: value }))} className="min-w-0 flex-1" />
              <span>|</span>
              <EditText value={customer.phone ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, phone: value }))} className="w-28" />
            </p>
            <details className="no-print mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-blue-900">More customer fields</summary>
              <div className="mt-2 grid gap-1">
                {[
                  ["contactName", "Contact name"],
                  ["state", "State"],
                ].map(([key, label]) => (
                  <label key={key} className="grid grid-cols-[110px_1fr] items-center gap-1">
                    <span className="text-[11px] text-slate-500">{label}</span>
                    <EditText value={customer[key] ?? ""} onChange={(value) => setCustomer((prev) => ({ ...prev, [key]: value }))} />
                  </label>
                ))}
              </div>
            </details>
          </div>
        </section>

        <section className="mt-5 grid grid-cols-4 gap-3 text-xs">
          <div className="border border-slate-300 p-3">
            <p className="font-semibold uppercase text-slate-500">Origin</p>
            <EditText value={origin} onChange={setOrigin} className="mt-2 font-semibold" />
          </div>
          <div className="border border-slate-300 p-3">
            <p className="font-semibold uppercase text-slate-500">Destination</p>
            <EditText value={destination} onChange={setDestination} className="mt-2 font-semibold" />
          </div>
          <div className="border border-slate-300 p-3">
            <p className="font-semibold uppercase text-slate-500">Currency</p>
            <EditText value={currency} onChange={setCurrency} className="mt-2 font-semibold" />
          </div>
          <div className="border border-slate-300 p-3">
            <p className="font-semibold uppercase text-slate-500">Boxes</p>
            <p className="mt-2 font-semibold">{parcels.length}</p>
          </div>
        </section>

        <details className="no-print mt-3 text-xs">
          <summary className="cursor-pointer font-semibold text-blue-900">More shipment fields</summary>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {(
              [
                [consigneeName, setConsigneeName, "Consignee name"],
                [customerReference, setCustomerReference, "Customer reference"],
                [sourceInvoiceNumber, setSourceInvoiceNumber, "Source invoice no."],
                [serviceType, setServiceType, "Service type"],
                [serviceCode, setServiceCode, "Service code"],
              ] as Array<[string, (value: string) => void, string]>
            ).map(([val, set, label]) => (
              <label key={label} className="grid grid-cols-[140px_1fr] items-center gap-1">
                <span className="text-[11px] text-slate-500">{label}</span>
                <EditText value={val} onChange={set} />
              </label>
            ))}
          </div>
        </details>

        <section className="mt-5 overflow-hidden border border-slate-950">
          <div className="grid grid-cols-[1.8fr_repeat(5,1fr)] bg-slate-100 text-center text-[10px] font-bold uppercase text-slate-700">
            <div className="border-r border-slate-950 px-3 py-2">Description</div>
            <div className="border-r border-slate-950 px-2 py-2">Actual KG</div>
            <div className="border-r border-slate-950 px-2 py-2">Volumetric KG</div>
            <div className="border-r border-slate-950 px-2 py-2">Chargeable KG</div>
            <div className="border-r border-slate-950 px-2 py-2">Rate / KG</div>
            <div className="px-3 py-2">Amount</div>
          </div>
          {parcels.map((parcel, index) => (
            <div key={parcel.sequence} className="border-t border-slate-950">
              <div className="flex items-center justify-center gap-1 bg-white px-3 py-2 text-center text-[11px] font-bold uppercase">
                <span>Box {parcel.sequence} | Dimensions(CM):</span>
                <EditNum value={parcel.len} onChange={(value) => patchParcel(index, { len: value })} className="w-14 text-center" placeholder="L" />
                <span>x</span>
                <EditNum value={parcel.wid} onChange={(value) => patchParcel(index, { wid: value })} className="w-14 text-center" placeholder="W" />
                <span>x</span>
                <EditNum value={parcel.hei} onChange={(value) => patchParcel(index, { hei: value })} className="w-14 text-center" placeholder="H" />
                <button
                  type="button"
                  title={`Remove Box ${parcel.sequence}`}
                  onClick={() => setParcels((prev) => prev.filter((_, i) => i !== index))}
                  className="no-print ml-2 rounded border border-slate-300 px-1.5 text-xs font-bold text-red-700 hover:border-red-500"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-[1.8fr_repeat(5,1fr)] border-t border-slate-950 text-center text-[11px]">
                <div className="border-r border-slate-950 px-3 py-3 font-semibold uppercase">
                  <EditText value={parcel.description} onChange={(value) => patchParcel(index, { description: value })} align="center" />
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  <EditNum value={parcel.actual} onChange={(value) => patchParcel(index, { actual: value })} className="text-center" />
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  <EditNum value={parcel.volumetric} onChange={(value) => patchParcel(index, { volumetric: value })} className="text-center" />
                </div>
                <div className="border-r border-slate-950 px-2 py-3 font-semibold">
                  <EditNum value={parcel.chargeable} onChange={(value) => patchParcel(index, { chargeable: value })} className="text-center font-semibold" />
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  <EditNum value={parcel.rate} onChange={(value) => patchParcel(index, { rate: value })} className="text-center" placeholder="—" />
                </div>
                <div className="px-3 py-3 font-semibold">
                  <EditNum value={parcel.amount} onChange={(value) => patchParcel(index, { amount: value })} className="text-center font-semibold" />
                </div>
              </div>
            </div>
          ))}
          {parcels.length === 0 ? (
            <p className="border-t border-slate-950 px-3 py-3 text-center text-[11px] text-slate-500">No boxes — use “Add box” below.</p>
          ) : null}
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid grid-cols-[1.8fr_repeat(5,1fr)] border-t border-slate-950 text-center text-[11px]"
            >
              <div className="flex items-center gap-1 border-r border-slate-950 px-3 py-3 text-left font-bold uppercase">
                <EditText
                  value={line.label}
                  onChange={(value) => setLines((prev) => prev.map((entry, i) => (i === index ? { ...entry, label: value } : entry)))}
                  placeholder="Charge label"
                />
                <select
                  value={line.kind}
                  title="Charge or discount"
                  onChange={(event) =>
                    setLines((prev) =>
                      prev.map((entry, i) => (i === index ? { ...entry, kind: event.target.value as LineDraft["kind"] } : entry)),
                    )
                  }
                  className="no-print shrink-0 rounded border border-slate-300 bg-white text-[10px] font-semibold normal-case"
                >
                  <option value="CHARGE">+ Charge</option>
                  <option value="DEDUCTION">− Deduction</option>
                </select>
                <button
                  type="button"
                  title="Remove charge"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  className="no-print shrink-0 rounded border border-slate-300 px-1.5 text-xs font-bold text-red-700 hover:border-red-500"
                >
                  ×
                </button>
              </div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="px-3 py-3 font-semibold">
                <span>{line.kind === "DEDUCTION" ? "-" : ""}</span>
                <EditNum
                  value={line.amount}
                  onChange={(value) => setLines((prev) => prev.map((entry, i) => (i === index ? { ...entry, amount: value } : entry)))}
                  className="inline-block w-20 text-center font-semibold"
                />
              </div>
            </div>
          ))}
        </section>

        <div className="no-print mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              setParcels((prev) => [
                ...prev,
                {
                  sequence: (prev.length ? Math.max(...prev.map((parcel) => parcel.sequence)) : 0) + 1,
                  description: "",
                  actual: "",
                  volumetric: "",
                  chargeable: "",
                  rate: "",
                  amount: "",
                  len: "",
                  wid: "",
                  hei: "",
                },
              ])
            }
            className="h-9 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:border-slate-500"
          >
            + Add box
          </button>
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, { label: "", amount: "", kind: "CHARGE" }])}
            className="h-9 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:border-slate-500"
          >
            + Add charge
          </button>
          <p className="self-center text-xs font-medium text-slate-500">
            + adds to taxable value; − subtracts a deduction or discount.
          </p>
        </div>

        <section className="grid grid-cols-[1fr_280px] border-x border-b border-slate-950 text-xs">
          <div className="p-4">
            <p className="font-semibold uppercase text-slate-500">Delivery Address</p>
            <EditArea value={deliveryAddress} onChange={setDeliveryAddress} rows={3} className="mt-2 leading-5" />
          </div>
          <div className="border-l border-slate-950">
            <div className="flex items-center justify-between gap-3 border-b border-slate-300 px-4 py-3">
              <span>Taxable Value</span>
              <EditNum value={taxable} onChange={setTaxable} className="w-24 text-right font-semibold" />
            </div>
            <div className="flex items-center justify-between gap-2 border-b border-slate-300 px-4 py-2 text-[11px]">
              <span className="flex items-center gap-1">
                GST
                <EditNum value={gstRate} onChange={setGstRate} className="w-12 text-right" />
                %
              </span>
              <select
                value={taxType}
                onChange={(event) => setTaxType(event.target.value as "CGST_SGST" | "IGST")}
                className="rounded border border-transparent bg-transparent text-[11px] font-semibold outline-none hover:border-blue-300 focus:border-blue-600"
              >
                <option value="CGST_SGST">CGST+SGST</option>
                <option value="IGST">IGST</option>
              </select>
            </div>
            {taxType === "CGST_SGST" ? (
              <>
                <div className="flex justify-between gap-3 border-b border-slate-300 px-4 py-3">
                  <span>{noGst ? "CGST" : `CGST ${parseNum(gstRate) / 2}%`}</span>
                  <span>{noGst ? "-" : safeMoney(totals.cgst, currency || "INR")}</span>
                </div>
                <div className="flex justify-between gap-3 border-b border-slate-300 px-4 py-3">
                  <span>{noGst ? "SGST" : `SGST ${parseNum(gstRate) / 2}%`}</span>
                  <span>{noGst ? "-" : safeMoney(totals.sgst, currency || "INR")}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between gap-3 border-b border-slate-300 px-4 py-3">
                <span>{noGst ? "IGST" : `IGST ${gstRate}%`}</span>
                <span>{noGst ? "-" : safeMoney(totals.igst, currency || "INR")}</span>
              </div>
            )}
            <div className="flex justify-between gap-3 bg-slate-100 px-4 py-3 text-sm font-bold">
              <span>Total Chargeable</span>
              <span>{safeMoney(totals.totalMinor, currency || "INR")}</span>
            </div>
            <button
              type="button"
              onClick={recalcFromRows}
              title="Sum box amounts plus other charges into the taxable value"
              className="no-print w-full border-t border-slate-300 px-4 py-2 text-[11px] font-semibold text-blue-900 hover:bg-blue-50"
            >
              Recalculate taxable from rows
            </button>
          </div>
        </section>

        <footer className="mt-8 flex items-end justify-between border-t border-slate-300 pt-5 text-xs">
          <div className="max-w-sm">
            <p className="font-semibold">Declaration</p>
            <p className="mt-2 leading-5 text-slate-600">
              We declare that this invoice records the shipment charges and applicable taxes shown above.
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold">For Swiftline Cargo and Express Logistics Pvt. Ltd.</p>
            <p className="mt-10 border-t border-slate-500 pt-2">Authorised Signatory</p>
          </div>
        </footer>
        <p className="mt-8 border-t border-slate-300 pt-3 text-center text-[10px] font-semibold text-slate-500">
          This is a computer generated invoice from Swiftline Portal.
        </p>
      </article>

      <div className="no-print mx-auto mt-4 flex max-w-[210mm] flex-wrap justify-end gap-2 pb-6">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="h-10 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {saving ? "Saving..." : "Save revised copy"}
        </button>
      </div>

      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 10mm;
        }
        @media print {
          body.printing-revised {
            background: white !important;
          }
          body.printing-revised .no-print {
            display: none !important;
          }
          /* Print only the invoice paper: hide the host page behind the modal
             and the modal backdrop, then lay the paper out as a plain sheet. */
          body.printing-revised * {
            visibility: hidden;
          }
          body.printing-revised .revised-paper,
          body.printing-revised .revised-paper * {
            visibility: visible;
          }
          body.printing-revised .revised-copy-editor {
            position: absolute !important;
            inset: 0 !important;
            overflow: visible !important;
            background: white !important;
            padding: 0 !important;
          }
          body.printing-revised .revised-paper {
            box-shadow: none !important;
            width: 190mm;
            margin: 0 auto;
          }
          body.printing-revised .revised-paper textarea {
            field-sizing: content;
          }
        }
      `}</style>
    </div>
  );
}

const editCls =
  "w-full min-w-0 rounded border border-transparent bg-transparent px-1 -mx-1 outline-none hover:border-blue-300 focus:border-blue-600 focus:bg-blue-50/40";

/** Inline-editable single-line value that looks like plain document text. */
function EditText({
  value,
  onChange,
  align = "left",
  className = "",
  placeholder = "",
}: {
  value: string;
  onChange: (value: string) => void;
  align?: "left" | "center" | "right";
  className?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${editCls} ${align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"} ${className}`}
    />
  );
}

/**
 * Inline-editable numeric value kept as a raw string, so it can be cleared
 * and retyped freely — never coercing "" back to 0 mid-edit.
 */
function EditNum({
  value,
  onChange,
  className = "",
  placeholder = "",
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => {
        // Allow an in-progress number: digits, one dot, one leading minus.
        if (/^-?\d*\.?\d*$/.test(event.target.value)) onChange(event.target.value);
      }}
      className={`${editCls} ${className}`}
    />
  );
}

/** Inline-editable multi-line value for addresses. */
function EditArea({
  value,
  onChange,
  rows = 2,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={`${editCls} resize-y ${className}`}
    />
  );
}
