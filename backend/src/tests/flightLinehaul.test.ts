import assert from "node:assert/strict";
import test from "node:test";
import { FlightLinehaul } from "../models/flightLinehaul.model.js";
import { FlightShipmentAllocation, allocationStatusValues } from "../models/flightShipmentAllocation.model.js";
import { portalNotificationTypeValues } from "../models/portalNotification.model.js";
import {
  calculateConnectionRisk,
  flightAllocationParcelDetails,
  formatFlightLinehaulNumber,
  allowedTransitions,
  remainingAllocatableParcelNumbers,
  remainingFlightAllocationTotals,
  shouldRecordFlightCustomsRelease
} from "../services/flightLinehaul.service.js";
import { getEmailPolicy, isEmailEnabledType } from "../services/email/catalog.js";
import { orphanedFlightCostSheetPipeline } from "../services/flightLinehaulIndexMigration.service.js";
import { comparableFlightNumber, normalizeFlightNumber } from "../utils/flightNumber.js";
import { describeMissingPrerequisites, findMissingPrerequisites } from "../services/shipmentStatusSequence.service.js";

function bookingSnapshot() {
  return {
    version: 1,
    source: { invoiceNumber: "INV-1", shipmentReference: "REF-1" },
    tracking: {
      swiftlineTrackingNumber: "SLC001",
      carrierShipmentId: "DPD-1",
      carrierTransactionId: "TX-1"
    },
    payment: { currency: "INR", totalAmountMinor: 100, advanceAmountMinor: 100, creditAmountMinor: 0 },
    parcels: [
      { sequence: 1, swiftlineParcelNumber: "PKG-1", carrierParcelNumber: "C-1", actualWeightKg: 2 },
      { sequence: 2, swiftlineParcelNumber: "PKG-2", carrierParcelNumber: "C-2", actualWeightKg: 5 }
    ],
    pricing: {
      parcels: [
        { sequence: 1, actualWeightKg: 2, volumetricWeightKg: 3, chargeableWeightKg: 3 },
        { sequence: 2, actualWeightKg: 5, volumetricWeightKg: 2, chargeableWeightKg: 5 }
      ]
    }
  };
}

test("flight allocation exposes actual, volumetric and chargeable weight per parcel", () => {
  assert.deepEqual(flightAllocationParcelDetails(bookingSnapshot()), [
    { parcelNumber: "PKG-1", actualWeightKg: 2, volumetricWeightKg: 3, chargeableWeightKg: 3 },
    { parcelNumber: "PKG-2", actualWeightKg: 5, volumetricWeightKg: 2, chargeableWeightKg: 5 }
  ]);
});

test("remaining flight totals exclude only the selected offloaded parcels", () => {
  const parcels = flightAllocationParcelDetails(bookingSnapshot());
  assert.deepEqual(remainingFlightAllocationTotals(parcels, ["PKG-2"]), {
    actualWeightKg: 5,
    volumetricWeightKg: 2,
    chargeableWeightKg: 5,
    pieces: 1
  });
  assert.deepEqual(remainingFlightAllocationTotals(parcels, []), {
    actualWeightKg: 0,
    volumetricWeightKg: 0,
    chargeableWeightKg: 0,
    pieces: 0
  });
});

test("chargeable weight falls back to the greater physical measure when absent", () => {
  const snapshot = bookingSnapshot() as { pricing: { parcels: Array<Record<string, unknown>> } };
  delete snapshot.pricing.parcels[0]!.chargeableWeightKg;
  assert.equal(flightAllocationParcelDetails(snapshot)[0]?.chargeableWeightKg, 3);
});

test("chargeable weight never trusts a stale value below actual or volumetric weight", () => {
  const snapshot = bookingSnapshot() as { pricing: { parcels: Array<Record<string, unknown>> } };
  snapshot.pricing.parcels[0]!.chargeableWeightKg = 1;
  assert.equal(flightAllocationParcelDetails(snapshot)[0]?.chargeableWeightKg, 3);
});

