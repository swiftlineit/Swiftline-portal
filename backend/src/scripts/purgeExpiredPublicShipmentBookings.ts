import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { purgeExpiredPublicShipmentBookings } from "../services/publicShipmentRetention.service.js";

async function main() {
  await connectDatabase();
  try {
    const result = await purgeExpiredPublicShipmentBookings();
    console.log(`Expired public booking sessions examined: ${result.examined}; purged: ${result.purged}; KYC objects deleted: ${result.deletedDocuments}.`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error) => { console.error("Public booking retention sweep failed.", error); process.exitCode = 1; });
