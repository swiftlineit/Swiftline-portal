import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { ShipmentManifest, type IShipmentManifest, type ShipmentManifestLineSnapshot } from "../models/shipmentManifest.model.js";
import { ShipmentManifestCounter } from "../models/shipmentManifestCounter.model.js";
import {
  allocateShipmentManifestNumber,
  buildHandoverManifestLine,
  buildManifestLine,
  formatManifestOrigin,
  hydrateMissingManifestParcelChargeableWeights,
  manifestBusinessAccountName,
  resolveClientManifestAccountScope,
  shipmentManifestCounterKey,
  shipmentManifestNumberPrefix,
  shipmentManifestSearchConditions,
  type ManifestPartySnapshot
} from "../services/shipmentManifest.service.js";
import { buildShipmentManifestHandoverWorkbook } from "../services/shipmentManifestExcel.service.js";
import { buildShipmentManifestPdf, manifestRows } from "../services/shipmentManifestPdf.service.js";
import type { ShipmentBookingSnapshot } from "../services/shipmentBookingSnapshot.service.js";

describe("shipment manifest identifiers and search", () => {
  it("uses up to three business-name initials or the full single-word name", () => {
    assert.equal(shipmentManifestNumberPrefix("ADITYA INTERNATIONAL COURIER AND LOGISTICS"), "AIC");
    assert.equal(shipmentManifestNumberPrefix("SITARAM EXPORT"), "SE");
    assert.equal(shipmentManifestNumberPrefix("routes"), "routes");
    assert.equal(shipmentManifestNumberPrefix(""), "SLC");
    assert.equal(shipmentManifestCounterKey("routes"), "shipment-manifest:ROUTES");
    assert.equal(new ShipmentManifest({ manifestNumber: "routes-001" }).manifestNumber, "routes-001");
  });

  it("treats manifest search input literally and searches manifest/account/shipment references", () => {
    const conditions = shipmentManifestSearchConditions("AIC.001");
    assert.equal(conditions.length, 7);
    const numberPattern = conditions[0]?.manifestNumber as RegExp;
    assert.equal(numberPattern.test("AIC.001"), true);
    assert.equal(numberPattern.test("AICx001"), false);
    assert.ok(conditions.some((condition) => "lineSnapshots.consignmentNumber" in condition));
    assert.deepEqual(shipmentManifestSearchConditions("  "), []);
  });

  it("keeps an explicitly requested client account inside their active membership scope", () => {
    const ownAccountId = new mongoose.Types.ObjectId();
    const otherAccountId = new mongoose.Types.ObjectId();
    const ownScope = resolveClientManifestAccountScope([ownAccountId], String(ownAccountId));
    assert.equal(ownScope.allowed, true);
    assert.equal(String(ownScope.filter.businessAccountId), String(ownAccountId));
    assert.equal(resolveClientManifestAccountScope([ownAccountId], String(otherAccountId)).allowed, false);
    assert.equal(resolveClientManifestAccountScope([]).allowed, false);
  });

  it("allocates atomic prefix sequences and seeds the legacy SLC counter without reusing old numbers", async () => {
    const counters = new Map<string, { sequence: number }>([["shipment-manifest", { sequence: 42 }]]);
    const existingNumbers = ["SLC-045"];
    const originals = {
      counterFindById: ShipmentManifestCounter.findById,
      counterFindOneAndUpdate: ShipmentManifestCounter.findOneAndUpdate,
      counterUpdateOne: ShipmentManifestCounter.updateOne,
      manifestFind: ShipmentManifest.find
    };
    const query = <T,>(value: T) => ({
      select() { return this; },
      lean() { return this; },
      exec: async () => value
    });

    (ShipmentManifestCounter as any).findById = (id: string) => query(counters.get(id) ?? null);
    (ShipmentManifest as any).find = (filter: { manifestNumber: RegExp }) =>
      query(existingNumbers.filter((manifestNumber) => filter.manifestNumber.test(manifestNumber)).map((manifestNumber) => ({ manifestNumber })));
    (ShipmentManifestCounter as any).updateOne = (filter: { _id: string }, update: { $max: { sequence: number } }) => ({
      exec: async () => {
        const current = counters.get(filter._id);
        counters.set(filter._id, { sequence: Math.max(current?.sequence ?? 0, update.$max.sequence) });
        return { acknowledged: true };
      }
    });
    (ShipmentManifestCounter as any).findOneAndUpdate = (filter: { _id: string }) => ({
      exec: async () => {
        const next = { sequence: (counters.get(filter._id)?.sequence ?? 0) + 1 };
        counters.set(filter._id, next);
        return next;
      }
    });

    try {
      assert.equal(await allocateShipmentManifestNumber("ADITYA INTERNATIONAL COURIER AND LOGISTICS"), "AIC-001");
      assert.equal(await allocateShipmentManifestNumber("ANOTHER INTERNATIONAL CARGO"), "AIC-002");
      assert.equal(await allocateShipmentManifestNumber("SITARAM EXPORT"), "SE-001");
      assert.equal(await allocateShipmentManifestNumber("routes"), "routes-001");
      assert.equal(await allocateShipmentManifestNumber("Swiftline Line Cargo"), "SLC-046");
    } finally {
      (ShipmentManifestCounter as any).findById = originals.counterFindById;
      (ShipmentManifestCounter as any).findOneAndUpdate = originals.counterFindOneAndUpdate;
      (ShipmentManifestCounter as any).updateOne = originals.counterUpdateOne;
      (ShipmentManifest as any).find = originals.manifestFind;
    }
  });
});

