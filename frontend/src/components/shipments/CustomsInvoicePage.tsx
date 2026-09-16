"use client";

import { Fragment, useEffect, useState } from "react";
import Image from "next/image";
import { FiDownload, FiFileText } from "react-icons/fi";
import {
  downloadCustomsInvoicePdf,
  downloadCustomsInvoiceWorkbook,
  getCustomsInvoice,
  type CustomsInvoice,
  type CustomsInvoiceAudience,
  type CustomsInvoiceBox,
  type CustomsInvoiceParty
} from "@/lib/customsInvoice";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric"
  }).format(new Date(value)).replaceAll("/", "-");
}

function formatDimensions(parcel: CustomsInvoiceBox) {
  if (!parcel.lengthCm || !parcel.widthCm || !parcel.heightCm) return "NOT PROVIDED";
  return `${parcel.lengthCm.toFixed(2)} * ${parcel.widthCm.toFixed(2)} * ${parcel.heightCm.toFixed(2)}`;
}

/** Party block, matching the shipper / consignee layout on the template. */
function Party({ party }: { party: CustomsInvoiceParty }) {
  return (
    <div className="px-3 py-2 text-[11px] leading-5">
      <p className="font-bold uppercase">{party.name}</p>
      <p><span className="font-bold">COMPANY NAME :</span>{party.companyName}</p>
      {party.address ? <p><span className="font-bold">ADDRESS : </span>{party.address}</p> : null}
      <p><span className="font-bold">{party.countryName}</span>{party.postcode ? `, ${party.postcode}` : ""}</p>
      {party.email ? <p><span className="font-bold">EMAIL </span>{party.email}</p> : null}
      {party.phone ? <p><span className="font-bold">PHONE NUMBER : </span>{party.phone}</p> : null}
    </div>
  );
}

/**
 * On-screen shipment (customs) invoice, laid out like the customer's Excel
 * template. Deliberately has no version/revision line: the document is always
 * regenerated from the current shipment, so an amendment simply shows through.
 */
