import mongoose, { type Collection } from "mongoose";
import { connectDatabase } from "../config/database.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";

type ExplainResult = {
  executionStats?: {
    executionTimeMillis?: number;
    nReturned?: number;
    totalDocsExamined?: number;
    totalKeysExamined?: number;
  };
  queryPlanner?: {
    winningPlan?: { stage?: string; inputStage?: { stage?: string } };
  };
};

function report(label: string, result: ExplainResult) {
  const stats = result.executionStats ?? {};
  const plan = result.queryPlanner?.winningPlan;
  console.log(JSON.stringify({
    label,
    executionTimeMs: stats.executionTimeMillis ?? null,
    returned: stats.nReturned ?? null,
    docsExamined: stats.totalDocsExamined ?? null,
    keysExamined: stats.totalKeysExamined ?? null,
    stage: plan?.stage ?? null,
    inputStage: plan?.inputStage?.stage ?? null
  }));
}

async function explainFind(
  label: string,
  collection: Collection,
  filter: Record<string, unknown>,
  projection: Record<string, 0 | 1>,
  sort: Record<string, 1 | -1>,
  limit: number
) {
  const result = await collection
    .find(filter, { projection })
    .sort(sort)
    .limit(limit)
    .explain("executionStats") as ExplainResult;
  report(label, result);
}

async function explainAggregate(label: string, collection: Collection, pipeline: object[]) {
  const result = await collection.aggregate(pipeline).explain("executionStats") as ExplainResult;
  report(label, result);
}

