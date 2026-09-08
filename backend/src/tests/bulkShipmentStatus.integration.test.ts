import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import {
  BulkStatusSelectionError,
  bulkRecordOperationalStatus
} from "../services/bulkShipmentStatus.service.js";

const databaseName = `sl_bulk_status_${Date.now()}`;
const userId = new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    family: 4,
    retryWrites: false
  });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([
    AuditLog.init(),
    DpdShipment.init(),
    ShipmentCancellation.init(),
    ShipmentDraft.init(),
    ShipmentEvent.init(),
    ShipmentInvoice.init()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(
      mongoose.connection.name.startsWith("sl_bulk_status_"),
      "Refusing to clean a non-test database."
    );
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function createFixture(input: {
  booked?: boolean;
  bookedAt?: Date;
} = {}) {
  const suffix = new mongoose.Types.ObjectId().toHexString().slice(-10).toUpperCase();
  const businessAccountId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId,
    branchId,
    consigneeEnteredAddress: {
      companyName: "BULK STATUS TEST CUSTOMER",
      countryCode: "GB",
      countryName: "UNITED KINGDOM",
      postcode: "SW1A 1AA",
      addressLine1: "1 TEST STREET",
      townOrCity: "LONDON"
    },
    parcelList: [{
      sequence: 1,
      weightKg: 2,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      shipmentContentType: "PARCEL",
      contentsDescription: "TEST GOODS"
    }],
    serviceType: "COURIER",
    serviceCode: "TEST",
    status: "READY_FOR_DPD",
    bookingState: input.booked === false ? "EDITABLE" : "BOOKED",
    createdBy: userId
  });

  if (input.booked === false) return { draft, dpdShipment: null, invoice: null };

  const dpdShipment = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `BULK-STATUS-${suffix}`,
    dpdShipmentId: `DPD-${suffix}`,
    swiftlineTrackingNumber: `SLC-${suffix}`,
    serviceCode: "TEST",
    paymentSource: "BUSINESS_ACCOUNT",
    status: "LABEL_RECEIVED"
  });
  const invoice = await ShipmentInvoice.create({
    invoiceNumber: `BS${suffix}`,
    financialYear: "26-27",
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    businessAccountId,
    branchId,
    currency: "INR",
    supplier: { legalName: "Swiftline Cargo" },
    customer: { companyName: "Bulk Status Test Customer" },
    shipment: { shipmentReference: suffix },
    description: "Bulk status integration test shipment",
    taxableValueMinor: 10_000,
    gstRatePercent: 18,
    taxType: "IGST",
    igstAmountMinor: 1_800,
    totalTaxAmountMinor: 1_800,
    totalAmountMinor: 11_800,
    advanceAppliedMinor: 0,
    creditOutstandingMinor: 11_800,
    pricingSnapshot: { totalAmount: 118, parcels: [] },
    status: "ISSUED",
    createdBy: userId
  });
  await ShipmentEvent.create({
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    status: "SHIPMENT_BOOKED",
    milestoneKey: "SHIPMENT_BOOKED",
    note: "Shipment booked",
    customerVisible: true,
    source: "SYSTEM",
    createdBy: userId,
    eventAt: input.bookedAt ?? new Date("2026-09-01T05:00:00.000Z")
  });

  return { draft, dpdShipment, invoice };
}

