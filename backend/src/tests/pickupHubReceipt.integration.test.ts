import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { PickupRequestShipment } from "../models/pickupRequestShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { markPickupReceivedAtDelhiHub } from "../services/pickup.service.js";
import { loadShipmentHubReceipt } from "../services/shipmentHubReceipt.service.js";
import { recordShipmentOperationsScan, ShipmentOperationsScanError } from "../services/shipmentOperationsScan.service.js";
import { buildManifestSealReadinessIssues } from "../services/operationsManifest.service.js";
import { requestShipmentCancellation, ShipmentCancellationError } from "../services/shipmentCancellation.service.js";

const databaseName = `sl_pickup_hub_receipt_${Date.now()}`;
const userId = new mongoose.Types.ObjectId();
let branchId: mongoose.Types.ObjectId;
let sequence = 0;

async function fixture(driverCollected = false) {
  sequence += 1;
  const tracking = `SLC-PICKUP-HUB-${sequence}`;
  const parcelNumbers = [`${tracking}-01`, `${tracking}-02`];
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId: new mongoose.Types.ObjectId(),
    customerType: "BUSINESS",
    branchId,
    consigneeEnteredAddress: {
      companyName: "Pickup receipt test", countryCode: "GB", countryName: "United Kingdom",
      postcode: "SW1A 1AA", addressLine1: "1 Test Street", townOrCity: "London"
    },
    parcelList: parcelNumbers.map((_, index) => ({ sequence: index + 1, weightKg: 1, shipmentContentType: "PARCEL", contentsDescription: "Test goods" })),
    serviceType: "COURIER", serviceCode: "TEST", status: "READY_FOR_DPD", bookingState: "BOOKED", createdBy: userId
  });
  const shipment = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `PICKUP-HUB-${sequence}`,
    dpdShipmentId: `DPD-PICKUP-HUB-${sequence}`,
    swiftlineTrackingNumber: tracking,
    parcelNumbers,
    serviceCode: "TEST",
    paymentSource: "ADMIN_DIRECT",
    status: "LABEL_RECEIVED"
  });
  await ShipmentEvent.create({
    shipmentDraftId: draft._id, dpdShipmentId: shipment._id, status: "SHIPMENT_BOOKED",
    source: "SYSTEM", createdBy: userId, eventAt: new Date()
  });
  const pickup = await PickupRequest.create({
    requestNumber: `SLPTESTHUB${String(sequence).padStart(3, "0")}`,
    businessAccountId: draft.businessAccountId,
    branchId,
    requestedBy: userId,
    source: "CLIENT_PORTAL",
    status: driverCollected ? "COLLECTED" : "IN_PROGRESS",
    addressFingerprint: "IN|110001|1 TEST ROAD",
    pickupAddress: { addressLine1: "1 Test Road", townOrCity: "Delhi", postcode: "110001", countryCode: "IN" },
    pickupContact: { name: "Test contact", phone: "+919876543210" },
    requestedWindow: { startAt: new Date("2026-10-15T04:30:00Z"), endAt: new Date("2026-10-15T06:30:00Z"), timezone: "Asia/Kolkata" },
    shipmentCount: 1, totalBoxes: 2, parcelCount: 2, totalWeightKg: 2
  });
  const link = await PickupRequestShipment.create({
    pickupRequestId: pickup._id, shipmentDraftId: draft._id, dpdShipmentId: shipment._id,
    trackingNumber: tracking, snapshotRevision: 1, shipmentSnapshot: { parcelNumbers },
    parcels: parcelNumbers.map((parcelNumber) => ({ parcelNumber, weightKg: 1, status: driverCollected ? "COLLECTED" : "PENDING" })),
    status: driverCollected ? "COLLECTED" : "PENDING", active: !driverCollected
  });
  const previousChargeDate = new Date("2026-10-14T08:00:00Z");
  const invoice = await ShipmentInvoice.create({
    invoiceNumber: `PHUB${String(sequence).padStart(5, "0")}`, financialYear: "26-27",
    shipmentDraftId: draft._id, dpdShipmentId: shipment._id,
    businessAccountId: draft.businessAccountId, branchId,
    supplier: { name: "Swiftline" }, customer: { name: "Test customer" }, shipment: { tracking },
    description: "Pickup receipt test", taxableValueMinor: 1000, gstRatePercent: 0, taxType: "IGST",
    cgstAmountMinor: 0, sgstAmountMinor: 0, igstAmountMinor: 0, totalTaxAmountMinor: 0,
    totalAmountMinor: 1000, advanceAppliedMinor: 0, creditOutstandingMinor: 1000,
    pricingSnapshot: { test: true }, createdBy: userId,
    chargeFinalizedAt: driverCollected ? previousChargeDate : null
  });
  if (driverCollected) {
    await ShipmentEvent.create({
      shipmentDraftId: draft._id, dpdShipmentId: shipment._id, status: "PARCEL_COLLECTED",
      source: "PICKUP", sourceReference: String(pickup._id), createdBy: userId, eventAt: new Date()
    });
  }
  return { draft, shipment, pickup, link, invoice, parcelNumbers, previousChargeDate };
}

