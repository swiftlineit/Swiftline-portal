import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as CFB from "cfb";
import XLSX from "xlsx";
import type { ManifestDocumentParcelRow } from "../types/manifestDocument.js";
import { collectMhbsEdiWarnings, MHBS_EDI_HEADERS } from "../services/mhbsEdi/mhbsEdiColumns.js";
import { buildMhbsEdiWorkbookBuffer } from "../services/mhbsEdi/mhbsEdiWorkbook.service.js";

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
  bagNumber: "SLC02501",
  declaredValueMinor: 12500,
  currency: "INR",
  serviceInfo: "EXP",
  consignor: { formatted: "", party },
  consignee: { formatted: "", party },
  shipmentDraftId: "draft-1",
  dpdShipmentId: "dpd-1"
};

function workbookStream(buffer: Buffer): Buffer {
  const container = CFB.read(buffer, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  assert.ok(workbook);
  return Buffer.from(workbook.content as Uint8Array);
}

function rowHeight(stream: Buffer, rowNumber: number): number {
  for (let offset = 0; offset + 4 <= stream.length;) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const payload = stream.subarray(offset + 4, offset + 4 + length);
    if (id === 0x0208 && payload.readUInt16LE(0) === rowNumber) return payload.readUInt16LE(6);
    offset += 4 + length;
  }
  throw new Error(`Missing BIFF row ${rowNumber}.`);
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

test("MHBS EDI preserves the approved BIFF8 layout and formulas", () => {
  const secondRow = { ...row, serial: 2, parcelNumber: "SLC123-02", bagNumber: "SLC02502" };
  const result = buildMhbsEdiWorkbookBuffer([row, secondRow]);
  const workbook = XLSX.read(result.buffer, { type: "buffer", cellFormula: true, cellStyles: true });
  const sheet = workbook.Sheets.Sheet1;

  assert.ok(sheet);
  assert.equal(sheet["!ref"], "A1:C3");
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false })[0], MHBS_EDI_HEADERS);
  assert.equal(sheet.A2?.v, "SLC123-01");
  assert.equal(sheet.B2?.v, "SLC02501");
  assert.equal(sheet.C2?.f, 'CONCATENATE("ZX-",A2)');
  assert.equal(sheet.C2?.v, "ZX-SLC123-01");
  assert.equal(sheet.C3?.f, 'CONCATENATE("ZX-",A3)');
  assert.equal(sheet.C3?.v, "ZX-SLC123-02");
  assert.deepEqual(sheet["!cols"]?.map((column) => column?.wch), [12.5, 8.38, 9.38]);

  const templateStream = workbookStream(fs.readFileSync("assets/mhbs-edi-template.xls"));
  const generatedStream = workbookStream(result.buffer);
  assert.equal(rowHeight(generatedStream, 1), rowHeight(templateStream, 1));
  assert.equal(rowHeight(generatedStream, 2), rowHeight(templateStream, 2));
  assert.equal(xfCount(generatedStream), xfCount(templateStream));
  assert.equal(result.warnings.length, 0);
});

test("MHBS EDI extends formulas beyond the supplied sample rows", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    ...row,
    serial: index + 1,
    parcelNumber: `SLC123-${String(index + 1).padStart(2, "0")}`
  }));
  const result = buildMhbsEdiWorkbookBuffer(rows);
  const sheet = XLSX.read(result.buffer, { type: "buffer", cellFormula: true }).Sheets.Sheet1;
  assert.ok(sheet);
  assert.equal(sheet["!ref"], "A1:C46");
  assert.equal(sheet.C46?.f, 'CONCATENATE("ZX-",A46)');
  assert.equal(sheet.C46?.v, "ZX-SLC123-45");
});

test("MHBS EDI leaves unavailable values blank and reports warnings", () => {
  const incomplete = { ...row, parcelNumber: "", bagNumber: "" };
  const warnings = collectMhbsEdiWarnings([incomplete]);
  assert.deepEqual(warnings.map((warning) => warning.column), ["HAWB_Number", "MHBS_NO"]);
  const result = buildMhbsEdiWorkbookBuffer([incomplete], warnings);
  const sheet = XLSX.read(result.buffer, { type: "buffer", cellFormula: true }).Sheets.Sheet1;
  assert.ok(sheet);
  assert.equal(sheet.A2?.v, undefined);
  assert.equal(sheet.B2?.v, undefined);
  assert.equal(sheet.C2?.v, "ZX-");
  assert.equal(result.warnings.length, 2);
});
