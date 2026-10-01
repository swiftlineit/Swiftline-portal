import assert from "node:assert/strict";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import {
  buildManifestDocumentModel,
  parseCurrentManifestSnapshot,
  parseSealedSnapshot,
  type SealedSnapshot
} from "../services/manifestDocument.service.js";

function sealedSnapshot(): SealedSnapshot {
  const bagOne = new mongoose.Types.ObjectId();
  const bagTwo = new mongoose.Types.ObjectId();
  return {
    version: 2,
    manifestNumber: "SLCM262700012",
    header: {
      destinationAgent: "Swiftline UK", destinationCountryCode: "GB", destinationCountryName: "United Kingdom",
      flightNumber: "EY-219", departureDate: "2026-07-17", mawbNumber: "607-54691055",
      originIataCode: "DEL", destinationIataCode: "LHR", valueType: "LV"
    },
    branch: { name: "Swiftline Delhi", code: "SLC" },
    totals: { totalBags: 2, totalConsignments: 2, totalPhysicalParcels: 3, totalWeightKg: 44 },
    bags: [{ _id: bagOne, bagNumber: "SLC01201" }, { _id: bagTwo, bagNumber: "SLC01202" }],
    consignments: [
      {
        bagId: bagOne, shipmentDraftId: new mongoose.Types.ObjectId(), dpdShipmentId: new mongoose.Types.ObjectId(),
        consignmentNumber: "SLC170712", manifestPieces: 1, weightKg: 44,
        consignorSnapshot: { formatted: "DINESH MARVADI\nRAULU MAJRA", party: { contactName: "Dinesh Marvadi", state: "Punjab", city: "Rupnagar", postcode: "140102", countryCode: "IN", countryName: "India", companyName: "", addressLine1: "Raulu Majra", addressLine2: "", phone: "+918375887887" } },
        consigneeSnapshot: { formatted: "NAVPREET KAUR\n492 HANWORTH ROAD", party: { contactName: "Navpreet Kaur", state: "", city: "Hounslow", postcode: "TW4 5LG", countryCode: "GB", countryName: "United Kingdom", companyName: "", addressLine1: "492 Hanworth Road", addressLine2: "", phone: "+444475865390" } },
        description: "Clothing", declaredValueMinor: 11_000_00, currency: "INR", serviceInfo: "EXP",
        parcels: [
          { parcelNumber: "SLC170712-01", weightKg: 20, description: "Snacks", bagNumber: "SLC01201" },
          { parcelNumber: "SLC170712-02", weightKg: 19, description: "Sweets", bagNumber: "SLC01202" },
          { parcelNumber: "SLC170712-03", weightKg: 5, description: "", bagNumber: "SLC01201" }
        ]
      },
      {
        // A legacy consignment: no parcels array, no party. Produces one summary row.
        bagId: bagTwo, shipmentDraftId: new mongoose.Types.ObjectId(), dpdShipmentId: new mongoose.Types.ObjectId(),
        consignmentNumber: "SLC170722", manifestPieces: 1, weightKg: 14.1,
        consignorSnapshot: { formatted: "KRUNAL GAJERA" },
        consigneeSnapshot: { formatted: "KRUNAL GAJERA" },
        description: "Sarees", declaredValueMinor: 10_500_00, currency: "INR", serviceInfo: "EXP"
      }
    ],
    sealedAt: "2026-07-17T10:00:00.000Z"
  };
}

describe("manifest document model", () => {
  it("parses a complete snapshot and rejects an incomplete one", () => {
    assert.ok(parseSealedSnapshot(sealedSnapshot()));
    assert.equal(parseSealedSnapshot(null), null);
    assert.equal(parseSealedSnapshot({ header: {}, branch: {} }), null);
  });

  it("uses corrected active header metadata without mutating the frozen sealed snapshot", () => {
    const original = sealedSnapshot();
    const currentHeader = { ...original.header, flightNumber: "AI-313", mawbNumber: "789-1234-5678", departureDate: "2026-10-02" };
    const current = parseCurrentManifestSnapshot(original, currentHeader);
    assert.equal(current?.header.flightNumber, "AI-313");
    assert.equal(current?.header.mawbNumber, "789-1234-5678");
    assert.equal(current?.header.departureDate, "2026-10-02");
    assert.equal(original.header.flightNumber, "EY-219");
    assert.equal(original.header.departureDate, "2026-07-17");
  });

  it("flattens to one row per parcel with a continuous serial", () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    assert.equal(model.parcelRows.length, 4); // 3 parcels + 1 legacy summary row
    assert.deepEqual(model.parcelRows.map((row) => row.serial), [1, 2, 3, 4]);
    assert.deepEqual(model.parcelRows.map((row) => row.parcelNumber), ["SLC170712-01", "SLC170712-02", "SLC170712-03", ""]);
    assert.deepEqual(model.parcelRows.map((row) => row.weightKg), [20, 19, 5, 14.1]);
  });

  it("states the goods value only on each consignment's first parcel row", () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    assert.deepEqual(model.parcelRows.map((row) => row.declaredValueMinor), [11_000_00, null, null, 10_500_00]);
  });

  it("gives each parcel its own value when the sealed parcels carry per-parcel values", () => {
    const snapshot = sealedSnapshot();
    const parcels = (snapshot.consignments[0]!.parcels)!;
    parcels[0]!.valueMinor = 6_000_00;
    parcels[1]!.valueMinor = 3_000_00;
    parcels[2]!.valueMinor = 2_000_00;
    const model = buildManifestDocumentModel(snapshot);
    // First consignment: each parcel row now shows its own value, not just the first.
    assert.deepEqual(model.parcelRows.slice(0, 3).map((row) => row.declaredValueMinor), [6_000_00, 3_000_00, 2_000_00]);
    // The legacy consignment (no per-parcel value) still shows its value on its one row.
    assert.equal(model.parcelRows[3]?.declaredValueMinor, 10_500_00);
  });

  it("falls back to the consignment description for a parcel that has none", () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    assert.equal(model.parcelRows[2]?.description, "Clothing"); // third parcel had ""
  });

  it("carries the structured party through, and null when absent (legacy row)", () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    assert.equal(model.parcelRows[0]?.consignor.party?.state, "Punjab");
    assert.equal(model.parcelRows[0]?.consignee.party?.countryCode, "GB");
    assert.equal(model.parcelRows[3]?.consignor.party, null);
    assert.equal(model.parcelRows[3]?.consignor.formatted, "KRUNAL GAJERA");
  });

  it("keeps the parcel barcode as the HAWB source and bag as the MHBS source", () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    assert.deepEqual(model.parcelRows.map((row) => row.bagNumber), ["SLC01201", "SLC01202", "SLC01201", "SLC01202"]);
    assert.equal(model.parcelRows[0]?.formattedConsignmentNumber, "SLC170712");
  });
});
