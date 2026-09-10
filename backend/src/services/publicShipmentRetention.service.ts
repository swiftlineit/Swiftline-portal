import { DpdShipment } from "../models/dpdShipment.model.js";
import { PublicShipmentBooking } from "../models/publicShipmentBooking.model.js";
import { ShipmentDraft, type ShipmentKycDocument } from "../models/shipmentDraft.model.js";
import { deleteObject } from "./storage/storage.service.js";

function documentKeys(documents: Record<string, ShipmentKycDocument | undefined> | undefined) {
  return Object.values(documents ?? {}).flatMap((document) => document?.storageKey ? [document.storageKey] : []);
}

/** Purges only unpaid editable sessions; paid, ambiguous and booked rows remain. */
export async function purgeExpiredPublicShipmentBookings(now = new Date()) {
  const expired = await PublicShipmentBooking.find({ state: { $in: ["DRAFT", "QUOTED"] }, expiresAt: { $lte: now } }).limit(200).exec();
  let purged = 0;
  let deletedDocuments = 0;
  for (const booking of expired) {
    const draft = booking.shipmentDraftId ? await ShipmentDraft.findById(booking.shipmentDraftId).exec() : null;
    if (draft && draft.creationSource === "PUBLIC_ONLINE" && !await DpdShipment.exists({ shipmentDraftId: draft._id })) {
      const keys = [
        ...documentKeys(draft.kycDocuments as Record<string, ShipmentKycDocument | undefined>),
        ...draft.parcelList.flatMap((parcel) => documentKeys(parcel.kycDocuments as Record<string, ShipmentKycDocument | undefined>)),
      ];
      for (const key of [...new Set(keys)]) {
        await deleteObject(key).catch((error) => console.error("Expired public KYC object could not be deleted.", { key, error }));
        deletedDocuments += 1;
      }
      await draft.deleteOne();
    }
    await booking.deleteOne();
    purged += 1;
  }
  return { examined: expired.length, purged, deletedDocuments };
}
