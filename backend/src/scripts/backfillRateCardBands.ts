import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard, rateCardBandValues } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { FeatureMigration } from "../models/featureMigration.model.js";
import { RateCardMutationLock } from "../models/rateCardMutationLock.model.js";
import { RateCardShare } from "../models/rateCardShare.model.js";

const MIGRATION_ID = "MULTI_RATE_CARD_BANDS_V1";
const applyChanges = process.argv.includes("--apply");

type Slab = {
  _id: mongoose.Types.ObjectId;
  band?: string;
  countryCode: string;
  service: string;
  fromKg: number;
  toKg: number;
};

function findSlabConflicts(slabs: Slab[]) {
  const byRoute = new Map<string, Slab[]>();
  for (const slab of slabs) {
    const key = [slab.band ?? "BAND_A", slab.countryCode, slab.service].join(":");
    byRoute.set(key, [...(byRoute.get(key) ?? []), slab]);
  }

  const exactDuplicates: Array<{ route: string; firstRateId: string; secondRateId: string }> = [];
  const overlaps: Array<{ route: string; firstRateId: string; secondRateId: string }> = [];

  for (const [route, routeSlabs] of byRoute.entries()) {
    const ordered = routeSlabs.sort((left, right) => left.fromKg - right.fromKg || left.toKg - right.toKg);
    ordered.forEach((current, index) => {
      for (const previous of ordered.slice(0, index)) {
        if (current.fromKg > previous.toKg) continue;
        const conflict = { route, firstRateId: String(previous._id), secondRateId: String(current._id) };
        if (current.fromKg === previous.fromKg && current.toKg === previous.toKg) {
          exactDuplicates.push(conflict);
        } else {
          overlaps.push(conflict);
        }
      }
    });
  }

  return { exactDuplicates, overlaps };
}

