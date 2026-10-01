import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestArchive } from "../models/operationsManifestArchive.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { OperationsManifestCounter } from "../models/operationsManifestCounter.model.js";
import { OperationsManifestScan } from "../models/operationsManifestScan.model.js";
import { OperationsManifestScanSession } from "../models/operationsManifestScanSession.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { FlightLinehaul } from "../models/flightLinehaul.model.js";
import { FlightLinehaulCounter } from "../models/flightLinehaulCounter.model.js";
import { FlightShipmentAllocation } from "../models/flightShipmentAllocation.model.js";
import { FlightOffload } from "../models/flightOffload.model.js";
import { FlightException } from "../models/flightException.model.js";
import { FlightDocument } from "../models/flightDocument.model.js";
import { FlightCostSheet } from "../models/flightCostSheet.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { operationsBranchIds } from "../middleware/operationsBranchAccess.middleware.js";
import { normalizePortalRole } from "../utils/portalRole.js";
import {
  buildOperationsManifestExcel,
  buildOperationsManifestPdf,
  buildManifestSealReadinessIssues,
  buildManifestDispatchIssues,
  buildManifestDispatchTrackingEvent,
  buildManifestReadyTrackingEvent,
  allocateOperationsManifestNumber,
  alreadyScannedParcelMessage,
  calculateScannedParcelWeight,
  chooseOperationsBagForParcel,
  createOperationsManifestWithFlight,
  deferredParcelEligibility,
  deleteOperationsManifest,
  formatOperationsBagNumber,
  formatOperationsManifestNumber,
  isOperationsBagWeightAllowed,
  isOperationsManifestNumberReusable,
  movingManifestConsignments,
  operationsManifestSearchConditions,
  sealedManifestDeletionBlockReason,
  OPERATIONS_MANIFEST_ORIGIN_ADDRESS,
  sealingIssues,
  shouldReactivateTrailingOperationsBag,
  summarizeBagComposition,
  summarizeManifestDestinations,
  unaccountedManifestParcelNumbers
} from "../services/operationsManifest.service.js";

describe("operations manifest list search", () => {
  it("searches literal manifest and flight values plus matching branches and shipments", () => {
    const branchId = new mongoose.Types.ObjectId();
    const manifestId = new mongoose.Types.ObjectId();
    const conditions = operationsManifestSearchConditions("EY.219", [branchId], [manifestId]);
    const flightPattern = conditions.find((condition) => "header.flightNumber" in condition)?.["header.flightNumber"] as RegExp;

    assert.equal(flightPattern.test("EY.219"), true);
    assert.equal(flightPattern.test("EYx219"), false);
    assert.ok(conditions.some((condition) => "branchId" in condition));
    assert.ok(conditions.some((condition) => "_id" in condition));
    assert.deepEqual(operationsManifestSearchConditions(""), []);
  });
});

describe("operations manifest omitted parcels", () => {
  it("includes the bag number when a parcel was already scanned", () => {
    assert.equal(
      alreadyScannedParcelMessage("SLC031B01"),
      "This parcel has already been scanned and is in bag number SLC031B01."
    );
    assert.equal(alreadyScannedParcelMessage(), "This parcel has already been scanned.");
  });

  it("requires every unscanned parcel to have an explicit disposition", () => {
    assert.deepEqual(unaccountedManifestParcelNumbers({
      expectedParcelNumbers: ["P01", "P02", "P03", "P04"],
      scannedParcelNumbers: ["P01", "P02", "P03"],
      parcelDispositions: []
    }), ["P04"]);
    assert.deepEqual(unaccountedManifestParcelNumbers({
      expectedParcelNumbers: ["P01", "P02", "P03", "P04"],
      scannedParcelNumbers: ["P01", "P02", "P03"],
      parcelDispositions: [{ parcelNumber: "P04", disposition: "HELD" }]
    }), []);
  });

  it("releases held and deferred parcels only after the earlier manifest dispatches", () => {
    const prior = {
      manifestStatus: "DISPATCHED",
      manifestNumber: "SLC017",
      expectedParcelNumbers: ["P01", "P02"],
      scannedParcelNumbers: ["P01"],
      parcelDispositions: [{ parcelNumber: "P02", disposition: "DEFERRED_TO_NEXT_MANIFEST" as const }]
    };
    assert.equal(deferredParcelEligibility("P02", [prior]).allowed, true);
    assert.equal(deferredParcelEligibility("P02", [{ ...prior, manifestStatus: "SEALED" }]).allowed, false);
  });

  it("never releases a parcel cancelled on an earlier manifest", () => {
    const result = deferredParcelEligibility("P02", [{
      manifestStatus: "DISPATCHED",
      manifestNumber: "SLC017",
      expectedParcelNumbers: ["P01", "P02"],
      scannedParcelNumbers: ["P01"],
      parcelDispositions: [{ parcelNumber: "P02", disposition: "CANCELLED" }]
    }]);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /cancelled/i);
  });

  it("does not allow sealing until every omitted parcel is decided and every bag is closed", () => {
    const manifest = sealedManifest();
    manifest.status = "READY_TO_SEAL";
    const issues = sealingIssues(manifest, [{ status: "CLOSED", totalWeightKg: 10, totalPhysicalParcels: 3 }], [{
      status: "PARTIAL",
      consignmentNumber: "SLC-TEST-01",
      expectedParcelNumbers: ["P01", "P02", "P03", "P04"],
      scannedParcelNumbers: ["P01", "P02", "P03"],
      parcelDispositions: [],
      parcelWeightSnapshots: [
        { parcelNumber: "P01", valueMinor: 100 },
        { parcelNumber: "P02", valueMinor: 100 },
        { parcelNumber: "P03", valueMinor: 100 }
      ]
    }]);
    assert.equal(issues.some((issue) => /Ready for Dispatch|bag barcode/i.test(issue)), false);
    assert.ok(issues.some((issue) => /^SLC-TEST-01: Choose Held, Deferred/i.test(issue)));

    const resolved = sealingIssues(manifest, [{ status: "CLOSED", totalWeightKg: 10, totalPhysicalParcels: 3 }], [{
      status: "PARTIAL",
      expectedParcelNumbers: ["P01", "P02", "P03", "P04"],
      scannedParcelNumbers: ["P01", "P02", "P03"],
      parcelDispositions: [{ parcelNumber: "P04", disposition: "DEFERRED_TO_NEXT_MANIFEST" }],
      parcelWeightSnapshots: [
        { parcelNumber: "P01", valueMinor: 100 },
        { parcelNumber: "P02", valueMinor: 100 },
        { parcelNumber: "P03", valueMinor: 100 }
      ]
    }]);
    assert.deepEqual(resolved, []);
  });
});

