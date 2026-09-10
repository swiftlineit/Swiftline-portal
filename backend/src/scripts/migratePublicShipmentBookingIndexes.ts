import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { PublicShipmentBooking } from "../models/publicShipmentBooking.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";

async function migratePublicShipmentBookingIndexes() {
  await connectDatabase();
  try {
    // The original schema used a unique sparse shipmentDraftId index while
    // storing an explicit null for every new session. MongoDB still indexes an
    // explicit null in a sparse index, so only one draft-less session could
    // exist. Replace that legacy index with the schema's partial ObjectId-only
    // unique index; existing null-valued sessions remain valid.
    const indexes = await PublicShipmentBooking.collection.indexes();
    const shipmentDraftIndex = indexes.find((index) => index.key?.shipmentDraftId === 1);
    const partialFilter = shipmentDraftIndex?.partialFilterExpression?.shipmentDraftId as
      | { $type?: unknown }
      | undefined;
    const hasCorrectIndex = Boolean(
      shipmentDraftIndex?.unique && partialFilter?.$type === "objectId",
    );

    if (!hasCorrectIndex) {
      for (const index of indexes.filter((candidate) => candidate.key?.shipmentDraftId === 1)) {
        if (index.name) await PublicShipmentBooking.collection.dropIndex(index.name);
      }
      await PublicShipmentBooking.createIndexes();
    }

    // Production disables automatic model indexes. Creating only the indexes
    // declared by these two models keeps token lookup and payment idempotency
    // guarantees identical in development and production.
    await PublicShipmentPayment.createIndexes();
    console.log("Public shipment booking and payment indexes are up to date.");
  } finally {
    await mongoose.disconnect();
  }
}

migratePublicShipmentBookingIndexes().catch((error) => {
  console.error("Public shipment booking index migration failed.", error);
  process.exitCode = 1;
});
