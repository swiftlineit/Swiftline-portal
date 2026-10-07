import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import {
  DpdShipmentServiceError,
  normalizeAlsCarrierReferences,
  reconcileAlsCarrierBooking
} from "../services/dpdShipment.service.js";

const testMongoUri = process.env.DPD_CARRIER_RECONCILIATION_TEST_MONGODB_URI?.trim();
const databaseName = `sl_dpd_reconcile_test_${Date.now()}`;
const operatorId = new mongoose.Types.ObjectId();
let branchId: mongoose.Types.ObjectId;
let fixtureSequence = 0;

function reconciliationInput(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    shipmentDraftId: String(fixture.draft._id),
    manifestId: String(fixture.manifest._id),
    carrierAwbNumber: "1017173313",
    carrierForwardingNumber: "3702191406",
    swiftlineTrackingNumber: fixture.trackingNumber,
    originalAlsAttemptVoided: true,
    replacementBookingVerified: true,
    confirmationNote: "Confirmed against the ALS docket record.",
    userId: operatorId
  };
}

test("requires explicit confirmation that the original attempt was voided and the replacement was verified", async () => {
  const baseInput = {
    shipmentDraftId: new mongoose.Types.ObjectId().toString(),
    manifestId: new mongoose.Types.ObjectId().toString(),
    carrierAwbNumber: "1017173313",
    carrierForwardingNumber: "3702191406",
    swiftlineTrackingNumber: "SLC-ALS-RECON-TEST",
    originalAlsAttemptVoided: true,
    replacementBookingVerified: true,
    confirmationNote: "Confirmed against the ALS replacement booking.",
    userId: operatorId
  };

  for (const confirmation of [
    { originalAlsAttemptVoided: false },
    { replacementBookingVerified: false }
  ]) {
    await assert.rejects(
      () => reconcileAlsCarrierBooking({ ...baseInput, ...confirmation }),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 400
    );
  }
});