test("rejects malformed snapshots and invalid parcel measurements", () => {
  assert.deepEqual(flightAllocationParcelDetails(null), []);
  assert.deepEqual(flightAllocationParcelDetails({ version: 1, source: {}, tracking: {}, payment: {}, pricing: {}, parcels: [] }), []);

  const snapshot = bookingSnapshot() as {
    parcels: Array<Record<string, unknown>>;
    pricing: { parcels: Array<Record<string, unknown>> };
  };
  snapshot.parcels.push(
    { sequence: 3, swiftlineParcelNumber: "", actualWeightKg: 4 },
    { sequence: 4, swiftlineParcelNumber: "PKG-4", actualWeightKg: 0 },
    { sequence: 5, swiftlineParcelNumber: "PKG-5", actualWeightKg: 4 },
    { sequence: 6, swiftlineParcelNumber: "PKG-6", actualWeightKg: 4 }
  );
  snapshot.pricing.parcels.push(
    { sequence: 3, volumetricWeightKg: 4, chargeableWeightKg: 4 },
    { sequence: 4, volumetricWeightKg: 4, chargeableWeightKg: 4 },
    { sequence: 5, volumetricWeightKg: -1, chargeableWeightKg: 4 },
    { sequence: 6, volumetricWeightKg: Number.NaN, chargeableWeightKg: 4 }
  );

  assert.deepEqual(flightAllocationParcelDetails(snapshot).map((parcel) => parcel.parcelNumber), ["PKG-1", "PKG-2"]);
});

test("normalizes remaining parcel identifiers and ignores unknown selections", () => {
  const parcels = flightAllocationParcelDetails(bookingSnapshot());
  assert.deepEqual(remainingFlightAllocationTotals(parcels, [" pkg-1 ", "NOT-IN-SNAPSHOT", "PKG-1"]), {
    actualWeightKg: 2,
    volumetricWeightKg: 3,
    chargeableWeightKg: 3,
    pieces: 1
  });
});

test("later flights receive only held or deferred parcels that have not already travelled", () => {
  assert.deepEqual(remainingAllocatableParcelNumbers(
    ["PKG-1", "PKG-2", "PKG-3", "PKG-4"],
    [{
      manifestStatus: "DISPATCHED",
      scannedParcelNumbers: ["PKG-1", "PKG-2"],
      parcelDispositions: [
        { parcelNumber: "PKG-3", disposition: "DEFERRED_TO_NEXT_MANIFEST" },
        { parcelNumber: "PKG-4", disposition: "CANCELLED" }
      ]
    }]
  ), ["PKG-3"]);
});

test("the dispatched manifest being attached keeps its own scanned parcels allocatable", () => {
  assert.deepEqual(remainingAllocatableParcelNumbers(
    ["PKG-1", "PKG-2"],
    [{
      manifestId: "CURRENT-MANIFEST",
      manifestStatus: "DISPATCHED",
      scannedParcelNumbers: ["PKG-1", "PKG-2"]
    }],
    { ignoreManifestId: "CURRENT-MANIFEST" }
  ), ["PKG-1", "PKG-2"]);
});

test("ignoring the current manifest preserves protection from earlier dispatched manifests", () => {
  assert.deepEqual(remainingAllocatableParcelNumbers(
    ["PKG-1", "PKG-2", "PKG-3"],
    [
      {
        manifestId: "CURRENT-MANIFEST",
        manifestStatus: "DISPATCHED",
        scannedParcelNumbers: ["PKG-1", "PKG-2"],
        parcelDispositions: [{ parcelNumber: "PKG-3", disposition: "HELD" }]
      },
      {
        manifestId: "PRIOR-MANIFEST",
        manifestStatus: "DISPATCHED",
        scannedParcelNumbers: ["PKG-1"]
      }
    ],
    { ignoreManifestId: "CURRENT-MANIFEST" }
  ), ["PKG-2", "PKG-3"]);
});

test("draft manifest decisions do not release a parcel into a later flight allocation", () => {
  assert.deepEqual(remainingAllocatableParcelNumbers(
    ["PKG-1", "PKG-2"],
    [{
      manifestStatus: "SEALED",
      scannedParcelNumbers: ["PKG-1"],
      parcelDispositions: [{ parcelNumber: "PKG-2", disposition: "HELD" }]
    }]
  ), ["PKG-1", "PKG-2"]);
});

test("connection risk uses the exact operational thresholds", () => {
  assert.equal(calculateConnectionRisk(null), "LOW");
  assert.equal(calculateConnectionRisk(-1), "MISSED");
  assert.equal(calculateConnectionRisk(0), "CRITICAL");
  assert.equal(calculateConnectionRisk(89), "CRITICAL");
  assert.equal(calculateConnectionRisk(90), "HIGH");
  assert.equal(calculateConnectionRisk(119), "HIGH");
  assert.equal(calculateConnectionRisk(120), "MEDIUM");
  assert.equal(calculateConnectionRisk(179), "MEDIUM");
  assert.equal(calculateConnectionRisk(180), "LOW");
});

test("flight linehaul numbers are stable and padded", () => {
  assert.equal(formatFlightLinehaulNumber(1), "FLH0001");
  assert.equal(formatFlightLinehaulNumber(42), "FLH0042");
  assert.equal(formatFlightLinehaulNumber(10000), "FLH10000");
});

