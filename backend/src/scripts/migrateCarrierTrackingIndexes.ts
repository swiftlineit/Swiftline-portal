import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { CarrierApiRateBucket } from "../models/carrierApiRateBucket.model.js";
import { CarrierTrackingEvent } from "../models/carrierTrackingEvent.model.js";
import { CarrierTrackingSync } from "../models/carrierTrackingSync.model.js";

/**
 * Production disables automatic collection and index creation. This migration
 * creates only the indexes declared by the three carrier-tracking models; it
 * does not remove data or drop unrelated indexes and is safe to run again.
 */
async function migrateCarrierTrackingIndexes() {
  await connectDatabase();
  try {
    await CarrierTrackingEvent.createIndexes();
    await CarrierTrackingSync.createIndexes();
    await CarrierApiRateBucket.createIndexes();
    console.log("Carrier tracking indexes are ready.");
  } finally {
    await mongoose.disconnect();
  }
}

migrateCarrierTrackingIndexes().catch((error) => {
  console.error("Carrier tracking index migration failed.", error);
  process.exitCode = 1;
});