async function createFixture(parcelCount = 2) {
  fixtureSequence += 1;
  const suffix = String(fixtureSequence).padStart(4, "0");
  const trackingNumber = `SLC-ALS-RECON-${suffix}`;
  const accountId = new mongoose.Types.ObjectId();
  const parcelNumbers = Array.from({ length: parcelCount }, (_, index) => `${trackingNumber}-${String(index + 1).padStart(2, "0")}`);
  const parcels = parcelNumbers.map((swiftlineParcelNumber, index) => ({
    sequence: index + 1,
    actualWeightKg: 1.25,
    carrierParcelNumber: "",
    swiftlineParcelNumber
  }));
  const snapshot = {
    version: 1,
    bookedAt: new Date().toISOString(),
    source: { invoiceNumber: `INV-${suffix}`, shipmentReference: `REF-${suffix}` },
    account: {},
    sender: {},
    consignee: { countryCode: "GB", countryName: "United Kingdom" },
    service: { type: "COURIER", code: "EXP" },
    tracking: {
      swiftlineTrackingNumber: trackingNumber,
      carrierShipmentId: "",
      carrierTransactionId: ""
    },
    parcels,
    pricing: { baseAmount: 10, gstAmount: 0, totalAmount: 10, parcels: [] },
    payment: { currency: "INR", totalAmountMinor: 1000, advanceAmountMinor: 0, creditAmountMinor: 1000 }
  };
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId: accountId,
    customerType: "BUSINESS",
    branchId,
    consigneeEnteredAddress: {
      companyName: "ALS reconciliation test",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Road",
      townOrCity: "London"
    },
    parcelList: parcelNumbers.map((_, index) => ({
      sequence: index + 1,
      weightKg: 1.25,
      shipmentContentType: "PARCEL",
      contentsDescription: "Test goods"
    })),
    serviceType: "COURIER",
    serviceCode: "EXP",
    status: "READY_FOR_DPD",
    bookingState: "BOOKED",
    createdBy: operatorId
  });
  const shipment = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `ALS-RECON-TEST:${suffix}`,
    swiftlineTrackingNumber: trackingNumber,
    parcelNumbers,
    serviceCode: "EXP",
    paymentSource: "ADMIN_DIRECT",
    status: "DPD_STATUS_UNKNOWN",
    responseSnapshot: {
      provider: "ALS",
      outcome: "INTERNAL_LABEL_ONLY",
      stage: "DPD_LABEL_ONLY"
    },
    bookingSnapshot: snapshot,
    currentShipmentSnapshot: snapshot,
    snapshotRevision: 1
  });
  const manifest = await OperationsManifest.create({
    manifestNumber: `ALS-RECON-${suffix}`,
    branchId,
    header: { destinationCountryCode: "GB", destinationCountryName: "United Kingdom" },
    status: "SEALED",
    createdBy: operatorId
  });
  const bag = await OperationsManifestBag.create({
    manifestId: manifest._id,
    sequence: 1,
    bagNumber: `ALS-RECON-BAG-${suffix}`,
    barcode: `ALS-RECON-BARCODE-${suffix}`,
    createdBy: operatorId
  });
  await OperationsManifestConsignment.create({
    manifestId: manifest._id,
    bagId: bag._id,
    shipmentDraftId: draft._id,
    dpdShipmentId: shipment._id,
    businessAccountId: accountId,
    consignmentNumber: trackingNumber,
    expectedParcelNumbers: parcelNumbers,
    scannedParcelNumbers: parcelNumbers,
    manifestPieces: 1,
    weightKg: parcelCount * 1.25,
    status: "COMPLETE",
    consignorSnapshot: {},
    consigneeSnapshot: {},
    description: "TEST GOODS",
    currency: "INR",
    serviceInfo: "EXP",
    dpdLabelGenerated: false
  });
  await LabelDocument.insertMany(parcelNumbers.map((parcelNumber) => ({
    dpdShipmentId: shipment._id,
    parcelNumber,
    labelType: "SWIFTLINE",
    format: "PDF",
    labelSize: "A6",
    storageKey: `als-reconciliation-test/${parcelNumber}.pdf`,
    fileChecksum: `checksum-${parcelNumber}`,
    labelVersion: 1
  })));
  return { draft, shipment, manifest, trackingNumber, parcelNumbers };
}