describe("combined operations manifest and flight setup", () => {
  it("creates and links a draft manifest, first bag, and booked auto-departure flight in one transaction", async () => {
    const manifestId = new mongoose.Types.ObjectId();
    const flightId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const savedManifest: Record<string, unknown> = {
      _id: manifestId,
      manifestNumber: "SLC031",
      branchId,
      status: "DRAFT",
      header: {
        destinationAgent: "London Gateway",
        destinationCountryCode: "GB",
        destinationCountryName: "United Kingdom",
        flightNumber: "EY-219",
        departureDate: "2026-09-30",
        mawbNumber: "607-54691055",
        originIataCode: "DEL",
        destinationIataCode: "LHR",
        valueType: "LV"
      },
      save: async () => undefined
    };
    let manifestCreateInput: Record<string, unknown> | undefined;
    let bagCreateInput: Record<string, unknown> | undefined;
    let flightCreateInput: Record<string, unknown> | undefined;
    let transactionCount = 0;
    const originals = {
      startSession: mongoose.startSession,
      branchFindOne: Branch.findOne,
      manifestCounter: OperationsManifestCounter.findOneAndUpdate,
      flightCounter: FlightLinehaulCounter.findOneAndUpdate,
      manifestCreate: OperationsManifest.create,
      bagFindOne: OperationsManifestBag.findOne,
      bagCreate: OperationsManifestBag.create,
      flightCreate: FlightLinehaul.create,
      auditCreate: AuditLog.create
    };
    const query = (result: unknown) => ({
      lean() { return this; },
      sort() { return this; },
      session() { return this; },
      exec: async () => result
    });

    (mongoose as any).startSession = async () => ({
      withTransaction: async (callback: () => Promise<unknown>) => {
        transactionCount += 1;
        return callback();
      },
      endSession: async () => undefined
    });
    (Branch as any).findOne = () => query({ _id: branchId, status: "ACTIVE" });
    (OperationsManifestCounter as any).findOneAndUpdate = () => ({ exec: async () => ({ lastAllocatedSequence: 31 }) });
    (FlightLinehaulCounter as any).findOneAndUpdate = () => ({ exec: async () => ({ lastAllocatedSequence: 42 }) });
    (OperationsManifest as any).create = async (rows: Array<Record<string, unknown>>) => {
      manifestCreateInput = rows[0];
      return [savedManifest];
    };
    (OperationsManifestBag as any).findOne = () => query(null);
    (OperationsManifestBag as any).create = async (rows: Array<Record<string, unknown>>) => {
      bagCreateInput = rows[0];
      return [{ _id: new mongoose.Types.ObjectId(), bagNumber: "SLC03101" }];
    };
    (FlightLinehaul as any).create = async (rows: Array<Record<string, unknown>>) => {
      flightCreateInput = rows[0];
      return [{ _id: flightId, flightLinehaulNumber: "FLH0042", status: "BOOKING_CONFIRMED" }];
    };
    (AuditLog as any).create = async () => [];

    try {
      const created = await createOperationsManifestWithFlight({
        branchId: String(branchId),
        userId,
        header: savedManifest.header as never,
        flight: {
          airlineName: "Etihad Airways",
          scheduledDepartureAt: "2026-09-30T06:30:00.000Z",
          scheduledArrivalAt: "2026-09-30T12:30:00.000Z",
          capacityKg: 1000
        }
      });

      assert.equal(transactionCount, 1);
      assert.equal(created.manifest.manifestNumber, "SLC031");
      assert.equal(created.manifest.flightLinehaulId, flightId);
      assert.equal((manifestCreateInput as Record<string, unknown>).status, "DRAFT");
      assert.equal((bagCreateInput as Record<string, unknown>).bagNumber, "SLC03101");
      assert.equal((flightCreateInput as Record<string, unknown>).status, "BOOKING_CONFIRMED");
      assert.equal((flightCreateInput as Record<string, unknown>).scheduledDepartureAutomationEnabled, true);
      assert.equal(created.flight.status, "BOOKING_CONFIRMED");
    } finally {
      (mongoose as any).startSession = originals.startSession;
      (Branch as any).findOne = originals.branchFindOne;
      (OperationsManifestCounter as any).findOneAndUpdate = originals.manifestCounter;
      (FlightLinehaulCounter as any).findOneAndUpdate = originals.flightCounter;
      (OperationsManifest as any).create = originals.manifestCreate;
      (OperationsManifestBag as any).findOne = originals.bagFindOne;
      (OperationsManifestBag as any).create = originals.bagCreate;
      (FlightLinehaul as any).create = originals.flightCreate;
      (AuditLog as any).create = originals.auditCreate;
    }
  });
});

