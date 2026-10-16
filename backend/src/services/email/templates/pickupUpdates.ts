import type { EmailBlock, EmailContent } from "../layout.js";
import { asNumber, asRecordArray, asText, firstNameOf, formatDate, formatDateTime, toAbsoluteUrl } from "../format.js";
import type { EmailTemplate, EmailTemplateContext } from "./index.js";

type PickupEvent = "requested" | "started" | "completed";
type PickupAudience = "client" | "staff";

export const pickupEmailImageCid = "pickup-parcel@swiftline";

const arrivalWindows: Record<string, string> = {
  MORNING: "Morning (06:00–12:00)",
  AFTERNOON: "Afternoon (12:00–17:00)",
  EVENING: "Evening (17:00–22:00)",
  EXACT: "Exact time"
};

function arrivalText(payload: Record<string, unknown>) {
  const date = formatDate(payload.arrivalDate as string);
  const window = arrivalWindows[asText(payload.arrivalWindow, "")] ?? "";
  const exact = payload.arrivalWindow === "EXACT" ? formatDateTime(payload.arrivalExactAt as string) : "";
  return exact && exact !== "Not available" ? exact : [date, window].filter(Boolean).join(" · ");
}

function detailRows(payload: Record<string, unknown>) {
  const documents = Array.isArray(payload.documentNames)
    ? payload.documentNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  const rows = [
    { label: "Pickup reference", value: asText(payload.requestNumber, "") },
    { label: "Client company", value: asText(payload.companyName, "") },
    { label: "Requested by", value: [asText(payload.requesterName, ""), asText(payload.requesterEmail, "")].filter(Boolean).join(" · ") },
    { label: "Branch", value: asText(payload.branchName, "") },
    { label: "Transport / courier", value: asText(payload.transportCompany, "") },
    { label: "Dispatch", value: formatDateTime(payload.dispatchAt as string) },
    { label: "Expected Delhi arrival", value: arrivalText(payload) },
    { label: "Collection address", value: asText(payload.collectionAddress, "") },
    { label: "Courier collection contact", value: [asText(payload.contactName, ""), asText(payload.contactPhone, "")].filter(Boolean).join(" · ") },
    { label: "Volume", value: `${asNumber(payload.totalBoxes)} boxes · ${asNumber(payload.totalWeightKg).toFixed(2)} kg gross` },
    { label: "Linked shipments", value: String(asNumber(payload.shipmentCount)) },
    { label: "Supporting documents", value: documents.length ? documents.join(", ") : "None" }
  ];
  return rows.filter((row) => row.value && row.value !== "Not available");
}

function shipmentBlocks(payload: Record<string, unknown>, completed: boolean): EmailBlock[] {
  const shipments = asRecordArray(payload.shipments);
  if (!shipments.length) {
    return [{ kind: "note", text: "This pickup was requested without linked booked shipments." }];
  }
  return [
    { kind: "paragraph", text: completed ? "Hub receipt by linked shipment:" : "Booked shipments linked to this pickup:" },
    {
      kind: "table",
      columns: completed ? ["Shipment", "Hub receipt"] : ["Shipment", "Parcels"],
      rows: shipments.map((shipment) => {
        const tracking = asText(shipment.trackingNumber, "Shipment");
        const parcels = asRecordArray(shipment.parcels);
        if (!completed) return [tracking, String(parcels.length)];
        const missing = parcels.filter((parcel) => parcel.hubReceiptOutcome === "NOT_RECEIVED");
        const received = parcels.filter((parcel) => parcel.hubReceiptOutcome === "RECEIVED");
        return [
          tracking,
          `${received.length} of ${parcels.length} received: ${received.map((parcel) => asText(parcel.parcelNumber, "")).filter(Boolean).join(", ") || "None"}. Not received: ${missing.map((parcel) => asText(parcel.parcelNumber, "")).filter(Boolean).join(", ") || "None"}`
        ];
      })
    }
  ];
}

