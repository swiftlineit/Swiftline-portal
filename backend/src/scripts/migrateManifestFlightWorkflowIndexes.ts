import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";

const apply = process.argv.includes("--apply");

type IndexDefinition = {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
};

const indexDefinitions: IndexDefinition[] = [
  {
    collection: "flightlinehauls",
    name: "idx_flight_auto_departure_due",
    key: {
      status: 1,
      scheduledDepartureAutomationEnabled: 1,
      scheduledDepartureAt: 1
    }
  },
  {
    collection: "operationsmanifestarchives",
    name: "idx_operations_manifest_archive_branch_archived",
    key: {
      branchId: 1,
      archivedAt: -1
    }
  }
];

function sameIndexKey(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, 1 | -1>
) {
  if (!actual) return false;

  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  if (actualEntries.length !== expectedEntries.length) return false;

  return expectedEntries.every(([field, direction], index) => {
    const actualEntry = actualEntries[index];
    return actualEntry?.[0] === field && actualEntry[1] === direction;
  });
}

async function existingIndexes(collectionName: string) {
  try {
    return await mongoose.connection
      .collection(collectionName)
      .listIndexes()
      .toArray();
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.codeName === "NamespaceNotFound"
    ) {
      return [];
    }

    throw error;
  }
}

async function migrate() {
  // This script manages indexes explicitly; never ask Mongoose to build them.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);

  await connectDatabase();

  // connectDatabase applies runtime defaults, so restore explicit-migration mode.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);

  try {
    const missing: IndexDefinition[] = [];

    for (const definition of indexDefinitions) {
      const indexes = await existingIndexes(definition.collection);
      const existingByName = indexes.find((index) => index.name === definition.name);

      if (existingByName) {
        if (!sameIndexKey(existingByName.key as Record<string, unknown>, definition.key)) {
          throw new Error(
            `${definition.collection}.${definition.name} exists with a different key definition. Review it manually; nothing was changed.`
          );
        }

        continue;
      }

      missing.push(definition);
    }

    console.log("Manifest / flight workflow index audit.", {
      apply,
      existing: indexDefinitions.length - missing.length,
      missing: missing.map((definition) => `${definition.collection}.${definition.name}`)
    });

    if (!apply) {
      console.log("Dry run only. Re-run with --apply to create missing additive indexes.");
      return;
    }

    for (const definition of missing) {
      await mongoose.connection
        .collection(definition.collection)
        .createIndex(definition.key, { name: definition.name });

      console.log(`Created ${definition.collection}.${definition.name}.`);
    }

    console.log("Manifest / flight workflow index migration complete.");
  } finally {
    await mongoose.disconnect();
  }
}

migrate().catch((error) => {
  console.error("Manifest / flight workflow index migration failed.", error);
  process.exitCode = 1;
});