function bookingSnapshot(): ShipmentBookingSnapshot {
  return {
    version: 1,
    bookedAt: "2026-07-21T10:00:00.000Z",
    source: { invoiceNumber: "INV-001", shipmentReference: "SHIP-001" },
    account: {
      company: {
        companyName: "Example Exporter",
        registeredAddress: "1 Export Road",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110001",
        addressCountry: "India"
      },
      contact: {
        title: "Mr.",
        firstName: "Ravi",
        lastName: "Sharma",
        countryCode: "+91",
        mobileNumber: "9000000000"
      }
    },
    sender: {
      name: "Swiftline Delhi",
      code: "DEL-001",
      address: {
        address: "1 Logistics Park",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110001",
        countryName: "India"
      }
    },
    consignee: {
      companyName: "Example Consignee",
      contactName: "Asha Patel",
      mobileCountryCode: "+44",
      mobileNumber: "7123456789",
      addressLine1: "10 Downing Street",
      townOrCity: "London",
      postcode: "SW1A 2AA",
      countryCode: "GB",
      countryName: "United Kingdom"
    },
    service: { type: "COURIER", code: "DPD_CLASSIC" },
    tracking: {
      swiftlineTrackingNumber: "SLDL21072026000001",
      carrierShipmentId: "TEST-1",
      carrierTransactionId: "TX-1"
    },
    parcels: [
      { sequence: 1, actualWeightKg: 4.5, shipmentContentType: "PARCEL", contentsDescription: "Clothing", carrierParcelNumber: "P1", swiftlineParcelNumber: "S1" },
      { sequence: 2, actualWeightKg: 5.5, shipmentContentType: "DOCUMENTS", contentsDescription: "Documents", carrierParcelNumber: "P2", swiftlineParcelNumber: "S2" }
    ],
    pricing: {} as ShipmentBookingSnapshot["pricing"],
    payment: { currency: "INR", totalAmountMinor: 118000, advanceAmountMinor: 0, creditAmountMinor: 118000 }
  };
}

