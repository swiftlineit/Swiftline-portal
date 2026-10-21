import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  throw new Error("Only --apply is accepted.");
}

async function main() {
  if (!apply) {
    console.log("Dry run: would create Tenant, TenantSlug and TenantMembership indexes. Use --apply after review.");
    return;
  }
  await mongoose.connect(env.MONGODB_URI, { family: 4, autoIndex: false, autoCreate: false });
  try {
    await Tenant.createIndexes();
    await TenantSlug.createIndexes();
    await TenantMembership.createIndexes();
    console.log("Tenant registry indexes created.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
