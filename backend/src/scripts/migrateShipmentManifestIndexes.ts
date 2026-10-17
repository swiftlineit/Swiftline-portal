import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { shipmentManifestAssignmentSlotField, shipmentManifestAssignmentSlot } from "../services/shipmentManifestMembership.service.js";

type ManifestMigrationRow = {
  _id: mongoose.Types.ObjectId;
  actorRole: "admin" | "client";
  manifestType?: "ACCOUNT" | "COMBINED" | null;
  shipmentDraftIds: mongoose.Types.ObjectId[];
};

function membershipBackfill(rows: ManifestMigrationRow[]) {
  const assignments = new Map<string, {
    shipmentDraftId: mongoose.Types.ObjectId;
    values: Record<string, mongoose.Types.ObjectId>;
  }>();

  for (const manifest of rows) {
    const manifestType = manifest.manifestType === "COMBINED" ? "COMBINED" : "ACCOUNT";
    const slot = shipmentManifestAssignmentSlot(manifest.actorRole, manifestType);
    const field = shipmentManifestAssignmentSlotField(slot);
    for (const shipmentDraftId of manifest.shipmentDraftIds) {
      const key = String(shipmentDraftId);
      const assignment = assignments.get(key) ?? { shipmentDraftId, values: {} };
      const current = assignment.values[field];
      if (current && String(current) !== String(manifest._id)) {
        throw new Error(`Shipment ${key} has more than one ${slot} manifest; resolve this before migrating.`);
      }
      assignment.values[field] = manifest._id;
      assignments.set(key, assignment);
    }
  }

  return [...assignments.values()];
}

async function migrateShipmentManifestIndexes() {
  await connectDatabase();
  try {
    await ShipmentManifest.collection.updateMany(
      { $or: [{ manifestType: { $exists: false } }, { manifestType: null }] },
      { $set: { manifestType: "ACCOUNT" } }
    );

    const manifests = await ShipmentManifest.collection.find({}, {
      projection: { _id: 1, actorRole: 1, manifestType: 1, shipmentDraftIds: 1 }
    }).toArray() as ManifestMigrationRow[];
    const assignments = membershipBackfill(manifests);

    // This is a reviewed, offline migration. Rebuilding from manifest records
    // makes reruns repair partial backfills instead of preserving stale slots.
    await ShipmentDraft.collection.updateMany(
      { shipmentManifestAssignments: { $exists: true } },
      { $unset: { shipmentManifestAssignments: "" } }
    );
    const writes = assignments.map(({ shipmentDraftId, values }) => ({
      updateOne: {
        filter: { _id: shipmentDraftId },
        update: { $set: { shipmentManifestAssignments: values } }
      }
    }));
    for (let offset = 0; offset < writes.length; offset += 1000) {
      await ShipmentDraft.collection.bulkWrite(writes.slice(offset, offset + 1000), { ordered: false });
    }

    // Create the type-aware uniqueness constraint before removing the older
    // actor-only index. This permits one ACCOUNT and one COMBINED staff record
    // for a shipment while keeping duplicates within each slot impossible.
    await ShipmentManifest.createIndexes();

    const indexes = await ShipmentManifest.collection.indexes();
    const obsoleteIndexes = indexes.filter((index) => (
      (index.name === "shipmentDraftIds_1_actorRole_1"
        && Object.keys(index.key).length === 2
        && index.key.shipmentDraftIds === 1
        && index.key.actorRole === 1)
      || (index.name === "shipmentDraftIds_1"
        && Object.keys(index.key).length === 1
        && index.key.shipmentDraftIds === 1)
    ));
    for (const index of obsoleteIndexes) {
      if (index.name) await ShipmentManifest.collection.dropIndex(index.name);
    }

    console.log("Shipment manifest indexes are up to date.");
  } finally {
    await mongoose.disconnect();
  }
}

migrateShipmentManifestIndexes().catch((error) => {
  console.error("Shipment manifest index migration failed.", error);
  process.exitCode = 1;
});
