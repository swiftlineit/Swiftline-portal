import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asNumber, asText, formatDateTime, firstNameOf, toAbsoluteUrl } from "../format.js";

function deliveredFacts(payload: Record<string, unknown>) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "AWB / Tracking No.", value: asText(payload.trackingNumber) },
    { label: "Customer reference", value: asText(payload.customerReference) },
    { label: "Service", value: asText(payload.serviceType) },
    { label: "Destination", value: asText(payload.destination) },
    { label: "Consignee", value: asText(payload.consigneeName) },
    { label: "Parcels", value: String(asNumber(payload.parcelCount)) },
    { label: "Delivered on", value: payload.deliveredAt ? formatDateTime(payload.deliveredAt as string) : "Not provided" }
  ];

  return rows.filter((row) => row.value && row.value !== "Not provided");
}

export function shipmentDeliveredClientTemplate(context: EmailTemplateContext): EmailContent {
  const { payload, appUrl, recipientName } = context;
  const trackingNumber = asText(payload.trackingNumber, "");
  const consignee = asText(payload.consigneeName, "");
  const deliveredLine = payload.deliveredAt
    ? `Delivered${consignee ? ` to ${consignee}` : ""} on ${formatDateTime(payload.deliveredAt as string)}.`
    : `Delivered${consignee ? ` to ${consignee}` : ""}.`;

  return {
    subject: trackingNumber
      ? `Shipment ${trackingNumber} delivered successfully`
      : "Your shipment has been delivered",
    preheader: deliveredLine,
    heading: "Your shipment has been delivered",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      {
        kind: "paragraph",
        text: "Good news - your shipment has been delivered successfully. The delivery details are listed below."
      },
      { kind: "callout", tone: "success", text: deliveredLine },
      { kind: "facts", rows: deliveredFacts(payload) },
      ...(trackingNumber
        ? [{
          kind: "button" as const,
          label: "Track shipment",
          url: toAbsoluteUrl(appUrl, `/track/${encodeURIComponent(trackingNumber)}`)
        }]
        : []),
      {
        kind: "note",
        text: "If you were not expecting this delivery or need help, contact your Swiftline branch with the AWB number above."
      }
    ]
  };
}