describe("bulk shipment status database workflow", { concurrency: false }, () => {
  test("writes eligible timelines, invoice stamps and audits while reporting unbooked rows", async () => {
    const eventAt = new Date("2026-09-01T06:30:00.000Z");
    const [first, second, unbooked] = await Promise.all([
      createFixture(),
      createFixture(),
      createFixture({ booked: false })
    ]);

    const result = await bulkRecordOperationalStatus({
      shipmentDraftIds: [String(first.draft._id), String(second.draft._id), String(unbooked.draft._id)],
      expectedStatuses: [first, second, unbooked].map((item) => ({
        shipmentDraftId: String(item.draft._id),
        status: "SHIPMENT_BOOKED"
      })),
      status: "PARCEL_COLLECTED",
      note: "Collected in bulk test",
      location: "Delhi collection point",
      eventAt,
      userId
    });

    assert.equal(result.updatedCount, 2);
    assert.deepEqual(
      result.updated.map((item) => item.shipmentDraftId).sort(),
      [String(first.draft._id), String(second.draft._id)].sort()
    );
    assert.deepEqual(result.skipped, [{
      shipmentDraftId: String(unbooked.draft._id),
      reason: "Shipment is not booked."
    }]);

    const updatedDraftIds = [first.draft._id, second.draft._id];
    const events = await ShipmentEvent.find({
      shipmentDraftId: { $in: updatedDraftIds },
      milestoneKey: "PARCEL_COLLECTED"
    }).sort({ shipmentDraftId: 1 }).lean().exec();
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.status, "PARCEL_COLLECTED");
      assert.equal(event.note, "Collected in bulk test");
      assert.equal(event.location, "Delhi collection point");
      assert.equal(event.source, "MANUAL");
      assert.equal(event.customerVisible, true);
      assert.equal(String(event.createdBy), String(userId));
      assert.equal(event.eventAt.toISOString(), eventAt.toISOString());
    }

    const firstTimeline = await ShipmentEvent.find({ shipmentDraftId: first.draft._id })
      .sort({ eventAt: 1, createdAt: 1 })
      .select("status eventAt")
      .lean()
      .exec();
    assert.deepEqual(firstTimeline.map((event) => event.status), ["SHIPMENT_BOOKED", "PARCEL_COLLECTED"]);
    assert.ok(firstTimeline[0]!.eventAt.getTime() <= firstTimeline[1]!.eventAt.getTime());

    const invoices = await ShipmentInvoice.find({ shipmentDraftId: { $in: updatedDraftIds } })
      .select("chargeFinalizedAt")
      .lean()
      .exec();
    assert.equal(invoices.length, 2);
    assert.ok(invoices.every((invoice) => invoice.chargeFinalizedAt?.toISOString() === eventAt.toISOString()));

    const audits = await AuditLog.find({
      action: "SHIPMENT_STATUS_UPDATED",
      entityId: { $in: [first.dpdShipment!._id, second.dpdShipment!._id] }
    }).lean().exec();
    assert.equal(audits.length, 2);
    assert.ok(audits.every((audit) => audit.metadata.source === "BULK"));
    assert.ok(audits.every((audit) => audit.metadata.eventAt instanceof Date));
  });

  test("allows only one concurrent request to record a customer milestone", async () => {
    const fixture = await createFixture();
    const input = {
      shipmentDraftIds: [String(fixture.draft._id)],
      expectedStatuses: [{ shipmentDraftId: String(fixture.draft._id), status: "SHIPMENT_BOOKED" }],
      status: "PARCEL_COLLECTED" as const,
      userId
    };

    const attempts = await Promise.allSettled([
      bulkRecordOperationalStatus(input),
      bulkRecordOperationalStatus(input)
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof BulkStatusSelectionError);
    assert.equal(await ShipmentEvent.countDocuments({
      shipmentDraftId: fixture.draft._id,
      milestoneKey: "PARCEL_COLLECTED"
    }), 1);
    assert.equal(await AuditLog.countDocuments({
      action: "SHIPMENT_STATUS_UPDATED",
      entityId: fixture.dpdShipment!._id
    }), 1);

    const invoice = await ShipmentInvoice.findById(fixture.invoice!._id).select("chargeFinalizedAt").lean().exec();
    assert.ok(invoice?.chargeFinalizedAt instanceof Date);
  });

  test("records a 100-shipment operational batch with complete event, invoice and audit parity", async () => {
    const fixtures: Awaited<ReturnType<typeof createFixture>>[] = [];
    // Keep test setup below the normal connection-pool ceiling; the operation
    // under test still receives all 100 shipments in one request.
    for (let offset = 0; offset < 100; offset += 20) {
      fixtures.push(...await Promise.all(
        Array.from({ length: 20 }, () => createFixture())
      ));
    }
    const eventAt = new Date("2026-09-01T07:00:00.000Z");
    const draftIds = fixtures.map((fixture) => fixture.draft._id);
    const dpdShipmentIds = fixtures.map((fixture) => fixture.dpdShipment!._id);

    const result = await bulkRecordOperationalStatus({
      shipmentDraftIds: draftIds.map(String),
      expectedStatuses: draftIds.map((shipmentDraftId) => ({
        shipmentDraftId: String(shipmentDraftId),
        status: "SHIPMENT_BOOKED"
      })),
      status: "PARCEL_COLLECTED",
      eventAt,
      userId
    });

    assert.equal(result.updatedCount, 100);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.updated.length, 100);
    assert.equal(await ShipmentEvent.countDocuments({
      shipmentDraftId: { $in: draftIds },
      milestoneKey: "PARCEL_COLLECTED",
      eventAt
    }), 100);
    assert.equal(await ShipmentInvoice.countDocuments({
      shipmentDraftId: { $in: draftIds },
      chargeFinalizedAt: eventAt
    }), 100);
    assert.equal(await AuditLog.countDocuments({
      action: "SHIPMENT_STATUS_UPDATED",
      entityId: { $in: dpdShipmentIds },
      "metadata.source": "BULK"
    }), 100);
  });

  test("rolls back timeline and invoice writes when the audit batch fails", async () => {
    const fixture = await createFixture();
    const originalInsertMany = AuditLog.insertMany;
    AuditLog.insertMany = (async () => {
      throw new Error("Injected audit failure");
    }) as typeof AuditLog.insertMany;

    try {
      await assert.rejects(
        bulkRecordOperationalStatus({
          shipmentDraftIds: [String(fixture.draft._id)],
          expectedStatuses: [{ shipmentDraftId: String(fixture.draft._id), status: "SHIPMENT_BOOKED" }],
          status: "PARCEL_COLLECTED",
          userId
        }),
        /Injected audit failure/
      );
    } finally {
      AuditLog.insertMany = originalInsertMany;
    }

    assert.equal(await ShipmentEvent.countDocuments({
      shipmentDraftId: fixture.draft._id,
      milestoneKey: "PARCEL_COLLECTED"
    }), 0);
    const invoice = await ShipmentInvoice.findById(fixture.invoice!._id).select("chargeFinalizedAt").lean().exec();
    assert.equal(invoice?.chargeFinalizedAt ?? null, null);
    assert.equal(await AuditLog.countDocuments({
      action: "SHIPMENT_STATUS_UPDATED",
      entityId: fixture.dpdShipment!._id
    }), 0);
  });
});