test("flight numbers use EY-219 display format while matching legacy EY219 values", () => {
  assert.equal(normalizeFlightNumber(" ey219 "), "EY-219");
  assert.equal(normalizeFlightNumber("EY-219"), "EY-219");
  assert.equal(comparableFlightNumber("EY219"), comparableFlightNumber("EY-219"));
});

test("flight departure prerequisites identify the missing shipment milestones", () => {
  const missing = findMissingPrerequisites("ORIGIN_HUB_DISPATCHED", ["ORIGIN_HUB_PROCESSED"]);
  assert.deepEqual(missing, ["WAREHOUSE_SCAN_IN", "READY_FOR_EXPORT"]);
  assert.match(describeMissingPrerequisites("ORIGIN_HUB_DISPATCHED", missing), /Ready for Dispatch/);
});

test("new flights use only the essential operational lifecycle", () => {
  assert.deepEqual(allowedTransitions.BOOKING_CONFIRMED, ["CARGO_ALLOCATED", "CANCELLED"]);
  assert.deepEqual(allowedTransitions.CARGO_ALLOCATED, ["DEPARTED", "CANCELLED"]);
  assert.deepEqual(allowedTransitions.DEPARTED, ["ARRIVED_DESTINATION"]);
  assert.deepEqual(allowedTransitions.ARRIVED_DESTINATION, ["CLOSED"]);
  assert.equal(allowedTransitions.CARGO_ALLOCATED.includes("MANIFEST_READY"), false);
  assert.equal(allowedTransitions.DEPARTED.includes("IN_TRANSIT"), false);
});

test("a customs hold is released only once when its flight status changes", () => {
  assert.equal(shouldRecordFlightCustomsRelease({
    previousCustomsStatus: "HELD",
    nextCustomsStatus: "CLEARED",
    latestShipmentStatus: "ON_HOLD",
    latestShipmentHoldReason: "customs_query"
  }), true);
  assert.equal(shouldRecordFlightCustomsRelease({
    previousCustomsStatus: "CLEARED",
    nextCustomsStatus: "CLEARED",
    latestShipmentStatus: "ON_HOLD",
    latestShipmentHoldReason: "customs_query"
  }), false);
  assert.equal(shouldRecordFlightCustomsRelease({
    previousCustomsStatus: "HELD",
    nextCustomsStatus: "CLEARED",
    latestShipmentStatus: "ON_HOLD",
    latestShipmentHoldReason: "payment_issue"
  }), false);
});

test("urgent flight notifications are registered for email and status notices remain in-app", () => {
  for (const type of ["FLIGHT_DELAY", "FLIGHT_OFFLOAD", "FLIGHT_CONNECTION_RISK", "FLIGHT_EXCEPTION", "FLIGHT_CUSTOMS_HOLD"] as const) {
    assert.ok((portalNotificationTypeValues as readonly string[]).includes(type), `${type} is missing from the notification enum`);
    assert.ok(isEmailEnabledType(type), `${type} is missing from the email catalogue`);
    assert.equal(getEmailPolicy(type)?.category, "OPERATIONAL");
  }
  for (const type of ["FLIGHT_DEPARTED", "FLIGHT_ARRIVED", "FLIGHT_FINAL_MILE_HANDOVER"] as const) {
    assert.ok((portalNotificationTypeValues as readonly string[]).includes(type), `${type} is missing from the notification enum`);
    assert.equal(isEmailEnabledType(type), false, `${type} should remain in-app only`);
  }
});

test("flight schema keeps MAWB searchable without using it as a unique portal identifier", () => {
  const index = (FlightLinehaul.schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown>]>).find((entry) => (
    entry[1].name === "uniq_active_flight_mawb"
  ));
  assert.equal(index, undefined);
  assert.equal(FlightLinehaul.schema.path("mawbNumber")?.options.index, true);
});

test("carried allocations are historical and do not match the active-allocation unique index", () => {
  assert.ok(allocationStatusValues.includes("CARRIED"));
  const index = (FlightShipmentAllocation.schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown>]>).find((entry) => (
    entry[1].name === "uniq_active_allocation_per_shipment"
  ));
  assert.deepEqual(index?.[1].partialFilterExpression, { status: "ALLOCATED" });
});

test("flight index migration allows a cost sheet whose manifest is awaiting flight assignment", () => {
  const pipeline = orphanedFlightCostSheetPipeline();
  assert.deepEqual(pipeline[1], { $match: { manifest: { $size: 0 } } });
  assert.doesNotMatch(JSON.stringify(pipeline), /flightLinehaulId/);
});
