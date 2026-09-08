import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

const apply = process.argv.includes("--apply");

const indexDefinitions = [
  {
    collection: "shipmentdrafts",
    name: "shipmentDraft_live_createdAt_desc",
    key: { deletedAt: 1, createdAt: -1 }
  },
  {
    collection: "shipmentdrafts",
    name: "shipmentDraft_account_branch_live_createdAt_desc",
    key: { businessAccountId: 1, branchId: 1, deletedAt: 1, createdAt: -1 }
  },
  {
    collection: "shipmentdrafts",
    name: "shipmentDraft_account_live_updatedAt_desc",
    key: { businessAccountId: 1, deletedAt: 1, updatedAt: -1 }
  },
  {
    collection: "dpdshipments",
    name: "dpdShipment_createdAt_desc",
    key: { createdAt: -1 }
  },
  {
    collection: "dpdshipments",
    name: "dpdShipment_status_createdAt_desc",
    key: { status: 1, createdAt: -1 }
  },
  {
    collection: "dpdshipments",
    name: "dpdShipment_status_draft",
    key: { status: 1, shipmentDraftId: 1 }
  },
  {
    collection: "shipmentevents",
    name: "shipmentEvent_draft_event_created_desc",
    key: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 }
  }
] as const;

async function existingIndexes(collectionName: string) {
  try {
    return new Set(
      (await mongoose.connection.collection(collectionName).listIndexes().toArray())
        .map((index) => index.name)
        .filter((name): name is string => Boolean(name))
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.codeName === "NamespaceNotFound") {
      return new Set<string>();
    }
    throw error;
  }
}

async function migrateShipmentPerformanceIndexes() {
  // Indexes are created only by this explicit migration, never implicitly at
  // API boot. That keeps a production deploy from building several indexes on
  // the request-serving process.
  mongoose.set("autoIndex", false);
  await connectDatabase();

  try {
    const existingByCollection = new Map<string, Set<string>>();
    for (const definition of indexDefinitions) {
      if (!existingByCollection.has(definition.collection)) {
        existingByCollection.set(definition.collection, await existingIndexes(definition.collection));
      }
    }

    const missing = indexDefinitions.filter((definition) => (
      !existingByCollection.get(definition.collection)?.has(definition.name)
    ));
    console.log("Shipment performance index audit.", {
      apply,
      existing: indexDefinitions.length - missing.length,
      missing: missing.map((definition) => `${definition.collection}.${definition.name}`)
    });

    if (!apply) {
      console.log("Dry run only. Re-run with --apply during a maintenance window to create the missing additive indexes.");
      return;
    }

    for (const definition of missing) {
      await mongoose.connection.collection(definition.collection).createIndex(definition.key, { name: definition.name });
      console.log(`Created ${definition.collection}.${definition.name}.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

migrateShipmentPerformanceIndexes().catch((error) => {
  console.error("Shipment performance index migration failed.", error);
  process.exitCode = 1;
});