type Database = {
  command(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  listCollections(filter?: Record<string, unknown>): { toArray(): Promise<Array<{ name: string }>> };
};

async function reportCollectionStats(database: Database, collection: Collection) {
  try {
    const stats = await database.command({ collStats: collection.collectionName });
    console.log(JSON.stringify({
      collection: collection.collectionName,
      documents: stats.count ?? null,
      storageBytes: stats.storageSize ?? null,
      indexBytes: stats.totalIndexSize ?? null,
      indexes: stats.nindexes ?? null
    }));
  } catch (error) {
    console.warn(`Could not read stats for ${collection.collectionName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function reportCollectionInventory(database: Database) {
  const collections = (await database.listCollections().toArray())
    .filter(({ name }) => !name.startsWith("system."));
  const inventory = await Promise.all(collections.map(async ({ name }) => {
    try {
      const stats = await database.command({ collStats: name });
      return {
        collection: name,
        documents: stats.count ?? null,
        storageBytes: stats.storageSize ?? null,
        indexBytes: stats.totalIndexSize ?? null,
        indexes: stats.nindexes ?? null
      };
    } catch (error) {
      return {
        collection: name,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));

  inventory.sort((left, right) => Number(right.storageBytes ?? 0) - Number(left.storageBytes ?? 0));
  console.log(JSON.stringify({ audit: "collection-inventory", mode: "read-only", collections: inventory }));
}

async function auditShipmentPerformance() {
  // This command is observational. Never let Mongoose build schema indexes as
  // a side effect of running an audit against any environment.
  mongoose.set("autoIndex", false);
  await connectDatabase();

  try {
    const database = mongoose.connection.db;
    if (!database) throw new Error("MongoDB connection is not ready.");

    const [draftSample, shipmentSample, eventDraftIds] = await Promise.all([
      ShipmentDraft.findOne({ deletedAt: null })
        .select("businessAccountId branchId")
        .lean()
        .exec(),
      DpdShipment.findOne({})
        .select("shipmentDraftId")
        .lean()
        .exec(),
      DpdShipment.find({})
        .select("shipmentDraftId")
        .limit(100)
        .lean()
        .exec()
    ]);

    const draftIds = [
      ...new Set([
        ...(eventDraftIds.map((item) => String(item.shipmentDraftId))),
        ...(shipmentSample ? [String(shipmentSample.shipmentDraftId)] : [])
      ])
    ]
      .filter((value) => mongoose.Types.ObjectId.isValid(value))
      .slice(0, 100)
      .map((value) => new mongoose.Types.ObjectId(value));
    const statusValues = ["LABEL_RECEIVED", "DPD_CREATED", "DPD_STATUS_UNKNOWN", "DPD_CREATING", "DPD_REJECTED"];
    const emptyIds = [new mongoose.Types.ObjectId()];
    const scopedDraftFilter: Record<string, unknown> = { deletedAt: null };
    if (draftSample?.businessAccountId) scopedDraftFilter.businessAccountId = draftSample.businessAccountId;
    if (draftSample?.branchId) scopedDraftFilter.branchId = draftSample.branchId;

    console.log(JSON.stringify({
      audit: "shipment-performance",
      mode: "read-only",
      sampleRows: draftIds.length,
      accountScopedSample: Boolean(draftSample)
    }));

    await reportCollectionInventory(database);
    const legacyInvoiceUploads = await database.collection("invoiceuploads").countDocuments();
    const linkedLegacyInvoiceUploads = await ShipmentDraft.collection.countDocuments({
      invoiceUploadId: { $exists: true }
    });
    console.log(JSON.stringify({
      audit: "legacy-invoice-upload",
      mode: "read-only",
      documents: legacyInvoiceUploads,
      linkedDrafts: linkedLegacyInvoiceUploads,
      action: "preserve until historical linkage and stored-object retention are reviewed"
    }));

    await Promise.all([
      reportCollectionStats(database, ShipmentDraft.collection),
      reportCollectionStats(database, DpdShipment.collection),
      reportCollectionStats(database, ShipmentEvent.collection),
      reportCollectionStats(database, ShipmentInvoice.collection),
      reportCollectionStats(database, ShipmentManifest.collection),
      explainFind(
        "booked-draft-scope",
        ShipmentDraft.collection,
        scopedDraftFilter,
        { _id: 1, businessAccountId: 1, branchId: 1 },
        { createdAt: -1 },
        100
      ),
      explainFind(
        "client-dashboard-recent-drafts",
        ShipmentDraft.collection,
        {
          ...scopedDraftFilter,
          ...(draftSample?.businessAccountId ? {} : { businessAccountId: { $in: emptyIds } })
        },
        { _id: 1, branchId: 1, status: 1, updatedAt: 1 },
        { updatedAt: -1 },
        50
      ),
      explainFind(
        "dashboard-dpd-feed",
        DpdShipment.collection,
        { status: { $in: statusValues } },
        { _id: 1, shipmentDraftId: 1, status: 1, createdAt: 1 },
        { createdAt: -1 },
        100
      ),
      explainFind(
        "booked-dpd-ids",
        DpdShipment.collection,
        { status: { $in: statusValues }, shipmentDraftId: { $in: draftIds.length ? draftIds : emptyIds } },
        { _id: 0, shipmentDraftId: 1 },
        {},
        100
      ),
      explainAggregate(
        "latest-visible-events",
        ShipmentEvent.collection,
        [
          { $match: { shipmentDraftId: { $in: draftIds.length ? draftIds : emptyIds }, customerVisible: true } },
          { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
          { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
        ]
      ),
      explainFind(
        "shipment-invoices-by-draft",
        ShipmentInvoice.collection,
        { shipmentDraftId: { $in: draftIds.length ? draftIds : emptyIds } },
        { _id: 0, shipmentDraftId: 1, totalAmountMinor: 1, revision: 1 },
        {},
        100
      ),
      explainFind(
        "manifests-by-draft-and-role",
        ShipmentManifest.collection,
        { shipmentDraftIds: { $in: draftIds.length ? draftIds : emptyIds }, actorRole: "admin" },
        { _id: 1, manifestNumber: 1, shipmentDraftIds: 1 },
        {},
        100
      )
    ]);
  } finally {
    await mongoose.disconnect();
  }
}

auditShipmentPerformance().catch((error) => {
  console.error("Shipment performance audit failed.", error);
  process.exitCode = 1;
});
