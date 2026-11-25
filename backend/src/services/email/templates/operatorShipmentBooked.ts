import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asNumber, asText, formatDateTime, formatMoneyMinor, firstNameOf, toAbsoluteUrl } from "../format.js";
import { shipmentBookingDocumentFacts } from "./shipmentBooked.js";

function facts(payload: Record<string, unknown>) {
  return [
    { label: "AWB", value: asText(payload.trackingNumber) },
    { label: "Business account", value: asText(payload.businessAccountName) },
    { label: "Consignee", value: asText(payload.consigneeName) },
    { label: "Destination", value: asText(payload.destination) },
    { label: "Parcels", value: String(asNumber(payload.parcelCount)) },
    { label: "Total weight", value: `${asNumber(payload.totalWeightKg).toFixed(2)} kg` },
    { label: "Booked at", value: formatDateTime(payload.bookedAt as string) }
  ];
}

export function operatorShipmentBookedClientTemplate({ payload, recipientName, appUrl }: EmailTemplateContext): EmailContent {
  const trackingNumber = asText(payload.trackingNumber);
  return {
    subject: `Shipment ${trackingNumber} booked`,
    preheader: `Your shipment with ${asText(payload.operatorName)} is booked.`,
    heading: "Your shipment is booked",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      { kind: "paragraph", text: `Your shipment with ${asText(payload.operatorName)} has been booked.` },
      { kind: "facts", rows: facts(payload) },
      { kind: "facts", rows: [
        { label: "Invoice", value: asText(payload.invoiceNumber) },
        { label: "Total", value: formatMoneyMinor(asNumber(payload.invoiceTotalMinor), asText(payload.currency, "INR")) }
      ] },
      shipmentBookingDocumentFacts(payload, "Internal labels"),
      { kind: "button", label: "View shipment", url: toAbsoluteUrl(appUrl, asText(payload.href)) }
    ]
  };
}

export function operatorShipmentBookedStaffTemplate({ payload, appUrl }: EmailTemplateContext): EmailContent {
  const trackingNumber = asText(payload.trackingNumber);
  return {
    subject: `New booking ${trackingNumber} - ${asText(payload.businessAccountName)}`,
    preheader: `${asText(payload.businessAccountName)} booked a shipment.`,
    heading: "New shipment booked",
    blocks: [
      { kind: "paragraph", text: `${asText(payload.businessAccountName)} booked a shipment through ${asText(payload.branchName, "the portal")}.` },
      { kind: "facts", rows: [
        { label: "Booked by", value: asText(payload.bookedByName) },
        ...facts(payload)
      ] },
      { kind: "facts", rows: [
        { label: "Invoice number", value: asText(payload.invoiceNumber) },
        { label: "GST", value: payload.taxTreatment === "NO_GST" ? "-" : formatMoneyMinor(asNumber(payload.totalTaxAmountMinor), asText(payload.currency, "INR")) },
        { label: "Invoice total", value: formatMoneyMinor(asNumber(payload.invoiceTotalMinor), asText(payload.currency, "INR")) }
      ] },
      shipmentBookingDocumentFacts(payload, "Internal labels"),
      { kind: "button", label: "Open shipment", url: toAbsoluteUrl(appUrl, asText(payload.href)) }
    ]
  };
}