describe("operations manifest dispatch readiness", () => {
  const firstDraftId = new mongoose.Types.ObjectId();
  const secondDraftId = new mongoose.Types.ObjectId();
  const readyStatuses = [
    "WAREHOUSE_SCAN_IN",
    "ORIGIN_HUB_PROCESSED",
    "READY_FOR_EXPORT"
  ];
  const eventsFor = (shipmentDraftId: mongoose.Types.ObjectId, statuses: string[]) =>
    statuses.map((status, index) => ({ shipmentDraftId, status, eventAt: new Date(2026, 7, 22, 8, index) }));

  it("allocates shipment consignments with scanned pieces and leaves fully omitted shipments behind", () => {
    const moving = { consignmentNumber: "SLC-MOVING", scannedParcelNumbers: ["P01", "P02", "P03"] };
    const held = { consignmentNumber: "SLC-HELD", scannedParcelNumbers: [] as string[] };
    assert.deepEqual(movingManifestConsignments([moving, held]), [moving]);
  });

  it("creates only the dispatch tracking milestone and carries no manifest IATA", () => {
    const event = buildManifestDispatchTrackingEvent({
      shipmentDraftId: firstDraftId,
      dpdShipmentId: new mongoose.Types.ObjectId(),
      manifestId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      dispatchedAt: new Date("2026-08-22T08:00:00.000Z")
    });

    assert.equal(event.status, "ORIGIN_HUB_DISPATCHED");
    assert.equal(event.location, "");
    assert.equal("gatewayCode" in event, false);
  });

  it("creates the customer-visible Ready for Dispatch event when sealing", () => {
    const event = buildManifestReadyTrackingEvent({
      shipmentDraftId: firstDraftId,
      dpdShipmentId: new mongoose.Types.ObjectId(),
      manifestId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      sealedAt: new Date("2026-08-22T08:00:00.000Z")
    });
    assert.equal(event.status, "READY_FOR_EXPORT");
    assert.equal(event.customerVisible, true);
    assert.match(event.sourceReference, /:SEALED$/);
  });

  it("allows dispatch when every packed shipment has completed the origin steps", () => {
    assert.deepEqual(buildManifestDispatchIssues({
      consignments: [
        { shipmentDraftId: firstDraftId, consignmentNumber: "SLC-READY-01" },
        { shipmentDraftId: secondDraftId, consignmentNumber: "SLC-READY-02" }
      ],
      events: [
        ...eventsFor(firstDraftId, readyStatuses),
        ...eventsFor(secondDraftId, readyStatuses)
      ]
    }), []);
  });

  it("blocks the entire dispatch and names each shipment with missing milestones", () => {
    const issues = buildManifestDispatchIssues({
      consignments: [
        { shipmentDraftId: firstDraftId, consignmentNumber: "SLC-READY-01" },
        { shipmentDraftId: secondDraftId, consignmentNumber: "SLC-GAP-02" }
      ],
      events: [
        ...eventsFor(firstDraftId, readyStatuses),
        ...eventsFor(secondDraftId, ["WAREHOUSE_SCAN_IN"])
      ]
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.reference, "SLC-GAP-02");
    assert.deepEqual(issues[0]?.missingStatuses, ["ORIGIN_HUB_PROCESSED", "READY_FOR_EXPORT"]);
  });

  it("blocks held and cancelled consignments before manifest mutation", () => {
    const issues = buildManifestDispatchIssues({
      consignments: [
        { shipmentDraftId: firstDraftId, consignmentNumber: "SLC-HOLD-01" },
        { shipmentDraftId: secondDraftId, consignmentNumber: "SLC-CANCEL-02" }
      ],
      events: [
        ...eventsFor(firstDraftId, readyStatuses),
        { shipmentDraftId: firstDraftId, status: "ON_HOLD", eventAt: new Date(2026, 7, 22, 9) },
        ...eventsFor(secondDraftId, readyStatuses)
      ],
      cancellations: [{ shipmentDraftId: secondDraftId, status: "COMPLETED" }]
    });
    assert.match(issues.find((issue) => issue.reference === "SLC-HOLD-01")?.reason ?? "", /on hold/);
    assert.match(issues.find((issue) => issue.reference === "SLC-CANCEL-02")?.reason ?? "", /cancelled/);
  });

  it("also blocks a cancellation recorded only in shipment event history", () => {
    const issues = buildManifestDispatchIssues({
      consignments: [{ shipmentDraftId: firstDraftId, consignmentNumber: "SLC-CANCEL-EVENT" }],
      events: [
        ...eventsFor(firstDraftId, readyStatuses),
        { shipmentDraftId: firstDraftId, status: "SHIPMENT_CANCELLED", eventAt: new Date(2026, 7, 22, 10) }
      ]
    });
    assert.match(issues[0]?.reason ?? "", /cancelled/);
  });
});

describe("operations manifest sealing readiness", () => {
  it("allows closed bags and reports only missing shipment prerequisites", () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const issues = buildManifestSealReadinessIssues({
      consignments: [{ shipmentDraftId, consignmentNumber: "SLC-READY-01" }],
      events: [
        { shipmentDraftId, status: "SHIPMENT_BOOKED", eventAt: new Date("2026-09-18T08:00:00Z") },
        { shipmentDraftId, status: "WAREHOUSE_SCAN_IN", eventAt: new Date("2026-09-18T08:10:00Z") },
        { shipmentDraftId, status: "ORIGIN_HUB_PROCESSED", eventAt: new Date("2026-09-18T08:20:00Z") }
      ]
    });
    assert.deepEqual(issues, []);

    const missing = buildManifestSealReadinessIssues({
      consignments: [{ shipmentDraftId, consignmentNumber: "SLC-READY-01" }],
      events: [{ shipmentDraftId, status: "SHIPMENT_BOOKED", eventAt: new Date("2026-09-18T08:00:00Z") }]
    });
    assert.deepEqual(missing[0]?.missingStatuses, ["WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED"]);
  });
});

function sealedManifest() {
  const manifestId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const bagId = new mongoose.Types.ObjectId();
  return new OperationsManifest({
    _id: manifestId,
    manifestNumber: "SLCM262700001",
    branchId,
    header: {
      destinationAgent: "Swiftline UK\n14 Marwell Avenue\nUB4 0QR\nUnited Kingdom",
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      flightNumber: "EY-219",
      departureDate: "2026-07-25",
      mawbNumber: "607-54691055",
      originIataCode: "DEL",
      destinationIataCode: "LHR",
      valueType: "LV"
    },
    status: "SEALED",
    totalBags: 1,
    totalConsignments: 1,
    totalPhysicalParcels: 2,
    totalWeightKg: 10,
    createdBy: new mongoose.Types.ObjectId(),
    sealedSnapshot: {
      version: 1,
      manifestNumber: "SLCM262700001",
      header: {
        destinationAgent: "Swiftline UK\n14 Marwell Avenue\nUB4 0QR\nUnited Kingdom",
        destinationCountryCode: "GB", destinationCountryName: "United Kingdom", flightNumber: "EY-219",
        departureDate: "2026-07-25", mawbNumber: "607-54691055", originIataCode: "DEL", destinationIataCode: "LHR", valueType: "LV"
      },
      branch: { _id: branchId, name: "Swiftline Delhi", code: "DEL-001", address: { address: "1 Logistics Park", city: "Delhi", stateOrProvince: "Delhi", postalCode: "110001", countryName: "India" } },
      totals: { totalBags: 1, totalConsignments: 1, totalPhysicalParcels: 2, totalWeightKg: 10 },
      bags: [{ _id: bagId, bagNumber: "SLC00101" }],
      consignments: [{
        bagId, shipmentDraftId: new mongoose.Types.ObjectId(), dpdShipmentId: new mongoose.Types.ObjectId(),
        consignmentNumber: "SLDL22072026000001", manifestPieces: 1, weightKg: 10,
        consignorSnapshot: { formatted: "Example Exporter\nRavi Sharma\nDelhi\nIndia" },
        consigneeSnapshot: { formatted: "Example Consignee\nAsha Patel\nLondon\nUnited Kingdom" },
        description: "Clothing", declaredValueMinor: 25_000_00, currency: "INR", serviceInfo: "EXP"
      }],
      sealedAt: "2026-07-22T10:00:00.000Z"
    }
  });
}

