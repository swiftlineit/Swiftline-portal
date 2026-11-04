// READ ONLY. Run before switching SWIFTLINE_PARCEL_NUMBER_FORMAT to COMPACT.
// This script contains no insert, update, delete, or index operation.
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import {
  findSwiftlineParcelIdentifierCollisions,
  type SwiftlineParcelIdentifierAuditRecord
} from "../services/swiftlineTracking.service.js";

type SnapshotReferences = {
  tracking?: { swiftlineTrackingNumber?: string };
  parcels?: Array<{ swiftlineParcelNumber?: string }>;
};

type ShipmentReferences = {
  _id: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  swiftlineTrackingNumber?: string;
  dpdShipmentId?: string;
  parcelNumbers?: string[];
  forwardingNumber?: string;
  entryNumber?: string;
  currentShipmentSnapshot?: SnapshotReferences;
  bookingSnapshot?: SnapshotReferences;
};

async function audit() {
  await mongoose.connect(env.MONGODB_URI, {
    readPreference: "primary",
    autoIndex: false,
    autoCreate: false
  });
  try {
    const recordByShipmentId = new Map<string, SwiftlineParcelIdentifierAuditRecord>();
    const shipmentDraftIdByBookingId = new Map<string, string>();
    let shipmentCount = 0;

    const shipments = DpdShipment.find({})
      .select([
        "_id",
        "shipmentDraftId",
        "swiftlineTrackingNumber",
        "dpdShipmentId",
        "parcelNumbers",
        "currentShipmentSnapshot.tracking.swiftlineTrackingNumber",
        "currentShipmentSnapshot.parcels.swiftlineParcelNumber",
        "bookingSnapshot.tracking.swiftlineTrackingNumber",
        "bookingSnapshot.parcels.swiftlineParcelNumber"
      ].join(" "))
      .lean()
      .cursor({ batchSize: 500 });

    for await (const rawShipment of shipments) {
      const shipment = rawShipment as unknown as ShipmentReferences;
      const shipmentDraftId = String(shipment.shipmentDraftId);
      const snapshots = [shipment.currentShipmentSnapshot, shipment.bookingSnapshot].filter(Boolean) as SnapshotReferences[];
      const parcelNumbers = [
        ...(shipment.parcelNumbers ?? []),
        ...snapshots.flatMap((snapshot) => (snapshot.parcels ?? [])
          .map((parcel) => parcel.swiftlineParcelNumber ?? ""))
      ].filter(Boolean);
      const trackingNumbers = [
        shipment.swiftlineTrackingNumber,
        ...snapshots.map((snapshot) => snapshot.tracking?.swiftlineTrackingNumber)
      ].filter((value): value is string => Boolean(value?.trim()));
      const carrierShipmentIds = [shipment.dpdShipmentId, shipment.forwardingNumber, shipment.entryNumber]
        .filter((value): value is string => Boolean(value?.trim()));
      const record = recordByShipmentId.get(shipmentDraftId) ?? {
        shipmentDraftId,
        trackingNumbers: [],
        carrierShipmentIds: [],
        parcelNumbers: []
      };
      recordByShipmentId.set(shipmentDraftId, {
        ...record,
        trackingNumbers: [...(record.trackingNumbers ?? []), ...trackingNumbers],
        carrierShipmentIds: [...(record.carrierShipmentIds ?? []), ...carrierShipmentIds],
        parcelNumbers: [...record.parcelNumbers, ...parcelNumbers]
      });
      shipmentDraftIdByBookingId.set(String(shipment._id), shipmentDraftId);
      shipmentCount += 1;
    }

    const labels = LabelDocument.find({ voidedAt: null })
      .select("dpdShipmentId parcelNumber")
      .lean()
      .cursor({ batchSize: 500 });
    for await (const label of labels) {
      const shipmentDraftId = shipmentDraftIdByBookingId.get(String(label.dpdShipmentId));
      if (!shipmentDraftId) continue;
      const record = recordByShipmentId.get(shipmentDraftId);
      if (!record) continue;
      recordByShipmentId.set(shipmentDraftId, {
        ...record,
        parcelNumbers: [...record.parcelNumbers, label.parcelNumber]
      });
    }

    const collisions = findSwiftlineParcelIdentifierCollisions([...recordByShipmentId.values()]);
    process.stdout.write(`${JSON.stringify({ shipmentCount, collisionCount: collisions.length, collisions }, null, 2)}\n`);
    if (collisions.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

void audit().catch((error) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(`Swiftline parcel identifier audit failed (${errorName}).`);
  process.exitCode = 1;
});
