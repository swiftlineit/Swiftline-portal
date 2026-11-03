import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { drainEmailOutbox } from "../services/email/dispatcher.js";
import { listOperationalTenantTargets, runTenantJob } from "../services/tenantJobRunner.service.js";

// Scheduled job: the safety net behind the post-enqueue drain. Picks up rows the
// API process never got to- because it crashed mid-send, because SES was
// throttling, or because the send is waiting out its backoff.
// Recommended cadence: every 5 minutes.
//
// The batch size bounds one run; a large backlog drains across several runs
// rather than in one burst, which is also what keeps us inside the SES send
// rate.
async function run() {
  await connectDatabase();
  try {
    const targets = await listOperationalTenantTargets();
    const rotation = Math.floor(Date.now() / (5 * 60 * 1000)) % targets.length;
    const orderedTargets = targets.slice(rotation).concat(targets.slice(0, rotation));
    const tenantQuota = Math.ceil(env.EMAIL_DRAIN_BATCH_SIZE / Math.max(1, orderedTargets.length));
    const totals = { processed: 0, sent: 0, failed: 0 };
    let remainingBudget = env.EMAIL_DRAIN_BATCH_SIZE;
    const summary = await runTenantJob("Email outbox drain", orderedTargets, async (tenant) => {
      const quota = Math.min(tenantQuota, remainingBudget);
      remainingBudget -= quota;
      if (!quota) return;
      const result = await drainEmailOutbox(quota);
      totals.processed += result.processed;
      totals.sent += result.sent;
      totals.failed += result.failed;
      console.log(
        `Email drain for ${tenant.slug}: processed ${result.processed}, sent ${result.sent}, failed ${result.failed}.`
      );
    });
    console.log(
      `Email drain complete: processed ${totals.processed}, sent ${totals.sent}, failed ${totals.failed}; `
      + `${summary.failed.length} tenant(s) could not be processed.`
    );
    if (summary.failed.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error("Email drain job failed.", error);
  process.exitCode = 1;
});
