import assert from "node:assert/strict";
import { describe, it } from "node:test";
import XLSX from "xlsx";
import mongoose from "mongoose";
import { buildManifestDocumentModel, type SealedSnapshot } from "../services/manifestDocument.service.js";
import { EDI_HEADERS, type EdiContext } from "../services/edi/ediColumns.js";
import { buildEdiWorkbookBuffer } from "../services/edi/ediWorkbook.service.js";

function sealedSnapshot(): SealedSnapshot {
  const bagOne = new mongoose.Types.ObjectId();
  const bagTwo = new mongoose.Types.ObjectId();
  const party = (overrides: Record<string, unknown>) => ({
    companyName: "", contactName: "", addressLine1: "", addressLine2: "",
    city: "", state: "", postcode: "", countryCode: "", countryName: "", phone: "", ...overrides
  });
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
        consignmentNumber: "SLC170712", manifestPieces: 1, weightKg: 45,
        consignorSnapshot: { formatted: "x", party: party({ contactName: "DINESH MARVADI", addressLine1: "RAULU MAJRA", city: "RUPNAGAR", state: "PUNJAB", postcode: "140102", countryCode: "IN", countryName: "India" }) },
        consigneeSnapshot: { formatted: "y", party: party({ contactName: "NAVPREET KAUR", addressLine1: "492 HANWORTH ROAD", city: "HOUNSLOW", postcode: "22885", countryCode: "DE", countryName: "Germany" }) },
        description: "SNACKS", declaredValueMinor: 11_000_00, currency: "INR", serviceInfo: "EXP",
        parcels: [
          { parcelNumber: "SLC170712-01", weightKg: 24.9, description: "SNACKS", bagNumber: "SLC01201" },
          { parcelNumber: "SLC170712-02", weightKg: 20.1, description: "SWEETS", bagNumber: "SLC01202" }
        ]
      },
      {
        bagId: bagTwo, shipmentDraftId: new mongoose.Types.ObjectId(), dpdShipmentId: new mongoose.Types.ObjectId(),
        consignmentNumber: "SLC170722", manifestPieces: 1, weightKg: 14.1,
        consignorSnapshot: { formatted: "x", party: party({ contactName: "KRUNAL GAJERA", addressLine1: "PIPLANWALA", city: "HOSHIARPUR", state: "PUNJAB", postcode: "146001", countryCode: "IN", countryName: "India" }) },
        consigneeSnapshot: { formatted: "y", party: party({ contactName: "MARIA K", addressLine1: "CHAMOSTERNAS 50", city: "ATHENS", postcode: "11853", countryCode: "GR", countryName: "Greece" }) },
        description: "SAREES", declaredValueMinor: 10_500_00, currency: "INR", serviceInfo: "EXP",
        parcels: [{ parcelNumber: "SLC170722-01", weightKg: 14.1, description: "SAREES", bagNumber: "SLC01202" }]
      }
    ],
    sealedAt: "2026-07-17T10:00:00.000Z"
  };
}

function readBack(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null });
  return { workbook, sheet, rows };
}

