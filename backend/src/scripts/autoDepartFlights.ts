import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { runScheduledFlightDepartureSweep } from "../services/flightLinehaul.service.js";

async function main() {
  await connectDatabase();
  try {
    const result = await runScheduledFlightDepartureSweep();
    if (!result.enabled) {
      console.log("Scheduled flight departure sweep skipped: FLIGHT_AUTO_DEPARTURE_ENABLED is false.");
      return;
    }
    console.log(
      `Scheduled flight departure sweep complete: ${result.departed} departed, `
      + `${result.blocked} waiting on Operations, ${result.failed} failed.`
    );
    for (const issue of result.issues) console.warn(issue);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("Scheduled flight departure sweep failed.", error);
  process.exitCode = 1;
});
