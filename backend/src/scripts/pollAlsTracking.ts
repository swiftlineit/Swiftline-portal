import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { runAlsTrackingSweep } from "../services/als/alsTracking.service.js";

async function main() {
  await connectDatabase();
  try {
    const result = await runAlsTrackingSweep();
    console.log(result.enabled
      ? `ALS tracking sweep complete: ${result.attempted} attempted, ${result.succeeded} succeeded, ${result.failed} failed, ${result.created} newly eligible.`
      : "ALS tracking sweep skipped: ALS_TRACKING_ENABLED is false.");
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("ALS tracking sweep failed.", error);
  process.exitCode = 1;
});
