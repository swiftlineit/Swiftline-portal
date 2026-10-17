import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { flushOutboxRow } from "../services/email/dispatcher.js";
import { isMailConfigured } from "../services/email/transport.js";
import { pendingPickupReminderEmailFilter, runPickupDispatchReminderSweep } from "../services/pickup.service.js";

async function main() {
  await connectDatabase();
  try {
    const result = await runPickupDispatchReminderSweep();
    console.log(`Pickup dispatch reminder sweep complete: ${result.sent} queued from ${result.due} due request(s).`);
    // A cron process may exit before the usual unref'd post-enqueue timer fires.
    // Send this run's reminders after commit; the email drain retries failures.
    if (result.notifiedReminderKeys.length && isMailConfigured()) {
      let delivered = 0;
      for (const reminderKey of result.notifiedReminderKeys) {
        const rows = await EmailOutbox.find(pendingPickupReminderEmailFilter(reminderKey))
          .select("idempotencyKey").lean().exec();
        for (const row of rows) {
          const outcome = await flushOutboxRow(row.idempotencyKey);
          if (outcome.sent) delivered += 1;
        }
      }
      console.log(`Pickup reminder emails sent: ${delivered}.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("Pickup dispatch reminder sweep failed.", error);
  process.exitCode = 1;
});