describe("shipment manifest workbook", () => {
  it("maps an immutable booking snapshot into one manifest line", () => {
    const line = buildManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 25_000_00,
      bagNumber: "BAG-01"
    });

    assert.equal(line.consignmentNumber, "SLDL21072026000001");
    assert.equal(line.pieces, 2);
    assert.equal(line.weightKg, 10);
    // No pricing parcels on this snapshot, so chargeable falls back to actual.
    assert.equal(line.chargeableWeightKg, 10);
    assert.equal(line.description, "Clothing, Documents");
    assert.equal(line.declaredValueMinor, 25_000_00);
    assert.equal(line.bagNumber, "BAG-01");
    assert.equal(line.serviceInfo, "EXP");
    assert.equal(line.consignor.formatted, "Example Exporter\nMr. Ravi Sharma\n1 Export Road\nDelhi\n110001\nIN\nTEL-+919000000000");
    assert.equal(formatManifestOrigin(bookingSnapshot().sender), "SWIFTLINE DELHI\n1 LOGISTICS PARK\nDELHI\n110001\nIN");
  });

  it("emits structured consignor/consignee party fields for the EDI export", () => {
    // Legacy shipment: no captured consignor, so the party falls back to the account.
    const legacy = buildManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 25_000_00,
      bagNumber: "BAG-01"
    });
    assert.deepEqual(legacy.consignor.party, {
      companyName: "Example Exporter",
      contactName: "Mr. Ravi Sharma",
      addressLine1: "1 Export Road",
      addressLine2: "",
      city: "Delhi",
      state: "Delhi",
      postcode: "110001",
      countryCode: "IN",
      countryName: "India",
      phone: "+919000000000"
    });
    assert.deepEqual(legacy.consignee.party, {
      companyName: "Example Consignee",
      contactName: "Asha Patel",
      addressLine1: "10 Downing Street",
      addressLine2: "",
      city: "London",
      state: "",
      postcode: "SW1A 2AA",
      countryCode: "GB",
      countryName: "United Kingdom",
      phone: "+447123456789"
    });

    // Captured Indian sender: the consignor party comes from the shipment consignor,
    // carrying the state (county) the EDI needs.
    const withConsignor = {
      ...bookingSnapshot(),
      consignor: {
        companyName: "",
        contactName: "Dinesh Marvadi",
        mobileCountryCode: "+91",
        mobileNumber: "8375887887",
        aadhaarNumber: "XXXX XXXX 4472",
        countryCode: "IN",
        countryName: "India",
        postcode: "140102",
        addressLine1: "Raulu Majra",
        addressLine2: "",
        townOrCity: "Rupnagar",
        county: "Punjab"
      }
    } as unknown as ShipmentBookingSnapshot;
    const captured = buildManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: withConsignor,
      declaredValueMinor: 11_000_00,
      bagNumber: "BAG-01"
    });
    const capturedParty = captured.consignor.party as ManifestPartySnapshot;
    assert.equal(capturedParty.contactName, "Dinesh Marvadi");
    assert.equal(capturedParty.state, "Punjab");
    assert.equal(capturedParty.city, "Rupnagar");
    assert.equal(capturedParty.postcode, "140102");
    assert.equal(capturedParty.countryCode, "IN");
    // The redacted Aadhaar is never carried on the party- the EDI reads it live.
    assert.equal("aadhaarNumber" in (capturedParty as Record<string, unknown>), false);
  });

  it("creates a PDF-shaped Excel handover manifest with one row per parcel", async () => {
    const line = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 25_000_00,
      bagNumber: "BAG-01"
    });
    const manifest = {
      _id: new mongoose.Types.ObjectId(),
      manifestNumber: "SLC-001",
      businessAccountId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      shipmentDraftIds: [line.shipmentDraftId],
      headerSnapshot: {
        businessAccountName: "Example Exporter",
        origin: "Ahmedabad",
        destination: "UK Service Del",
        coloader: "Sky Cargo",
        paymentType: "PREPAID"
      },
      lineSnapshots: [line],
      totalPieces: 2,
      totalWeightKg: 10,
      totalBags: 1,
      actorRole: "admin",
      generatedAt: new Date("2026-07-21T10:00:00.000Z")
    } as unknown as IShipmentManifest;

    const workbook = new ExcelJS.Workbook();
    const workbookBytes = await buildShipmentManifestHandoverWorkbook(manifest);
    const workbookData = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength
    ) as ArrayBuffer;
    await workbook.xlsx.load(workbookData);
    const sheet = workbook.getWorksheet("Manifest");
    assert.ok(sheet);
    assert.equal(sheet.getCell("A1").value, "MANIFEST");
    assert.equal(sheet.getCell("A3").value, "FROM,");
    assert.equal(sheet.getCell("A4").value, "AHMEDABAD");
    assert.equal(sheet.getCell("E3").value, "TO,");
    assert.equal(sheet.getCell("E4").value, "UK SERVICE DEL");
    assert.equal(sheet.getCell("I3").value, "DATE: 21/07/2026");
    assert.equal(sheet.getCell("I4").value, "TOTAL PCS : 2");
    assert.equal(sheet.getCell("I5").value, "TOTAL WEIGHT: 10.00");
    assert.equal(sheet.getCell("I6").value, "MANIFEST #: SLC-001");
    assert.equal(sheet.getCell("I7").value, "COLOADER: Sky Cargo");
    assert.equal(sheet.getCell("I8").value, "PAYMENT TYPE: PREPAID");
    for (let column = 1; column <= 12; column += 1) {
      const labelCellBorder: Partial<ExcelJS.Borders> = sheet.getCell(3, column).border;
      assert.equal(labelCellBorder.top?.style, "thin", `missing header top border at column ${column}`);
      assert.equal(labelCellBorder.bottom?.style, "thin", `missing label divider at column ${column}`);
    }
    for (let row = 4; row <= 8; row += 1) {
      for (let column = 1; column <= 8; column += 1) {
        const cellBorder: Partial<ExcelJS.Borders> = sheet.getCell(row, column).border;
        if (row === 4) assert.equal(cellBorder.top?.style, "thin", `missing origin/destination top at ${row},${column}`);
        if (row === 8) assert.equal(cellBorder.bottom?.style, "thin", `missing origin/destination bottom at ${row},${column}`);
        if (column === 1 || column === 5) assert.equal(cellBorder.left?.style, "thin", `missing section left at ${row},${column}`);
        if (column === 4 || column === 8) assert.equal(cellBorder.right?.style, "thin", `missing section right at ${row},${column}`);
      }
      for (let column = 9; column <= 12; column += 1) {
        const cellBorder: Partial<ExcelJS.Borders> = sheet.getCell(row, column).border;
        assert.equal(cellBorder.top?.style, "thin", `missing metadata row top at ${row},${column}`);
        assert.equal(cellBorder.bottom?.style, "thin", `missing metadata row bottom at ${row},${column}`);
        if (column === 9) assert.equal(cellBorder.left?.style, "thin", `missing metadata left at ${row}`);
        if (column === 12) assert.equal(cellBorder.right?.style, "thin", `missing metadata right at ${row}`);
      }
    }
    assert.deepEqual(Array.from({ length: 12 }, (_value, index) => sheet.getCell(10, index + 1).value), [
      "Sr.\nNo.", "AWB No. /\nParcel No", "Forwarding\nNo.", "Destination", "Shipper", "Receiver",
      "Service", "Product", "Pcs", "Weight", "Chg Wt", "Remark"
    ]);
    assert.equal(sheet.getCell("A11").value, 1);
    assert.equal(sheet.getCell("B11").value, "S1");
    assert.equal(sheet.getCell("C11").value, "P1");
    assert.equal(sheet.getCell("D11").value, "United Kingdom");
    assert.equal(sheet.getCell("H11").value, "PARCEL");
    assert.equal(sheet.getCell("I11").value, 1);
    assert.equal(sheet.getCell("J11").value, 4.5);
    assert.equal(sheet.getCell("B12").value, "S2");
    assert.equal(sheet.getCell("H12").value, "DOCUMENTS");
    assert.equal(sheet.getCell("J12").value, 5.5);
    assert.equal(String(sheet.getCell("A14").value).startsWith("We hereby declare"), true);
    assert.equal(sheet.getCell("A16").value, "FOR AHMEDABAD (SIGN AND STAMP)");
    assert.equal(sheet.autoFilter, undefined);
    assert.equal(sheet.views[0]?.state, "normal");
    assert.equal(Object.hasOwn(sheet.views[0] ?? {}, "ySplit"), false);
    assert.equal(sheet.getCell("A1").font.bold, true);
    assert.equal(sheet.getCell("A10").font.bold, true);
  });

});