export default function CustomsInvoicePage({
  draftId,
  audience
}: {
  draftId: string;
  audience: CustomsInvoiceAudience;
}) {
  const [invoice, setInvoice] = useState<CustomsInvoice | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"pdf" | "xlsx" | "">("");

  useEffect(() => {
    async function load() {
      try {
        setInvoice(await getCustomsInvoice(draftId, audience));
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load the shipment invoice.");
      }
    }
    void load();
  }, [audience, draftId]);

  async function handleDownload(format: "pdf" | "xlsx") {
    setBusy(format);
    setError("");
    try {
      await (format === "pdf"
        ? downloadCustomsInvoicePdf(draftId, audience)
        : downloadCustomsInvoiceWorkbook(draftId, audience));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to download the shipment invoice.");
    } finally {
      setBusy("");
    }
  }

  if (error && !invoice) {
    return (
      <main className="mx-auto mt-12 max-w-3xl border border-red-200 bg-red-50 p-5 text-sm font-semibold text-red-700">
        {error}
      </main>
    );
  }
  if (!invoice) {
    return (
      <main className="mx-auto mt-12 max-w-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500">
        Loading shipment invoice...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 print:bg-white print:p-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-600">
          Shipment Invoice | {invoice.invoiceNumber}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleDownload("xlsx")}
            disabled={Boolean(busy)}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:border-slate-300 disabled:text-slate-400"
          >
            <FiFileText aria-hidden="true" />{busy === "xlsx" ? "Downloading..." : "Download Excel"}
          </button>
          <button
            type="button"
            onClick={() => void handleDownload("pdf")}
            disabled={Boolean(busy)}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-400"
          >
            <FiDownload aria-hidden="true" />{busy === "pdf" ? "Downloading..." : "Download PDF"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="no-print mx-auto mb-4 max-w-[210mm] border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <article className="invoice-sheet mx-auto max-w-[210mm] bg-white p-6 text-slate-950 shadow-sm print:max-w-none print:p-0 print:shadow-none">
        <header className="mb-5 flex items-start justify-between gap-8 border-b-2 border-slate-950 pb-4">
          <Image
            src="/swiftline-invoice-logo.png"
            alt="Swiftline Cargo and Express Logistics"
            width={180}
            height={120}
            priority
            className="h-[120px] w-[180px] shrink-0 object-contain object-left"
          />
          <div className="min-w-0 pt-3 text-right text-xs leading-5">
            <h1 className="mb-3 text-2xl font-bold">INVOICE</h1>
            <p><strong>Invoice No:</strong> {invoice.invoiceNumber}</p>
            <p><strong>Date:</strong> {formatDate(invoice.invoiceDate)}</p>
            {invoice.otherReference ? <p className="break-words"><strong>Reference:</strong> {invoice.otherReference}</p> : null}
            {invoice.aadhaarNumber ? <p><strong>Aadhaar Number:</strong> {invoice.aadhaarNumber}</p> : null}
          </div>
        </header>
        <div className="border border-slate-950">
          <div className="grid grid-cols-2 border-b border-slate-950 text-[11px] font-bold">
            <p className="border-r border-slate-950 px-3 py-1">SHIPPER</p>
            <p className="px-3 py-1">CONSIGNEE</p>
          </div>
          <div className="grid grid-cols-2 border-b border-slate-950">
            <div className="border-r border-slate-950"><Party party={invoice.shipper} /></div>
            <Party party={invoice.consignee} />
          </div>

          <div className="grid grid-cols-4 border-b border-slate-950 text-[11px] font-bold">
            <p className="border-r border-slate-950 px-3 py-1">COUNTRY OF ORIGIN</p>
            <p className="border-r border-slate-950 px-3 py-1 text-center">{invoice.countryOfOrigin}</p>
            <p className="border-r border-slate-950 px-3 py-1 text-center">DESTINATION</p>
            <p className="px-3 py-1 text-center">{invoice.destination}</p>
          </div>

          <div className="grid grid-cols-[1fr_3fr] border-b border-slate-950 text-[11px] font-bold">
            <p className="border-r border-slate-950 px-3 py-1">NOTE</p>
            <p className="px-3 py-1 text-center">{invoice.note}</p>
          </div>

          {/* Item table. Wide content scrolls inside its own container so the
              page body never scrolls sideways. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-slate-950 font-bold">
                  <th className="w-12 border-r border-slate-950 px-2 py-2 text-center">SR.<br />NO.</th>
                  <th className="border-r border-slate-950 px-2 py-2 text-center">DESCRIPTION</th>
                  <th className="w-24 border-r border-slate-950 px-2 py-2 text-center">HS CODE</th>
                  <th className="w-20 border-r border-slate-950 px-2 py-2 text-center">UNIT TYPE</th>
                  <th className="w-20 border-r border-slate-950 px-2 py-2 text-center">QUANTITY</th>
                  <th className="w-24 border-r border-slate-950 px-2 py-2 text-center">UNIT RATES</th>
                  <th className="w-24 px-2 py-2 text-center">AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {invoice.boxes.map((parcel) => (
                  <Fragment key={`box-${parcel.boxNumber}`}>
                    <tr className="border-b border-slate-950">
                      <td colSpan={7} className="px-2 py-1.5 text-center font-bold">
                        BOX NO: {parcel.boxNumber}{parcel.parcelNumber ? ` , HAWB:${parcel.parcelNumber}` : ""} , DIMENSIONS (CMS) {formatDimensions(parcel)} , ACTUAL WEIGHT - {parcel.actualWeightKg.toFixed(2)} KG
                      </td>
                    </tr>
                    {parcel.items.map((item) => (
                      <tr key={`box-${parcel.boxNumber}-item-${item.serialNumber}`} className="border-b border-slate-950">
                        <td className="border-r border-slate-950 px-2 py-1.5 text-center">{item.serialNumber}</td>
                        <td className="border-r border-slate-950 px-2 py-1.5">{item.description}</td>
                        <td className="border-r border-slate-950 px-2 py-1.5 text-center">{item.hsCode}</td>
                        <td className="border-r border-slate-950 px-2 py-1.5 text-center">{item.unitType}</td>
                        <td className="border-r border-slate-950 px-2 py-1.5 text-center">{item.quantity}</td>
                        <td className="border-r border-slate-950 px-2 py-1.5 text-center">{item.unitRate.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-center">{item.amount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-[1.2fr_2.4fr_1.4fr] border-b border-t border-slate-950 text-[11px] font-bold">
            <p className="border-r border-slate-950 px-3 py-2">AMOUNT CHARGEABLE</p>
            <p className="border-r border-slate-950 px-3 py-2">{invoice.totalAmountInWords}</p>
            <p className="px-3 py-2 text-right">TOTAL: {invoice.totalAmount.toFixed(2)} {invoice.currency}</p>
          </div>

          <div className="grid grid-cols-2 border-b border-slate-950 text-[11px] font-bold">
            <p className="border-r border-slate-950 px-3 py-1">NOTES</p>
            <p className="px-3 py-1">SIGNATURE / STAMP</p>
          </div>
          <div className="grid min-h-20 grid-cols-2 text-[11px]">
            <p className="border-r border-slate-950 px-3 py-2 font-bold">{invoice.note}</p>
            <p className="flex items-end justify-end px-3 py-2 text-slate-600">
              For Swiftline Cargo and Express Logistics Pvt. Ltd.
            </p>
          </div>
        </div>
      </article>

      <style jsx global>{`
        @page { size: A4 portrait; margin: 10mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .invoice-sheet { width: 190mm; }
        }
      `}</style>
    </main>
  );
}