describe("edi workbook writer", () => {
  const context: EdiContext = {
    mawbNumber: "607-54691055",
    departureDate: "2026-07-17",
    aadhaarFor: (row) => (row.parcelNumber.startsWith("SLC170712") ? "234567890124" : "102158934472")
  };

  it("writes an .xlsx sheet with the header row and one row per parcel", async () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    const { workbook, sheet, rows } = readBack(await buildEdiWorkbookBuffer(model.parcelRows, context));

    assert.equal(workbook.SheetNames[0], "Sheet1");
    // Header row present with all 36 columns.
    const headerCells = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0];
    assert.deepEqual(headerCells, [...EDI_HEADERS]);
    // Three parcels across two consignments → three data rows.
    assert.equal(rows.length, 3);
  });

  it("maps each parcel to its own HAWB, weight, bag and country name", async () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    const { rows } = readBack(await buildEdiWorkbookBuffer(model.parcelRows, context));

    assert.deepEqual(rows.map((row) => row.HAWBNumber), ["SLC170712-01", "SLC170712-02", "SLC170722-01"]);
    assert.deepEqual(rows.map((row) => row.Weight), [24.9, 20.1, 14.1]);
    assert.deepEqual(rows.map((row) => row.MHBSNo), ["SLC01201", "SLC01202", "SLC01202"]);
    assert.deepEqual(rows.map((row) => row.ConsigneeCountry), ["GERMANY", "GERMANY", "GREECE"]);
    // State keeps its title case even though the rest of the content is upper-cased.
    assert.deepEqual(rows.map((row) => row.ConsignorState), ["Punjab", "Punjab", "Punjab"]);
  });

  it("writes compact parcel-derived identifiers regardless of the portal display setting", async (t) => {
    const originalFormat = process.env.SWIFTLINE_PARCEL_NUMBER_FORMAT;
    t.after(() => {
      if (originalFormat === undefined) delete process.env.SWIFTLINE_PARCEL_NUMBER_FORMAT;
      else process.env.SWIFTLINE_PARCEL_NUMBER_FORMAT = originalFormat;
    });
    process.env.SWIFTLINE_PARCEL_NUMBER_FORMAT = "LEGACY";

    const model = buildManifestDocumentModel(sealedSnapshot());
    const trackingNumber = "SLCDEL031126016";
    const legacyParcelNumber = `${trackingNumber}-01`;
    const parcelRow = {
      ...model.parcelRows[0]!,
      consignmentNumber: trackingNumber,
      parcelNumber: legacyParcelNumber
    };
    const customInvoiceRow = { ...parcelRow, exportInvoiceNumber: "INV-100" };
    const { rows } = readBack(await buildEdiWorkbookBuffer([parcelRow, customInvoiceRow], context));

    for (const field of ["HAWBNumber", "ExportInvoiceNo", "GSTInvoiceNo", "CRN_NO"] as const) {
      assert.equal(rows[0]![field], `${trackingNumber}01`);
    }
    assert.equal(rows[1]!.HAWBNumber, `${trackingNumber}01`);
    assert.equal(rows[1]!.ExportInvoiceNo, "INV-100");
    assert.equal(rows[1]!.GSTInvoiceNo, "INV-100");
    assert.equal(rows[0]!.MAWBNumber, "607-54691055");
  });

  it("keeps numeric cells numeric and text cells textual, and blanks the value on non-first parcels", async () => {
    const model = buildManifestDocumentModel(sealedSnapshot());
    const { sheet, rows } = readBack(await buildEdiWorkbookBuffer(model.parcelRows, context));

    // Goods value only on each consignment's first parcel row.
    assert.deepEqual(rows.map((row) => row.Value), [11000, null, 10500]);
    assert.deepEqual(rows.map((row) => row.FOB_Value), [11000, null, 10500]);
    // The full Aadhaar is read live and written as a number.
    assert.deepEqual(rows.map((row) => row.GSTINNumber), [234567890124, 234567890124, 102158934472]);
    // A numeric-looking postcode stays a text cell (B2 area: ConsigneePostalCode is column O).
    const postcodeCell = sheet.O2; // first data row, ConsigneePostalCode
    assert.equal(postcodeCell?.t, "s", "postal code must be a text cell");
    assert.equal(postcodeCell?.v, "22885");
    // Weight is a numeric cell.
    const weightCell = sheet.R2;
    assert.equal(weightCell?.t, "n");
    // Constant columns.
    assert.deepEqual([...new Set(rows.map((row) => row.PayType))], ["N"]);
    assert.deepEqual([...new Set(rows.map((row) => row.Bond))], ["NA"]);
    assert.deepEqual([...new Set(rows.map((row) => row.GSTDate))], ["17/7/2026"]);
    assert.deepEqual([...new Set(rows.map((row) => row.ADCode))], [null]);
  });

  it("upper-cases content but preserves the state and the GSTINType label", async () => {
    const snapshot = sealedSnapshot();
    const consignment = snapshot.consignments[0]!;
    consignment.parcels![0]!.description = "snacks, sweets";
    (consignment.consignorSnapshot.party as { contactName: string }).contactName = "Dinesh Marvadi";
    const model = buildManifestDocumentModel(snapshot);
    const { rows } = readBack(await buildEdiWorkbookBuffer(model.parcelRows, context));

    assert.equal(rows[0]!.DescriptionofGoods, "SNACKS, SWEETS");
    assert.equal(rows[0]!.ConsignorName, "DINESH MARVADI");
    assert.equal(rows[0]!.ConsignorState, "Punjab"); // preserved
    assert.equal(rows[0]!.GSTINType, "Aadhaar Number"); // preserved
  });
});
