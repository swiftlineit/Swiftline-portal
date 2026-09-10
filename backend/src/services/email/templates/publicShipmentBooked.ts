import type { EmailContent } from "../layout.js";
import { asNumber, asText, firstNameOf, formatMoneyMinor, toAbsoluteUrl } from "../format.js";
import type { EmailTemplateContext } from "./index.js";

export function publicShipmentBookedTemplate({ recipientName, payload, appUrl }: EmailTemplateContext): EmailContent {
  const trackingNumber = asText(payload.trackingNumber, "");
  return {
    subject: `Shipment ${trackingNumber} booked successfully`,
    preheader: "Your Swiftline label, payment receipt and invoice are ready.",
    heading: "Your shipment is booked",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      { kind: "paragraph", text: "We received your payment and created your Swiftline shipment. Your invoice and one Swiftline label per parcel are attached." },
      { kind: "facts", rows: [
        { label: "AWB / tracking number", value: trackingNumber },
        { label: "Booking reference", value: asText(payload.bookingReference) },
        { label: "Invoice", value: asText(payload.invoiceNumber) },
        { label: "Payment receipt", value: asText(payload.paymentReceipt) },
        { label: "Amount paid", value: formatMoneyMinor(asNumber(payload.amountMinor), "INR") },
      ] },
      { kind: "button", label: "View booking", url: toAbsoluteUrl(appUrl, asText(payload.statusHref, "/book-shipment-online/status")) },
      { kind: "button", label: "Track shipment", url: toAbsoluteUrl(appUrl, asText(payload.trackingHref, "/track")) },
      { kind: "note", text: "Print and affix the Swiftline label to each parcel. Public bookings cannot be amended or cancelled online; contact Swiftline if you need help." },
    ],
  };
}
