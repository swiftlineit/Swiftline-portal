"use client";

import { useMemo, useState } from "react";
import {
  getShipmentLevelInvoiceLines,
  type ShipmentInvoice,
  type ShipmentInvoiceParcel,
} from "@/lib/shipmentInvoices";
import type { ShipmentChargeLine } from "@/lib/shipmentCostEstimate";

type WorkingLine = { code: string; label: string; kind: "CHARGE" | "DEDUCTION"; amountMajor: string };

function toMajor(minor: number) {
  return (minor / 100).toFixed(2);
}

function toMinor(major: string | number) {
  const value = typeof major === "string" ? Number(major) : major;
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function num(value: string | number, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitTax(taxableMinor: number, gstRatePercent: number, taxType: "CGST_SGST" | "IGST") {
  const taxMinor = Math.round((taxableMinor * gstRatePercent) / 100);
  if (taxType === "CGST_SGST") {
    const cgst = Math.floor(taxMinor / 2);
    return { cgst, sgst: taxMinor - cgst, igst: 0, taxMinor };
  }
  return { cgst: 0, sgst: 0, igst: taxMinor, taxMinor };
}

function toWorkingLines(invoice: ShipmentInvoice): WorkingLine[] {
  return getShipmentLevelInvoiceLines(invoice.pricingSnapshot).map((line) => ({
    code: line.code,
    label: line.label,
    kind: line.kind === "DEDUCTION" ? "DEDUCTION" : "CHARGE",
    amountMajor: (line.amountMinor / 100).toFixed(2),
  }));
}

export default function ShipmentInvoiceRevisedCopyEditor({
  initial,
  copyId,
  onSave,
  onCancel,
}: {
  initial: ShipmentInvoice;
  copyId?: string;
  onSave: (invoice: ShipmentInvoice, copyId?: string) => void;
  onCancel: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(initial.invoiceNumber);
  const [issuedAt, setIssuedAt] = useState(initial.issuedAt.slice(0, 10));
  const [currency, setCurrency] = useState(initial.currency);
  const [sacCode, setSacCode] = useState(initial.sacCode);
  const [description, setDescription] = useState(initial.description);
  const [supplier, setSupplier] = useState({ ...initial.supplier });
  const [customer, setCustomer] = useState({ ...initial.customer });
  const [shipment, setShipment] = useState({ ...initial.shipment });
  const [taxableMajor, setTaxableMajor] = useState(toMajor(initial.taxableValueMinor));
  const [gstRate, setGstRate] = useState(String(initial.gstRatePercent));
  const [taxType, setTaxType] = useState<"CGST_SGST" | "IGST">(initial.taxType);
  const [parcels, setParcels] = useState<ShipmentInvoiceParcel[]>(() =>
    JSON.parse(JSON.stringify(initial.shipment.parcels ?? [])) as ShipmentInvoiceParcel[],
  );
  const [lines, setLines] = useState<WorkingLine[]>(() => toWorkingLines(initial));
  const [error, setError] = useState("");

  const preview = useMemo(() => {
    const taxableMinor = toMinor(taxableMajor);
    const split = splitTax(taxableMinor, num(gstRate), taxType);
    return { taxableMinor, ...split, totalMinor: taxableMinor + split.taxMinor };
  }, [taxableMajor, gstRate, taxType]);

  function setParty(
    kind: "supplier" | "customer" | "shipment",
    key: string,
    value: string,
  ) {
    if (kind === "supplier") setSupplier((prev) => ({ ...prev, [key]: value }));
    else if (kind === "customer") setCustomer((prev) => ({ ...prev, [key]: value }));
    else setShipment((prev) => ({ ...prev, [key]: value }));
  }

  function updateParcel(index: number, patch: Partial<ShipmentInvoiceParcel>) {
    setParcels((prev) => prev.map((parcel, i) => (i === index ? { ...parcel, ...patch } : parcel)));
  }

  function recalcFromBoxes() {
    const boxesTotal = parcels.reduce((sum, parcel) => sum + num(parcel.baseAmount), 0);
    const linesTotal = lines.reduce(
      (sum, line) => sum + (line.kind === "DEDUCTION" ? -num(line.amountMajor) : num(line.amountMajor)),
      0,
    );
    setTaxableMajor((boxesTotal + linesTotal).toFixed(2));
  }

  function handleSave() {
    if (!invoiceNumber.trim()) {
      setError("Invoice number is required on the revised document.");
      return;
    }
    const taxableMinor = toMinor(taxableMajor);
    const rate = num(gstRate);
    if (taxableMinor < 0 || rate < 0) {
      setError("Taxable value and GST rate must be zero or more.");
      return;
    }
    const split = splitTax(taxableMinor, rate, taxType);

    // Rebuild pricing lines: keep original FREIGHT/GST entries untouched,
    // replace only the shipment-level rows the editor shows.
    const originalLines = initial.pricingSnapshot?.lines ?? [];
    const kept = originalLines.filter((line) => line.code === "FREIGHT" || line.code === "GST");
    const edited: ShipmentChargeLine[] = lines
      .filter((line) => line.label.trim())
      .map((line, index) => ({
        code: (line.code.trim() || `CHARGE_${index + 1}`) as ShipmentChargeLine["code"],
        label: line.label.trim(),
        kind: line.kind === "DEDUCTION" ? ("DEDUCTION" as const) : ("CHARGE" as const),
        amount: num(line.amountMajor),
        amountMinor: toMinor(line.amountMajor),
        basis: "Edited on the revised document copy",
      }));

    const next: ShipmentInvoice = {
      ...initial,
      invoiceNumber: invoiceNumber.trim(),
      issuedAt: issuedAt ? new Date(`${issuedAt}T00:00:00`).toISOString() : initial.issuedAt,
      currency: currency.trim() || initial.currency,
      supplier: { ...supplier },
      customer: { ...customer },
      // Tracking number stays locked: the revised copy must still point at the
      // same shipment, so the original reference is always kept.
      shipment: {
        ...shipment,
        parcels,
        parcelCount: parcels.length,
        shipmentReference: String(initial.shipment.shipmentReference ?? ""),
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
    onSave(next, copyId);
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-4">
      <div className="mx-auto max-w-4xl rounded-2xl bg-white shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-950">Edit as revised copy</h2>
            <p className="mt-1 text-xs font-medium text-slate-500">
              Document only — the real invoice in the database is never changed. Logo and tracking number stay locked.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="h-10 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Save revised copy
            </button>
          </div>
        </div>

        {error ? (
          <p className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">{error}</p>
        ) : null}

        <div className="space-y-6 px-5 py-5">
          <Section title="Invoice header">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Invoice No.">
                <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Date">
                <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Currency">
                <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Tracking No. (locked)">
                <input value={String(initial.shipment.shipmentReference ?? "")} disabled className={`${inputCls} bg-slate-100 text-slate-500`} />
              </Field>
              <Field label="SAC Code">
                <input value={sacCode} onChange={(e) => setSacCode(e.target.value)} className={inputCls} />
              </Field>
              <div className="sm:col-span-3">
                <Field label="Description">
                  <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
                </Field>
              </div>
            </div>
          </Section>

          <Section title="Supplier / Shipper Branch">
            <PartyFields
              record={supplier}
              fields={[
                ["legalName", "Legal name"],
                ["branchName", "Branch name"],
                ["branchCode", "Branch code"],
                ["gstin", "GSTIN"],
                ["state", "State"],
                ["address", "Address"],
                ["email", "Email"],
                ["phone", "Phone"],
              ]}
              onChange={(key, value) => setParty("supplier", key, value)}
            />
          </Section>

          <Section title="Bill To / Customer">
            <PartyFields
              record={customer}
              fields={[
                ["companyName", "Company name"],
                ["contactName", "Contact name"],
                ["gstin", "GSTIN"],
                ["state", "State"],
                ["billingAddress", "Billing address"],
                ["email", "Email"],
                ["phone", "Phone"],
              ]}
              onChange={(key, value) => setParty("customer", key, value)}
            />
          </Section>

          <Section title="Shipment">
            <PartyFields
              record={shipment}
              exclude={["shipmentReference", "parcels", "parcelNumbers", "parcelCount"]}
              fields={[
                ["origin", "Origin"],
                ["destination", "Destination"],
                ["deliveryAddress", "Delivery address"],
                ["consigneeName", "Consignee name"],
                ["customerReference", "Customer reference"],
                ["sourceInvoiceNumber", "Source invoice no."],
                ["serviceType", "Service type"],
                ["serviceCode", "Service code"],
              ]}
              onChange={(key, value) => setParty("shipment", key, value)}
            />
          </Section>

          <Section title="Boxes (freight rows)">
            <div className="space-y-3">
              {parcels.map((parcel, index) => (
                <div key={parcel.sequence} className="rounded-xl border border-slate-200 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Box {parcel.sequence}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-4">
                    <Field label="Description">
                      <input
                        value={parcel.contentsDescription}
                        onChange={(e) => updateParcel(index, { contentsDescription: e.target.value })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Actual KG">
                      <input
                        type="number" step="0.001" value={parcel.actualWeightKg}
                        onChange={(e) => updateParcel(index, { actualWeightKg: num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Volumetric KG">
                      <input
                        type="number" step="0.001" value={parcel.volumetricWeightKg}
                        onChange={(e) => updateParcel(index, { volumetricWeightKg: num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Chargeable KG">
                      <input
                        type="number" step="0.001" value={parcel.chargeableWeightKg}
                        onChange={(e) => updateParcel(index, { chargeableWeightKg: num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Rate / KG">
                      <input
                        type="number" step="0.01" value={parcel.chargesPerKg ?? ""}
                        onChange={(e) => updateParcel(index, { chargesPerKg: e.target.value === "" ? null : num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Amount">
                      <input
                        type="number" step="0.01" value={parcel.baseAmount}
                        onChange={(e) => updateParcel(index, { baseAmount: num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="L (cm)">
                      <input
                        type="number" step="0.01" value={parcel.lengthCm ?? ""}
                        onChange={(e) => updateParcel(index, { lengthCm: e.target.value === "" ? null : num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="W (cm)">
                      <input
                        type="number" step="0.01" value={parcel.widthCm ?? ""}
                        onChange={(e) => updateParcel(index, { widthCm: e.target.value === "" ? null : num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="H (cm)">
                      <input
                        type="number" step="0.01" value={parcel.heightCm ?? ""}
                        onChange={(e) => updateParcel(index, { heightCm: e.target.value === "" ? null : num(e.target.value) })}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                </div>
              ))}
              {parcels.length === 0 ? <p className="text-sm text-slate-500">No boxes on this invoice.</p> : null}
            </div>
          </Section>

          <Section title="Other charges">
            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_140px_130px_auto]">
                  <input
                    value={line.label} placeholder="Charge label"
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))}
                    className={inputCls}
                  />
                  <input
                    type="number" step="0.01" value={line.amountMajor} placeholder="Amount"
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (i === index ? { ...l, amountMajor: e.target.value } : l)))}
                    className={inputCls}
                  />
                  <select
                    value={line.kind}
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (i === index ? { ...l, kind: e.target.value as WorkingLine["kind"] } : l)))}
                    className={inputCls}
                  >
                    <option value="CHARGE">Charge</option>
                    <option value="DEDUCTION">Discount</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                    className="h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-red-700 hover:border-red-500"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setLines((prev) => [...prev, { code: "", label: "", kind: "CHARGE", amountMajor: "0" }])}
                className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
              >
                + Add charge
              </button>
            </div>
          </Section>

          <Section title="Tax totals">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Taxable value">
                <input type="number" step="0.01" value={taxableMajor} onChange={(e) => setTaxableMajor(e.target.value)} className={inputCls} />
              </Field>
              <Field label="GST rate %">
                <input type="number" step="0.01" value={gstRate} onChange={(e) => setGstRate(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Tax type">
                <select value={taxType} onChange={(e) => setTaxType(e.target.value as "CGST_SGST" | "IGST")} className={inputCls}>
                  <option value="CGST_SGST">CGST + SGST</option>
                  <option value="IGST">IGST</option>
                </select>
              </Field>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={recalcFromBoxes}
                  title="Sum box amounts plus other charges into the taxable value"
                  className="h-10 w-full rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900"
                >
                  Recalc from boxes
                </button>
              </div>
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-700">
              Total: {new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR" }).format(preview.totalMinor / 100)}{" "}
              <span className="font-normal text-slate-500">
                (Taxable {toMajor(preview.taxableMinor)} + GST {toMajor(preview.taxMinor)})
              </span>
            </p>
          </Section>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="h-10 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800"
          >
            Save revised copy
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 focus:border-blue-900 focus:outline-none disabled:bg-slate-100";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 p-4">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function PartyFields({
  record,
  fields,
  exclude,
  onChange,
}: {
  record: Record<string, unknown>;
  fields: Array<[string, string]>;
  exclude?: string[];
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields
        .filter(([key]) => !exclude?.includes(key))
        .map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              value={typeof record[key] === "string" ? (record[key] as string) : String(record[key] ?? "")}
              onChange={(e) => onChange(key, e.target.value)}
              className={inputCls}
            />
          </Field>
        ))}
    </div>
  );
}
