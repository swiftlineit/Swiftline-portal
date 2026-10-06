import mongoose from "mongoose";
import { isDeepStrictEqual } from "node:util";
import { connectDatabase } from "../config/database.js";

const apply = process.argv.includes("--apply");
const COLLECTION = "dpdshipments";
type CarrierReferenceIndex = {
  name: string;
  key: Record<string, 1>;
  partialFilterExpression: Record<string, unknown>;
  collation?: { locale: string; strength: 2 };
};
const indexDefinitions: CarrierReferenceIndex[] = [
  {
    name: "uniq_dpd_carrier_awb",
    key: { dpdShipmentId: 1 as const },
    partialFilterExpression: { dpdShipmentId: { $type: "string", $gt: "" } }
  },
  {
    name: "uniq_dpd_carrier_forwarding_number",
    key: { forwardingNumber: 1 as const },
    partialFilterExpression: { forwardingNumber: { $type: "string", $gt: "" } },
    collation: { locale: "en", strength: 2 as const }
  }
];

function sameKey(actual: Record<string, unknown> | undefined, expected: Record<string, 1>) {
  if (!actual) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length
    && expectedEntries.every(([field, direction], index) => {
      const entry = actualEntries[index];
      return entry?.[0] === field && entry[1] === direction;
    });
}

function matchesDefinition(actual: Record<string, unknown>, expected: (typeof indexDefinitions)[number]) {
  const partial = actual.partialFilterExpression as Record<string, unknown> | undefined;
  const collation = actual.collation as { locale?: string; strength?: number } | undefined;
  return sameKey(actual.key as Record<string, unknown>, expected.key)
    && actual.unique === true
    && isDeepStrictEqual(partial, expected.partialFilterExpression)
    && (expected.collation
      ? collation?.locale === expected.collation.locale && collation.strength === expected.collation.strength
      : !collation);
}

async function duplicateReferences(field: "dpdShipmentId" | "forwardingNumber", caseInsensitive = false) {
  const trimmed = { $trim: { input: `$${field}` } };
  const groupKey = caseInsensitive ? { $toUpper: trimmed } : trimmed;
  return mongoose.connection.collection(COLLECTION).aggregate([
    { $match: { [field]: { $type: "string", $gt: "" } } },
    {
      $group: {
        _id: groupKey,
        count: { $sum: 1 },
        shipmentIds: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 }
  ]).toArray();
}

async function auditIndexes() {
  try {
    return await mongoose.connection.collection(COLLECTION).listIndexes().toArray();
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

async function migrate() {
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await connectDatabase();
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);

  try {
    const [duplicateAwbs, duplicateForwardingNumbers, existingIndexes] = await Promise.all([
      duplicateReferences("dpdShipmentId"),
      duplicateReferences("forwardingNumber", true),
      auditIndexes()
    ]);
    const missing = indexDefinitions.filter((definition) => {
      const sameName = existingIndexes.find((index) => index.name === definition.name);
      if (sameName) {
        if (!matchesDefinition(sameName as unknown as Record<string, unknown>, definition)) {
          throw new Error(`${COLLECTION}.${definition.name} exists with incompatible options. Review it manually; nothing was changed.`);
        }
        return false;
      }
      const existingWithSameKey = existingIndexes.find((index) => sameKey(index.key as Record<string, unknown>, definition.key));
      if (existingWithSameKey) {
        if (!matchesDefinition(existingWithSameKey as unknown as Record<string, unknown>, definition)) {
          throw new Error(`${COLLECTION} already has an incompatible index on ${Object.keys(definition.key)[0]}. Review it manually; nothing was changed.`);
        }
        return false;
      }
      return true;
    });

    console.log("DPD carrier-reference index audit.", {
      database: mongoose.connection.name,
      apply,
      duplicateAwbs,
      duplicateForwardingNumberGroups: duplicateForwardingNumbers,
      existingExpectedIndexes: indexDefinitions.length - missing.length,
      missingExpectedIndexes: missing.map((definition) => definition.name)
    });

    if (duplicateAwbs.length || duplicateForwardingNumbers.length) {
      throw new Error("Resolve duplicate carrier references before creating unique indexes. Nothing was changed.");
    }
    if (!apply) {
      console.log("Dry run only. Re-run with --apply to create the missing unique indexes.");
      return;
    }

    for (const definition of missing) {
      await mongoose.connection.collection(COLLECTION).createIndex(definition.key, {
        unique: true,
        name: definition.name,
        partialFilterExpression: definition.partialFilterExpression,
        ...(definition.collation ? { collation: definition.collation } : {})
      });
      console.log(`Created ${COLLECTION}.${definition.name}.`);
    }

    const verifiedIndexes = await auditIndexes();
    const unverified = indexDefinitions.filter((definition) => !verifiedIndexes.some(
      (index) => matchesDefinition(index as unknown as Record<string, unknown>, definition)
    ));
    if (unverified.length) {
      throw new Error(`Index creation could not be verified: ${unverified.map((definition) => definition.name).join(", ")}.`);
    }
    console.log("Verified all DPD carrier-reference unique indexes.");
  } finally {
    await mongoose.disconnect();
  }
}

migrate().catch((error) => {
  console.error("DPD carrier-reference index migration failed.", error);
  process.exitCode = 1;
});
