import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { FlightException } from "../models/flightException.model.js";
import { FlightLinehaul } from "../models/flightLinehaul.model.js";
import { FlightLinehaulCounter } from "../models/flightLinehaulCounter.model.js";
import { FlightOffload } from "../models/flightOffload.model.js";
import { FlightShipmentAllocation } from "../models/flightShipmentAllocation.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { OperationsManifestScan } from "../models/operationsManifestScan.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import {
  allocateShipments,
  cancelFlightLinehaul,
  createFlightLinehaul,
  createOffload,
  searchEligibleShipments,
  transitionFlightStatus,
  type FlightLinehaulServiceError
} from "../services/flightLinehaul.service.js";

const databaseName = `sl_flight_${Date.now()}`;
const userId = new mongoose.Types.ObjectId();
let branchId: mongoose.Types.ObjectId;
let flightSequence = 0;

const snapshotFor = (draftId: mongoose.Types.ObjectId, parcelCount = 2) => {
  const suffix = String(draftId).slice(-8).toUpperCase();
  const parcels = Array.from({ length: parcelCount }, (_, index) => ({
    sequence: index + 1,
    actualWeightKg: index === 0 ? 2 : 5,
    carrierParcelNumber: `C-${suffix}-${index + 1}`,
    swiftlineParcelNumber: `PKG-${suffix}-${index + 1}`,
    contentsDescription: "TEST GOODS"
  }));
  const pricingParcels = parcels.map((parcel, index) => ({
    sequence: index + 1,
    actualWeightKg: parcel.actualWeightKg,
    volumetricWeightKg: index === 0 ? 3 : 2,
    chargeableWeightKg: index === 0 ? 3 : 5
  }));
  return {
    version: 1,
    bookedAt: new Date().toISOString(),
    source: { invoiceNumber: `INV-${suffix}`, shipmentReference: `REF-${suffix}` },
    account: {},
    sender: {},
    consignee: { countryCode: "GB", countryName: "United Kingdom" },
    service: { type: "COURIER", code: "TEST" },
    tracking: {
      swiftlineTrackingNumber: `SLC-${suffix}`,
      carrierShipmentId: `DPD-${suffix}`,
      carrierTransactionId: `TX-${suffix}`
    },
    parcels,
    pricing: {
      baseAmount: 10,
      gstAmount: 1.8,
      totalAmount: 11.8,
      parcels: pricingParcels
    },
    payment: { currency: "INR", totalAmountMinor: 1180, advanceAmountMinor: 0, creditAmountMinor: 1180 }
  };
};

async function createShipment(options: {
  hubProcessed?: boolean;
  latestStatus?: "ON_HOLD" | "SHIPMENT_CANCELLED" | "DELIVERED";
  parcelCount?: number;
} = {}) {
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId: new mongoose.Types.ObjectId(),
    customerType: "BUSINESS",
    branchId,
    consigneeEnteredAddress: {
      companyName: "Flight Test Customer",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Flight Road",
      townOrCity: "London"
    },
    parcelList: Array.from({ length: options.parcelCount ?? 2 }, (_, index) => ({
      sequence: index + 1,
      weightKg: index === 0 ? 2 : 5,
      shipmentContentType: "PARCEL",
      contentsDescription: "Test goods"
    })),
    serviceType: "COURIER",
    serviceCode: "TEST",
    status: "READY_FOR_DPD",
    bookingState: "BOOKED",
    createdBy: userId
  });
  const snapshot = snapshotFor(draft._id as mongoose.Types.ObjectId, options.parcelCount ?? 2);
  const dpd = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `FLIGHT-DPD-${String(draft._id)}`,
    dpdShipmentId: `DPD-${String(draft._id).slice(-8)}`,
    swiftlineTrackingNumber: snapshot.tracking.swiftlineTrackingNumber,
    serviceCode: "TEST",
    status: "LABEL_RECEIVED",
    paymentSource: "ADMIN_DIRECT",
    currentShipmentSnapshot: snapshot,
    bookingSnapshot: snapshot,
    parcelNumbers: snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber)
  });

  if (options.hubProcessed !== false) {
    await ShipmentEvent.create({
      shipmentDraftId: draft._id,
      dpdShipmentId: dpd._id,
      status: "ORIGIN_HUB_PROCESSED",
      source: "MANUAL",
      note: "Processed at origin hub",
      createdBy: userId,
      eventAt: new Date(Date.now() - 60_000)
    });
  }
  if (options.latestStatus) {
    await ShipmentEvent.create({
      shipmentDraftId: draft._id,
      dpdShipmentId: dpd._id,
      status: options.latestStatus,
      source: "MANUAL",
      note: options.latestStatus,
      createdBy: userId,
      eventAt: new Date()
    });
  }
  return { draft, dpd, snapshot };
}