async function exerciseManifestDeletion(
  status: "DRAFT" | "SEALED",
  fixture: {
    manifestId?: mongoose.Types.ObjectId;
    bagId?: mongoose.Types.ObjectId;
    deleteMode?: "ARCHIVE" | "PERMANENT";
    events?: Array<Record<string, unknown>>;
    flightStatus?: string;
    allocations?: Array<Record<string, unknown>>;
    flightDocuments?: Array<Record<string, unknown>>;
  } = {}
) {
  const manifestId = fixture.manifestId ?? new mongoose.Types.ObjectId();
  const manifestNumber = status === "DRAFT" ? "SLC017" : "SLC018";
  const shipmentDraftId = new mongoose.Types.ObjectId();
  const bagId = fixture.bagId ?? new mongoose.Types.ObjectId();
  const flightId = fixture.flightStatus ? new mongoose.Types.ObjectId() : null;
  const manifest = {
    _id: manifestId,
    manifestNumber,
    branchId: new mongoose.Types.ObjectId(),
    status,
    totalBags: 1,
    totalConsignments: status === "DRAFT" ? 0 : 2,
    totalPhysicalParcels: status === "DRAFT" ? 0 : 3,
    totalWeightKg: status === "DRAFT" ? 0 : 12,
    flightLinehaulId: flightId,
    sealedSnapshot: status === "SEALED" ? { header: {}, branch: {}, totals: {}, bags: [], consignments: [] } : {},
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    toObject() { return { ...this }; }
  };
  const deletedChildren: string[] = [];
  let removedEventFilter: Record<string, unknown> | undefined;
  let remainingFixtureEvents = [...(fixture.events ?? [])];
  let counterUpdate: unknown;
  let auditEntry: Record<string, unknown> | undefined;
  let archived: Record<string, unknown> | undefined;

  const originals = {
    startSession: mongoose.startSession,
    findById: OperationsManifest.findById,
    manifestDeleteOne: OperationsManifest.deleteOne,
    bagDeleteMany: OperationsManifestBag.deleteMany,
    consignmentDeleteMany: OperationsManifestConsignment.deleteMany,
    scanDeleteMany: OperationsManifestScan.deleteMany,
    sessionDeleteMany: OperationsManifestScanSession.deleteMany,
    bagFind: OperationsManifestBag.find,
    consignmentFind: OperationsManifestConsignment.find,
    shipmentEventFind: ShipmentEvent.find,
    shipmentEventDeleteMany: ShipmentEvent.deleteMany,
    flightFindById: FlightLinehaul.findById,
    flightDeleteOne: FlightLinehaul.deleteOne,
    allocationFind: FlightShipmentAllocation.find,
    allocationDeleteMany: FlightShipmentAllocation.deleteMany,
    offloadFind: FlightOffload.find,
    offloadDeleteMany: FlightOffload.deleteMany,
    exceptionFind: FlightException.find,
    exceptionDeleteMany: FlightException.deleteMany,
    flightDocumentFind: FlightDocument.find,
    flightDocumentDeleteMany: FlightDocument.deleteMany,
    costSheetFind: FlightCostSheet.find,
    costSheetCountDocuments: FlightCostSheet.countDocuments,
    costSheetUpdateMany: FlightCostSheet.updateMany,
    portalNotificationDeleteMany: PortalNotification.deleteMany,
    counterUpdateOne: OperationsManifestCounter.updateOne,
    auditCreate: AuditLog.create,
    archiveCreate: OperationsManifestArchive.create
  };

  const deletionQuery = (label: string) => ({
    exec: async () => {
      deletedChildren.push(label);
      return { deletedCount: 1 };
    }
  });
  const query = <T,>(value: T) => ({
    select() { return this; },
    session() { return this; },
    lean() { return this; },
    exec: async () => value
  });

  (mongoose as any).startSession = async () => ({
    withTransaction: async (callback: () => Promise<unknown>) => callback(),
    endSession: async () => undefined
  });
  (OperationsManifest as any).findById = () => ({
    session() { return this; },
    exec: async () => manifest
  });
  (OperationsManifestConsignment as any).find = () => query(
    fixture.events?.length ? [{ shipmentDraftId }] : []
  );
  (OperationsManifestBag as any).find = () => query(status === "SEALED" ? [{ _id: bagId }] : []);
  (ShipmentEvent as any).find = () => query(remainingFixtureEvents);
  (ShipmentEvent as any).deleteMany = (filter: Record<string, unknown>) => {
    removedEventFilter = filter;
    const before = remainingFixtureEvents.length;
    const sourceReferences = filter.sourceReference as { $in: string[] };
    const shipmentDraftIds = filter.shipmentDraftId as { $in: mongoose.Types.ObjectId[] };
    remainingFixtureEvents = remainingFixtureEvents.filter((event) => !(
      sourceReferences.$in.includes(String(event.sourceReference))
      && shipmentDraftIds.$in.some((id) => String(id) === String(shipmentDraftId))
      && event.status === filter.status
    ));
    return { exec: async () => ({ deletedCount: before - remainingFixtureEvents.length }) };
  };
  const flight = flightId ? {
    _id: flightId,
    status: fixture.flightStatus,
    toObject() { return { _id: flightId, status: fixture.flightStatus, flightNumber: "EY-219" }; }
  } : null;
  (FlightLinehaul as any).findById = () => query(flight);
  (FlightLinehaul as any).deleteOne = () => deletionQuery("flight");
  (FlightShipmentAllocation as any).find = () => query(fixture.allocations ?? []);
  (FlightShipmentAllocation as any).deleteMany = () => deletionQuery("allocations");
  (FlightOffload as any).find = () => query([]);
  (FlightOffload as any).deleteMany = () => deletionQuery("offloads");
  (FlightException as any).find = () => query([]);
  (FlightException as any).deleteMany = () => deletionQuery("exceptions");
  (FlightDocument as any).find = () => query(fixture.flightDocuments ?? []);
  (FlightDocument as any).deleteMany = () => deletionQuery("flightDocuments");
  (FlightCostSheet as any).countDocuments = () => query(0);
  (FlightCostSheet as any).find = () => query([]);
  (FlightCostSheet as any).updateMany = () => deletionQuery("costSheets");
  (PortalNotification as any).deleteMany = () => deletionQuery("notifications");
  (OperationsManifest as any).deleteOne = () => deletionQuery("manifest");
  (OperationsManifestBag as any).deleteMany = () => deletionQuery("bags");
  (OperationsManifestConsignment as any).deleteMany = () => deletionQuery("consignments");
  (OperationsManifestScan as any).deleteMany = () => deletionQuery("scans");
  (OperationsManifestScanSession as any).deleteMany = () => deletionQuery("scanSessions");
  (OperationsManifestCounter as any).updateOne = (_filter: unknown, update: unknown) => {
    counterUpdate = update;
    return { exec: async () => ({ acknowledged: true }) };
  };
  (AuditLog as any).create = async (entries: Array<Record<string, unknown>>) => {
    auditEntry = entries[0];
    return entries;
  };
  (OperationsManifestArchive as any).create = async (entries: Array<Record<string, unknown>>) => {
    archived = entries[0];
    return entries;
  };

  try {
    const result = await deleteOperationsManifest({
      manifestId: String(manifestId),
      confirmationManifestNumber: manifestNumber,
      mode: status === "SEALED" ? fixture.deleteMode ?? "ARCHIVE" : "PERMANENT",
      reason: status === "SEALED" ? "Test archive deletion" : "Test draft deletion",
      userId: new mongoose.Types.ObjectId()
    }, {
      stageOperationsManifestArchive: async () => [{ format: "pdf", key: "archive/test.pdf", filename: "test.pdf", contentType: "application/pdf", checksumSha256: "abc" }],
      removeStagedArchiveDocuments: async () => undefined
    });
    return { result, deletedChildren, counterUpdate, auditEntry, archived, removedEventFilter, remainingFixtureEvents, manifestId };
  } finally {
    (mongoose as any).startSession = originals.startSession;
    (OperationsManifest as any).findById = originals.findById;
    (OperationsManifest as any).deleteOne = originals.manifestDeleteOne;
    (OperationsManifestBag as any).deleteMany = originals.bagDeleteMany;
    (OperationsManifestConsignment as any).deleteMany = originals.consignmentDeleteMany;
    (OperationsManifestScan as any).deleteMany = originals.scanDeleteMany;
    (OperationsManifestScanSession as any).deleteMany = originals.sessionDeleteMany;
    (OperationsManifestConsignment as any).find = originals.consignmentFind;
    (OperationsManifestBag as any).find = originals.bagFind;
    (ShipmentEvent as any).find = originals.shipmentEventFind;
    (ShipmentEvent as any).deleteMany = originals.shipmentEventDeleteMany;
    (FlightLinehaul as any).findById = originals.flightFindById;
    (FlightLinehaul as any).deleteOne = originals.flightDeleteOne;
    (FlightShipmentAllocation as any).find = originals.allocationFind;
    (FlightShipmentAllocation as any).deleteMany = originals.allocationDeleteMany;
    (FlightOffload as any).find = originals.offloadFind;
    (FlightOffload as any).deleteMany = originals.offloadDeleteMany;
    (FlightException as any).find = originals.exceptionFind;
    (FlightException as any).deleteMany = originals.exceptionDeleteMany;
    (FlightDocument as any).find = originals.flightDocumentFind;
    (FlightDocument as any).deleteMany = originals.flightDocumentDeleteMany;
    (FlightCostSheet as any).find = originals.costSheetFind;
    (FlightCostSheet as any).countDocuments = originals.costSheetCountDocuments;
    (FlightCostSheet as any).updateMany = originals.costSheetUpdateMany;
    (PortalNotification as any).deleteMany = originals.portalNotificationDeleteMany;
    (OperationsManifestCounter as any).updateOne = originals.counterUpdateOne;
    (AuditLog as any).create = originals.auditCreate;
    (OperationsManifestArchive as any).create = originals.archiveCreate;
  }
}