async function auditRateCardBands() {
  const [slabs, missingRates, missingRouteCharges, missingAccountBands, missingShareBands, invalidRates, invalidRouteCharges, invalidAccountBands, invalidShareBands, sentinel] = await Promise.all([
    CountryRateCard.find({}).select("band countryCode service fromKg toKg").lean().exec() as Promise<Slab[]>,
    CountryRateCard.countDocuments({ band: { $exists: false } }).exec(),
    CountryRouteCharge.countDocuments({ band: { $exists: false } }).exec(),
    BusinessAccount.countDocuments({
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" },
      rateCardBand: { $exists: false }
    }).exec(),
    RateCardShare.collection.countDocuments({ band: { $exists: false } }),
    CountryRateCard.countDocuments({ band: { $exists: true, $nin: rateCardBandValues } }).exec(),
    CountryRouteCharge.countDocuments({ band: { $exists: true, $nin: rateCardBandValues } }).exec(),
    BusinessAccount.countDocuments({
      rateCardBand: { $exists: true, $ne: null, $nin: rateCardBandValues }
    }).exec(),
    RateCardShare.collection.countDocuments({ band: { $exists: true, $nin: rateCardBandValues } }),
    BusinessAccount.findOne({ accountKind: "INDIVIDUAL_SENTINEL" }).select("_id rateCardBand").lean().exec()
  ]);

  const duplicateRouteCharges = await CountryRouteCharge.aggregate<{
    _id: { band: string; countryCode: string; service: string };
    count: number;
    ids: mongoose.Types.ObjectId[];
  }>([
    {
      $group: {
        _id: {
          band: { $ifNull: ["$band", "BAND_A"] },
          countryCode: "$countryCode",
          service: "$service"
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).exec();

  const legacyRouteChargeIndex = (await CountryRouteCharge.collection.indexes()).find((index) =>
    index.unique && index.key?.countryCode === 1 && index.key?.service === 1 && !("band" in index.key)
  );

  const slabConflicts = findSlabConflicts(slabs);
  return {
    mode: applyChanges ? "APPLY" : "DRY_RUN",
    migrationId: MIGRATION_ID,
    wouldChange: {
      rates: missingRates,
      routeCharges: missingRouteCharges,
      businessAccounts: missingAccountBands,
      shares: missingShareBands,
      sentinel: sentinel && sentinel.rateCardBand !== "BAND_D" ? 1 : 0
    },
    conflicts: {
      exactDuplicateSlabs: slabConflicts.exactDuplicates,
      overlappingSlabs: slabConflicts.overlaps,
      duplicateRouteCharges: duplicateRouteCharges.map((entry) => ({
        route: [entry._id.band, entry._id.countryCode, entry._id.service].join(":"),
        ids: entry.ids.map(String)
      })),
      invalidBands: {
        rates: invalidRates,
        routeCharges: invalidRouteCharges,
        businessAccounts: invalidAccountBands,
        shares: invalidShareBands
      }
    },
    legacyRouteChargeIndex: legacyRouteChargeIndex?.name ?? null
  };
}

function hasConflicts(report: Awaited<ReturnType<typeof auditRateCardBands>>) {
  const invalid = report.conflicts.invalidBands;
  return report.conflicts.overlappingSlabs.length > 0
    || report.conflicts.exactDuplicateSlabs.length > 0
    || report.conflicts.duplicateRouteCharges.length > 0
    || Object.values(invalid).some((count) => count > 0);
}

async function backfillRateCardBands() {
  await connectDatabase();
  try {
    const report = await auditRateCardBands();
    console.log("Rate-card band migration audit.", JSON.stringify(report, null, 2));

    if (!applyChanges) {
      console.log("Dry run only. Re-run with --apply after reviewing this report.");
      return;
    }
    if (hasConflicts(report)) {
      throw new Error("Migration stopped because rate-card conflicts require manual review.");
    }

    const [rates, routeCharges, accounts, shares, sentinel] = await Promise.all([
      CountryRateCard.updateMany({ band: { $exists: false } }, { $set: { band: "BAND_A" } }).exec(),
      CountryRouteCharge.updateMany({ band: { $exists: false } }, { $set: { band: "BAND_A" } }).exec(),
      BusinessAccount.updateMany(
        { accountKind: { $ne: "INDIVIDUAL_SENTINEL" }, rateCardBand: { $exists: false } },
        { $set: { rateCardBand: "BAND_A" } }
      ).exec(),
      RateCardShare.collection.updateMany({ band: { $exists: false } }, { $set: { band: "BAND_A" } }),
      BusinessAccount.updateMany(
        { accountKind: "INDIVIDUAL_SENTINEL", rateCardBand: { $ne: "BAND_D" } },
        { $set: { rateCardBand: "BAND_D" } }
      ).exec()
    ]);

    if (report.legacyRouteChargeIndex) {
      await CountryRouteCharge.collection.dropIndex(report.legacyRouteChargeIndex);
    }

    await Promise.all([
      CountryRateCard.createIndexes(),
      CountryRouteCharge.createIndexes(),
      BusinessAccount.createIndexes(),
      RateCardShare.createIndexes(),
      RateCardMutationLock.createIndexes()
    ]);

    const applied = {
      rates: rates.modifiedCount,
      routeCharges: routeCharges.modifiedCount,
      businessAccounts: accounts.modifiedCount,
      shares: shares.modifiedCount,
      sentinel: sentinel.modifiedCount
    };
    const verification = await auditRateCardBands();
    const missingAfterApply = Object.values(verification.wouldChange).some((count) => count > 0);
    if (hasConflicts(verification) || missingAfterApply || verification.legacyRouteChargeIndex) {
      throw new Error("Post-migration verification failed. Review the audit output before enabling Band B or Band C.");
    }
    await FeatureMigration.findByIdAndUpdate(
      MIGRATION_ID,
      { $set: { appliedAt: new Date(), report: { applied, verification } } },
      { upsert: true, runValidators: true }
    ).exec();

    console.log("Rate-card band migration complete.", { applied, verification });
  } finally {
    await mongoose.disconnect();
  }
}

backfillRateCardBands().catch((error) => {
  console.error("Rate-card band migration failed.", error);
  process.exitCode = 1;
});