function handoverManifest(lines: ShipmentManifestLineSnapshot[]): IShipmentManifest {
  return {
    _id: new mongoose.Types.ObjectId(),
    manifestNumber: "SLC-002",
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    shipmentDraftIds: lines.map((line) => line.shipmentDraftId),
    headerSnapshot: {
      businessAccountName: "Example Exporter",
      originBranch: "Swiftline Delhi - DEL-001",
      originAddress: "Swiftline Delhi\n1 Logistics Park\nDelhi\n110001\nIndia",
      origin: "Ahmedabad",
      destination: "UK Service Del",
      coloader: "Sky Cargo",
      paymentType: "PREPAID"
    },
    lineSnapshots: lines,
    totalPieces: lines.reduce((sum, line) => sum + line.pieces, 0),
    totalWeightKg: lines.reduce((sum, line) => sum + line.weightKg, 0),
    totalBags: 1,
    actorRole: "client",
    generatedAt: new Date("2026-07-21T10:00:00.000Z")
  } as unknown as IShipmentManifest;
}

describe("handover manifest", () => {
  it("keeps every parcel's own barcode, forwarding number, weight and product", () => {
    const line = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 0,
      bagNumber: "1",
      remark: "DONE"
    });

    assert.deepEqual(line.parcels, [
      { awbNumber: "S1", forwardingNumber: "P1", weightKg: 4.5, chargeableWeightKg: 4.5, product: "PARCEL" },
      { awbNumber: "S2", forwardingNumber: "P2", weightKg: 5.5, chargeableWeightKg: 5.5, product: "DOCUMENTS" }
    ]);
    assert.equal(line.destination, "United Kingdom");
    assert.equal(line.remark, "DONE");
    assert.equal(line.pieces, 2);
    assert.equal(line.weightKg, 10);
    assert.equal(line.chargeableWeightKg, 10);
  });

  it("takes shipper and receiver from the two contact names, and service from the service type", () => {
    // A consignor company distinct from its contact name, and a business account
    // distinct from both, so the shipper can only be right if it reads the
    // consignor's contact name rather than either company.
    const snapshot = bookingSnapshot();
    snapshot.consignor = {
      companyName: "Sharma Trading Co",
      contactName: "Ravi Sharma",
      mobileCountryCode: "+91",
      mobileNumber: "9876543210",
      countryCode: "IN",
      countryName: "India",
      postcode: "110001",
      addressLine1: "12 Connaught Place",
      townOrCity: "New Delhi"
    } as ShipmentBookingSnapshot["consignor"];

    assert.equal(manifestBusinessAccountName(snapshot), "Example Exporter");
    const line = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot,
      declaredValueMinor: 0,
      bagNumber: "1"
    });

    assert.equal(line.shipperName, "Ravi Sharma");
    assert.equal(line.receiverName, "Asha Patel");
    assert.equal(line.service, "COURIER");
    // serviceInfo stays the EXP/CARGO code the EDI export and operations
    // manifest depend on.
    assert.equal(line.serviceInfo, "EXP");
    // The consignor block still carries the real sender for other documents.
    assert.ok(String(line.consignor.formatted).startsWith("Sharma Trading Co"));
  });

  it("gives every parcel its own row, numbered continuously across shipments", () => {
    const lines = [
      buildHandoverManifestLine({
        shipmentDraftId: new mongoose.Types.ObjectId(),
        dpdShipmentId: new mongoose.Types.ObjectId(),
        snapshot: bookingSnapshot(),
        declaredValueMinor: 0,
        bagNumber: "1"
      }),
      buildHandoverManifestLine({
        shipmentDraftId: new mongoose.Types.ObjectId(),
        dpdShipmentId: new mongoose.Types.ObjectId(),
        snapshot: bookingSnapshot(),
        declaredValueMinor: 0,
        bagNumber: "1"
      })
    ];

    const rows = manifestRows(lines);
    // Two shipments of two parcels each: four rows, not two.
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row[0]), ["1", "2", "3", "4"]);
    // Every row carries one parcel's own barcode, product, piece count and weight.
    assert.deepEqual(rows.map((row) => row[1]), ["S1", "S2", "S1", "S2"]);
    assert.deepEqual(rows.map((row) => row[2]), ["P1", "P2", "P1", "P2"]);
    assert.deepEqual(rows.map((row) => row[7]), ["PARCEL", "DOCUMENTS", "PARCEL", "DOCUMENTS"]);
    assert.deepEqual(rows.map((row) => row[8]), ["1", "1", "1", "1"]);
    assert.deepEqual(rows.map((row) => row[9]), ["4.50", "5.50", "4.50", "5.50"]);
    assert.deepEqual(rows.map((row) => row[10]), ["4.50", "5.50", "4.50", "5.50"]);
    assert.deepEqual(rows.map((row) => row[11]), ["DONE", "DONE", "DONE", "DONE"]);
    assert.deepEqual([...new Set(rows.map((row) => row[6]))], ["COURIER"]);
  });

  it("carries the pricing snapshot's chargeable weight on the line, parcels and rows", () => {
    const snapshot = bookingSnapshot();
    snapshot.pricing = {
      parcels: [
        { sequence: 1, chargeableWeightKg: 6 },
        { sequence: 2, chargeableWeightKg: 7 }
      ]
    } as unknown as ShipmentBookingSnapshot["pricing"];
    const line = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot,
      declaredValueMinor: 0,
      bagNumber: "1"
    });

    assert.equal(line.chargeableWeightKg, 13);
    assert.deepEqual(line.parcels?.map((parcel) => parcel.chargeableWeightKg), [6, 7]);
    const rows = manifestRows([line]);
    assert.deepEqual(rows.map((row) => row[9]), ["4.50", "5.50"]);
    assert.deepEqual(rows.map((row) => row[10]), ["6.00", "7.00"]);
  });

  it("restores missing parcel chargeable weights for legacy PDF downloads", () => {
    const snapshot = bookingSnapshot();
    snapshot.parcels[0]!.actualWeightKg = 10.2;
    snapshot.parcels[1]!.actualWeightKg = 11.5;
    snapshot.pricing = {
      parcels: [
        { sequence: 1, chargeableWeightKg: 11 },
        { sequence: 2, chargeableWeightKg: 12 }
      ]
    } as unknown as ShipmentBookingSnapshot["pricing"];
    const line = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot,
      declaredValueMinor: 0,
      bagNumber: "1"
    });
    line.parcels?.forEach((parcel) => { delete parcel.chargeableWeightKg; });

    const [hydratedLine] = hydrateMissingManifestParcelChargeableWeights(
      [line],
      [{ _id: line.dpdShipmentId, currentShipmentSnapshot: snapshot }]
    );

    assert.deepEqual(hydratedLine?.parcels?.map((parcel) => parcel.chargeableWeightKg), [11, 12]);
    assert.deepEqual(manifestRows([hydratedLine!]).map((row) => row[10]), ["11.00", "12.00"]);
    // The historical line is only hydrated for rendering; it is not mutated.
    assert.deepEqual(line.parcels?.map((parcel) => parcel.chargeableWeightKg), [undefined, undefined]);
  });

  it("keeps a legacy line without per-parcel data as a single summary row", () => {
    const legacyLine = buildManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 12_500_00,
      bagNumber: "1"
    });

    const rows = manifestRows([legacyLine]);
    assert.equal(rows.length, 1);
    // Falls back to the consignment number and the shipment's own piece total.
    assert.equal(rows[0]?.[1], "SLDL210720260001");
    assert.equal(rows[0]?.[8], "2");
    assert.equal(rows[0]?.[6], "EXP");
    // Legacy lines carry no chargeable weight, so it falls back to actual.
    assert.equal(rows[0]?.[9], "10.00");
    assert.equal(rows[0]?.[10], "10.00");
  });

  it("states a pre-chargeable line's shipment total only on its first parcel row", () => {
    // Sealed before per-parcel chargeable weights were captured: neither the
    // line nor its parcels carry them, so the total must not repeat as if
    // every parcel weighed that much.
    const legacyParcelLine = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 0,
      bagNumber: "1"
    });
    delete legacyParcelLine.chargeableWeightKg;
    legacyParcelLine.parcels?.forEach((parcel) => { delete parcel.chargeableWeightKg; });

    const rows = manifestRows([legacyParcelLine]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row[9]), ["4.50", "5.50"]);
    assert.deepEqual(rows.map((row) => row[10]), ["10.00", ""]);
  });

  it("renders a PDF for handover lines and for legacy lines without the new fields", async () => {
    const handoverLine = buildHandoverManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 0,
      bagNumber: "1"
    });
    // Sealed before the handover columns existed: every new field is absent.
    const legacyLine = buildManifestLine({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      snapshot: bookingSnapshot(),
      declaredValueMinor: 12_500_00,
      bagNumber: "1"
    });

    const pdf = await buildShipmentManifestPdf(handoverManifest([handoverLine, legacyLine]));
    assert.ok(pdf.length > 1000);
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  });
});
