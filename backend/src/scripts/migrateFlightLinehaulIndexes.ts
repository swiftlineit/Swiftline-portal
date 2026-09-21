import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { orphanedFlightCostSheetPipeline } from "../services/flightLinehaulIndexMigration.service.js";

const apply = process.argv.includes("--apply");
const ACTIVE_MANIFEST_STATUSES = ["DRAFT", "PACKING", "READY_TO_SEAL", "SEALED", "DISPATCHED"];
const MANIFEST_INDEX_NAME = "uniq_active_manifest_per_flight";
const ACTIVE_ALLOCATION_INDEX_NAME = "uniq_active_flight_shipment";
const LEGACY_ALLOCATION_INDEX_NAME = "uniq_flight_shipment";
const FLIGHT_MAWB_INDEX_NAME = "uniq_active_flight_mawb";
const FLIGHT_COST_SHEET_INDEX_NAME = "uniq_flight_cost_sheet_per_flight";

async function duplicateActiveManifests() {
  return mongoose.connection.collection("operationsmanifests").aggregate([
    {
      $match: {
        flightLinehaulId: { $type: "objectId" },
        status: { $in: ACTIVE_MANIFEST_STATUSES }
      }
    },
    {
      $group: {
        _id: "$flightLinehaulId",
        count: { $sum: 1 },
        manifestNumbers: { $push: "$manifestNumber" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
}

async function duplicateActiveAllocations() {
  return mongoose.connection.collection("flightshipmentallocations").aggregate([
    { $match: { status: "ALLOCATED" } },
    {
      $group: {
        _id: { flightLinehaulId: "$flightLinehaulId", shipmentDraftId: "$shipmentDraftId" },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
}

async function duplicateFlightCostSheets() {
  return mongoose.connection.collection("flightcostsheets").aggregate([
    {
      $lookup: {
        from: "operationsmanifests",
        localField: "operationsManifestId",
        foreignField: "_id",
        as: "manifest"
      }
    },
    { $unwind: "$manifest" },
    { $match: { "manifest.flightLinehaulId": { $type: "objectId" } } },
    {
      $group: {
        _id: "$manifest.flightLinehaulId",
        count: { $sum: 1 },
        sheetIds: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
}

async function orphanedFlightCostSheets() {
  return mongoose.connection.collection("flightcostsheets")
    .aggregate(orphanedFlightCostSheetPipeline())
    .toArray();
}

async function attachedFlightCostSheetMappings() {
  return mongoose.connection.collection("flightcostsheets").aggregate([
    {
      $lookup: {
        from: "operationsmanifests",
        localField: "operationsManifestId",
        foreignField: "_id",
        as: "manifest"
      }
    },
    { $unwind: "$manifest" },
    { $match: { "manifest.flightLinehaulId": { $type: "objectId" } } },
    { $project: { _id: 1, flightLinehaulId: "$manifest.flightLinehaulId" } }
  ]).toArray();
}

async function existingIndexNames(collectionName: string) {
  try {
    return (await mongoose.connection.collection(collectionName).listIndexes().toArray())
      .map((index) => index.name)
      .filter((name): name is string => Boolean(name));
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

async function migrate() {
  mongoose.set("autoIndex", false);
  await connectDatabase();
  try {
    const duplicates = await duplicateActiveManifests();
    const duplicateAllocations = await duplicateActiveAllocations();
    const duplicateCostSheets = await duplicateFlightCostSheets();
    const orphanedCostSheets = await orphanedFlightCostSheets();
    console.log("Flight linehaul index audit.", {
      apply,
      duplicateManifestGroups: duplicates,
      duplicateAllocationGroups: duplicateAllocations,
      duplicateFlightCostSheetGroups: duplicateCostSheets,
      orphanedCostSheets
    });
    if (duplicates.length || duplicateAllocations.length || duplicateCostSheets.length) {
      throw new Error("Resolve duplicate active manifests/allocations/cost sheets before creating the unique indexes. Nothing was changed.");
    }
    if (orphanedCostSheets.length && apply) {
      throw new Error("Resolve orphaned flight cost sheets before applying the unique flight cost-sheet index. Nothing was changed.");
    }
    if (!apply) {
      console.log(`Dry run passed. Re-run with --apply to create or repair ${MANIFEST_INDEX_NAME}, ${ACTIVE_ALLOCATION_INDEX_NAME}, and ${FLIGHT_COST_SHEET_INDEX_NAME}, and remove the retired ${FLIGHT_MAWB_INDEX_NAME} constraint.`);
      return;
    }

    const allocationIndexes = await existingIndexNames("flightshipmentallocations");
    if (allocationIndexes.includes(LEGACY_ALLOCATION_INDEX_NAME)) {
      await mongoose.connection.collection("flightshipmentallocations").dropIndex(LEGACY_ALLOCATION_INDEX_NAME);
      console.log(`Dropped legacy ${LEGACY_ALLOCATION_INDEX_NAME}.`);
    }

    const flightIndexes = await existingIndexNames("flightlinehauls");
    if (flightIndexes.includes(FLIGHT_MAWB_INDEX_NAME)) {
      await mongoose.connection.collection("flightlinehauls").dropIndex(FLIGHT_MAWB_INDEX_NAME);
      console.log(`Dropped retired ${FLIGHT_MAWB_INDEX_NAME}.`);
    }

    await mongoose.connection.collection("operationsmanifests").createIndex(
      { flightLinehaulId: 1 },
      {
        unique: true,
        name: MANIFEST_INDEX_NAME,
        partialFilterExpression: {
          flightLinehaulId: { $type: "objectId" },
          status: { $in: ACTIVE_MANIFEST_STATUSES }
        }
      }
    );
    await mongoose.connection.collection("flightshipmentallocations").createIndex(
      { flightLinehaulId: 1, shipmentDraftId: 1 },
      {
        unique: true,
        name: ACTIVE_ALLOCATION_INDEX_NAME,
        partialFilterExpression: { status: "ALLOCATED" }
      }
    );
    const costSheetMappings = await attachedFlightCostSheetMappings();
    if (costSheetMappings.length) {
      await mongoose.connection.collection("flightcostsheets").bulkWrite(
        costSheetMappings.map((sheet) => ({
          updateOne: {
            filter: { _id: sheet._id },
            update: { $set: { flightLinehaulId: sheet.flightLinehaulId } }
          }
        }))
      );
    }
    await mongoose.connection.collection("flightcostsheets").createIndex(
      { flightLinehaulId: 1 },
      {
        unique: true,
        name: FLIGHT_COST_SHEET_INDEX_NAME,
        partialFilterExpression: { flightLinehaulId: { $type: "objectId" } }
      }
    );
    console.log(`Created or confirmed ${MANIFEST_INDEX_NAME}, ${ACTIVE_ALLOCATION_INDEX_NAME}, and ${FLIGHT_COST_SHEET_INDEX_NAME}.`);
  } finally {
    await mongoose.disconnect();
  }
}

migrate().catch((error) => {
  console.error("Flight linehaul index migration failed.", error);
  process.exitCode = 1;
});
