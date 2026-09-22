"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { FiDownload, FiEdit2, FiPrinter } from "react-icons/fi";
import {
  downloadShipmentInvoicePdf,
  getShipmentInvoice,
  getShipmentLevelInvoiceLines,
  ShipmentInvoice,
  ShipmentInvoiceAudience,
  ShipmentInvoiceParcel,
  shipmentInvoiceParcelDescription,
} from "@/lib/shipmentInvoices";
import { apiUrl } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import {
  getRevisedCopy,
  saveRevisedCopy,
} from "@/lib/shipmentInvoiceRevisedCopies";
import ShipmentInvoiceRevisedCopyEditor from "@/components/shipments/ShipmentInvoiceRevisedCopyEditor";

function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
    .format(new Date(value))
    .replaceAll("/", "-");
}

function value(record: Record<string, unknown>, key: string) {
  const current = record[key];
  return typeof current === "string" && current.trim()
    ? current
    : "Not provided";
}

/** Blank rather than "Not provided", for fields a party may legitimately lack. */
function optionalValue(record: Record<string, unknown>, key: string) {
  const current = record[key];
  return typeof current === "string" && current.trim() ? current : "";
}

export default function ShipmentInvoicePage({
  draftId,
  audience,
}: {
  draftId: string;
  audience: ShipmentInvoiceAudience;
}) {
  const [invoice, setInvoice] = useState<ShipmentInvoice | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  // Document-only revised copy id from `?revised=`. When set, the page renders
  // the browser-stored edited document instead of the real backend invoice.
  const [revisedId, setRevisedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const revisedParam = searchParams.get("revised");
        if (revisedParam) {
          const copy = getRevisedCopy(draftId, revisedParam);
          if (!copy) {
            setError("This revised copy was created on another device or browser and is not available here. The real invoice is unchanged.");
            return;
          }
          setRevisedId(copy.id);
          setInvoice(copy.invoice);
          return;
        }
        const revisionValue = searchParams.get("revision");
        const requestedRevision =
          revisionValue && /^\d+$/.test(revisionValue)
            ? Number(revisionValue)
            : undefined;
        const result = await getShipmentInvoice(
          draftId,
          audience,
          requestedRevision,
        );
        setInvoice(result);
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load shipment invoice.",
        );
      }
    }
    void load();
  }, [audience, draftId]);

  // Only admin / operations may edit, and only into a document-only copy.
  // Clients and other roles keep a read-only invoice.
  useEffect(() => {
    if (audience !== "admin") return;
    async function checkRole() {
      try {
        const token = getAccessToken();
        if (!token) return;
        const response = await fetch(apiUrl("/api/v1/auth/me"), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => null);
        const role = data?.user?.role as string | undefined;
        if (role === "admin" || role === "operations") setCanEdit(true);
      } catch {
        // Read-only fallback: the invoice still renders.
      }
    }
    void checkRole();
  }, [audience]);

  async function downloadPdf() {
    if (!invoice) return;
    // A revised copy exists only in this browser, so it prints via the
    // browser instead of the server PDF. The real invoice keeps its download.
    if (revisedId) {
      window.print();
      return;
    }
    setDownloading(true);
    setError("");
    try {
      await downloadShipmentInvoicePdf(
        draftId,
        audience,
        invoice.invoiceNumber,
        invoice.revision,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to download shipment invoice PDF.",
      );
    } finally {
      setDownloading(false);
    }
  }

  if (error && !invoice)
    return (
      <main className="mx-auto mt-12 max-w-3xl border border-red-200 bg-red-50 p-5 text-sm font-semibold text-red-700">
        {error}
      </main>
    );
  if (!invoice)
    return (
      <main className="mx-auto mt-12 max-w-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500">
        Loading shipment invoice...
      </main>
    );

  const parcels = invoice.shipment.parcels ?? [];
  // Every charge that is not per-box freight and is not the tax itself. Freight is
  // already itemised per box above, and GST is totalled opposite, so listing them
  // again here would double them.
  //
  // Invoices raised before route charges existed carry no `lines`, so their flat
  // CSB-V clearance charge is reconstructed from the stored amount and they print
  // exactly as they always did.
  const shipmentLevelLines = getShipmentLevelInvoiceLines(invoice.pricingSnapshot);
  const showDraftStatus = invoice.status === "DRAFT";
  const noGst = invoice.taxTreatment === "NO_GST" || invoice.gstRatePercent === 0;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 print:bg-white print:p-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-600">
          {invoice.invoiceNumber} | Invoice {invoice.revision} of{" "}
          {invoice.versions.length}
          {revisedId ? <span className="ml-2 text-amber-700">· Revised copy</span> : null}
        </p>
        <div className="flex gap-2">
          {canEdit ? (
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="inline-flex h-10 items-center gap-2 border border-blue-900 bg-white px-4 text-sm font-semibold text-blue-900 hover:bg-blue-50"
            >
              <FiEdit2 aria-hidden="true" />
              {revisedId ? "Edit revised copy" : "Edit as revised copy"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={downloading}
            className="inline-flex h-10 items-center gap-2 bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-400"
          >
            {revisedId ? <FiPrinter aria-hidden="true" /> : <FiDownload aria-hidden="true" />}
            {revisedId ? "Print / Save PDF" : downloading ? "Downloading..." : "Download PDF"}
          </button>
        </div>
      </div>

      {revisedId ? (
        <div className="no-print mx-auto mb-4 max-w-[210mm] border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          Revised copy — document only. The real tax invoice and all records are unchanged.
        </div>
      ) : null}

      {editorOpen ? (
        <div className="no-print">
          <ShipmentInvoiceRevisedCopyEditor
            initial={invoice}
            copyId={revisedId ?? undefined}
            onSave={(edited, copyId) => {
              // Browser storage only: no request, no database write.
              const saved = saveRevisedCopy({
                shipmentDraftId: draftId,
                invoice: edited,
                basedOnRevision: invoice.revision,
                copyId,
              });
              setEditorOpen(false);
              const url = `${window.location.pathname}?revised=${encodeURIComponent(saved.id)}`;
              window.location.href = url;
            }}
            onCancel={() => setEditorOpen(false)}
          />
        </div>
      ) : null}

      {error ? (
        <div className="no-print mx-auto mb-4 max-w-[210mm] border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <article className="invoice-sheet relative mx-auto min-h-[297mm] max-w-[210mm] bg-white p-10 text-slate-950 shadow-sm print:min-h-0 print:max-w-none print:p-0 print:shadow-none">
        {showDraftStatus ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-bold text-red-600 opacity-[0.06] -rotate-45">
            DRAFT
          </div>
        ) : null}
        <header className="relative flex items-start justify-between gap-8 border-b-2 border-slate-950 pb-4">
          <Image
            src="/swiftline-invoice-logo.png"
            alt="Swiftline Cargo and Express Logistics"
            width={180}
            height={120}
            priority
            className="h-[120px] w-[180px] shrink-0 object-contain object-left"
          />
          <div className="min-w-0 pt-3 text-right">
            <h1 className="text-2xl font-bold">
              {noGst
                ? (showDraftStatus ? "DRAFT INVOICE" : "INVOICE")
                : (showDraftStatus ? "DRAFT TAX INVOICE" : "TAX INVOICE")}
            </h1>
            <p className="mt-3 text-xs">
              <strong>Invoice No:</strong> {invoice.invoiceNumber}
            </p>
            {/* <p className="mt-1 text-xs"><strong>Version:</strong> Invoice {invoice.revision}</p> */}
            <p className="mt-1 text-xs">
              <strong>Date:</strong> {date(invoice.issuedAt)}
            </p>
            <p className="mt-1 text-xs">
              <strong>AWB / Tracking No.:</strong>{" "}
              {value(invoice.shipment, "shipmentReference")}
            </p>
            {revisedId ? (
              <p className="mt-2 inline-block border border-amber-500 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-700">
                Revised copy — document only
              </p>
            ) : null}
          </div>
        </header>

        {revisedId ? (
          <p className="relative mt-4 border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            This is an edited document copy for reference. It does not change the real tax invoice or any records.
          </p>
        ) : null}

        {invoice.validationWarnings.length ? (
          <section className="relative mt-4 border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            {invoice.validationWarnings.join(" ")}
          </section>
        ) : null}

        <section className="relative mt-5 grid grid-cols-2 gap-4">
          <Party
            title="Supplier / Shipper Branch"
            name={value(invoice.supplier, "legalName")}
            address={value(invoice.supplier, "address")}
            gstin={optionalValue(invoice.supplier, "gstin")}
            email={value(invoice.supplier, "email")}
            phone={value(invoice.supplier, "phone")}
          />
          <Party
            title="Bill To / Customer"
            name={value(invoice.customer, "companyName")}
            address={value(invoice.customer, "billingAddress")}
            gstin={optionalValue(invoice.customer, "gstin")}
            email={value(invoice.customer, "email")}
            phone={value(invoice.customer, "phone")}
          />
        </section>

        <section className="relative mt-5 grid grid-cols-4 gap-3 text-xs">
          <Meta label="Origin" text={value(invoice.shipment, "origin")} />
          <Meta
            label="Destination"
            text={value(invoice.shipment, "destination")}
          />
          <Meta label="Currency" text={invoice.currency} />
          <Meta label="Boxes" text={String(parcels.length)} />
        </section>

        <section className="relative mt-5 overflow-hidden border border-slate-950">
          <div className="grid grid-cols-[1.8fr_repeat(5,1fr)] bg-slate-100 text-center text-[10px] font-bold uppercase text-slate-700">
            <div className="border-r border-slate-950 px-3 py-2">
              Description
            </div>
            <div className="border-r border-slate-950 px-2 py-2">Actual KG</div>
            <div className="border-r border-slate-950 px-2 py-2">
              Volumetric KG
            </div>
            <div className="border-r border-slate-950 px-2 py-2">
              Chargeable KG
            </div>
            <div className="border-r border-slate-950 px-2 py-2">Rate / KG</div>
            <div className="px-3 py-2">Amount</div>
          </div>
          {parcels.map((parcel) => (
            <div key={parcel.sequence} className="border-t border-slate-950">
              <div className="bg-white px-3 py-2 text-center text-[11px] font-bold uppercase">
                Box {parcel.sequence} | Dimensions(CM): {formatDimensions(parcel)}
              </div>
              <div className="grid grid-cols-[1.8fr_repeat(5,1fr)] border-t border-slate-950 text-center text-[11px]">
                <div className="border-r border-slate-950 px-3 py-3 font-semibold uppercase">
                  {shipmentInvoiceParcelDescription(parcel) || "Shipment goods"}
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  {parcel.actualWeightKg.toFixed(3)}
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  {parcel.volumetricWeightKg.toFixed(3)}
                </div>
                <div className="border-r border-slate-950 px-2 py-3 font-semibold">
                  {parcel.chargeableWeightKg.toFixed(3)}
                </div>
                <div className="border-r border-slate-950 px-2 py-3">
                  {parcel.chargesPerKg === null
                    ? "-"
                    : money(
                        Math.round(parcel.chargesPerKg * 100),
                        invoice.currency,
                      )}
                </div>
                <div className="px-3 py-3 font-semibold">
                  {money(Math.round(parcel.baseAmount * 100), invoice.currency)}
                </div>
              </div>
            </div>
          ))}
          {/* Charges that apply to the whole shipment rather than to one box:
              surcharges, clearance, handling, insurance and any discount. Listed
              below the per-box rows so the rows above plus these always add up to
              the taxable value printed opposite. */}
          {shipmentLevelLines.map((line) => (
            <div
              key={line.code}
              className="grid grid-cols-[1.8fr_repeat(5,1fr)] border-t border-slate-950 text-center text-[11px]"
            >
              <div className="border-r border-slate-950 px-3 py-3 text-left font-bold uppercase">
                {line.label}
              </div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="border-r border-slate-950 px-2 py-3">-</div>
              <div className="px-3 py-3 font-semibold">
                {line.kind === "DEDUCTION" ? "-" : ""}
                {money(line.amountMinor, invoice.currency)}
              </div>
            </div>
          ))}
        </section>

        <section className="relative grid grid-cols-[1fr_280px] border-x border-b border-slate-950 text-xs">
          <div className="p-4">
            <p className="font-semibold uppercase text-slate-500">
              Delivery Address
            </p>
            <p className="mt-2 leading-5">
              {value(invoice.shipment, "deliveryAddress")}
            </p>
          </div>
          <div className="border-l border-slate-950">
            <Total
              label="Taxable Value"
              amount={invoice.taxableValueMinor}
              currency={invoice.currency}
            />
            {invoice.taxType === "CGST_SGST" ? (
                <>
                  <Total
                    label={noGst ? "CGST" : `CGST ${invoice.gstRatePercent / 2}%`}
                    amount={noGst ? null : invoice.cgstAmountMinor}
                    currency={invoice.currency}
                  />
                  <Total
                    label={noGst ? "SGST" : `SGST ${invoice.gstRatePercent / 2}%`}
                    amount={noGst ? null : invoice.sgstAmountMinor}
                    currency={invoice.currency}
                  />
                </>
              ) : (
                <Total
                  label={noGst ? "IGST" : `IGST ${invoice.gstRatePercent}%`}
                  amount={noGst ? null : invoice.igstAmountMinor}
                  currency={invoice.currency}
                />
              )}
            <Total
              label="Total Chargeable"
              amount={invoice.totalAmountMinor}
              currency={invoice.currency}
              strong
            />
          </div>
        </section>

        <footer className="relative mt-8 flex items-end justify-between border-t border-slate-300 pt-5 text-xs">
          <div className="max-w-sm">
            <p className="font-semibold">Declaration</p>
            <p className="mt-2 leading-5 text-slate-600">
              We declare that this invoice records the shipment charges and
              applicable taxes shown above.
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold">
              For Swiftline Cargo and Express Logistics Pvt. Ltd.
            </p>
            <p className="mt-10 border-t border-slate-500 pt-2">
              Authorised Signatory
            </p>
          </div>
        </footer>
        <p className="relative mt-8 border-t border-slate-300 pt-3 text-center text-[10px] font-semibold text-slate-500">
          This is a computer generated invoice from Swiftline Portal.
        </p>
      </article>

      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 10mm;
        }
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            background: white !important;
          }
          .invoice-sheet {
            width: 190mm;
          }
        }
      `}</style>
    </main>
  );
}

function Party({
  title,
  name,
  address,
  gstin,
  email,
  phone,
}: {
  title: string;
  name: string;
  address: string;
  gstin: string;
  email: string;
  phone: string;
}) {
  return (
    <div className="min-h-36 border border-slate-300 p-4 text-xs">
      <p className="font-semibold uppercase text-slate-500">{title}</p>
      <p className="mt-3 text-sm font-bold">{name}</p>
      <p className="mt-2 leading-5">{address}</p>
      <p className="mt-2 font-semibold ">GSTIN: <span className="tracking-wider">{gstin}</span></p>
      <p className="mt-1 text-slate-600">
        {email} | {phone}
      </p>
    </div>
  );
}

function Meta({ label, text }: { label: string; text: string }) {
  return (
    <div className="border border-slate-300 p-3">
      <p className="font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-2 font-semibold">{text}</p>
    </div>
  );
}

function formatDimensions(parcel: ShipmentInvoiceParcel) {
  if (!parcel.lengthCm || !parcel.widthCm || !parcel.heightCm)
    return "Not provided";
  return `${parcel.lengthCm.toFixed(2)} x ${parcel.widthCm.toFixed(2)} x ${parcel.heightCm.toFixed(2)} `;
}

function Total({
  label,
  amount,
  currency,
  strong = false,
}: {
  label: string;
  amount: number | null;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-3 border-b border-slate-300 px-4 py-3 last:border-b-0 ${strong ? "bg-slate-100 text-sm font-bold" : ""}`}
    >
      <span>{label}</span>
      <span>{amount === null ? "-" : money(amount, currency)}</span>
    </div>
  );
}
