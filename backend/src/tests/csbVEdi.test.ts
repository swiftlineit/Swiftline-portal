import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as CFB from "cfb";
import XLSX from "xlsx";
import type { ManifestDocumentConsignment, ManifestDocumentParcelRow } from "../types/manifestDocument.js";
import { missingCsbVCustomsFields, assertCsbVOnlyDrafts, CSB_V_ONLY_MANIFEST_MESSAGE } from "../services/csbVEdi/csbVEdiExport.service.js";
import { buildCsbVEdiRows, CSB_V_EDI_HEADERS } from "../services/csbVEdi/csbVEdiColumns.js";
import { buildCsbVEdiWorkbookBuffer } from "../services/csbVEdi/csbVEdiWorkbook.service.js";
import { buildCsbVEdi2Rows, CSB_V_EDI2_HEADERS } from "../services/csbVEdi/csbVEdi2Columns.js";
import { buildCsbVEdi2WorkbookBuffer } from "../services/csbVEdi/csbVEdi2Workbook.service.js";

const consignor = {
  companyName: "KALINGA ARTS",
  contactName: "RAVI",
  addressLine1: "1 JAIPUR ROAD",
  addressLine2: "",
  city: "JAIPUR",
  state: "RAJASTHAN",
  postcode: "302001",
  countryCode: "IN",
  countryName: "INDIA",
  phone: ""
};
const consignee = {
  ...consignor,
  companyName: "OHIO RETAIL",
  city: "REYNOLDSBURG",
  state: "OH",
  postcode: "43068",
  countryCode: "US",
  countryName: "UNITED STATES"
};

function parcel(index: number, bagNumber: string, items: ManifestDocumentParcelRow["items"]): ManifestDocumentParcelRow {
  return {
    serial: index,
    consignmentIndex: 0,
    parcelIndexInConsignment: index - 1,
    isFirstParcelOfConsignment: index === 1,
    consignmentNumber: "SLCAMD260926001",
    formattedConsignmentNumber: "SLCAMD260926001",
    parcelNumber: `SLCAMD260926001-${String(index).padStart(2, "0")}`,
    weightKg: index === 1 ? 1.25 : 2.75,
    description: "GOODS",
    items,
    bagNumber,
    declaredValueMinor: index === 1 ? 250000 : null,
    currency: "INR",
    serviceInfo: "EXP",
    consignor: { formatted: "", party: consignor },
    consignee: { formatted: "", party: consignee },
    shipmentDraftId: "draft-1",
    dpdShipmentId: "dpd-1"
  };
}

const consignment: ManifestDocumentConsignment = {
  consignmentIndex: 0,
  consignmentNumber: "SLCAMD260926001",
  formattedConsignmentNumber: "SLCAMD260926001",
  declaredValueMinor: 250000,
  currency: "INR",
  serviceInfo: "EXP",
  consignor: { formatted: "", party: consignor },
  consignee: { formatted: "", party: consignee },
  shipmentDraftId: "draft-1",
  dpdShipmentId: "dpd-1",
  parcels: [
    parcel(1, "SLC00701", [
      { description: "BOOKS", hsnCode: "49019900", unitType: "PCS", quantity: 2, unitRate: 100 },
      { description: "PENS", hsnCode: "96081000", unitType: "PCS", quantity: 3, unitRate: 10 }
    ]),
    parcel(2, "SLC00702", [{ description: "BOOKS", hsnCode: "49019900", unitType: "PCS", quantity: 1, unitRate: 50 }])
  ]
};

