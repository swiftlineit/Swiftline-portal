import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import {
  recordShipmentOperationsScan,
  ShipmentOperationsScanError
} from "../services/shipmentOperationsScan.service.js";

const databaseName = `sl_origin_scans_${Date.now()}`;
const userId = new mongoose.Types.ObjectId();
let branchId: mongoose.Types.ObjectId;
let sequence = 0;

async function createTwoParcelShipment(input: {
  persistedParcelNumbers?: string[];
  includeBookingSnapshot?: boolean;
  includeSwiftlineLabels?: boolean;
} = {}) {
  sequence += 1;
  const tracking = `SLC-SCAN-${sequence}`;
  const parcelNumbers = [`${tracking}-01`, `${tracking}-02`];
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId: new mongoose.Types.ObjectId(),
    customerType: "BUSINESS",
    branchId,
    consigneeEnteredAddress: {
      companyName: "Origin scan test",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcelList: parcelNumbers.map((_, index) => ({
      sequence: index + 1,
      weightKg: 1,
      shipmentContentType: "PARCEL",
      contentsDescription: "Test goods"
    })),
    serviceType: "COURIER",
    serviceCode: "TEST",
    status: "READY_FOR_DPD",
    bookingState: "BOOKED",
    createdBy: userId
  });
  const shipment = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `ORIGIN-SCAN-${sequence}`,
    dpdShipmentId: `DPD-SCAN-${sequence}`,
    swiftlineTrackingNumber: tracking,
    parcelNumbers: input.persistedParcelNumbers ?? parcelNumbers,
    ...(input.includeBookingSnapshot ? {
      bookingSnapshot: {
        version: 1,
        source: {},
        tracking: { swiftlineTrackingNumber: tracking },
        payment: {},
        pricing: {},
        parcels: parcelNumbers.map((parcelNumber, index) => ({
          sequence: index + 1,
          actualWeightKg: 1,
          carrierParcelNumber: "",
          swiftlineParcelNumber: parcelNumber
        }))
      },
      currentShipmentSnapshot: {
        version: 1,
        source: {},
        tracking: { swiftlineTrackingNumber: tracking },
        payment: {},
        pricing: {},
        parcels: parcelNumbers.map((parcelNumber, index) => ({
          sequence: index + 1,
          actualWeightKg: 1,
          carrierParcelNumber: "",
          swiftlineParcelNumber: parcelNumber
        }))
      }
    } : {}),
    serviceCode: "TEST",
    paymentSource: "ADMIN_DIRECT",
    status: "LABEL_RECEIVED"
  });
  if (input.includeSwiftlineLabels) {
    await LabelDocument.insertMany(parcelNumbers.map((parcelNumber) => ({
      dpdShipmentId: shipment._id,
      parcelNumber,
      labelType: "SWIFTLINE",
      format: "PDF",
      labelSize: "A6",
      storageKey: `origin-scan-test/${parcelNumber}.pdf`,
      fileChecksum: `checksum-${parcelNumber}`
    })));
  }
  return { draft, shipment, tracking, parcelNumbers };
}

async function scan(action: "RECEIVE" | "PROCESS", barcode: string) {
  return recordShipmentOperationsScan({
    action,
    barcode,
    userId,
    allowedBranchIds: null,
    scanRequestId: crypto.randomUUID()
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Origin scan tests must use an isolated database.");
  await Promise.all([
    AuditLog.init(), Branch.init(), DpdShipment.init(), LabelDocument.init(), ShipmentDraft.init(),
    ShipmentEvent.init(), ShipmentOperationsParcelScan.init()
  ]);
  const branch = await Branch.create({
    name: "Origin Scan Test Branch",
    code: `OS${String(Date.now()).slice(-6)}`,
    status: "ACTIVE",
    address: { addressLine1: "1 Test Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
    contact: { email: "origin-scan@test.invalid", countryCode: "+91", phone: "9000000000" },
    createdBy: userId
  });
  branchId = branch._id as mongoose.Types.ObjectId;
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_origin_scans_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("origin parcel scan tracking", () => {
  test("does not advance a multi-piece shipment until every parcel is received", async () => {
    const fixture = await createTwoParcelShipment();
    const first = await scan("RECEIVE", fixture.parcelNumbers[0]!);
    assert.equal(first.progress.scannedParcels, 1);
    assert.equal(first.progress.totalParcels, 2);
    assert.equal(first.progress.milestoneRecorded, false);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: fixture.draft._id, status: "WAREHOUSE_SCAN_IN" }), 0);

    const second = await scan("RECEIVE", fixture.parcelNumbers[1]!);
    assert.equal(second.progress.milestoneRecorded, true);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: fixture.draft._id, status: "WAREHOUSE_SCAN_IN" }), 1);
  });

  test("requires receipt first and counts export processing per parcel", async () => {
    const fixture = await createTwoParcelShipment();
    await assert.rejects(
      () => scan("PROCESS", fixture.parcelNumbers[0]!),
      (error: unknown) => error instanceof ShipmentOperationsScanError && error.statusCode === 409
    );
    await scan("RECEIVE", fixture.parcelNumbers[0]!);
    await scan("RECEIVE", fixture.parcelNumbers[1]!);
    const firstProcess = await scan("PROCESS", fixture.parcelNumbers[0]!);
    assert.equal(firstProcess.progress.milestoneRecorded, false);
    const secondProcess = await scan("PROCESS", fixture.parcelNumbers[1]!);
    assert.equal(secondProcess.progress.milestoneRecorded, true);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: fixture.draft._id, status: "ORIGIN_HUB_PROCESSED" }), 1);
  });

  test("rejects a HAWB for multi-piece receipt and acknowledges a duplicate parcel", async () => {
    const fixture = await createTwoParcelShipment();
    await assert.rejects(
      () => scan("RECEIVE", fixture.tracking),
      (error: unknown) => error instanceof ShipmentOperationsScanError && error.statusCode === 409
    );
    await scan("RECEIVE", fixture.parcelNumbers[0]!);
    const duplicate = await scan("RECEIVE", fixture.parcelNumbers[0]!);
    assert.equal(duplicate.alreadyRecorded, true);
    assert.equal(duplicate.progress.scannedParcels, 1);
    assert.equal(await ShipmentOperationsParcelScan.countDocuments({ shipmentDraftId: fixture.draft._id, action: "RECEIVE" }), 1);
  });

  test("scans a rebooked-style booking when ALS supplied no parcel numbers", async () => {
    const fixture = await createTwoParcelShipment({
      persistedParcelNumbers: [],
      includeBookingSnapshot: true,
      includeSwiftlineLabels: true
    });

    const first = await scan("RECEIVE", fixture.parcelNumbers[0]!);

    assert.equal(first.progress.scannedParcels, 1);
    assert.equal(first.progress.totalParcels, 2);
    assert.equal(first.progress.milestoneRecorded, false);
  });
});