test("ALS carrier references are trimmed and validated without coercing identifiers to numbers", () => {
  assert.deepEqual(normalizeAlsCarrierReferences({
    carrierAwbNumber: " 1017173313 ",
    carrierForwardingNumber: " 3702191406 "
  }), {
    carrierAwbNumber: "1017173313",
    carrierForwardingNumber: "3702191406"
  });
  assert.deepEqual(normalizeAlsCarrierReferences({
    carrierAwbNumber: "1017173313",
    carrierForwardingNumber: " fwd-0009 "
  }).carrierForwardingNumber, "FWD-0009");
  assert.throws(
    () => normalizeAlsCarrierReferences({ carrierAwbNumber: "AWB-1", carrierForwardingNumber: "FWD-1" }),
    (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 400
  );
  assert.throws(
    () => normalizeAlsCarrierReferences({ carrierAwbNumber: "1017173313", carrierForwardingNumber: "  " }),
    (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 400
  );
  assert.throws(
    () => normalizeAlsCarrierReferences({ carrierAwbNumber: "1017173313", carrierForwardingNumber: `FWD${"X".repeat(120)}` }),
    (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 400
  );
});

test("carrier AWB and forwarding number indexes are unique only for populated values", () => {
  const indexes = DpdShipment.schema.indexes() as Array<[
    Record<string, unknown>,
    {
      name?: string;
      unique?: boolean;
      partialFilterExpression?: Record<string, unknown>;
      collation?: { locale: string; strength: number };
    }
  ]>;
  const awbIndex = indexes.find(([keys, options]) => options.name === "uniq_dpd_carrier_awb" && "dpdShipmentId" in keys);
  const forwardingIndex = indexes.find(([keys, options]) => options.name === "uniq_dpd_carrier_forwarding_number" && "forwardingNumber" in keys);

  assert.equal(awbIndex?.[1].unique, true);
  assert.deepEqual(awbIndex?.[1].partialFilterExpression, { dpdShipmentId: { $type: "string", $gt: "" } });
  assert.equal(forwardingIndex?.[1].unique, true);
  assert.deepEqual(forwardingIndex?.[1].partialFilterExpression, { forwardingNumber: { $type: "string", $gt: "" } });
  assert.deepEqual(forwardingIndex?.[1].collation, { locale: "en", strength: 2 });
});

describe("ALS carrier booking reconciliation transaction", { skip: !testMongoUri }, () => {
  before(async () => {
    await mongoose.connect(testMongoUri!, { dbName: databaseName, family: 4, retryWrites: false });
    assert.equal(mongoose.connection.name, databaseName, "Reconciliation tests must use their isolated test database.");
    await Promise.all([
      AuditLog.init(),
      Branch.init(),
      DpdShipment.init(),
      LabelDocument.init(),
      OperationsManifest.init(),
      OperationsManifestBag.init(),
      OperationsManifestConsignment.init(),
      ShipmentDraft.init()
    ]);
    const branch = await Branch.create({
      name: "ALS Reconciliation Test Branch",
      code: `AR${String(Date.now()).slice(-6)}`,
      status: "ACTIVE",
      address: { addressLine1: "1 Test Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
      contact: { email: "als-reconciliation@test.invalid", countryCode: "+91", phone: "9000000000" },
      createdBy: operatorId
    });
    branchId = branch._id as mongoose.Types.ObjectId;
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      assert.ok(mongoose.connection.name.startsWith("sl_dpd_reconcile_test_"), "Refusing to clean a non-test database.");
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test("stores both carrier references once, preserves the missing-label state, and is idempotent", async () => {
    const fixture = await createFixture();
    const input = reconciliationInput(fixture);

    const first = await reconcileAlsCarrierBooking(input);
    assert.equal(first.reused, false);
    assert.equal(first.dpdShipment.dpdShipmentId, input.carrierAwbNumber);
    assert.equal(first.dpdShipment.forwardingNumber, input.carrierForwardingNumber);
    assert.equal(first.dpdShipment.status, "DPD_CREATED");
    assert.equal(first.dpdShipment.responseSnapshot?.outcome, "MANUAL_ALS_REBOOK_RECONCILED");
    assert.equal(first.dpdShipment.responseSnapshot?.carrierLabelStatus, "AVAILABLE_IN_ALS_NOT_STORED_IN_PORTAL");
    assert.equal(first.dpdShipment.responseSnapshot?.labelCount, 0);
    assert.equal(first.dpdShipment.responseSnapshot?.originalAlsAttemptVoided, true);
    assert.equal(first.dpdShipment.responseSnapshot?.replacementBookingVerified, true);
    assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: fixture.shipment._id, labelType: "DPD", voidedAt: null }), 0);
    assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: fixture.shipment._id, labelType: "SWIFTLINE", voidedAt: null }), fixture.parcelNumbers.length);

    const audit = await AuditLog.find({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }).lean().exec();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.metadata?.carrierAwbNumber, input.carrierAwbNumber);
    assert.equal(audit[0]?.metadata?.carrierForwardingNumber, input.carrierForwardingNumber);
    assert.equal(audit[0]?.metadata?.carrierLabelStatus, "AVAILABLE_IN_ALS_NOT_STORED_IN_PORTAL");
    assert.equal(audit[0]?.metadata?.evidenceSource, "ALS_MANUAL_REBOOK_CONFIRMED_BY_OPERATIONS");
    assert.equal(audit[0]?.metadata?.originalAlsAttemptVoided, true);
    assert.equal(audit[0]?.metadata?.replacementBookingVerified, true);

    const repeated = await reconcileAlsCarrierBooking(input);
    assert.equal(repeated.reused, true);
    assert.equal(await AuditLog.countDocuments({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }), 1);
  });

  test("rejects a tracking-number mismatch without modifying the shipment or audit history", async () => {
    const fixture = await createFixture(1);
    const input = { ...reconciliationInput(fixture), swiftlineTrackingNumber: "SLC-WRONG" };

    await assert.rejects(
      () => reconcileAlsCarrierBooking(input),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );
    const unchanged = await DpdShipment.findById(fixture.shipment._id).lean().exec();
    assert.equal(unchanged?.status, "DPD_STATUS_UNKNOWN");
    assert.equal(unchanged?.dpdShipmentId, "");
    assert.equal(unchanged?.forwardingNumber, "");
    assert.equal(await AuditLog.countDocuments({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }), 0);
  });

  test("rejects a reused carrier AWB or forwarding number", async () => {
    const target = await createFixture(1);
    const other = await createFixture(1);
    await DpdShipment.updateOne({ _id: other.shipment._id }, { $set: { dpdShipmentId: "1017173313" } });

    await assert.rejects(
      () => reconcileAlsCarrierBooking(reconciliationInput(target)),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );

    await DpdShipment.collection.updateOne(
      { _id: other.shipment._id },
      { $set: { dpdShipmentId: "", forwardingNumber: " 3702191406 " } }
    );
    await assert.rejects(
      () => reconcileAlsCarrierBooking({ ...reconciliationInput(target), carrierAwbNumber: "1017173314" }),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );
    assert.equal((await DpdShipment.findById(target.shipment._id).lean().exec())?.status, "DPD_STATUS_UNKNOWN");
  });

  test("rejects a snapshot tracking number that differs from the shipment record", async () => {
    const fixture = await createFixture(1);
    await DpdShipment.collection.updateOne(
      { _id: fixture.shipment._id },
      { $set: { "currentShipmentSnapshot.tracking.swiftlineTrackingNumber": "SLC-WRONG" } }
    );

    await assert.rejects(
      () => reconcileAlsCarrierBooking(reconciliationInput(fixture)),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );
    assert.equal((await DpdShipment.findById(fixture.shipment._id).lean().exec())?.status, "DPD_STATUS_UNKNOWN");
    assert.equal(await AuditLog.countDocuments({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }), 0);
  });

  test("rejects incomplete or cross-branch manifest linkage without partial writes", async () => {
    const fixture = await createFixture(2);
    await OperationsManifestConsignment.updateOne(
      { manifestId: fixture.manifest._id, shipmentDraftId: fixture.draft._id },
      { $set: { scannedParcelNumbers: fixture.parcelNumbers.slice(0, 1) } }
    );

    await assert.rejects(
      () => reconcileAlsCarrierBooking(reconciliationInput(fixture)),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );
    const unchanged = await DpdShipment.findById(fixture.shipment._id).lean().exec();
    assert.equal(unchanged?.status, "DPD_STATUS_UNKNOWN");
    assert.equal(await AuditLog.countDocuments({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }), 0);

    await OperationsManifestConsignment.updateOne(
      { manifestId: fixture.manifest._id, shipmentDraftId: fixture.draft._id },
      { $set: { scannedParcelNumbers: fixture.parcelNumbers } }
    );
    const otherBranch = await Branch.create({
      name: "ALS Reconciliation Other Branch",
      code: `AO${String(Date.now()).slice(-6)}`,
      status: "ACTIVE",
      address: { addressLine1: "2 Test Road", city: "Mumbai", state: "Maharashtra", postalCode: "400001", country: "India" },
      contact: { email: "als-reconciliation-other@test.invalid", countryCode: "+91", phone: "9000000001" },
      createdBy: operatorId
    });
    await OperationsManifest.updateOne({ _id: fixture.manifest._id }, { $set: { branchId: otherBranch._id } });
    await assert.rejects(
      () => reconcileAlsCarrierBooking(reconciliationInput(fixture)),
      (error: unknown) => error instanceof DpdShipmentServiceError && error.statusCode === 409
    );
    assert.equal((await DpdShipment.findById(fixture.shipment._id).lean().exec())?.status, "DPD_STATUS_UNKNOWN");
    assert.equal(await AuditLog.countDocuments({ entityId: fixture.shipment._id, action: "DPD_CARRIER_BOOKING_RECONCILED" }), 0);
  });
});