function fontSizes(buffer: Buffer): number[] {
  const container = CFB.read(buffer, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  assert.ok(workbook);
  const stream = Buffer.from(workbook.content as Uint8Array);
  const sizes: number[] = [];
  for (let offset = 0; offset + 4 <= stream.length;) {
    const recordId = stream.readUInt16LE(offset);
    const recordLength = stream.readUInt16LE(offset + 2);
    const recordEnd = offset + 4 + recordLength;
    if (recordEnd > stream.length) break;
    if (recordId === 0x0031 && recordLength >= 2) sizes.push(stream.readUInt16LE(offset + 4) / 20);
    offset = recordEnd;
  }
  return sizes;
}

test("CSB-V EDI repeats shipment-level values and joins multi-item values", () => {
  const rows = buildCsbVEdiRows(
    [consignment],
    new Map([[
      "draft-1",
      {
        csbType: "CSB_V",
        csbVGstin: "08ABCDE1234F1Z5",
        csbVAccountNumber: "001234",
        csbVIecCode: "CUSTOMIEC1",
        csbVAdCode: "0123456-7654321",
        csbVInvoiceNumber: "INV-100",
        consigneeEnteredAddress: { stateCode: "39" }
      }
    ]]),
    "2026-09-26"
  );

  assert.equal(rows.length, 2);
  assert.equal(CSB_V_EDI_HEADERS.length, 45);
  assert.ok(rows.every((row) => row.length === CSB_V_EDI_HEADERS.length));
  assert.equal(rows[0]?.[0], "SLCAMD260926001");
  assert.equal(rows[1]?.[0], "SLCAMD260926001");
  assert.equal(rows[0]?.[1], 2);
  assert.equal(rows[0]?.[2], 4);
  assert.equal(rows[0]?.[5], "SLC00701|SLC00702");
  assert.equal(rows[0]?.[3], "CUSTOMIEC1");
  assert.equal(rows[0]?.[8], "0123456-7654321");
  assert.equal(rows[0]?.[9], "SLCAMD260926001|SLCAMD260926001");
  assert.equal(rows[0]?.[24], "UNITED STATES");
  assert.equal(rows[0]?.[25], "INV-100");
  assert.equal(rows[0]?.[21], "OH");
  assert.equal(rows[0]?.[27], "49019900,96081000");
  assert.equal(rows[0]?.[28], "BOOKS,PENS");
  assert.equal(rows[0]?.[41], "39");
  assert.equal(rows[0]?.[42], "001234");

  const workbook = XLSX.read(buildCsbVEdiWorkbookBuffer(rows), { type: "buffer", raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  assert.ok(sheet);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
  assert.deepEqual(matrix[0], CSB_V_EDI_HEADERS);
  assert.equal(matrix.length, 3);
  assert.equal(matrix[1]?.[0], "SLCAMD260926001");
  assert.equal(matrix[1]?.[25], "INV-100");
});

test("CSB-V EDI leaves missing historical customs fields blank instead of inventing sample values", () => {
  assert.deepEqual(missingCsbVCustomsFields({ csbVAccountNumber: "001234", csbVIecCode: "", csbVInvoiceNumber: "INV-100" }),
    ["GSTIN", "IEC code", "AD code"]);
  const rows = buildCsbVEdiRows([consignment], new Map([["draft-1", { csbVIecCode: "", csbVAdCode: "" }]]), "2026-09-26");
  assert.equal(rows[0]?.[3], "");
  assert.equal(rows[0]?.[8], "");
});

test("CSB-V EDI2 keeps the supplied Sheet1 format and emits one row per item", () => {
  const model = { header: { mawbNumber: "123-45678901" }, consignments: [consignment] } as never;
  const rows = buildCsbVEdi2Rows(model, new Map([["draft-1", { csbVInvoiceNumber: "INV-100" }]]));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.length === CSB_V_EDI2_HEADERS.length));
  assert.deepEqual(rows.map((row) => row[1]), ["SLCAMD260926001", "SLCAMD260926001", "SLCAMD260926001"]);
  assert.deepEqual(rows.map((row) => row[5]), [200, 30, 50]);
  assert.deepEqual(rows.map((row) => row[6]), [200, 30, 50]);
  assert.deepEqual(rows.map((row) => row[10]), [200, 30, 50]);
  assert.deepEqual(rows.map((row) => row[7]), ["49019900", "96081000", "49019900"]);
  assert.ok(rows.every((row) => row[11] === "INR" && row[12] === 0 && row[13] === 0 && row[14] === "N"));
  const buffer = buildCsbVEdi2WorkbookBuffer(rows);
  const source = fs.readFileSync("assets/csb-v-edi2-template.xls");
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
  const template = XLSX.read(source, { type: "buffer", cellStyles: true });
  assert.deepEqual(workbook.SheetNames, ["Sheet1"]);
  const sheet = workbook.Sheets.Sheet1!;
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0], [...CSB_V_EDI2_HEADERS]);
  assert.equal(sheet.B2?.v, "SLCAMD260926001");
  assert.equal(sheet.G2?.v, 200);
  assert.equal(sheet.G3?.v, 30);
  assert.equal(sheet.G4?.v, 50);
  assert.deepEqual(fontSizes(buffer), fontSizes(source));
  assert.deepEqual(sheet["!cols"]?.map((column) => column.wch), template.Sheets.Sheet1?.["!cols"]?.map((column) => column.wch));
});

