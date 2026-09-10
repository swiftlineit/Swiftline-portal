import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { FeatureMigration } from "../models/featureMigration.model.js";

const MIGRATION_ID = "INDIVIDUAL_RATE_CARD_BAND_D_V1";
const applyChanges = process.argv.includes("--apply");

/**
 * Moves only the system-owned individual-shipment sentinel to Band D. Existing
 * shipment pricing snapshots and invoices are not recalculated; this affects
 * future individual quotes/bookings only.
 */
async function migrateIndividualRateCardBand() {
  await connectDatabase();
  try {
    const sentinels = await BusinessAccount.find({ accountKind: "INDIVIDUAL_SENTINEL" })
      .select("_id accountId rateCardBand")
      .lean()
      .exec();
    const needsUpdate = sentinels.filter((account) => account.rateCardBand !== "BAND_D");
    const report = {
      mode: applyChanges ? "APPLY" : "DRY_RUN",
      migrationId: MIGRATION_ID,
      sentinelCount: sentinels.length,
      sentinelIds: sentinels.map((account) => String(account._id)),
      wouldChange: needsUpdate.length
    };
    console.log("Individual shipment rate-card migration audit.", JSON.stringify(report, null, 2));

    if (!applyChanges) {
      console.log("Dry run only. Re-run with --apply after reviewing this report.");
      return;
    }

    const result = await BusinessAccount.updateMany(
      { accountKind: "INDIVIDUAL_SENTINEL", rateCardBand: { $ne: "BAND_D" } },
      { $set: { rateCardBand: "BAND_D" } }
    ).exec();
    const verification = await BusinessAccount.find({ accountKind: "INDIVIDUAL_SENTINEL" })
      .select("_id accountId rateCardBand")
      .lean()
      .exec();
    const invalid = verification.filter((account) => account.rateCardBand !== "BAND_D");
    if (invalid.length > 0) {
      throw new Error(`Individual sentinel verification failed for ${invalid.length} account(s).`);
    }

    const applied = { modified: result.modifiedCount };
    await FeatureMigration.findByIdAndUpdate(
      MIGRATION_ID,
      { $set: { appliedAt: new Date(), report: { applied, verification } } },
      { upsert: true, runValidators: true }
    ).exec();
    console.log("Individual shipment rate-card migration complete.", { applied, verified: verification.length });
  } finally {
    await mongoose.disconnect();
  }
}

migrateIndividualRateCardBand().catch((error) => {
  console.error("Individual shipment rate-card migration failed.", error);
  process.exitCode = 1;
});
