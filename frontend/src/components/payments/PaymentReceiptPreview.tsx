"use client";
import type { ReactNode } from "react";
import { FiDownload, FiPrinter, FiX } from "react-icons/fi";
import type { ClientShellUser } from "@/components/client/ClientDashboardShell";
import type { ClientDashboardAccount, ClientPrepaidTopUp } from "@/lib/clientDashboard";
import { formatDashboardDate } from "@/lib/dateFormat";
export type PaymentInvoiceDetails = {
  invoiceNumber: string;
  issuedAt: string;
  companyName: string;
  accountId: string;
  billingAddress: string;
  contactName: string;
  contactEmail: string;
  paymentReference: string;
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  purpose: "CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT";
  status: string;
};

export function formatMinorMoney(amountMinor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(amountMinor / 100);
}

export function createIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatInvoiceDate(value?: string) {
  return formatDashboardDate(value);
}

function buildBillingAddress(account: ClientDashboardAccount["account"]) {
  return [
    account.company.registeredAddress,
    account.company.city,
    account.company.stateOrProvince,
    account.company.postalCode,
    account.company.addressCountry
  ].filter(Boolean).join(", ") || "Not available";
}

export function buildPaymentInvoice(
  topUp: ClientPrepaidTopUp,
  account: ClientDashboardAccount["account"],
  user: ClientShellUser
): PaymentInvoiceDetails {
  const contactName = [account.contact.firstName, account.contact.lastName].filter(Boolean).join(" ") || user.name || "Client";

  return {
    invoiceNumber: `INV-${topUp.internalReference}`,
    issuedAt: topUp.updatedAt || topUp.createdAt || new Date().toISOString(),
    companyName: account.company.companyName || account.accountId,
    accountId: account.accountId,
    billingAddress: buildBillingAddress(account),
    contactName,
    contactEmail: account.contact.email || user.email || "Not available",
    paymentReference: topUp.internalReference,
    orderId: topUp.razorpayOrderId,
    paymentId: topUp.razorpayPaymentId || "Not available",
    amountMinor: topUp.amountMinor,
    currency: topUp.currency,
    purpose: topUp.purpose,
    status: topUp.status
  };
}