/** Three boxes of one shipment: 20 kg and 5 kg in bag 01, 19 kg in bag 02. */
function sealedMultiParcelManifest() {
  const manifest = sealedManifest();
  const snapshot = manifest.sealedSnapshot as Record<string, unknown>;
  const bagOne = new mongoose.Types.ObjectId();
  const bagTwo = new mongoose.Types.ObjectId();
  snapshot.bags = [
    { _id: bagOne, sequence: 1, bagNumber: "SLC00101" },
    { _id: bagTwo, sequence: 2, bagNumber: "SLC00102" }
  ];
  snapshot.totals = { totalBags: 2, totalConsignments: 1, totalPhysicalParcels: 3, totalWeightKg: 44 };
  const consignments = snapshot.consignments as Array<Record<string, unknown>>;
  const first = consignments[0];
  if (first) {
    first.bagId = bagOne;
    first.weightKg = 44;
    first.description = "Clothing, Footwear, Books";
    first.parcels = [
      { parcelNumber: "SLDL22072026000001P01", weightKg: 20, description: "Clothing", bagNumber: "SLC00101" },
      { parcelNumber: "SLDL22072026000001P02", weightKg: 19, description: "Footwear", bagNumber: "SLC00102" },
      { parcelNumber: "SLDL22072026000001P03", weightKg: 5, description: "Books", bagNumber: "SLC00101" }
    ];
  }
  return manifest;
}

async function manifestSheetRows(manifest: InstanceType<typeof OperationsManifest>) {
  const workbook = new ExcelJS.Workbook();
  const bytes = await buildOperationsManifestExcel(manifest);
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet("Manifest");
  assert.ok(sheet);
  return sheet;
}

