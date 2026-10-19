import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOperationsBagViews, outstandingParcels, searchOperationsBagViews } from "./operationsManifestView";
import type { ManifestDetail, OperationsConsignment } from "./operationsManifests";

const bagIds = ["bag-1", "bag-2", "bag-3"];
const parcelNumbers = Array.from({ length: 6 }, (_, index) => `SLC001-${String(index + 1).padStart(2, "0")}`);

function detail(): ManifestDetail {
  const consignment: OperationsConsignment = {
    id: "consignment-1",
    shipmentDraftId: "draft-1",
    dpdShipmentId: "dpd-1",
    bagId: bagIds[0],
    bagIds,
    bagNumbers: ["SLC00101", "SLC00102", "SLC00103"],
    consignmentNumber: "SLC001",
    displayConsignmentNumber: "SLC001",
    consigneeSnapshot: { name: "Asha Patel", formatted: "Asha Patel\nLondon" },
    consignorSnapshot: { name: "Swiftline", formatted: "Swiftline" },
    description: "Shipment contents",
    weightKg: 21,
    status: "PARTIAL",
    serviceInfo: "EXP",
    goodsValueRequired: false,
    dpdWarning: "",
    carrierReconciliationRequired: false,
    carrierBookingReconciled: false,
    csbType: "CSB_IV",
    expectedParcelNumbers: [...parcelNumbers, "SLC001-07"],
    scannedParcelNumbers: parcelNumbers,
    activeParcelScans: parcelNumbers.map((parcelNumber, index) => ({
      parcelNumber,
      scanId: `scan-${index + 1}`,
      bagId: index < 2 ? bagIds[0] : index < 5 ? bagIds[1] : bagIds[2],
    })),
    parcelWeightSnapshots: parcelNumbers.map((parcelNumber, index) => ({
      parcelNumber,
      weightKg: index + 1,
      contentsDescription: "Box contents",
      items: [{ description: index === 3 ? "Handwoven scarf" : "Cotton shirt" }],
      valueMinor: (index + 1) * 100,
    })),
    parcelValues: parcelNumbers.map((parcelNumber, index) => ({ parcelNumber, valueMinor: (index + 1) * 100 })),
    parcelDispositions: [{ parcelNumber: "SLC001-07", disposition: "HELD", reason: "Not at facility", recordedAt: "2026-10-19T00:00:00.000Z" }],
  };
  return {
    manifest: {
      id: "manifest-1", manifestNumber: "SLC001", status: "SEALED", branchId: "branch-1",
      header: {
        destinationAgent: "London Gateway", destinationCountryCode: "GB", destinationCountryName: "United Kingdom",
        flightNumber: "EY-219", departureDate: "2026-10-19", mawbNumber: "607-00000000",
        originIataCode: "DEL", destinationIataCode: "LHR", valueType: "LV",
      },
      totalBags: 3, totalConsignments: 1, totalPhysicalParcels: 6, totalWeightKg: 21,
      createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z",
    },
    bags: bagIds.map((id, index) => ({
      id,
      sequence: index + 1,
      bagNumber: `SLC0010${index + 1}`,
      status: "CLOSED" as const,
      totalConsignments: 1,
      totalPhysicalParcels: [2, 3, 1][index],
      totalWeightKg: [3, 12, 6][index],
    })),
    consignments: [consignment],
    scans: [], latestScan: null, sealingIssues: [], destinationSummary: [], dispatchIssues: [],
  };
}

describe("operations manifest bag display", () => {
  it("places each accepted parcel in exactly its scanned bag and totals only those values", () => {
    const views = buildOperationsBagViews(detail());
    assert.deepEqual(views.map((view) => view.parcels.map((row) => row.parcelNumber)), [
      ["SLC001-01", "SLC001-02"],
      ["SLC001-03", "SLC001-04", "SLC001-05"],
      ["SLC001-06"],
    ]);
    assert.deepEqual(views.map((view) => view.recordedValueMinor), [300, 1200, 600]);
    assert.deepEqual(views.map((view) => view.bag.totalWeightKg), [3, 12, 6]);
    assert.deepEqual(views.map((view) => outstandingParcels(view).map((item) => item.parcel)), [
      ["SLC001-07"], ["SLC001-07"], ["SLC001-07"],
    ]);
    assert.equal(outstandingParcels(views[0])[0].label, "Held");
  });

  it("finds bags, packed and unscanned parcel numbers, consignee, and per-parcel items", () => {
    const views = buildOperationsBagViews(detail());
    assert.equal(searchOperationsBagViews(views, "SLC00103").length, 1);
    assert.equal(searchOperationsBagViews(views, "SLC001-04")[0].parcels.length, 1);
    assert.equal(searchOperationsBagViews(views, "SLC001-07").length, 3);
    assert.equal(searchOperationsBagViews(views, "Asha Patel").length, 3);
    assert.equal(searchOperationsBagViews(views, "handwoven scarf")[0].bag.id, "bag-2");
    assert.equal(searchOperationsBagViews(views, "not present").length, 0);
  });

  it("marks a bag value incomplete when a packed parcel lacks a value", () => {
    const input = detail();
    input.consignments[0].parcelValues[0].valueMinor = null;
    const views = buildOperationsBagViews(input);
    assert.equal(views[0].valueIncomplete, true);
    assert.equal(views[0].recordedValueMinor, 200);
    assert.equal(views[1].valueIncomplete, false);
  });

  it("treats zero as missing, matching manifest sealing validation", () => {
    const input = detail();
    input.consignments[0].parcelValues[0].valueMinor = 0;
    const views = buildOperationsBagViews(input);
    assert.equal(views[0].valueIncomplete, true);
    assert.equal(views[0].recordedValueMinor, 200);
  });
});
