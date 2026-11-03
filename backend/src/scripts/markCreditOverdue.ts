import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { expireLapsedCreditAccounts, notifyCreditUtilizationWarnings } from "../services/creditAccount.service.js";
import { markOverdueCreditStatements } from "../services/creditOverdue.service.js";
import { runOperationalTenantJob } from "../services/tenantJobRunner.service.js";

// Scheduled job: flag due-passed statements as OVERDUE and expire credit
// facilities whose validity window has closed, so restrictions apply on time
// rather than only when a page lazily triggers the same check.
// Recommended cadence: hourly (or at least once daily).
async function run() {
  await connectDatabase();
  try {
    const now = new Date();
    const summary = await runOperationalTenantJob("Credit overdue and expiry", async (tenant) => {
      const overdue = await markOverdueCreditStatements(now);
      const expired = await expireLapsedCreditAccounts(now);
      const warnings = await notifyCreditUtilizationWarnings(now);
      console.log(
        `Credit maintenance for ${tenant.slug}: ${overdue.markedOverdue} statement(s) marked overdue, `
        + `${expired.expired} facility(ies) expired, ${warnings.notified} utilization warning(s) sent.`
      );
    });
    console.log(
      `Credit maintenance complete: ${summary.succeeded.length}/${summary.total} tenant(s) succeeded, `
      + `${summary.failed.length} tenant(s) failed.`
    );
    if (summary.failed.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error("Credit overdue/expiry job failed.", error);
  process.exitCode = 1;
});
