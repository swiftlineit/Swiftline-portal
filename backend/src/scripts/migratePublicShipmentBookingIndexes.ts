import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { PublicShipmentBooking } from "../models/publicShipmentBooking.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { ensurePublicShipmentBookingIndexes } from "../services/publicShipmentBookingIndexes.service.js";

async function migratePublicShipmentBookingIndexes() {
  await connectDatabase();
  try {
    // The original schema used a unique sparse shipmentDraftId index while
    // storing an explicit null for every new session. MongoDB still indexes an
    // explicit null in a sparse index, so only one draft-less session could
    // exist. Replace that legacy index with the schema's partial ObjectId-only
    // unique index; existing null-valued sessions remain valid.
    const result = await ensurePublicShipmentBookingIndexes({
      bookingCollection: PublicShipmentBooking.collection,
      createBookingIndexes: () => PublicShipmentBooking.createIndexes(),
      createPaymentIndexes: () => PublicShipmentPayment.createIndexes(),
    });
    console.log("Public shipment booking and payment indexes are up to date.", result);
  } finally {
    await mongoose.disconnect();
  }
}

migratePublicShipmentBookingIndexes().catch((error) => {
  console.error("Public shipment booking index migration failed.", error);
  process.exitCode = 1;
});