function renderPaymentInvoiceHtml(invoice: PaymentInvoiceDetails, logoUrl: string) {
  const safe = (value: string) => escapeHtml(value);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe(invoice.invoiceNumber)}</title>
  <style>
    @font-face {
      font-family: "IBM Plex Sans";
      src: url("/fonts/ibm-plex-sans/IBMPlexSans[wdth,wght].ttf") format("truetype");
      font-weight: 100 700;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "IBM Plex Sans";
      src: url("/fonts/ibm-plex-sans/IBMPlexSans-Italic[wdth,wght].ttf") format("truetype");
      font-weight: 100 700;
      font-style: italic;
      font-display: swap;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: "IBM Plex Sans", Arial, Helvetica, sans-serif; }
    .page { width: min(860px, 100%); margin: 0 auto; background: #fff; padding: 40px; }
    .top { display: flex; min-height: 126px; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0f172a; padding-bottom: 16px; }
    .brand { display: flex; width: 180px; height: 120px; align-items: flex-start; justify-content: flex-start; }
    .brand img { display: block; width: 180px; height: 120px; object-fit: contain; object-position: left top; }
    .meta { display: flex; max-width: 300px; padding-top: 14px; flex-direction: column; align-items: flex-end; text-align: right; font-size: 11px; line-height: 1.75; }
    .invoice-title { margin: 0 0 12px; font-size: 24px; line-height: 1.1; }
    .meta strong { display: block; max-width: 240px; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 28px; }
    .box { border: 1px solid #e2e8f0; padding: 18px; min-height: 132px; }
    .label { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 14px; line-height: 1.6; }
    table { width: 100%; margin-top: 28px; border-collapse: collapse; }
    th { background: #0f172a; color: #fff; padding: 13px; text-align: left; font-size: 12px; text-transform: uppercase; }
    td { border: 1px solid #e2e8f0; padding: 14px 13px; font-size: 14px; vertical-align: top; }
    .right { text-align: right; }
    .total { margin-left: auto; margin-top: 20px; width: min(340px, 100%); border: 1px solid #0f172a; }
    .total-row { display: flex; justify-content: space-between; gap: 16px; padding: 14px 16px; font-size: 14px; }
    .total-row.final { background: #0f172a; color: #fff; font-size: 18px; font-weight: 700; }
    .note { margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 12px; line-height: 1.7; color: #64748b; }
    @media print { body { background: #fff; } .page { width: 100%; padding: 24px; } }
    @media (max-width: 680px) { .page { padding: 24px; } .top { display: block; } .grid { display: block; } .brand { max-width: 100%; } .brand img { max-width: 100%; } .meta { align-items: flex-start; margin-top: 14px; padding-top: 0; text-align: left; } .box + .box { margin-top: 16px; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="top">
      <div>
        <div class="brand">
          <img src="${safe(logoUrl)}" alt="Swiftline" />
        </div>
      </div>
      <div class="meta">
        <h1 class="invoice-title">PAYMENT RECEIPT</h1>
        <strong>${safe(invoice.invoiceNumber)}</strong><br />
        Issued: ${safe(formatInvoiceDate(invoice.issuedAt))}<br />
        Account: ${safe(invoice.accountId)}
      </div>
    </section>

    <section class="grid">
      <div class="box">
        <div class="label">Billed To</div>
        <div class="value">
          <strong>${safe(invoice.companyName)}</strong><br />
          ${safe(invoice.contactName)}<br />
          ${safe(invoice.contactEmail)}<br />
          ${safe(invoice.billingAddress)}
        </div>
      </div>
      <div class="box">
        <div class="label">Payment Details</div>
        <div class="value">
          Reference: ${safe(invoice.paymentReference)}<br />
          Razorpay Order: ${safe(invoice.orderId)}<br />
          Razorpay Payment: ${safe(invoice.paymentId)}
        </div>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${invoice.purpose === "SECURITY_DEPOSIT" ? "Historical security deposit payment recorded in Swiftline Portal." : "Prepaid wallet top-up received after successful payment capture."}</td>
          <td class="right">${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</td>
        </tr>
      </tbody>
    </table>

    <section class="total">
      <div class="total-row"><span>Subtotal</span><strong>${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</strong></div>
      <div class="total-row final"><span>Total Paid</span><span>${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</span></div>
    </section>

    <p class="note">${invoice.purpose === "SECURITY_DEPOSIT" ? "This receipt preserves the historical security deposit payment record in Swiftline Portal." : "This receipt confirms the prepaid wallet top-up recorded after successful Razorpay payment capture."}</p>
  </main>
</body>
</html>`;
}

function printPaymentInvoice(invoice: PaymentInvoiceDetails) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return;

  printWindow.document.write(renderPaymentInvoiceHtml(invoice, `${window.location.origin}/swiftline-invoice-logo.png`));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 500);
}

function downloadPaymentInvoice(invoice: PaymentInvoiceDetails) {
  const blob = new Blob([renderPaymentInvoiceHtml(invoice, `${window.location.origin}/swiftline-invoice-logo.png`)], {
    type: "text/html;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${invoice.invoiceNumber}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function InvoiceActionButton({
  label,
  icon,
  onClick
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center justify-center rounded-4xl gap-1.5 border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900"
    >
      {icon}
      {label}
    </button>
  );
}

export default function PaymentInvoicePreview({ invoice, onClose }: { invoice: PaymentInvoiceDetails; onClose: () => void }) {
  const html = renderPaymentInvoiceHtml(invoice, "/swiftline-invoice-logo.png");

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 px-4 py-6">
      <div className="mx-auto flex h-full max-w-5xl flex-col bg-white shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">{invoice.invoiceNumber}</p>
            <p className="text-xs font-medium text-slate-500">{invoice.companyName}</p>
          </div>
          <div className="flex items-center gap-2">
            <InvoiceActionButton label="Print" icon={<FiPrinter aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => printPaymentInvoice(invoice)} />
            <InvoiceActionButton label="Download" icon={<FiDownload aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => downloadPaymentInvoice(invoice)} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close invoice preview"
              className="flex h-8 w-8 items-center justify-center border border-slate-300 text-slate-600 hover:border-slate-900 hover:text-slate-950"
            >
              <FiX aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
        <iframe title="Payment invoice preview" srcDoc={html} className="min-h-0 flex-1 border-0 bg-white" />
      </div>
    </div>
  );
}