function pickupTemplate(event: PickupEvent, audience: PickupAudience): EmailTemplate {
  return ({ recipientName, payload, appUrl }: EmailTemplateContext): EmailContent => {
    const requestNumber = asText(payload.requestNumber, "your pickup");
    const company = asText(payload.companyName, "the client");
    const missing = asNumber(payload.missingParcelCount);
    const received = asNumber(payload.receivedParcelCount);
    const hasLinkedShipments = asNumber(payload.shipmentCount) > 0;
    const completedWithMissing = event === "completed" && missing > 0;
    const subject = event === "requested"
      ? audience === "staff" ? `New pickup request ${requestNumber} · ${company}` : `Pickup request ${requestNumber} received`
      : event === "started"
        ? `Pickup ${requestNumber} has started`
        : completedWithMissing
          ? `Pickup ${requestNumber} completed · ${missing} parcel${missing === 1 ? "" : "s"} not received`
          : `Pickup ${requestNumber} received at Delhi hub`;
    const heading = event === "requested" ? audience === "staff" ? "A pickup needs your review" : "Your pickup request is with us"
      : event === "started" ? "Pickup is in progress"
      : completedWithMissing ? "Pickup completed with parcels not received" : "Pickup received at Delhi hub";
    const introduction = event === "requested"
      ? audience === "staff"
        ? `${company} has requested a pickup for ${formatDateTime(payload.dispatchAt as string)}. Review the collection details and approve the request in the portal.`
        : "We have received your pickup request. Our team will review the details and coordinate the collection. You can follow its status in the portal."
      : event === "started"
        ? audience === "staff"
          ? `Pickup ${requestNumber} for ${company} has started. Follow its progress and record the parcels that reach the Delhi hub.`
          : "Your pickup has started. We will update you again when the parcels are recorded at the Delhi hub."
        : completedWithMissing
          ? `${received} parcel${received === 1 ? "" : "s"} recorded at the Delhi hub; ${missing} expected parcel${missing === 1 ? " was" : "s were"} not received when this pickup was closed.`
          : hasLinkedShipments
            ? `The pickup has been completed and ${received} parcel${received === 1 ? "" : "s"} recorded at the Delhi hub.`
            : "The pickup has been completed and recorded at the Delhi hub. No booked shipments were linked to this request.";
    const blocks: EmailBlock[] = [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      { kind: "paragraph", text: introduction },
      { kind: "facts", rows: detailRows(payload) },
      ...(event === "completed" ? [{ kind: "facts" as const, rows: [
        { label: "Hub receipt recorded", value: formatDateTime(payload.receivedAt as string) },
        ...(hasLinkedShipments ? [
          { label: "Received parcels", value: String(received) },
          { label: "Not received at hub", value: String(missing) }
        ] : [])
      ] }] : []),
      ...shipmentBlocks(payload, event === "completed"),
      ...(event === "requested" && asNumber(payload.documentCount) > 0 ? [{
        kind: "note" as const,
        text: asNumber(payload.pickupDocumentsAttached) === asNumber(payload.documentCount)
          ? `All ${asNumber(payload.documentCount)} supporting document${asNumber(payload.documentCount) === 1 ? " is" : "s are"} attached to this email.`
          : `${asNumber(payload.pickupDocumentsAttached)} of ${asNumber(payload.documentCount)} supporting documents attached. Open the pickup in the portal to view every document securely.`
      }] : []),
      ...(asText(payload.handlingRemarks, "") ? [{ kind: "callout" as const, tone: "info" as const, text: `Handling instructions: ${asText(payload.handlingRemarks, "")}` }] : []),
      ...(asText(payload.pickupPartnerInfo, "") ? [{ kind: "paragraph" as const, text: `Pickup partner information: ${asText(payload.pickupPartnerInfo, "")}` }] : []),
      ...(completedWithMissing ? [{
        kind: "callout" as const,
        tone: "warning" as const,
        text: audience === "staff"
          ? "Follow up on the parcels listed as not received. Their shipment will remain short of full origin receipt until they are recorded at the hub."
          : "The parcels listed as not received remain outstanding. Their shipment will show full origin receipt only after those parcels arrive and are recorded."
      }] : []),
      {
        kind: "button",
        label: audience === "staff" ? "Review pickup" : "View pickup",
        url: toAbsoluteUrl(appUrl, audience === "staff" ? "/dashboard/pickups" : "/client/pickups")
      },
      { kind: "note", text: "All dates and times are shown in India Standard Time. Supporting documents and pickup proof can be viewed securely in the portal." }
    ];
    return {
      subject,
      preheader: event === "completed"
        ? hasLinkedShipments ? `${received} received · ${missing} not received at Delhi hub.` : `${requestNumber} completed at Delhi hub.`
        : `${requestNumber} · ${company} · ${formatDateTime(payload.dispatchAt as string)}`,
      heading,
      heroImage: { url: `cid:${pickupEmailImageCid}`, alt: "Parcel delivery illustration" },
      blocks
    };
  };
}

export const pickupRequestedClientTemplate = pickupTemplate("requested", "client");
export const pickupRequestedStaffTemplate = pickupTemplate("requested", "staff");
export const pickupStartedClientTemplate = pickupTemplate("started", "client");
export const pickupStartedStaffTemplate = pickupTemplate("started", "staff");
export const pickupCompletedClientTemplate = pickupTemplate("completed", "client");
export const pickupCompletedStaffTemplate = pickupTemplate("completed", "staff");