async function scan(action: "RECEIVE" | "PROCESS", parcelNumber: string) {
  return recordShipmentOperationsScan({ action, barcode: parcelNumber, userId, allowedBranchIds: null, scanRequestId: new mongoose.Types.ObjectId().toHexString() });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Pickup receipt tests must use an isolated database.");
  await Promise.all([
    AuditLog.init(), Branch.init(), DpdShipment.init(), PickupRequest.init(), PickupRequestShipment.init(),
    ShipmentDraft.init(), ShipmentEvent.init(), ShipmentInvoice.init(), ShipmentOperationsParcelScan.init()
  ]);
  const branch = await Branch.create({
    name: "Delhi pickup test branch", code: `PH${String(Date.now()).slice(-6)}`, status: "ACTIVE",
    address: { addressLine1: "1 Test Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
    contact: { email: "pickup-hub@test.invalid", countryCode: "+91", phone: "9000000000" },
    createdBy: userId
  });
  branchId = branch._id as mongoose.Types.ObjectId;
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_pickup_hub_receipt_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("pickup hub receipt", () => {
  test("closes a partial pickup without advancing export, then accepts the later origin scan", async () => {
    const { draft, pickup, link, invoice, parcelNumbers } = await fixture();
    const detail = await markPickupReceivedAtDelhiHub({
      pickupId: String(pickup._id), actorId: userId,
      receivedParcels: [{ shipmentDraftId: String(draft._id), parcelNumber: parcelNumbers[0]! }]
    });
    assert.equal(detail.status, "COMPLETED_WITH_MISSING_PARCELS");
    const closedLink = await PickupRequestShipment.findById(link._id).lean().exec();
    assert.equal(closedLink?.active, false);
    assert.deepEqual(closedLink?.parcels.map((parcel) => parcel.hubReceiptOutcome), ["RECEIVED", "NOT_RECEIVED"]);
    assert.equal(await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: draft._id, action: "RECEIVE" }), 1);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "WAREHOUSE_SCAN_IN" }), 0);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "PARCEL_COLLECTED" }), 0);
    assert.equal((await ShipmentInvoice.findById(invoice._id).lean().exec())?.chargeFinalizedAt ?? null, null);
    assert.deepEqual((await loadShipmentHubReceipt(draft._id as mongoose.Types.ObjectId))?.notReceivedParcelNumbers, [parcelNumbers[1]]);
    for (const requesterType of ["CLIENT", "ADMIN"] as const) {
      await assert.rejects(() => requestShipmentCancellation({
        shipmentDraftId: draft._id as mongoose.Types.ObjectId, requestedBy: userId,
        requesterType, requesterRole: requesterType === "CLIENT" ? "client" : "admin", reason: "Test cancellation"
      }), (error: unknown) => error instanceof ShipmentCancellationError && error.statusCode === 409);
    }
    await assert.rejects(() => scan("PROCESS", parcelNumbers[0]!), (error: unknown) => error instanceof ShipmentOperationsScanError && error.statusCode === 409);
    const consignment = { shipmentDraftId: draft._id, consignmentNumber: "TEST" };
    const issues = buildManifestSealReadinessIssues({
      consignments: [consignment], events: await ShipmentEvent.find({ shipmentDraftId: draft._id }).select("shipmentDraftId status eventAt").lean().exec()
    });
    assert.ok(issues[0]?.missingStatuses.includes("WAREHOUSE_SCAN_IN"));

    await scan("RECEIVE", parcelNumbers[1]!);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "WAREHOUSE_SCAN_IN" }), 1);
    assert.ok((await ShipmentInvoice.findById(invoice._id).lean().exec())?.chargeFinalizedAt);
    assert.equal((await loadShipmentHubReceipt(draft._id as mongoose.Types.ObjectId))?.receivedParcels, 2);
    assert.equal((await PickupRequest.findById(pickup._id).lean().exec())?.status, "COMPLETED_WITH_MISSING_PARCELS");
    await scan("PROCESS", parcelNumbers[0]!);
    await scan("PROCESS", parcelNumbers[1]!);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "ORIGIN_HUB_PROCESSED" }), 1);
    assert.deepEqual(buildManifestSealReadinessIssues({
      consignments: [consignment], events: await ShipmentEvent.find({ shipmentDraftId: draft._id }).select("shipmentDraftId status eventAt").lean().exec()
    }), []);
  });

  test("records a driver-collected shipment from its inactive link exactly once", async () => {
    const { draft, pickup, invoice, parcelNumbers, previousChargeDate } = await fixture(true);
    const receivedParcels = parcelNumbers.map((parcelNumber) => ({ shipmentDraftId: String(draft._id), parcelNumber }));
    const first = await markPickupReceivedAtDelhiHub({ pickupId: String(pickup._id), actorId: userId, receivedParcels });
    assert.equal(first.status, "RECEIVED_AT_DELHI_HUB");
    await markPickupReceivedAtDelhiHub({ pickupId: String(pickup._id), actorId: userId, receivedParcels });
    assert.equal(await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: draft._id, action: "RECEIVE" }), 2);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "PARCEL_COLLECTED" }), 1);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "WAREHOUSE_SCAN_IN" }), 1);
    assert.equal((await ShipmentInvoice.findById(invoice._id).lean().exec())?.chargeFinalizedAt?.toISOString(), previousChargeDate.toISOString());
  });

  test("does not finalize charges when a collected parcel is missing at the hub", async () => {
    const { draft, pickup, link, invoice, parcelNumbers } = await fixture();
    await PickupRequest.updateOne({ _id: pickup._id }, { $set: { status: "COLLECTED" } });
    await PickupRequestShipment.updateOne(
      { _id: link._id },
      { $set: { status: "COLLECTED", active: false, "parcels.0.status": "COLLECTED", "parcels.1.status": "COLLECTED" } }
    );
    const detail = await markPickupReceivedAtDelhiHub({
      pickupId: String(pickup._id), actorId: userId,
      receivedParcels: [{ shipmentDraftId: String(draft._id), parcelNumber: parcelNumbers[0]! }]
    });
    assert.equal(detail.status, "COMPLETED_WITH_MISSING_PARCELS");
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "PARCEL_COLLECTED" }), 0);
    assert.equal((await ShipmentInvoice.findById(invoice._id).lean().exec())?.chargeFinalizedAt ?? null, null);
  });

  test("records every parcel in a manual pickup and rejects parcels outside the pickup", async () => {
    const { draft, pickup, invoice, parcelNumbers } = await fixture();
    await assert.rejects(() => markPickupReceivedAtDelhiHub({
      pickupId: String(pickup._id), actorId: userId,
      receivedParcels: [{ shipmentDraftId: String(draft._id), parcelNumber: "UNLINKED-01" }]
    }), /selected parcels do not match/);
    assert.equal(await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: draft._id }), 0);
    const detail = await markPickupReceivedAtDelhiHub({
      pickupId: String(pickup._id), actorId: userId,
      receivedParcels: parcelNumbers.map((parcelNumber) => ({ shipmentDraftId: String(draft._id), parcelNumber }))
    });
    assert.equal(detail.status, "RECEIVED_AT_DELHI_HUB");
    assert.equal(await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: draft._id, action: "RECEIVE" }), 2);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "WAREHOUSE_SCAN_IN" }), 1);
    assert.ok((await ShipmentInvoice.findById(invoice._id).lean().exec())?.chargeFinalizedAt);
  });
});