async function createFlight(capacityKg = 100) {
  flightSequence += 1;
  const token = String(flightSequence).padStart(4, "0");
  return createFlightLinehaul({
    branchId: String(branchId),
    flightNumber: `AI${token}`,
    airlineName: "Air India",
    mawbNumber: `098-${String(10_000_000 + flightSequence).slice(-8)}`,
    originIataCode: "DEL",
    destinationIataCode: "LHR",
    scheduledDepartureAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    scheduledArrivalAt: new Date(Date.now() + 28 * 60 * 60 * 1000).toISOString(),
    capacityKg,
    userId
  });
}

async function expectServiceError(action: () => Promise<unknown>, statusCode: number) {
  await assert.rejects(action, (error: unknown) => (
    error instanceof Error
    && (error as FlightLinehaulServiceError).statusCode === statusCode
  ));
}

async function createManifestFixture(flightId: mongoose.Types.ObjectId, shipment: Awaited<ReturnType<typeof createShipment>>, status: "DRAFT" | "SEALED") {
  const manifest = await OperationsManifest.create({
    manifestNumber: `OM-${String(manifestSequence()).padStart(6, "0")}`,
    branchId,
    flightLinehaulId: flightId,
    header: {
      destinationAgent: "Test Agent",
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      flightNumber: "AI9999",
      departureDate: new Date().toISOString().slice(0, 10),
      mawbNumber: "098-12345678",
      originIataCode: "DEL",
      destinationIataCode: "LHR",
      valueType: "LV"
    },
    status,
    createdBy: userId
  });
  const bag = await OperationsManifestBag.create({
    manifestId: manifest._id,
    sequence: 1,
    bagNumber: `BAG-${String(manifest._id).slice(-8)}`,
    barcode: `BAR-${String(manifest._id).slice(-8)}`,
    status: status === "SEALED" ? "CLOSED" : "OPEN",
    createdBy: userId
  });
  const parcelNumbers = shipment.snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber);
  const consignment = await OperationsManifestConsignment.create({
    manifestId: manifest._id,
    bagId: bag._id,
    shipmentDraftId: shipment.draft._id,
    dpdShipmentId: shipment.dpd._id,
    businessAccountId: shipment.draft.businessAccountId,
    consignmentNumber: shipment.snapshot.tracking.swiftlineTrackingNumber,
    expectedParcelNumbers: parcelNumbers,
    scannedParcelNumbers: status === "SEALED" ? parcelNumbers : [],
    parcelWeightSnapshots: parcelNumbers.map((parcelNumber, index) => ({ parcelNumber, weightKg: index === 0 ? 2 : 5 })),
    manifestPieces: 1,
    weightKg: 7,
    status: status === "SEALED" ? "COMPLETE" : "PARTIAL",
    consignorSnapshot: {},
    consigneeSnapshot: shipment.snapshot.consignee,
    description: "TEST GOODS",
    currency: "INR",
    serviceInfo: "TEST",
    dpdLabelGenerated: true
  });
  if (status === "SEALED") {
    await OperationsManifestScan.insertMany(parcelNumbers.map((parcelNumber, index) => ({
      manifestId: manifest._id,
      bagId: bag._id,
      consignmentId: consignment._id,
      parcelNumber,
      scanRequestId: `SCAN-${String(manifest._id).slice(-8)}-${index}`,
      status: "ACCEPTED",
      scanSource: "MANUAL",
      message: "Accepted",
      scannedBy: userId,
      scannedAt: new Date()
    })));
  }
  return { manifest, bag, consignment };
}

