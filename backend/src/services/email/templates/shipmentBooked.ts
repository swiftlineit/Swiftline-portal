import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import {
  asNumber,
  asText,
  formatDateTime,
  formatMoneyMinor,
  firstNameOf,
  toAbsoluteUrl
} from "../format.js";

function shipmentFacts(payload: Record<string, unknown>) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "AWB / Tracking No.", value: asText(payload.trackingNumber) },
    { label: "Customer reference", value: asText(payload.customerReference) },
    { label: "Service", value: asText(payload.serviceType) },
    { label: "Destination", value: asText(payload.destination) },
    { label: "Parcels", value: String(asNumber(payload.parcelCount)) },
    { label: "Chargeable weight", value: `${asNumber(payload.totalWeightKg).toFixed(2)} kg` },
    { label: "Booked at", value: formatDateTime(payload.bookedAt as string) }
  ];

  return rows.filter((row) => row.value && row.value !== "Not provided");
}

function invoiceFacts(payload: Record<string, unknown>) {
  const currency = asText(payload.currency, "INR");
  const noGst = payload.taxTreatment === "NO_GST";
  return {
    kind: "facts" as const,
    rows: [
      { label: "Invoice number", value: asText(payload.invoiceNumber) },
      { label: "Taxable value", value: formatMoneyMinor(asNumber(payload.taxableValueMinor), currency) },
      { label: "GST", value: noGst ? "-" : formatMoneyMinor(asNumber(payload.totalTaxAmountMinor), currency) },
      { label: "Invoice total", value: formatMoneyMinor(asNumber(payload.invoiceTotalMinor), currency) }
    ]
  };
}

export function shipmentBookingDocumentFacts(payload: Record<string, unknown>, label = "Swiftline labels") {
  return {
    kind: "facts" as const,
    rows: [
      { label: payload.taxTreatment === "NO_GST" ? "Invoice" : "GST tax invoice", value: payload.invoiceAttached ? "Attached" : "Available in portal" },
      { label: "Shipment invoice", value: payload.customsInvoiceAttached ? "Attached" : "Available in portal" },
      { label, value: payload.swiftlineLabelAttached ? "Attached" : "Not generated" },
      ...(payload.dpdLabelAttached ? [{ label: "DPD label", value: "Attached" }] : []),
      ...(payload.cashReceiptAttached ? [{ label: "Cash receipt", value: "Attached" }] : [])
    ]
  };
}

export function shipmentBookedClientTemplate(context: EmailTemplateContext): EmailContent {
  const { payload, appUrl, recipientName } = context;
  const trackingNumber = asText(payload.trackingNumber, "");
  const parcelCount = asNumber(payload.parcelCount);
  const invoiceLabel = payload.taxTreatment === "NO_GST" ? "invoice" : "tax invoice";

  return {
    subject: trackingNumber
      ? `Shipment ${trackingNumber} booked successfully`
      : "Your shipment has been booked",
    preheader: `${parcelCount} parcel${parcelCount === 1 ? "" : "s"} booked. Your shipment documents are ready.`,
    heading: "Your shipment is booked",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      {
        kind: "paragraph",
        text: "Your shipment has been booked successfully. The booking details and attached documents are listed below."
      },
      { kind: "facts", rows: shipmentFacts(payload) },
      { kind: "callout", tone: "success", text: `${invoiceLabel === "invoice" ? "Invoice" : "GST tax invoice"} ${asText(payload.invoiceNumber)} totals ${formatMoneyMinor(asNumber(payload.invoiceTotalMinor), asText(payload.currency, "INR"))}.` },
      shipmentBookingDocumentFacts(payload),
      {
        kind: "note",
        text: payload.dpdLabelAttached
          ? "Print and affix the Swiftline and DPD labels before handover."
          : payload.swiftlineLabelAttached
            ? "Print and affix the Swiftline label to each parcel before handover."
            : "Available documents can be downloaded from the shipment page."
      },
      { kind: "button", label: "View shipment", url: toAbsoluteUrl(appUrl, asText(payload.href, "/client/shipments")) },
      // "View shipment" needs a session, so it is only useful to the account
      // holder receiving this email. The consignee has no account and holds
      // nothing but the number on the label, so they get a link that needs none.
      ...(trackingNumber
        ? [{
          kind: "button" as const,
          label: "Track shipment",
          url: toAbsoluteUrl(appUrl, `/track/${encodeURIComponent(trackingNumber)}`)
        }]
        : []),
      {
        kind: "note",
        text: trackingNumber
          ? "The tracking link opens without signing in- forward it to your consignee so they can follow the shipment themselves."
          : "Keep the tracking number handy when contacting support about this shipment."
      }
    ]
  };
}

export function shipmentBookedStaffTemplate(context: EmailTemplateContext): EmailContent {
  const { payload, appUrl } = context;
  const trackingNumber = asText(payload.trackingNumber, "");

  return {
    subject: `New booking ${trackingNumber}- ${asText(payload.businessAccountName, "client")}`,
    preheader: `Booked by ${asText(payload.bookedByName)} at ${asText(payload.branchName)}.`,
    heading: "New shipment booked",
    blocks: [
      {
        kind: "paragraph",
        text: `${asText(payload.businessAccountName, "A client")} booked a shipment through ${asText(payload.branchName, "the portal")}. Booking documents are listed below.`
      },
      {
        kind: "facts",
        rows: [
          { label: "Business account", value: asText(payload.businessAccountName) },
          { label: "Booked by", value: asText(payload.bookedByName) },
          { label: "Branch", value: asText(payload.branchName) },
          ...shipmentFacts(payload)
        ]
      },
      invoiceFacts(payload),
      shipmentBookingDocumentFacts(payload),
      { kind: "button", label: "Open shipment", url: toAbsoluteUrl(appUrl, asText(payload.staffHref, "/dashboard/shipments")) }
    ]
  };
}
