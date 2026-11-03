import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { assertExpectedDatabaseName, assertNonProductionEnvironment } from "./migrationSafety.js";

const swiftlineTenant = {
  kind: "SWIFTLINE" as const,
  status: "ACTIVE" as const,
  companyName: "Swiftline Cargo and Express Logistics",
  slug: "swiftline"
};

function parseArguments(args: string[]) {
  const apply = args.includes("--apply");
  const remaining = args.filter((argument) => argument !== "--apply");
  if (remaining.length !== 2 || remaining[0] !== "--database" || !remaining[1]?.trim()) {
    throw new Error("Usage: npm run migrate:swiftline-root-ownership -- --database <expected-database-name> [--apply]");
  }
  return { apply, expectedDatabase: remaining[1].trim() };
}

function missingTenantFilter() {
  return { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

async function inspectRootTenant(expectedDatabase: string) {
  const roots = await Tenant.find({ kind: "SWIFTLINE" }).lean().exec();
  if (roots.length > 1) throw new Error("More than one Swiftline tenant exists; no data was changed.");
  const root = roots[0];
  if (root && (root.status !== "ACTIVE" || root.slug !== swiftlineTenant.slug)) {
    throw new Error("The existing Swiftline tenant is not active with the reserved swiftline slug; no data was changed.");
  }

  const slugOwner = await Tenant.findOne({ slug: swiftlineTenant.slug }).lean().exec();
  if (slugOwner && (!root || !slugOwner._id.equals(root._id))) {
    throw new Error("The reserved swiftline tenant slug belongs to another tenant; no data was changed.");
  }
  const slugMapping = await TenantSlug.findOne({ slug: swiftlineTenant.slug }).lean().exec();
  if (slugMapping && (!root || !slugMapping.tenantId.equals(root._id) || !slugMapping.isCurrent)) {
    throw new Error("The reserved swiftline slug mapping conflicts with the Swiftline tenant; no data was changed.");
  }

  const [accounts, branches, nonDraftOperatorTenants] = await Promise.all([
    inspectOwnership(BusinessAccount, root?._id),
    inspectOwnership(Branch, root?._id),
    Tenant.countDocuments({ kind: "OPERATOR", status: { $in: ["ACTIVE", "SUSPENDED"] } }).exec()
  ]);

  return {
    database: expectedDatabase,
    swiftlineTenantExists: Boolean(root),
    currentSlugMappingExists: Boolean(slugMapping),
    nonDraftOperatorTenants,
    accounts,
    branches
  };
}

async function inspectOwnership(
  model: mongoose.Model<any>,
  tenantId?: mongoose.Types.ObjectId
) {
  const [total, missing, conflicting] = await Promise.all([
    model.collection.countDocuments({}),
    model.collection.countDocuments(missingTenantFilter()),
    tenantId
      ? model.collection.countDocuments({
          $and: [
            { tenantId: { $exists: true, $ne: null } },
            { tenantId: { $ne: tenantId } }
          ]
        })
      : model.collection.countDocuments({ tenantId: { $exists: true, $ne: null } })
  ]);
  if (conflicting > 0) throw new Error(`${model.modelName} contains ${conflicting} conflicting tenant assignment(s); no data was changed.`);
  return { total, missing, conflicting };
}

async function applyMigration() {
  await Tenant.createIndexes();
  await TenantSlug.createIndexes();
  await TenantMembership.createIndexes();
  await BusinessAccount.collection.createIndex({ tenantId: 1 }, { name: "business_account_tenant" });
  await Branch.collection.createIndex({ tenantId: 1 }, { name: "branch_tenant" });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      let root = await Tenant.findOne({ kind: "SWIFTLINE" }).session(session).exec();
      const rootAlreadyExisted = Boolean(root);
      const nonDraftOperatorTenants = await Tenant.countDocuments({
        kind: "OPERATOR",
        status: { $in: ["ACTIVE", "SUSPENDED"] }
      })
        .session(session)
        .exec();
      if (!rootAlreadyExisted && nonDraftOperatorTenants > 0) {
        throw new Error("A non-draft operator exists before Swiftline ownership is initialized; no data was changed.");
      }

      if (rootAlreadyExisted) {
        const [unassignedAccounts, unassignedBranches] = await Promise.all([
          BusinessAccount.collection.countDocuments(missingTenantFilter(), { session }),
          Branch.collection.countDocuments(missingTenantFilter(), { session })
        ]);
        if (unassignedAccounts > 0 || unassignedBranches > 0) {
          throw new Error("The Swiftline tenant already exists but unassigned accounts or branches remain; refusing to assign them automatically.");
        }
      }

      if (!root) {
        const [createdRoot] = await Tenant.create([{ ...swiftlineTenant, createdBy: null }], { session });
        root = createdRoot ?? null;
      }
      if (!root) throw new Error("Swiftline tenant was not created.");

      const slugMapping = await TenantSlug.findOne({ slug: swiftlineTenant.slug }).session(session).exec();
      if (!slugMapping) {
        await TenantSlug.create([{ slug: swiftlineTenant.slug, tenantId: root._id, isCurrent: true }], { session });
      } else if (!slugMapping.tenantId.equals(root._id) || !slugMapping.isCurrent) {
        throw new Error("The reserved swiftline slug mapping changed during migration.");
      }

      // Raw collection updates intentionally bypass Mongoose's immutable-path
      // guard. Application writes cannot change tenantId; only this migration can.
      await BusinessAccount.collection.updateMany(missingTenantFilter(), { $set: { tenantId: root._id } }, { session });
      await Branch.collection.updateMany(missingTenantFilter(), { $set: { tenantId: root._id } }, { session });

      const [missingAccounts, missingBranches, conflictingAccounts, conflictingBranches] = await Promise.all([
        BusinessAccount.collection.countDocuments(missingTenantFilter(), { session }),
        Branch.collection.countDocuments(missingTenantFilter(), { session }),
        BusinessAccount.collection.countDocuments({
          $and: [{ tenantId: { $exists: true, $ne: null } }, { tenantId: { $ne: root._id } }]
        }, { session }),
        Branch.collection.countDocuments({
          $and: [{ tenantId: { $exists: true, $ne: null } }, { tenantId: { $ne: root._id } }]
        }, { session })
      ]);
      if (missingAccounts || missingBranches || conflictingAccounts || conflictingBranches) {
        throw new Error("Tenant assignments were incomplete or conflicted inside the migration transaction.");
      }
    });
  } finally {
    await session.endSession();
  }
}