async function createUnattachedDispatchedManifest(input: {
  shipment: Awaited<ReturnType<typeof createShipment>>;
  flightNumber: string;
  mawbNumber: string;
  departureDate: string;
  scannedParcelNumbers?: string[];
  parcelDispositions?: Array<{
    parcelNumber: string;
    disposition: "HELD" | "DEFERRED_TO_NEXT_MANIFEST" | "CANCELLED";
    reason: string;
  }>;
}) {
  const manifest = await OperationsManifest.create({
    manifestNumber: `OM-${String(manifestSequence()).padStart(6, "0")}`,
    branchId,
    flightLinehaulId: null,
    header: {
      destinationAgent: "Test Agent",
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      flightNumber: input.flightNumber,
      departureDate: input.departureDate,
      mawbNumber: input.mawbNumber,
      originIataCode: "DEL",
      destinationIataCode: "LHR",
      valueType: "LV"
    },
    status: "DISPATCHED",
    createdBy: userId
  });
  const bag = await OperationsManifestBag.create({
    manifestId: manifest._id,
    sequence: 1,
    bagNumber: `BAG-${String(manifest._id).slice(-8)}`,
    barcode: `BAR-${String(manifest._id).slice(-8)}`,
    status: "CLOSED",
    createdBy: userId
  });
  const parcelNumbers = input.shipment.snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber);
  const scannedParcelNumbers = input.scannedParcelNumbers ?? parcelNumbers;
  await OperationsManifestConsignment.create({
    manifestId: manifest._id,
    bagId: bag._id,
    shipmentDraftId: input.shipment.draft._id,
    dpdShipmentId: input.shipment.dpd._id,
    businessAccountId: input.shipment.draft.businessAccountId,
    consignmentNumber: input.shipment.snapshot.tracking.swiftlineTrackingNumber,
    expectedParcelNumbers: parcelNumbers,
    scannedParcelNumbers,
    parcelDispositions: (input.parcelDispositions ?? []).map((disposition) => ({
      ...disposition,
      recordedBy: userId,
      recordedAt: new Date()
    })),
    parcelWeightSnapshots: parcelNumbers.map((parcelNumber, index) => ({ parcelNumber, weightKg: index === 0 ? 2 : 5 })),
    manifestPieces: 1,
    weightKg: 7,
    status: "COMPLETE",
    consignorSnapshot: {},
    consigneeSnapshot: input.shipment.snapshot.consignee,
    description: "TEST GOODS",
    currency: "INR",
    serviceInfo: "TEST",
    dpdLabelGenerated: true
  });
  return manifest;
}