test("CSB-V EDI2 keeps legacy parcels readable without fabricating item values", () => {
  const legacy = { ...consignment, parcels: [{ ...parcel(1, "", undefined), description: "LEGACY GOODS", items: undefined }] };
  const rows = buildCsbVEdi2Rows({ header: { mawbNumber: "123-45678901" }, consignments: [legacy] } as never,
    new Map([["draft-1", {}]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[1], "SLCAMD260926001");
  assert.equal(rows[0]?.[2], "");
  assert.equal(rows[0]?.[3], "");
  assert.equal(rows[0]?.[5], "");
  assert.equal(rows[0]?.[6], "");
  assert.equal(rows[0]?.[8], "LEGACY GOODS");
  assert.doesNotThrow(() => XLSX.read(buildCsbVEdi2WorkbookBuffer(rows), { type: "buffer" }));
});

test("CSB-V EDI uses the legacy 11-point workbook font", () => {
  const buffer = buildCsbVEdiWorkbookBuffer([CSB_V_EDI_HEADERS.map(() => "value")]);
  assert.equal(fontSizes(buffer)[0], 11);
});

test("CSB-V EDI keeps one complete row for a parcel with no item array or bag metadata", () => {
  const singleParcelConsignment: ManifestDocumentConsignment = {
    ...consignment,
    parcels: [{
      ...parcel(1, "", []),
      description: "LEGACY DESCRIPTION",
      items: undefined
    }]
  };
  const [row] = buildCsbVEdiRows(
    [singleParcelConsignment],
    new Map([["draft-1", { csbType: "CSB_V", csbVGstin: "08ABCDE1234F1Z5", csbVAccountNumber: "001234", csbVInvoiceNumber: "INV-LEGACY", consigneeEnteredAddress: { stateCode: "39" } }]]),
    "2026-09-26"
  );

  assert.equal(row?.length, CSB_V_EDI_HEADERS.length);
  assert.equal(row?.[1], 1);
  assert.equal(row?.[5], "");
  assert.equal(row?.[27], "");
  assert.equal(row?.[28], "LEGACY DESCRIPTION");
});

test("CSB-V EDI eligibility rejects mixed or incomplete manifests", () => {
  assert.throws(
    () => assertCsbVOnlyDrafts(["draft-1", "draft-2"], [{ _id: "draft-1", csbType: "CSB_V" }, { _id: "draft-2", csbType: "CSB_IV" }]),
    (error: unknown) => error instanceof Error && error.message === CSB_V_ONLY_MANIFEST_MESSAGE
  );
  assert.throws(
    () => assertCsbVOnlyDrafts(["draft-1"], []),
    (error: unknown) => error instanceof Error && error.message === CSB_V_ONLY_MANIFEST_MESSAGE
  );
});
