import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ExcelJS from "exceljs";
import {
  amountToWords,
  buildCustomsInvoiceModel
} from "../services/customsInvoice/customsInvoiceModel.service.js";
import { customsInvoiceFooterNote } from "../services/customsInvoice/customsInvoiceConstants.js";
import { buildCustomsInvoiceWorkbook } from "../services/customsInvoice/customsInvoiceWorkbook.service.js";
import { renderCustomsInvoicePdfBuffer } from "../services/customsInvoice/customsInvoicePdf.service.js";
import { customsInvoiceFileName } from "../services/customsInvoice/customsInvoice.service.js";
import { getDeclaredGoodsValue, getParcelItemAmount } from "../services/parcelItems.service.js";

// Mirrors the customer's supplied template (DAT301472) closely enough to check
// grouping, per-item rows and totals.
function sampleDraft() {
  return {
    consignorAddress: {
      contactName: "TRAMBAKLAL AMRUTLAL VYAS",
      companyName: "TRAMBAKLAL AMRUTLAL VYAS",
      addressLine1: "9 SHITALKUNJ SOC J B UPADHYAY HIGH SCHOOL",
      townOrCity: "HIMATNAGAR",
      county: "GUJARAT",
      countryName: "INDIA",
      postcode: "383215",
      email: "shipper@example.com",
      mobileCountryCode: "+91",
      mobileNumber: "7862859213",
      aadhaarNumber: "868801614500"
    },
    consigneeEnteredAddress: {
      contactName: "KRUSHNAKANT VYAS",
      companyName: "KRUSHNAKANT VYAS",
      addressLine1: "INDIAN ASSOCIATION OLDHAM RADHA KRISHNA TEMPLE",
      townOrCity: "OLDHAM",
      countryName: "UNITED KINGDOM",
      countryCode: "GB",
      postcode: "OL8 1QJ",
      email: "consignee@example.com",
      mobileCountryCode: "+44",
      mobileNumber: "7865449406"
    },
    parcelList: [
      {
        sequence: 1, weightKg: 25.7, lengthCm: 50, widthCm: 46, heightCm: 45,
        shipmentReference1: "DAT-REF-1",
        items: [
          { description: "Banner", hsnCode: "42034010", unitType: "Pkt", quantity: 2, unitRate: 150 },
          { description: "Under Garment", hsnCode: "62082100", unitType: "Pkt", quantity: 5, unitRate: 50 },
          { description: "Duppata", hsnCode: "6117102030", unitType: "Pkt", quantity: 9, unitRate: 100 }
        ]
      },
      {
        sequence: 2, weightKg: 24.9, lengthCm: 50, widthCm: 46, heightCm: 45,
        items: [{ description: "Plastic Flowers", hsnCode: "6702102000", unitType: "Pkt", quantity: 40, unitRate: 50 }]
      }
    ]
  };
}

function build(draft = sampleDraft()) {
  return buildCustomsInvoiceModel({
    draft: draft as never,
    invoiceNumber: "DAT301472",
    invoiceDate: new Date("2026-07-13T00:00:00.000Z")
  });
}

describe("customs invoice line amounts", () => {
  test("amount is quantity x unit rate", () => {
    assert.equal(getParcelItemAmount({ quantity: 9, unitRate: 100 }), 900);
    assert.equal(getParcelItemAmount({ quantity: 3, unitRate: 12.5 }), 37.5);
  });

  test("missing or invalid quantity/rate contributes nothing", () => {
    assert.equal(getParcelItemAmount({}), 0);
    assert.equal(getParcelItemAmount({ quantity: -5, unitRate: 10 }), 0);
    assert.equal(getParcelItemAmount({ quantity: 2, unitRate: "abc" }), 0);
  });

  test("declared goods value sums every item across every box", () => {
    // 300 + 250 + 900 (box 1) + 2000 (box 2)
    assert.equal(getDeclaredGoodsValue(sampleDraft().parcelList as never), 3450);
  });
});

describe("amount in words", () => {
  test("matches the sample's Indian-numbering wording", () => {
    assert.equal(amountToWords(9190), "Nine Thousand One Hundred And Ninety Rupees Only");
  });

  test("handles lakh and crore segments", () => {
    assert.equal(amountToWords(100000), "One Lakh Rupees Only");
    assert.equal(amountToWords(12345678), "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred And Seventy Eight Rupees Only");
  });

  test("handles zero and paise", () => {
    assert.equal(amountToWords(0), "Zero Rupees Only");
    assert.equal(amountToWords(10.5), "Ten Rupees And Fifty Paise Only");
  });
});

