import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

/** Additive, idempotent index migration for the minute-level dispatch reminder sweep. */
async function migratePickupDispatchReminderIndex() {
  await connectDatabase();
  try {
    await mongoose.connection.collection("pickuprequests").createIndex(
      { status: 1, dispatchAt: 1, dispatchReminderSentAt: 1 },
      { name: "pickup_dispatch_reminder_due" }
    );
    console.log("Pickup dispatch reminder index is ready.");
  } finally {
    await mongoose.disconnect();
  }
}

migratePickupDispatchReminderIndex().catch((error) => {
  console.error("Pickup dispatch reminder index migration failed.", error);
  process.exitCode = 1;
});
