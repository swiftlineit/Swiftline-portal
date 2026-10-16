import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

async function migratePickupCourierAddressIndex() {
  await connectDatabase();
  try {
    await mongoose.connection.collection("pickupcourieraddresses").createIndex(
      { branchId: 1, companyKey: 1 },
      { unique: true, name: "pickup_courier_branch_company_unique" }
    );
    console.log("Pickup courier address index is ready.");
  } finally {
    await mongoose.disconnect();
  }
}

migratePickupCourierAddressIndex().catch((error) => {
  console.error("Pickup courier address index migration failed.", error);
  process.exitCode = 1;
});
