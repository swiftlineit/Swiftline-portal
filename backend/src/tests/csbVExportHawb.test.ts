import assert from "node:assert/strict";
import { test } from "node:test";
import type { ManifestDocumentParcelRow } from "../types/manifestDocument.js";
import { withCsbVExportHawb } from "../services/edi/csbVExportHawb.js";
import { MHBS_EDI_COLUMNS } from "../services/mhbsEdi/mhbsEdiColumns.js";
import { OPS_EDI_COLUMNS } from "../services/opsEdi/opsEdiColumns.js";
import { EDI_COLUMNS } from "../services/edi/ediColumns.js";

const parcels = [
  { shipmentDraftId: "csb-v", consignmentNumber: "SLCAMD260926002", parcelNumber: "SLCAMD260926002-01", bagNumber: "SLC02901" },
  { shipmentDraftId: "csb-v", consignmentNumber: "SLCAMD260926002", parcelNumber: "SLCAMD260926002-02", bagNumber: "SLC02902" },
  { shipmentDraftId: "csb-iv", consignmentNumber: "SLCAMD260926003", parcelNumber: "SLCAMD260926003-01", bagNumber: "SLC02902" }
] as ManifestDocumentParcelRow[];

test("only CSB-V export HAWBs use the original unsuffixed shipment number", () => {
  const rows = withCsbVExportHawb(parcels, [
    { _id: "csb-v", csbType: "CSB_V", csbVIecCode: "CUSTOMIEC1", csbVAccountNumber: "001234", csbVInvoiceNumber: "INV-100" },
    { _id: "csb-iv", csbType: "CSB_IV" }
  ]);
  assert.deepEqual(rows.map((row) => row.parcelNumber), parcels.map((row) => row.parcelNumber));
  assert.deepEqual(rows.map((row) => row.bagNumber), parcels.map((row) => row.bagNumber));

  const mhbsHawb = MHBS_EDI_COLUMNS.find((column) => column.header === "HAWB_Number")!;
  const mhbsSystem = MHBS_EDI_COLUMNS.find((column) => column.header === "SYSTEM NO")!;
  const opsHawb = OPS_EDI_COLUMNS.find((column) => column.header === "HAWB_Number")!;
  const opsInvoice = OPS_EDI_COLUMNS.find((column) => column.header === "Export_Invoice_no")!;
  const opsIec = OPS_EDI_COLUMNS.find((column) => column.header === "IEC_CODE")!;
  const opsAccount = OPS_EDI_COLUMNS.find((column) => column.header === "ACCOUNT_NO")!;
  const ediHawb = EDI_COLUMNS.find((column) => column.header === "HAWBNumber")!;
  const ediCrn = EDI_COLUMNS.find((column) => column.header === "CRN_NO")!;
  const ediInvoice = EDI_COLUMNS.find((column) => column.header === "ExportInvoiceNo")!;
  const ediContext = { mawbNumber: "", departureDate: "", aadhaarFor: () => "" };
  const opsContext = { departureDate: "", aadhaarFor: () => "" };

  for (const [index, row] of rows.entries()) {
    const expected = index < 2 ? "SLCAMD260926002" : "SLCAMD260926003-01";
    assert.equal(mhbsHawb.value(row), expected);
    assert.equal(mhbsSystem.value(row), `ZX-${expected}`);
    assert.equal(opsHawb.value(row, opsContext), expected);
    assert.equal(opsInvoice.value(row, opsContext), index < 2 ? "INV-100" : expected);
    assert.equal(opsIec.value(row, opsContext), index < 2 ? "CUSTOMIEC1" : "");
    assert.equal(opsAccount.value(row, opsContext), index < 2 ? "001234" : 0);
    assert.equal(typeof opsAccount.type === "function" ? opsAccount.type(row) : opsAccount.type, index < 2 ? "text" : "number");
    assert.equal(ediHawb.value(row, ediContext), expected);
    assert.equal(ediCrn.value(row, ediContext), expected);
    assert.equal(ediInvoice.value(row, ediContext), index < 2 ? "INV-100" : expected);
  }
});
