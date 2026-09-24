import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import * as CFB from "cfb";
import XLSX from "xlsx";
import type { ManifestDocumentParcelRow } from "../types/manifestDocument.js";
import { OPS_EDI_HEADERS, collectOpsEdiWarnings } from "../services/opsEdi/opsEdiColumns.js";
import { buildOpsEdiWorkbookBuffer } from "../services/opsEdi/opsEdiWorkbook.service.js";

const party = {
  companyName: "",
  contactName: "RAVI SINGH",
  addressLine1: "1 MAIN ROAD",
  addressLine2: "",
  city: "DELHI",
  state: "PUNJAB",
  postcode: "110001",
  countryCode: "IN",
  countryName: "INDIA",
  phone: ""
};

const row: ManifestDocumentParcelRow = {
  serial: 1,
  consignmentIndex: 0,
  parcelIndexInConsignment: 0,
  isFirstParcelOfConsignment: true,
  consignmentNumber: "SLC123",
  formattedConsignmentNumber: "SLC123",
  parcelNumber: "SLC123-01",
  weightKg: 2.5,
  description: "BOOKS",
  items: [{ description: "BOOKS" }],
  bagNumber: "SLC001",
  declaredValueMinor: 12500,
  currency: "INR",
  serviceInfo: "EXP",
  consignor: { formatted: "", party },
  consignee: {
    formatted: "",
    party: { ...party, contactName: "JOHN SMITH", countryCode: "GB", countryName: "UNITED KINGDOM", state: "" }
  },
  shipmentDraftId: "draft-1",
  dpdShipmentId: "dpd-1"
};

const context = { departureDate: "2026-09-23", aadhaarFor: () => "234567890124" };

function workbookStream(buffer: Buffer): Buffer {
  const container = CFB.read(buffer, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  assert.ok(workbook);
  return Buffer.from(workbook.content as Uint8Array);
}

function dataRowHeight(stream: Buffer, row: number): number {
  for (let offset = 0; offset + 4 <= stream.length;) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const payload = stream.subarray(offset + 4, offset + 4 + length);
    if (id === 0x0208 && payload.readUInt16LE(0) === row) return payload.readUInt16LE(6);
    offset += 4 + length;
  }
  throw new Error(`Missing BIFF row ${row}`);
}

function xfCount(stream: Buffer): number {
  let count = 0;
  for (let offset = 0; offset + 4 <= stream.length;) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (id === 0x00e0) count += 1;
    offset += 4 + length;
  }
  return count;
}

test("OPS EDI uses the approved 46-column order and BIFF8 formulas", () => {
  const result = buildOpsEdiWorkbookBuffer([row], context);
  const workbook = XLSX.read(result.buffer, { type: "buffer", cellFormula: true, cellNF: true, cellStyles: true });
  const sheet = workbook.Sheets.Sheet1;

  assert.ok(sheet);
  assert.equal(sheet["!ref"], "A1:AT2");
  assert.equal(sheet["!cols"]?.length, 46);
  assert.equal(sheet["!cols"]?.[0]?.wch, 12.5);
  assert.equal(sheet["!cols"]?.[45]?.wch, 8.88);
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false })[0], OPS_EDI_HEADERS);
  assert.equal(sheet.A2?.v, "SLC123-01");
  assert.equal(sheet.B2?.v, "BOOKS");
  assert.equal(sheet.D2?.v, 125);
  assert.equal(sheet.AC2?.v, "23/9/2026");
  assert.equal(sheet.AJ2?.v, 234567890124);
  assert.equal(sheet.AJ2?.z, "0");
  assert.equal(sheet.AP2?.f, 'CONCATENATE("ZX-",A2)');
  assert.equal(sheet.AQ2?.f, 'CONCATENATE("KYC-",AJ2)');
  assert.equal(sheet.C2?.v, undefined);
  assert.equal(result.warnings.length, 0);

  // The generated file must retain the template's BIFF8 visual definitions;
  // an XLSX round-trip drops these and produces the wrong row height/font/border
  // set even when the cell values still look correct to a parser.
  const templateStream = workbookStream(fs.readFileSync("assets/ops-edi-template.xls"));
  const generatedStream = workbookStream(result.buffer);
  assert.equal(dataRowHeight(generatedStream, 1), dataRowHeight(templateStream, 1));
  assert.equal(xfCount(generatedStream), xfCount(templateStream));
});

test("OPS EDI keeps formula columns working beyond the template sample rows", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    ...row,
    parcelNumber: `SLC123-${String(index + 1).padStart(2, "0")}`,
    serial: index + 1
  }));
  const result = buildOpsEdiWorkbookBuffer(rows, context);
  const sheet = XLSX.read(result.buffer, { type: "buffer", cellFormula: true }).Sheets.Sheet1;

  assert.ok(sheet);
  assert.equal(sheet["!ref"], "A1:AT46");
  assert.equal(sheet.AP46?.f, 'CONCATENATE("ZX-",A46)');
  assert.equal(sheet.AQ46?.f, 'CONCATENATE("KYC-",AJ46)');
  assert.equal(sheet.AP46?.v, "ZX-SLC123-45");
});

test("OPS EDI leaves unavailable data blank and reports row-level warnings", () => {
  const incomplete = {
    ...row,
    parcelNumber: "",
    description: "",
    items: [],
    consignor: { formatted: "", party: null },
    consignee: { formatted: "", party: null }
  };
  const warnings = collectOpsEdiWarnings([incomplete], { departureDate: "", aadhaarFor: () => "" });
  const columns = new Set(warnings.map((warning) => warning.column));

  assert.ok(columns.has("HAWB_Number"));
  assert.ok(columns.has("Description_of_Goods"));
  assert.ok(columns.has("Kyc No"));
  assert.ok(!columns.has("CnrAddress_2"));
  assert.ok(!columns.has("AD CODE"));
});
