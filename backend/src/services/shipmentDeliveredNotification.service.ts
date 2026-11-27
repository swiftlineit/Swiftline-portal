import mongoose from "mongoose";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft, type IShipmentDraft } from "../models/shipmentDraft.model.js";
import { notifyPortalUsers } from "./portalNotification.service.js";

type ShipmentDeliveredInput = {
  shipmentDraftId: mongoose.Types.ObjectId | string;
  dpdShipmentId: mongoose.Types.ObjectId | string;
  deliveredAt?: Date | string | null;
};

function resolveConsigneeAddress(draft: IShipmentDraft) {
  return draft.consigneeValidatedAddress ?? draft.consigneeSelectedAddress ?? draft.consigneeEnteredAddress;
}

/**
 * Emails the consignor captured on the booking form when a shipment is marked
 * delivered. It deliberately sends email only- no in-app notification is
 * written and no business account members are copied.
 *
 * Delivery is best effort: the delivered event is already persisted, so a
 * notification failure must never fail or roll back the status update.
 */
export async function notifyShipmentDelivered(input: ShipmentDeliveredInput) {
  try {
    const [draft, shipment] = await Promise.all([
      ShipmentDraft.findById(input.shipmentDraftId)
        .select("businessAccountId branchId serviceType parcelList consignorAddress consigneeEnteredAddress consigneeSelectedAddress consigneeValidatedAddress")
        .lean()
        .exec(),
      DpdShipment.findById(input.dpdShipmentId)
        .select("swiftlineTrackingNumber")
        .lean()
        .exec()
    ]);
    if (!draft) return;

    const consignorEmail = draft.consignorAddress?.email?.trim() || "";
    if (!consignorEmail) return;

    const consignee = resolveConsigneeAddress(draft);
    const consigneeName = consignee?.companyName || consignee?.contactName || "";
    const destination = [consignee?.townOrCity, consignee?.countryName || consignee?.countryCode]
      .filter(Boolean)
      .join(", ");
    const trackingNumber = shipment?.swiftlineTrackingNumber?.trim() || "";
    const consignorName = draft.consignorAddress?.contactName
      || draft.consignorAddress?.companyName
      || "Customer";
    const deliveredAt = input.deliveredAt ?? new Date();

    await notifyPortalUsers([], {
      type: "SHIPMENT_DELIVERED",
      title: "Shipment delivered",
      message: `${trackingNumber || String(draft._id)} was delivered${consigneeName ? ` to ${consigneeName}` : ""}.`,
      href: `/client/shipments/${String(draft._id)}`,
      idempotencyKey: `SHIPMENT_DELIVERED:${String(input.dpdShipmentId)}`,
      businessAccountId: draft.businessAccountId,
      metadata: {
        shipmentDraftId: draft._id,
        dpdShipmentId: input.dpdShipmentId,
        trackingNumber
      },
      email: {
        templateKey: "SHIPMENT_DELIVERED_CLIENT",
        subject: trackingNumber
          ? `Shipment ${trackingNumber} delivered successfully`
          : "Your shipment has been delivered",
        payload: {
          trackingNumber,
          customerReference: "",
          serviceType: draft.serviceType === "CARGO" ? "Cargo" : "Courier",
          destination,
          consigneeName,
          parcelCount: draft.parcelList.length,
          deliveredAt
        },
        extraRecipients: [{ email: consignorEmail, name: consignorName }]
      }
    });
  } catch (error) {
    console.error("Shipment delivered notification failed.", {
      shipmentDraftId: String(input.shipmentDraftId),
      dpdShipmentId: String(input.dpdShipmentId),
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