describe("operations manifest safeguards", () => {
  // The export prints one row per parcel; each of those rows still counts as one piece.
  it("counts a consignment as a single piece regardless of how many boxes it holds", async () => {
    const row = new OperationsManifestConsignment({
      manifestId: new mongoose.Types.ObjectId(), bagId: new mongoose.Types.ObjectId(), shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(), businessAccountId: new mongoose.Types.ObjectId(), consignmentNumber: "SLDL22072026000001",
      expectedParcelNumbers: ["SLDL22072026000001P01", "SLDL22072026000001P02"], scannedParcelNumbers: ["SLDL22072026000001P01"],
      parcelWeightSnapshots: [{ parcelNumber: "SLDL22072026000001P01", weightKg: 5 }, { parcelNumber: "SLDL22072026000001P02", weightKg: 5 }],
      manifestPieces: 1, weightKg: 10, status: "PARTIAL", consignorSnapshot: {}, consigneeSnapshot: {}, description: "Clothing", currency: "INR", serviceInfo: "EXP", dpdLabelGenerated: false
    });
    await row.validate();
    assert.equal(row.manifestPieces, 1);
    row.manifestPieces = 2 as 1;
    await assert.rejects(row.validate(), /manifestPieces/);
  });

  it("keeps each parcel row intact while ordering the standard Excel by bag sequence", async () => {
    const sheet = await manifestSheetRows(sealedMultiParcelManifest());
    const dataRows: Array<{ serial: unknown; weight: unknown; description: unknown; bag: unknown }> = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 14) return;
      const serial = row.getCell(1).value;
      if (typeof serial === "number") {
        dataRows.push({ serial, weight: row.getCell(4).value, description: row.getCell(7).value, bag: row.getCell(10).value });
      }
    });

    assert.equal(dataRows.length, 3, "each of the three boxes needs its own row");
    assert.deepEqual(dataRows.map((row) => row.serial), [1, 2, 3]);
    assert.deepEqual(dataRows.map((row) => row.weight), [20, 5, 19]);
    // Each row describes only its own box, never the whole shipment.
    assert.deepEqual(dataRows.map((row) => row.description), ["Clothing", "Books", "Footwear"]);
    // Complete rows move together: the two boxes packed in Bag 01 are adjacent.
    assert.deepEqual(dataRows.map((row) => row.bag), ["SLC00101", "SLC00101", "SLC00102"]);
  });

  it("expands the Excel description row for wrapped contents", async () => {
    const manifest = sealedManifest();
    const snapshot = manifest.sealedSnapshot as Record<string, unknown>;
    const consignments = snapshot.consignments as Array<Record<string, unknown>>;
    consignments[0]!.description = "RAKHI, CHOCOLATE, DOODH, DAHI, LASSI, PANEER, KHOYA, CHEENI, CHAIPATTI, TISSUE, DYES, TOOTHPASTE, LEMONS, TEA, LOCKS";

    const sheet = await manifestSheetRows(manifest);
    const descriptionCell = sheet.getCell(15, 7);

    assert.equal(descriptionCell.value, consignments[0]!.description);
    assert.equal(sheet.getCell("E3").value, "FROM *");
    assert.equal(sheet.getCell("F3").value, "TO *");
    assert.equal(sheet.getCell("G3").value, "Manifest Number");
    assert.equal(sheet.getCell("H3").value, "SLCM262700001");
    assert.equal(sheet.getCell("E14").value, "Consignor *");
    assert.equal(sheet.getCell("F14").value, "Consignee *");
    assert.equal(sheet.getCell("G14").value, "Description *");
    assert.equal(sheet.getCell("H14").value, "Value *");
    assert.equal(sheet.getCell("L14").value, null);
    assert.ok((sheet.getRow(15).height ?? 0) > 26, "the description row must grow with wrapped content");
  });

  it("prints every item from a parcel instead of the bounded summary", async () => {
    const manifest = sealedManifest();
    const snapshot = manifest.sealedSnapshot as Record<string, unknown>;
    const consignments = snapshot.consignments as Array<Record<string, unknown>>;
    consignments[0]!.parcels = [{
      parcelNumber: "SLDL22072026000001P01",
      weightKg: 5,
      description: "DRY SEVIYA, DRY FRUIT, DRY TEA, DRY MASALA, HAIR OIL, COTTON BRA, CREAM & FACE WASH, PLASTIC SPOON, COTTON SUIT",
      items: [
        "DRY SEVIYA", "DRY FRUIT", "DRY TEA", "DRY MASALA", "HAIR OIL", "COTTON BRA",
        "CREAM & FACE WASH", "PLASTIC SPOON", "COTTON SUIT", "COTTON PAD", "COTTON T-SHIRT",
        "COTTON LOWER", "REXINE JUTTI", "REXINE SHOES", "DRY PICKLE", "DRY PANJIRI", "DRY DESI GHEE"
      ].map((description) => ({ description, hsnCode: "", unitType: "Pcs", quantity: 1, unitRate: 0 })),
      bagNumber: "SLC00101",
      valueMinor: 25_000_00
    }];

    const sheet = await manifestSheetRows(manifest);
    const description = String(sheet.getCell(15, 7).value);

    assert.match(description, /COTTON PAD/);
    assert.match(description, /DRY DESI GHEE/);
    assert.ok((sheet.getRow(15).height ?? 0) > 26, "the full item list must grow the description row");
  });

  it("ends every parcel block on an empty line instead of a separator row", async () => {
    const sheet = await manifestSheetRows(sealedMultiParcelManifest());
    const serialRowNumbers: number[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 14 && typeof row.getCell(1).value === "number") serialRowNumbers.push(rowNumber);
    });

    assert.equal(serialRowNumbers.length, 3);
    const [first, second, third] = serialRowNumbers as [number, number, number];
    assert.equal(second - first, third - second, "parcel blocks must be evenly spaced");

    // The row closing each block carries no data in any column.
    for (const start of serialRowNumbers) {
      const closingRow = sheet.getRow(start + (second - first) - 1);
      for (let column = 1; column <= 12; column += 1) {
        const value = closingRow.getCell(column).value;
        assert.ok(value === null || value === undefined || value === "", `column ${column} must be blank on the closing line`);
      }
    }
  });

  it("splits one consignment across bags and charges each bag only its own parcels", () => {
    const bagOne = new mongoose.Types.ObjectId();
    const bagTwo = new mongoose.Types.ObjectId();
    const consignmentId = new mongoose.Types.ObjectId();
    const consignments = [{
      parcelWeightSnapshots: [
        { parcelNumber: "P01", weightKg: 20 },
        { parcelNumber: "P02", weightKg: 20 }
      ]
    }];
    // A 40 kg shipment cannot fit one 32 kg bag, but each 20 kg parcel fits its own.
    const composition = summarizeBagComposition([
      { bagId: bagOne, parcelNumber: "P01", consignmentId },
      { bagId: bagTwo, parcelNumber: "P02", consignmentId }
    ], consignments);

    assert.equal(composition.get(String(bagOne))?.weightKg, 20);
    assert.equal(composition.get(String(bagTwo))?.weightKg, 20);
    assert.equal(composition.get(String(bagOne))?.parcelCount, 1);
    assert.equal(composition.get(String(bagOne))?.consignmentIds.size, 1);
    assert.equal(isOperationsBagWeightAllowed(composition.get(String(bagOne))?.weightKg ?? 0), true);
  });

  it("rolls a parcel into a new bag instead of refusing it, unless the parcel alone is oversized", () => {
    const bagWeightKg = 30;
    const parcelWeightKg = 8;
    // The bag is full for this parcel, so packing must continue in a fresh bag.
    assert.equal(isOperationsBagWeightAllowed(bagWeightKg + parcelWeightKg), false);
    // The parcel itself fits a bag, so it is packed rather than rejected.
    assert.equal(isOperationsBagWeightAllowed(parcelWeightKg), true);
    // Only a parcel heavier than a whole bag can never be packed.
    assert.equal(isOperationsBagWeightAllowed(32.5), false);
  });

  it("automatically packs 10, 10, 20, 10 kg as Bag 01, 01, 02, 01", () => {
    const bags: Array<{ id: string; sequence: number; status: string; totalWeightKg: number }> = [
      { id: "bag-1", sequence: 1, status: "OPEN", totalWeightKg: 0 }
    ];
    const assignments = [10, 10, 20, 10].map((weight) => {
      let selected = chooseOperationsBagForParcel(bags, weight);
      if (!selected) {
        const next = { id: `bag-${bags.length + 1}`, sequence: bags.length + 1, status: "OPEN", totalWeightKg: 0 };
        bags.push(next);
        selected = next;
      }
      const bag = bags.find((item) => item.id === selected?.id);
      assert.ok(bag);
      bag.totalWeightKg += weight;
      return bag.sequence;
    });

    assert.deepEqual(assignments, [1, 1, 2, 1]);
    assert.deepEqual(bags.map((bag) => bag.totalWeightKg), [30, 20]);
  });

  it("keeps a shipment together before applying general best-fit", () => {
    const selected = chooseOperationsBagForParcel([
      { id: "bag-1", sequence: 1, status: "OPEN", totalWeightKg: 15, containsConsignment: false },
      { id: "bag-2", sequence: 2, status: "OPEN", totalWeightKg: 5, containsConsignment: true }
    ], 10);
    assert.equal(selected?.id, "bag-2");
  });

  it("reactivates only an empty cancelled trailing bag", () => {
    assert.equal(shouldReactivateTrailingOperationsBag("CANCELLED", false), true);
    assert.equal(shouldReactivateTrailingOperationsBag("CANCELLED", true), false);
    assert.equal(shouldReactivateTrailingOperationsBag("CLOSED", false), false);
  });

  it("summarizes mixed final countries without treating the MAWB route as a parcel restriction", () => {
    assert.deepEqual(summarizeManifestDestinations([
      { consigneeSnapshot: { party: { countryCode: "GB", countryName: "United Kingdom" } }, scannedParcelNumbers: ["GB-1", "GB-2"] },
      { consigneeSnapshot: { party: { countryCode: "PL", countryName: "Poland" } }, scannedParcelNumbers: ["PL-1"] }
    ]), [
      { countryCode: "PL", countryName: "Poland", consignments: 1, parcels: 1 },
      { countryCode: "GB", countryName: "United Kingdom", consignments: 1, parcels: 2 }
    ]);
  });

  it("counts every parcel packed into the same bag once, whatever consignment it belongs to", () => {
    const bagId = new mongoose.Types.ObjectId();
    const first = new mongoose.Types.ObjectId();
    const second = new mongoose.Types.ObjectId();
    const composition = summarizeBagComposition([
      { bagId, parcelNumber: "A01", consignmentId: first },
      { bagId, parcelNumber: "A02", consignmentId: first },
      { bagId, parcelNumber: "B01", consignmentId: second }
    ], [
      { parcelWeightSnapshots: [{ parcelNumber: "A01", weightKg: 5 }, { parcelNumber: "A02", weightKg: 5 }] },
      { parcelWeightSnapshots: [{ parcelNumber: "B01", weightKg: 6 }] }
    ]);

    assert.equal(composition.get(String(bagId))?.weightKg, 16);
    assert.equal(composition.get(String(bagId))?.parcelCount, 3);
    assert.equal(composition.get(String(bagId))?.consignmentIds.size, 2);
  });

  it("uses the flight sequence for bag numbering and adds only scanned parcel weight", async () => {
    // The bag number is the manifest number plus a two-digit bag suffix.
    assert.equal(formatOperationsManifestNumber(17), "SLC017");
    assert.equal(formatOperationsBagNumber("SLC012", 1), "SLC01201");
    assert.equal(formatOperationsBagNumber("SLC012", 12), "SLC01212");
    assert.equal(formatOperationsBagNumber("SLC017", 1), "SLC01701");
    const parcelWeights = [{ parcelNumber: "P01", weightKg: 5 }, { parcelNumber: "P02", weightKg: 5 }];
    assert.equal(calculateScannedParcelWeight({ scannedParcelNumbers: ["P01"], parcelWeightSnapshots: parcelWeights }), 5);
    assert.equal(calculateScannedParcelWeight({ scannedParcelNumbers: ["P01", "P02"], parcelWeightSnapshots: parcelWeights }), 10);

    assert.equal(isOperationsBagWeightAllowed(32), true);
    assert.equal(isOperationsBagWeightAllowed(32.001), false);
  });

  it("marks the counter update as an aggregation pipeline", async () => {
    const original = OperationsManifestCounter.findOneAndUpdate;
    let capturedOptions: { updatePipeline?: boolean } | undefined;
    let capturedUpdate: unknown;
    (OperationsManifestCounter as any).findOneAndUpdate = (
      _filter: unknown,
      update: unknown,
      options: { updatePipeline?: boolean },
    ) => {
      capturedUpdate = update;
      capturedOptions = options;
      return { exec: async () => ({ sequence: 25, lastAllocatedSequence: 17 }) };
    };

    try {
      assert.equal(await allocateOperationsManifestNumber(), "SLC017");
      assert.equal(capturedOptions?.updatePipeline, true);
      assert.match(JSON.stringify(capturedUpdate), /reusableSequences/);
    } finally {
      OperationsManifestCounter.findOneAndUpdate = original;
    }
  });

  it("reuses deleted manifest numbers only while their movement is still safely reversible", () => {
    assert.equal(isOperationsManifestNumberReusable("DRAFT"), true);
    assert.equal(isOperationsManifestNumberReusable("PACKING"), true);
    assert.equal(isOperationsManifestNumberReusable("READY_TO_SEAL"), true);
    assert.equal(isOperationsManifestNumberReusable("SEALED"), true);
    assert.equal(isOperationsManifestNumberReusable("DISPATCHED"), false);
    assert.equal(isOperationsManifestNumberReusable("CANCELLED"), true);
  });

  it("allows sealed deletion only before flight movement, later shipment milestones, offloads, and active costs", () => {
    assert.equal(sealedManifestDeletionBlockReason({ flightStatus: "BOOKING_CONFIRMED", allocationStatuses: ["ALLOCATED"] }), null);
    assert.match(sealedManifestDeletionBlockReason({ flightStatus: "DEPARTED" }) ?? "", /departed or arrived/);
    assert.match(sealedManifestDeletionBlockReason({ allocationStatuses: ["CARRIED"] }) ?? "", /carried or offloaded/);
    assert.match(sealedManifestDeletionBlockReason({ hasOffloads: true }) ?? "", /offload history/);
    assert.match(sealedManifestDeletionBlockReason({ hasActiveCostSheet: true }) ?? "", /flight cost sheet/);
    assert.match(sealedManifestDeletionBlockReason({ shipmentStatuses: ["OUT_FOR_DELIVERY"] }) ?? "", /advanced beyond Ready for Dispatch/);
  });

  it("deletes every manifest workspace child and queues a draft number for reuse", async () => {
    const deleted = await exerciseManifestDeletion("DRAFT");
    assert.equal(deleted.result.manifestNumber, "SLC017");
    assert.equal(deleted.result.numberWillBeReused, true);
    assert.deepEqual(deleted.deletedChildren, ["scanSessions", "scans", "consignments", "bags", "manifest"]);
    assert.match(JSON.stringify(deleted.counterUpdate), /reusableSequences/);
    assert.equal(deleted.auditEntry?.action, "OPERATIONS_MANIFEST_DELETED");
  });

  it("archives an issued manifest before releasing its number", async () => {
    const deleted = await exerciseManifestDeletion("SEALED");
    assert.equal(deleted.result.manifestNumber, "SLC018");
    assert.equal(deleted.result.numberWillBeReused, true);
    assert.equal(deleted.archived?.manifestNumber, "SLC018");
    assert.equal(deleted.archived?.recordType, "ARCHIVED");
    assert.equal(String(deleted.archived?.originalManifestId), String(deleted.manifestId));
    assert.equal(deleted.archived?.deletionMode, "ARCHIVE");
    assert.equal((deleted.archived?.documents as unknown[])?.length, 1);
    assert.match(JSON.stringify(deleted.counterUpdate), /reusableSequences/);
    assert.deepEqual(deleted.deletedChildren, ["scanSessions", "scans", "consignments", "bags", "manifest"]);
  });

  it("removes only the Ready for Dispatch milestone created by the sealed manifest and archives its linked pre-departure flight", async () => {
    const manifestId = new mongoose.Types.ObjectId();
    const bagId = new mongoose.Types.ObjectId();
    const sourceReference = `MANIFEST:${String(manifestId)}:SEALED`;
    const bagSourceReference = `BAG:${String(bagId)}:READY`;
    const deleted = await exerciseManifestDeletion("SEALED", {
      manifestId,
      bagId,
      flightStatus: "BOOKING_CONFIRMED",
      allocations: [{ status: "ALLOCATED", awb: "1017000001", weightKg: 8, pieces: 1 }],
      events: [
        { status: "ORIGIN_HUB_PROCESSED", sourceReference: "SCAN" },
        { status: "READY_FOR_EXPORT", sourceReference },
        { status: "READY_FOR_EXPORT", sourceReference: bagSourceReference },
        { status: "READY_FOR_EXPORT", sourceReference: "MANUAL" }
      ],
      flightDocuments: [{ _id: new mongoose.Types.ObjectId(), documentType: "BOOKING_CONFIRMATION", originalName: "booking.pdf", storageKey: "private/flight/booking.pdf", mimeType: "application/pdf", size: 10, note: "", createdAt: new Date() }]
    });
    const removedFilter = deleted.removedEventFilter as {
      shipmentDraftId: { $in: unknown[] };
      sourceReference: { $in: string[] };
      status: string;
    } | undefined;
    assert.equal(removedFilter?.shipmentDraftId.$in.length, 1);
    assert.deepEqual(removedFilter?.sourceReference.$in, [sourceReference, bagSourceReference]);
    assert.equal(removedFilter?.status, "READY_FOR_EXPORT");
    assert.deepEqual(deleted.remainingFixtureEvents.map((event) => event.sourceReference), ["SCAN", "MANUAL"]);
    assert.equal(deleted.result.readyMilestonesRemoved, 2);
    const linkedFlight = deleted.archived?.linkedFlight as { flight?: Record<string, unknown>; allocations?: unknown[]; documents?: Array<Record<string, unknown>> };
    assert.equal(linkedFlight.flight?.status, "BOOKING_CONFIRMED");
    assert.equal(linkedFlight.allocations?.length, 1);
    assert.equal(linkedFlight.documents?.[0]?.storageKey, "private/flight/booking.pdf");
    assert.ok(deleted.deletedChildren.includes("flight"));
    assert.ok(deleted.deletedChildren.includes("allocations"));
  });

  it("permanently deletes a sealed pre-departure manifest, removes its own readiness event, and releases its number without an archive", async () => {
    const manifestId = new mongoose.Types.ObjectId();
    const sourceReference = `MANIFEST:${String(manifestId)}:SEALED`;
    const deleted = await exerciseManifestDeletion("SEALED", {
      manifestId,
      deleteMode: "PERMANENT",
      flightStatus: "BOOKING_CONFIRMED",
      events: [
        { status: "READY_FOR_EXPORT", sourceReference },
        { status: "READY_FOR_EXPORT", sourceReference: "MANUAL" }
      ]
    });
    assert.equal(deleted.result.mode, "PERMANENT");
    assert.equal(deleted.result.numberWillBeReused, true);
    assert.equal(deleted.archived, undefined);
    assert.deepEqual(deleted.remainingFixtureEvents.map((event) => event.sourceReference), ["MANUAL"]);
    assert.ok(deleted.deletedChildren.includes("flight"));
    assert.ok(deleted.deletedChildren.includes("allocations"));
  });

  it("enforces idempotent scan request identifiers and active parcel uniqueness", () => {
    const indexes = OperationsManifestScan.schema.indexes() as Array<[
      Record<string, number>,
      { unique?: boolean; partialFilterExpression?: Record<string, string> }
    ]>;
    const requestIndex = indexes.find(([fields]) => fields.scanRequestId === 1);
    const parcelIndex = indexes.find(([fields]) => fields.parcelNumber === 1);
    assert.equal(requestIndex?.[1]?.unique, true);
    assert.equal(parcelIndex?.[1]?.unique, true);
    assert.deepEqual(parcelIndex?.[1]?.partialFilterExpression, { status: "ACCEPTED" });
  });

  it("records camera scan provenance and protects active scanner sessions", async () => {
    const scan = new OperationsManifestScan({
      manifestId: new mongoose.Types.ObjectId(),
      bagId: new mongoose.Types.ObjectId(),
      parcelNumber: "SLDL22072026000001P01",
      scanRequestId: crypto.randomUUID(),
      status: "ACCEPTED",
      scanSource: "CAMERA",
      scanSessionId: new mongoose.Types.ObjectId(),
      message: "Parcel added.",
      scannedBy: new mongoose.Types.ObjectId()
    });
    await scan.validate();
    assert.equal(scan.scanSource, "CAMERA");

    const indexes = OperationsManifestScanSession.schema.indexes() as Array<[
      Record<string, number>,
      { unique?: boolean; partialFilterExpression?: Record<string, string>; expireAfterSeconds?: number }
    ]>;
    const activeSessionIndex = indexes.find(([, options]) => options.partialFilterExpression?.status === "ACTIVE");
    const purgeIndex = indexes.find(([fields]) => fields.purgeAt === 1);
    assert.equal(activeSessionIndex?.[1].unique, true);
    assert.deepEqual(activeSessionIndex?.[1].partialFilterExpression, { status: "ACTIVE" });
    assert.equal(purgeIndex?.[1].expireAfterSeconds, 0);
  });

  it("maps legacy roles to current ones and scopes operations users to assigned branches", () => {
    const firstBranch = new mongoose.Types.ObjectId();
    const secondBranch = new mongoose.Types.ObjectId();
    assert.equal(normalizePortalRole("staff"), "operations");
    assert.equal(normalizePortalRole("accounts"), "finance");
    assert.equal(normalizePortalRole("finance"), "finance");
    assert.deepEqual(operationsBranchIds({
      user: { _id: new mongoose.Types.ObjectId(), role: "operations", assignedBranches: [firstBranch, secondBranch] }
    } as never), [String(firstBranch), String(secondBranch)]);
    assert.equal(operationsBranchIds({
      user: { _id: new mongoose.Types.ObjectId(), role: "admin", assignedBranches: [] }
    } as never), null);
  });

  it("renders sealed Excel and PDF files from the immutable snapshot", async () => {
    const manifest = sealedManifest();
    const bytes = await buildOperationsManifestExcel(manifest);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const sheet = workbook.getWorksheet("Manifest");
    assert.ok(sheet);
    const values = sheet.getSheetValues().flat(3).filter(Boolean).join(" ");
    assert.match(values, /SLCM262700001/);
    assert.match(values, /SLDL220720260001/);
    assert.match(values, /SLC00101/);
    assert.match(values, /Example Consignee/);
    const pdf = await buildOperationsManifestPdf(manifest);
    assert.ok(pdf.length > 1000);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  });

  it("renders the frozen Swiftline legal FROM block on v3 documents", async () => {
    const manifest = sealedManifest();
    const snapshot = manifest.sealedSnapshot as Record<string, unknown>;
    snapshot.version = 3;
    snapshot.originAddress = OPERATIONS_MANIFEST_ORIGIN_ADDRESS;
    const sheet = await manifestSheetRows(manifest);
    const values = sheet.getSheetValues().flat(3).filter(Boolean).join(" ");
    assert.match(values, /M\/S SWIFTLINE CARGO AND EXPRESS/);
    assert.match(values, /HARYANA-123401/);
  });
});