function manifestSequence() {
  return Date.now() + flightSequence;
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Flight tests must use an isolated database.");
  await Promise.all([
    AuditLog.init(), Branch.init(), DpdShipment.init(), FlightException.init(), FlightLinehaul.init(),
    FlightLinehaulCounter.init(), FlightOffload.init(), FlightShipmentAllocation.init(), OperationsManifest.init(),
    OperationsManifestBag.init(), OperationsManifestConsignment.init(), OperationsManifestScan.init(),
    ShipmentDraft.init(), ShipmentEvent.init()
  ]);
  const branch = await Branch.create({
    name: "Flight Test Branch",
    code: `FT${String(Date.now()).slice(-6)}`,
    status: "ACTIVE",
    address: { addressLine1: "1 Test Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
    contact: { email: "flight@test.invalid", countryCode: "+91", phone: "9000000000" },
    createdBy: userId
  });
  branchId = branch._id as mongoose.Types.ObjectId;
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_flight_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("flight linehaul workflow boundaries", () => {
  test("requires valid airline identity and allows repeated airline flight and MAWB references", async () => {
    await expectServiceError(() => createFlightLinehaul({
      branchId: String(branchId), flightNumber: "AI9001", mawbNumber: "098-12345678",
      originIataCode: "DEL", destinationIataCode: "LHR", scheduledDepartureAt: new Date(Date.now() + 86_400_000).toISOString(),
      scheduledArrivalAt: new Date(Date.now() + 100_000_000).toISOString(), capacityKg: 10, userId
    }), 400);

    const first = await createFlight();
    const second = await createFlightLinehaul({
      branchId: String(branchId), flightNumber: first.flightNumber, airlineName: "Air India", mawbNumber: first.mawbNumber,
      originIataCode: "DEL", destinationIataCode: "LHR", scheduledDepartureAt: new Date(Date.now() + 172_800_000).toISOString(),
      scheduledArrivalAt: new Date(Date.now() + 190_000_000).toISOString(), capacityKg: 10, userId
    });
    assert.notEqual(String(second._id), String(first._id));
  });

  test("creates a selected flight and manifest attachment atomically", async () => {
    const shipment = await createShipment();
    const scheduledDepartureAt = new Date(Date.now() + 10 * 86_400_000);
    const scheduledArrivalAt = new Date(scheduledDepartureAt.getTime() + 4 * 60 * 60 * 1000);
    const manifest = await createUnattachedDispatchedManifest({
      shipment,
      flightNumber: "AI-777",
      mawbNumber: "098-77777777",
      departureDate: scheduledDepartureAt.toISOString().slice(0, 10)
    });

    const flight = await createFlightLinehaul({
      branchId: String(branchId),
      flightNumber: "AI-777", airlineName: "Air India", mawbNumber: "098-77777777",
      originIataCode: "DEL", destinationIataCode: "LHR",
      scheduledDepartureAt: scheduledDepartureAt.toISOString(), scheduledArrivalAt: scheduledArrivalAt.toISOString(),
      capacityKg: 20, manifestId: String(manifest._id), userId
    });

    const [attachedManifest, allocation, storedFlight] = await Promise.all([
      OperationsManifest.findById(manifest._id).lean().exec(),
      FlightShipmentAllocation.findOne({ flightLinehaulId: flight._id, shipmentDraftId: shipment.draft._id, status: "ALLOCATED" }).lean().exec(),
      FlightLinehaul.findById(flight._id).lean().exec()
    ]);
    assert.equal(String(attachedManifest?.flightLinehaulId), String(flight._id));
    assert.ok(allocation);
    assert.equal(storedFlight?.totalShipments, 1);
  });

  test("attaches only scanned parcels and leaves a held parcel out of the flight allocation", async () => {
    const shipment = await createShipment({ parcelCount: 3 });
    const scheduledDepartureAt = new Date(Date.now() + 12 * 86_400_000);
    const scheduledArrivalAt = new Date(scheduledDepartureAt.getTime() + 4 * 60 * 60 * 1000);
    const parcelNumbers = shipment.snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber);
    const manifest = await createUnattachedDispatchedManifest({
      shipment,
      flightNumber: "AI-779",
      mawbNumber: "098-77777779",
      departureDate: scheduledDepartureAt.toISOString().slice(0, 10),
      scannedParcelNumbers: parcelNumbers.slice(0, 2),
      parcelDispositions: [{
        parcelNumber: parcelNumbers[2]!,
        disposition: "HELD",
        reason: "Payment verification pending"
      }]
    });

    const flight = await createFlightLinehaul({
      branchId: String(branchId),
      flightNumber: "AI-779", airlineName: "Air India", mawbNumber: "098-77777779",
      originIataCode: "DEL", destinationIataCode: "LHR",
      scheduledDepartureAt: scheduledDepartureAt.toISOString(), scheduledArrivalAt: scheduledArrivalAt.toISOString(),
      capacityKg: 20, manifestId: String(manifest._id), userId
    });

    const allocation = await FlightShipmentAllocation.findOne({
      flightLinehaulId: flight._id,
      shipmentDraftId: shipment.draft._id,
      status: "ALLOCATED"
    }).lean().exec();
    assert.deepEqual(allocation?.activeParcelNumbers, parcelNumbers.slice(0, 2));
    assert.equal(allocation?.pieces, 2);
    assert.equal(allocation?.offloadedParcelNumbers?.includes(parcelNumbers[2]!), false);
  });

  test("does not leave an empty flight behind when the selected manifest cannot be attached", async () => {
    const shipment = await createShipment();
    const scheduledDepartureAt = new Date(Date.now() + 11 * 86_400_000);
    const scheduledArrivalAt = new Date(scheduledDepartureAt.getTime() + 4 * 60 * 60 * 1000);
    const flightNumber = "AI-778";
    const manifest = await createUnattachedDispatchedManifest({
      shipment,
      flightNumber,
      mawbNumber: "098-77777778",
      departureDate: scheduledDepartureAt.toISOString().slice(0, 10)
    });

    await expectServiceError(() => createFlightLinehaul({
      branchId: String(branchId), flightNumber, airlineName: "Air India", mawbNumber: "098-77777778",
      originIataCode: "DEL", destinationIataCode: "LHR",
      scheduledDepartureAt: scheduledDepartureAt.toISOString(), scheduledArrivalAt: scheduledArrivalAt.toISOString(),
      capacityKg: 1, manifestId: String(manifest._id), userId
    }), 409);

    assert.equal(await FlightLinehaul.countDocuments({ flightNumber }), 0);
    assert.equal((await OperationsManifest.findById(manifest._id).lean().exec())?.flightLinehaulId, null);
  });

  test("search and allocation accept only hub-processed, live, labelled shipments", async () => {
    const flight = await createFlight();
    const eligible = await createShipment();
    const noHub = await createShipment({ hubProcessed: false });
    const held = await createShipment({ latestStatus: "ON_HOLD" });
    const cancelled = await createShipment({ latestStatus: "SHIPMENT_CANCELLED" });
    const delivered = await createShipment({ latestStatus: "DELIVERED" });

    const search = await searchEligibleShipments({ branchId: String(branchId), limit: 20, allowedBranchIds: null });
    const searchIds = search.shipments.map((item) => String(item.shipmentDraftId));
    assert.ok(searchIds.includes(String(eligible.draft._id)));
    for (const blocked of [noHub, held, cancelled, delivered]) assert.equal(searchIds.includes(String(blocked.draft._id)), false);

    const result = await allocateShipments({
      flightId: String(flight._id),
      shipmentDraftIds: [String(eligible.draft._id), String(noHub.draft._id), String(held.draft._id), String(delivered.draft._id)],
      userId,
      allowedBranchIds: null
    });
    assert.equal(result.allocatedCount, 1);
    assert.equal(result.results.filter((item) => item.status === "skipped").length, 3);
    assert.equal((await FlightShipmentAllocation.countDocuments({ flightLinehaulId: flight._id, status: "ALLOCATED" })), 1);
  });

  test("allows a durable booking without a local DPD label for later external-label reconciliation", async () => {
    const flight = await createFlight();
    const shipment = await createShipment();
    await DpdShipment.updateOne({ _id: shipment.dpd._id }, { $set: { status: "DPD_CREATED" } });
    const search = await searchEligibleShipments({ branchId: String(branchId), q: shipment.snapshot.tracking.swiftlineTrackingNumber, limit: 20, allowedBranchIds: null });
    assert.ok(search.shipments.some((item) => String(item.shipmentDraftId) === String(shipment.draft._id)));
    const result = await allocateShipments({ flightId: String(flight._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    assert.equal(result.allocatedCount, 1);
  });

  test("uses chargeable weight for capacity and leaves the flight unchanged when capacity fails", async () => {
    const flight = await createFlight(7);
    const shipment = await createShipment();
    const result = await allocateShipments({ flightId: String(flight._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    assert.equal(result.allocatedCount, 0);
    assert.equal(result.results[0]?.status, "skipped");
    assert.equal((await FlightLinehaul.findById(flight._id).lean().exec())?.allocatedWeightKg, 0);
    assert.equal(await FlightShipmentAllocation.countDocuments({ flightLinehaulId: flight._id }), 0);
  });

  test("offloads selected parcels only, is retry-safe, and never creates a replacement allocation", async () => {
    const flight = await createFlight();
    const shipment = await createShipment();
    await allocateShipments({ flightId: String(flight._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    const firstParcel = shipment.snapshot.parcels[0]!.swiftlineParcelNumber;
    const secondParcel = shipment.snapshot.parcels[1]!.swiftlineParcelNumber;

    const first = await createOffload({
      flightId: String(flight._id), reason: "Airline removed parcel", offloadReason: "AIRLINE_OFFLOAD",
      affectedParcels: [{ shipmentDraftId: String(shipment.draft._id), parcelNumber: firstParcel }], userId, allowedBranchIds: null
    });
    const allocationAfterPartial = await FlightShipmentAllocation.findOne({ flightLinehaulId: flight._id, shipmentDraftId: shipment.draft._id }).lean().exec();
    assert.ok(first);
    assert.deepEqual(allocationAfterPartial?.activeParcelNumbers, [secondParcel]);
    assert.deepEqual(allocationAfterPartial?.offloadedParcelNumbers, [firstParcel]);
    assert.equal(allocationAfterPartial?.weightKg, 5);
    assert.equal(first?.replacementFlightId, null);

    const retry = await createOffload({
      flightId: String(flight._id), reason: "Airline removed parcel", offloadReason: "AIRLINE_OFFLOAD",
      affectedParcels: [{ shipmentDraftId: String(shipment.draft._id), parcelNumber: firstParcel }], userId, allowedBranchIds: null
    });
    assert.equal(String(retry?._id), String(first?._id));
    await expectServiceError(() => createOffload({
      flightId: String(flight._id), reason: "Second attempt", offloadReason: "AIRLINE_OFFLOAD",
      affectedParcels: [{ shipmentDraftId: String(shipment.draft._id), parcelNumber: firstParcel }], userId, allowedBranchIds: null
    }), 409);

    await createOffload({
      flightId: String(flight._id), reason: "Airline removed parcel two", offloadReason: "AIRLINE_OFFLOAD",
      affectedParcels: [{ shipmentDraftId: String(shipment.draft._id), parcelNumber: secondParcel }], userId, allowedBranchIds: null
    });
    const finalAllocation = await FlightShipmentAllocation.findOne({ flightLinehaulId: flight._id, shipmentDraftId: shipment.draft._id }).lean().exec();
    assert.equal(finalAllocation?.status, "OFFLOADED");
    assert.deepEqual(finalAllocation?.activeParcelNumbers, []);
    assert.equal(finalAllocation?.weightKg, 0);
    assert.equal(await FlightOffload.countDocuments({ flightLinehaulId: flight._id }), 2);
  });

  test("blocks offloading a parcel still accepted in an editable manifest but allows a sealed-history offload", async () => {
    const editableFlight = await createFlight();
    const editableShipment = await createShipment({ parcelCount: 1 });
    await allocateShipments({ flightId: String(editableFlight._id), shipmentDraftIds: [String(editableShipment.draft._id)], userId, allowedBranchIds: null });
    const editable = await createManifestFixture(editableFlight._id as mongoose.Types.ObjectId, editableShipment, "DRAFT");
    await OperationsManifestScan.create({
      manifestId: editable.manifest._id, bagId: editable.bag._id, consignmentId: editable.consignment._id,
      parcelNumber: editableShipment.snapshot.parcels[0]!.swiftlineParcelNumber, scanRequestId: `EDIT-${String(editable.manifest._id)}`,
      status: "ACCEPTED", scanSource: "MANUAL", message: "Accepted", scannedBy: userId, scannedAt: new Date()
    });
    await expectServiceError(() => createOffload({
      flightId: String(editableFlight._id), reason: "Remove packed parcel", offloadReason: "CAPACITY",
      affectedParcels: [{ shipmentDraftId: String(editableShipment.draft._id), parcelNumber: editableShipment.snapshot.parcels[0]!.swiftlineParcelNumber }], userId, allowedBranchIds: null
    }), 409);

    const sealedFlight = await createFlight();
    const sealedShipment = await createShipment({ parcelCount: 1 });
    await allocateShipments({ flightId: String(sealedFlight._id), shipmentDraftIds: [String(sealedShipment.draft._id)], userId, allowedBranchIds: null });
    await createManifestFixture(sealedFlight._id as mongoose.Types.ObjectId, sealedShipment, "SEALED");
    const offload = await createOffload({
      flightId: String(sealedFlight._id), reason: "Remove sealed parcel", offloadReason: "CAPACITY",
      affectedParcels: [{ shipmentDraftId: String(sealedShipment.draft._id), parcelNumber: sealedShipment.snapshot.parcels[0]!.swiftlineParcelNumber }], userId, allowedBranchIds: null
    });
    assert.ok(offload);
  });

  test("manifest readiness requires the complete sealed control chain and departure skips held shipments", async () => {
    const flight = await createFlight();
    const shipment = await createShipment({ parcelCount: 1 });
    await allocateShipments({ flightId: String(flight._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    await FlightLinehaul.updateOne({ _id: flight._id }, { $set: { status: "CARGO_ALLOCATED" } });
    await expectServiceError(() => transitionFlightStatus({ flightId: String(flight._id), toStatus: "MANIFEST_READY", userId, allowedBranchIds: null }), 409);

    const fixture = await createManifestFixture(flight._id as mongoose.Types.ObjectId, shipment, "SEALED");
    await FlightException.create({
      flightLinehaulId: flight._id, branchId, type: "OTHER", severity: "CRITICAL", status: "OPEN",
      title: "Blocking exception", description: "Resolve before departure", dedupeKey: `CRITICAL-${String(flight._id)}`
    });
    await expectServiceError(() => transitionFlightStatus({ flightId: String(flight._id), toStatus: "MANIFEST_READY", userId, allowedBranchIds: null }), 409);
    await FlightException.deleteMany({ flightLinehaulId: flight._id });
    await transitionFlightStatus({ flightId: String(flight._id), toStatus: "MANIFEST_READY", userId, allowedBranchIds: null });
    await FlightLinehaul.updateOne({ _id: flight._id }, { $set: { status: "HANDED_TO_AIRLINE" } });
    await ShipmentEvent.create({
      shipmentDraftId: shipment.draft._id, dpdShipmentId: shipment.dpd._id, status: "ON_HOLD", source: "MANUAL",
      note: "Held for review", createdBy: userId, eventAt: new Date(Date.now() + 60_000)
    });
    await transitionFlightStatus({
      flightId: String(flight._id), toStatus: "DEPARTED", userId, allowedBranchIds: null,
      metadata: { actualDepartureAt: new Date().toISOString() }
    });
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: shipment.draft._id, status: "FLIGHT_DEPARTED" }), 0);
    assert.ok(fixture.manifest);
  });

  test("blocks automatic departure when an active shipment has a missing prior milestone", async () => {
    const flight = await createFlight();
    const shipment = await createShipment({ parcelCount: 1 });
    await allocateShipments({ flightId: String(flight._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    await createManifestFixture(flight._id as mongoose.Types.ObjectId, shipment, "SEALED");
    await FlightLinehaul.updateOne({ _id: flight._id }, { $set: { status: "CARGO_ALLOCATED" } });
    await transitionFlightStatus({ flightId: String(flight._id), toStatus: "MANIFEST_READY", userId, allowedBranchIds: null });
    await FlightLinehaul.updateOne({ _id: flight._id }, { $set: { status: "HANDED_TO_AIRLINE" } });

    await expectServiceError(() => transitionFlightStatus({
      flightId: String(flight._id),
      toStatus: "DEPARTED",
      userId,
      allowedBranchIds: null,
      metadata: { actualDepartureAt: new Date().toISOString() }
    }), 409);
    assert.equal((await FlightLinehaul.findById(flight._id).lean().exec())?.status, "HANDED_TO_AIRLINE");
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: shipment.draft._id, status: "FLIGHT_DEPARTED" }), 0);
  });

  test("cancellation is allowed before sealing and rejected after a manifest is sealed", async () => {
    const cancellable = await createFlight();
    const shipment = await createShipment();
    await allocateShipments({ flightId: String(cancellable._id), shipmentDraftIds: [String(shipment.draft._id)], userId, allowedBranchIds: null });
    await cancelFlightLinehaul({ flightId: String(cancellable._id), reason: "Airline cancelled sector", userId, allowedBranchIds: null });
    assert.equal((await FlightLinehaul.findById(cancellable._id).lean().exec())?.status, "CANCELLED");
    assert.equal((await FlightShipmentAllocation.findOne({ flightLinehaulId: cancellable._id }).lean().exec())?.status, "REMOVED");

    const sealed = await createFlight();
    const sealedShipment = await createShipment({ parcelCount: 1 });
    await allocateShipments({ flightId: String(sealed._id), shipmentDraftIds: [String(sealedShipment.draft._id)], userId, allowedBranchIds: null });
    await createManifestFixture(sealed._id as mongoose.Types.ObjectId, sealedShipment, "SEALED");
    await expectServiceError(() => cancelFlightLinehaul({ flightId: String(sealed._id), reason: "Airline cancelled sector", userId, allowedBranchIds: null }), 409);
    assert.equal((await FlightLinehaul.findById(sealed._id).lean().exec())?.status, "PLANNED");
  });
});
