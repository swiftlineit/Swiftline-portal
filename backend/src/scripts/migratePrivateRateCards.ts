import mongoose from "mongoose";
import { env } from "../config/env.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { RateCardShare } from "../models/rateCardShare.model.js";
import { User } from "../models/user.model.js";
import { auditPrivateRateCardAccount, migratePrivateRateCardAccount } from "../services/privateRateCardMigration.service.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const accountIds = args.filter((arg) => arg.startsWith("--account-id=")).map((arg) => arg.slice("--account-id=".length));
const actorArg = args.find((arg) => arg.startsWith("--actor-id="))?.slice("--actor-id=".length);
if (args.some((arg) => arg !== "--apply" && !arg.startsWith("--account-id=") && !arg.startsWith("--actor-id="))) throw new Error("Only --apply, --account-id=BA-..., and --actor-id=<active-admin-id> are accepted.");
if (new Set(accountIds).size !== accountIds.length) throw new Error("Do not repeat a --account-id.");
if (apply && (!actorArg || !mongoose.Types.ObjectId.isValid(actorArg))) throw new Error("--apply requires --actor-id=<active-admin-id> so the migration is attributed correctly.");
if (actorArg && !mongoose.Types.ObjectId.isValid(actorArg)) throw new Error("--actor-id must be a valid user id.");

async function main() {
  // Dry runs never create collections/indexes or write data, even in development.
  await mongoose.connect(env.MONGODB_URI, { family: 4, autoIndex: false, autoCreate: false });
  try {
    const accounts = await BusinessAccount.find({ accountKind: { $ne: "INDIVIDUAL_SENTINEL" }, ...(accountIds.length ? { accountId: { $in: accountIds } } : {}) })
      .select("_id accountId").sort({ accountId: 1 }).lean().exec();
    if (accountIds.length && accounts.length !== new Set(accountIds).size) throw new Error("An allowlisted business account was not found.");
    const actor = apply ? await User.findOne({ _id: actorArg, role: "admin", userStatus: "active" }).select("_id").lean().exec() : null;
    if (apply && !actor) throw new Error("The migration actor must be an active admin user.");
    const report = [];
    for (const account of accounts) report.push(await auditPrivateRateCardAccount(account._id));
    console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", accounts: report }, null, 2));
    if (!apply) return;
    const actorId = actor!._id;
    // Build the replacement constraint before retiring the old shared-band key.
    await CountryRouteCharge.collection.createIndex({ businessAccountId: 1, band: 1, countryCode: 1, service: 1 }, { unique: true, name: "rate_card_owner_route_unique" });
    const indexes = await CountryRouteCharge.collection.indexes();
    for (const index of indexes) {
      if (index.unique && Object.keys(index.key).length === 3 && index.key.band === 1 && index.key.countryCode === 1 && index.key.service === 1 && index.name) {
        await CountryRouteCharge.collection.dropIndex(index.name);
      }
    }
    await CountryRateCard.createIndexes();
    await CountryRouteCharge.createIndexes();
    await RateCardShare.createIndexes();
    for (const item of report) {
      if (item.state === "ALREADY_PRIVATE") continue;
      await migratePrivateRateCardAccount(new mongoose.Types.ObjectId(item.id), item.checksum!, actor!._id);
      const verified = await auditPrivateRateCardAccount(new mongoose.Types.ObjectId(item.id));
      if (verified.state !== "ALREADY_PRIVATE") throw new Error("Post-migration verification failed: " + item.accountId);
      console.log("Verified private rate card:", item.accountId);
    }
    console.log("Migration complete. Legacy bands and historical invoices/charges are retained; Individual Clients is unchanged.");
  } finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
