import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { expireStaleReservations } from "../services/creditBooking.service.js";
import { runOperationalTenantJob } from "../services/tenantJobRunner.service.js";

// Scheduled job: release booking reservations that passed their TTL without being
// converted or released, so their funds stop consuming available credit.
// Recommended cadence: every 5 minutes.
async function run() {
  await connectDatabase();
  try {
    const summary = await runOperationalTenantJob("Credit reservation expiry", async (tenant) => {
      const result = await expireStaleReservations();
      console.log(
        `Reservation sweep for ${tenant.slug}: scanned ${result.scanned}, released ${result.released}, failed ${result.failed}.`
      );
      if (result.failed > 0) {
        throw new Error(`${result.failed} reservation(s) could not be expired.`);
      }
    });
    console.log(
      `Reservation sweep complete: ${summary.succeeded.length}/${summary.total} tenant(s) succeeded, `
      + `${summary.failed.length} tenant(s) failed.`
    );
    if (summary.failed.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error("Reservation expiry job failed.", error);
  process.exitCode = 1;
});
