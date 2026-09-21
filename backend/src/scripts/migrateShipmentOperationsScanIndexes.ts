import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

const apply = process.argv.includes("--apply");

async function migrate() {
  mongoose.set("autoIndex", false);
  await connectDatabase();
  try {
    const scans = mongoose.connection.collection("shipmentoperationsparcelscans");
    const duplicateParcels = await scans.aggregate([
      { $group: { _id: { shipmentDraftId: "$shipmentDraftId", action: "$action", parcelNumber: "$parcelNumber" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    const duplicateRequests = await scans.aggregate([
      { $match: { scanRequestId: { $type: "string", $gt: "" } } },
      { $group: { _id: "$scanRequestId", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    if (duplicateParcels.length || duplicateRequests.length) {
      throw new Error("Resolve duplicate origin parcel scans before creating indexes. Nothing was changed.");
    }
    if (!apply) {
      console.log("Dry run passed. Re-run with --apply to create origin parcel scan indexes.");
      return;
    }
    await scans.createIndex(
      { shipmentDraftId: 1, action: 1, parcelNumber: 1 },
      { unique: true, name: "uniq_shipment_origin_action_parcel" }
    );
    await scans.createIndex(
      { scanRequestId: 1 },
      { unique: true, name: "uniq_shipment_origin_scan_request" }
    );
    await scans.createIndex({ shipmentDraftId: 1, action: 1, scannedAt: 1 });
    console.log("Created or confirmed origin parcel scan indexes.");
  } finally {
    await mongoose.disconnect();
  }
}

migrate().catch((error) => {
  console.error("Origin parcel scan index migration failed.", error);
  process.exitCode = 1;
});