async function run() {
  assertNonProductionEnvironment(env.NODE_ENV, "Swiftline root ownership migration");
  const { apply, expectedDatabase } = parseArguments(process.argv.slice(2));
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(env.MONGODB_URI, {
    family: 4,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000
  });

  try {
    const actualDatabase = mongoose.connection.db?.databaseName;
    assertExpectedDatabaseName(expectedDatabase, actualDatabase);

    const before = await inspectRootTenant(expectedDatabase);
    console.log(`Database: ${before.database}`);
    console.log(`Swiftline tenant exists: ${before.swiftlineTenantExists}`);
    console.log(`Current swiftline slug mapping exists: ${before.currentSlugMappingExists}`);
    console.log(`Non-draft operator tenants: ${before.nonDraftOperatorTenants}`);
    console.log(`Business accounts: ${before.accounts.total}; missing tenant: ${before.accounts.missing}; conflicts: ${before.accounts.conflicting}`);
    console.log(`Branches: ${before.branches.total}; missing tenant: ${before.branches.missing}; conflicts: ${before.branches.conflicting}`);
    if (!apply) {
      console.log("Dry run only. Pass --apply to create the Swiftline tenant and assign existing accounts and branches.");
      return;
    }

    if (before.swiftlineTenantExists && (before.accounts.missing > 0 || before.branches.missing > 0)) {
      throw new Error("The Swiftline tenant already exists but unassigned accounts or branches remain; refusing to assign them automatically.");
    }
    if (!before.swiftlineTenantExists && before.nonDraftOperatorTenants > 0) {
      throw new Error("A non-draft operator exists before Swiftline ownership is initialized; no data was changed.");
    }

    await applyMigration();
    const after = await inspectRootTenant(expectedDatabase);
    if (!after.swiftlineTenantExists || !after.currentSlugMappingExists || after.accounts.missing || after.branches.missing) {
      throw new Error("Post-migration verification failed. Rerun the dry-run audit and review database state.");
    }
    console.log(`Applied. Swiftline tenant and slug are active; ${after.accounts.total} business account(s) and ${after.branches.total} branch(es) have tenant ownership.`);
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Swiftline tenant ownership migration failed.");
  process.exitCode = 1;
});
