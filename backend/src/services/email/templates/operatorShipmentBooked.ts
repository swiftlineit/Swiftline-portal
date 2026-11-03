import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asNumber, asText, formatDateTime, formatMoneyMinor, firstNameOf, toAbsoluteUrl } from "../format.js";

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
  const invoiceAttached = Boolean(payload.invoiceAttached);
  const labelsAttached = Boolean(payload.labelsAttached);
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
      { kind: "paragraph", text: invoiceAttached && labelsAttached
        ? "Your invoice and internal parcel labels are attached."
        : invoiceAttached
          ? "Your invoice is attached. Download your internal parcel labels from the shipment page."
          : labelsAttached
            ? "Your internal parcel labels are attached. Download your invoice from the shipment page."
            : "Download your invoice and internal parcel labels from the shipment page." },
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
      { kind: "button", label: "Open shipment", url: toAbsoluteUrl(appUrl, asText(payload.href)) }
    ]
  };
}