describe("customs invoice model", () => {
  test("groups one row per item under its box, numbered from 1 within each box", () => {
    const invoice = build();
    assert.equal(invoice.boxes.length, 2);
    assert.deepEqual(invoice.boxes[0]?.items.map((item) => item.serialNumber), [1, 2, 3]);
    assert.deepEqual(invoice.boxes[1]?.items.map((item) => item.serialNumber), [1]);
    assert.equal(invoice.boxes[0]?.items[2]?.amount, 900);
  });

  test("keeps a 10 digit HS code intact", () => {
    assert.equal(build().boxes[0]?.items[2]?.hsCode, "6117102030");
  });

  test("takes the Aadhaar from consignor KYC and the reference from the shipment form", () => {
    const invoice = build();
    assert.equal(invoice.aadhaarNumber, "868801614500");
    assert.equal(invoice.otherReference, "DAT-REF-1");
  });

  test("reads Aadhaar from the first parcel when KYC is per parcel", () => {
    const draft = sampleDraft() as Record<string, unknown>;
    draft.kycUseForAllParcels = false;
    (draft.parcelList as Array<Record<string, unknown>>)[0]!.aadhaarNumber = "111122223333";
    assert.equal(build(draft as never).aadhaarNumber, "111122223333");
  });

  test("totals the declared goods value only, with no freight or GST", () => {
    const invoice = build();
    assert.equal(invoice.totalAmount, 3450);
    assert.equal(invoice.totalAmountInWords, "Three Thousand Four Hundred And Fifty Rupees Only");
  });

  test("leaves the note empty when the shipment has none", () => {
    // Never pre-filled: an unedited default would put a gift declaration on
    // commercial shipments.
    assert.equal(build().note, "");
  });

  test("uses the shipment's own declaration note when set", () => {
    const draft = sampleDraft() as Record<string, unknown>;
    draft.declarationNote = "COMMERCIAL SAMPLES OF NO COMMERCIAL VALUE";
    assert.equal(build(draft as never).note, "COMMERCIAL SAMPLES OF NO COMMERCIAL VALUE");
  });

  test("renders legacy parcels that predate per-item capture", () => {
    const invoice = build({
      ...sampleDraft(),
      parcelList: [{ sequence: 1, weightKg: 5, contentsDescription: "Handicrafts" }]
    } as never);
    assert.equal(invoice.boxes[0]?.items[0]?.description, "HANDICRAFTS");
    assert.equal(invoice.totalAmount, 0);
  });
});

describe("customs invoice documents", () => {
  test("names downloads with the shipment AWB and consignee, for both formats", () => {
    const invoice = build();
    invoice.swiftlineTrackingNumber = "SLC/DEL 123";
    invoice.consignee.name = "Aman Neji / Receiver";

    assert.equal(customsInvoiceFileName(invoice, "pdf"), "SLC-DEL-123-Aman-Neji-Receiver-shipment-invoice.pdf");
    assert.equal(customsInvoiceFileName(invoice, "xlsx"), "SLC-DEL-123-Aman-Neji-Receiver-shipment-invoice.xlsx");
  });

  test("produces a PDF", async () => {
    const buffer = await renderCustomsInvoicePdfBuffer(build());
    assert.ok(buffer.length > 500, `expected a non-trivial PDF, got ${buffer.length} bytes`);
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
  });

  test("produces an .xlsx workbook", async () => {
    const buffer = await buildCustomsInvoiceWorkbook(build());
    assert.ok(buffer.length > 500, `expected a non-trivial workbook, got ${buffer.length} bytes`);
    // XLSX files are ZIP archives, which always start "PK".
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
  });

  test("the workbook carries borders, merges and column widths", async () => {
    // The community `xlsx` build silently drops styles, which is why this is
    // asserted rather than assumed.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildCustomsInvoiceWorkbook(build()) as never);
    const sheet = workbook.getWorksheet("Invoice");
    assert.ok(sheet, "expected an Invoice sheet");

    assert.ok((sheet.columns?.length ?? 0) >= 11, "expected all 11 columns to be sized");
    assert.ok(sheet.columns?.every((column) => (column.width ?? 0) > 0), "every column needs an explicit width");

    // Header block and item rows are merged, as on the template.
    assert.ok(Object.keys(sheet.model.merges ?? {}).length > 5, "expected merged header and item cells");

    // Every cell in the title row is bordered, so the grid reads continuously.
    for (let column = 1; column <= 11; column += 1) {
      assert.ok(sheet.getCell(1, column).border?.top, `cell ${column} in row 1 needs a border`);
    }
  });

  test("prints the computer-generated footer line", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildCustomsInvoiceWorkbook(build()) as never);
    const sheet = workbook.getWorksheet("Invoice");
    const values: string[] = [];
    sheet?.eachRow((sheetRow) => {
      const value = sheetRow.getCell(1).value;
      if (typeof value === "string") values.push(value);
    });
    assert.ok(values.includes(customsInvoiceFooterNote), "expected the footer note on the sheet");
  });
});
