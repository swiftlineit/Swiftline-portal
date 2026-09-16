// Renders the customs (shipment) invoice as .xlsx, mirroring the customer's
// template AND the PDF: bordered cells, merged header blocks, sized columns and
// wrapped party details, so the sheet is readable without touching a column width.
//
// Built with ExcelJS rather than `xlsx` because the community `xlsx` build
// silently discards cell styles- borders, bold and widths never reach the file,
// which is what left earlier exports looking unstructured.
//
// Column map, taken from the supplied template:
//   A      SR. NO.        B..E  DESCRIPTION
//   F      HS CODE        G     UNIT TYPE     H..I QUANTITY
//   J      UNIT RATES     K     AMOUNT

import ExcelJS from "exceljs";
import type { CustomsInvoiceModel, CustomsInvoiceParty } from "./customsInvoiceModel.service.js";
import { customsInvoiceFooterNote } from "./customsInvoiceConstants.js";

const lastColumn = 11; // K, 1-indexed for ExcelJS

// Row heights, in Excel points. Generous enough that each section reads as a
// distinct band rather than a cramped line of text; kept here as named values so
// the sheet stays proportional to the PDF.
const rowHeights = {
  title: 26,
  meta: 24,          // per line inside the invoice-no / other-reference block
  metaMinimum: 48,
  sectionLabel: 24,  // SHIPPER / CONSIGNEE / NOTES banner rows
  partyLine: 17,     // per line inside a party block
  partyMinimum: 110,
  originDestination: 26,
  note: 30,
  tableHeading: 34,
  boxHeader: 28,
  item: 24,
  total: 30,
  footerNote: 62,
  generatedBy: 24
};

const colours = {
  border: "FF000000",
  text: "FF000000",
  headingFill: "FFF2F2F2"
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: colours.border } },
  left: { style: "thin", color: { argb: colours.border } },
  bottom: { style: "thin", color: { argb: colours.border } },
  right: { style: "thin", color: { argb: colours.border } }
};

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata"
  }).format(value).replaceAll("/", "-");
}

/** Multi-line party block, as the template prints it inside one merged cell. */
function partyBlock(party: CustomsInvoiceParty): string {
  const lines = [party.name.toUpperCase(), `COMPANY NAME :${party.companyName}`];
  if (party.address) lines.push(`ADDRESS : ${party.address}`);
  lines.push([party.countryName, party.postcode].filter(Boolean).join(", "));
  if (party.email) lines.push(`EMAIL ${party.email}`);
  if (party.phone) lines.push(`PHONE NUMBER : ${party.phone}`);
  return lines.join("\n");
}

export async function buildCustomsInvoiceWorkbook(invoice: CustomsInvoiceModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Swiftline Portal";
  const sheet = workbook.addWorksheet("Invoice", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  // Widths chosen so every column is legible as-generated: the merged description
  // spans B..E, and quantity spans H..I.
  sheet.columns = [
    { width: 7 },  // A  SR. NO.
    { width: 18 }, // B  DESCRIPTION (merged B..E)
    { width: 12 }, // C
    { width: 12 }, // D
    { width: 12 }, // E
    { width: 15 }, // F  HS CODE
    { width: 11 }, // G  UNIT TYPE
    { width: 7 },  // H  QUANTITY (merged H..I)
    { width: 7 },  // I
    { width: 13 }, // J  UNIT RATES
    { width: 13 }  // K  AMOUNT
  ];

  let row = 0;

  /** Writes a row, merges the given spans, borders every cell and returns its index. */
  function addRow(
    cells: Array<{ column: number; value: string | number; bold?: boolean; align?: "left" | "center" | "right"; wrap?: boolean }>,
    merges: Array<[number, number]> = [],
    height?: number
  ) {
    row += 1;
    const sheetRow = sheet.getRow(row);
    if (height) sheetRow.height = height;

    for (const cell of cells) {
      const target = sheet.getCell(row, cell.column);
      target.value = cell.value;
      target.font = { name: "Calibri", size: 9, bold: Boolean(cell.bold), color: { argb: colours.text } };
      target.alignment = {
        horizontal: cell.align ?? "left",
        vertical: "middle",
        wrapText: cell.wrap ?? true
      };
    }

    for (const [from, to] of merges) {
      if (to > from) sheet.mergeCells(row, from, row, to);
    }

    // Borders go on every cell in the row, including the empty ones inside a
    // merge, so the grid reads as a continuous table.
    for (let column = 1; column <= lastColumn; column += 1) {
      sheet.getCell(row, column).border = thinBorder;
    }
    return row;
  }

  // Title
  addRow([{ column: 1, value: "INVOICE", bold: true, align: "center" }], [[1, lastColumn]], rowHeights.title);

  // Invoice number / other reference
  const referenceLines = ["OTHER REFERENCE"];
  if (invoice.otherReference) referenceLines.push(`REFERENCE :${invoice.otherReference}`);
  if (invoice.aadhaarNumber) referenceLines.push(`AADHAAR NUMBER :${invoice.aadhaarNumber}`);
  addRow(
    [
      { column: 1, value: `INVOICE NO. :${invoice.invoiceNumber}    INVOICE DATE. :${formatDate(invoice.invoiceDate)}`, bold: true },
      { column: 6, value: referenceLines.join("\n"), bold: true }
    ],
    [[1, 5], [6, lastColumn]],
    Math.max(rowHeights.metaMinimum, referenceLines.length * rowHeights.meta)
  );

  // Shipper / consignee labels
  addRow(
    [
      { column: 1, value: "SHIPPER", bold: true },
      { column: 6, value: "CONSIGNEE", bold: true }
    ],
    [[1, 5], [6, lastColumn]],
    rowHeights.sectionLabel
  );

  // Party details, sized to the taller of the two blocks.
  const shipperBlock = partyBlock(invoice.shipper);
  const consigneeBlock = partyBlock(invoice.consignee);
  const partyLineCount = Math.max(shipperBlock.split("\n").length, consigneeBlock.split("\n").length);
  addRow(
    [
      { column: 1, value: shipperBlock, bold: true },
      { column: 6, value: consigneeBlock, bold: true }
    ],
    [[1, 5], [6, lastColumn]],
    Math.max(rowHeights.partyMinimum, partyLineCount * rowHeights.partyLine)
  );

  // Country of origin / destination
  addRow(
    [
      { column: 1, value: "COUNTRY OF ORIGIN", bold: true },
      { column: 5, value: invoice.countryOfOrigin, bold: true, align: "center" },
      { column: 6, value: "DESTINATION", bold: true, align: "center" },
      { column: 9, value: invoice.destination, bold: true, align: "center" }
    ],
    [[1, 4], [6, 8], [9, lastColumn]],
    rowHeights.originDestination
  );

  // Note
  addRow(
    [
      { column: 1, value: "NOTE", bold: true },
      { column: 3, value: invoice.note, bold: true, align: "center" }
    ],
    [[1, 2], [3, lastColumn]],
    rowHeights.note
  );

  // Item table headings
  const headingRow = addRow(
    [
      { column: 1, value: "SR.\nNO.", bold: true, align: "center" },
      { column: 2, value: "DESCRIPTION", bold: true, align: "center" },
      { column: 6, value: "HS CODE", bold: true, align: "center" },
      { column: 7, value: "UNIT TYPE", bold: true, align: "center" },
      { column: 8, value: "QUANTITY", bold: true, align: "center" },
      { column: 10, value: "UNIT RATES", bold: true, align: "center" },
      { column: 11, value: "AMOUNT", bold: true, align: "center" }
    ],
    [[2, 5], [8, 9]],
    rowHeights.tableHeading
  );
  for (let column = 1; column <= lastColumn; column += 1) {
    sheet.getCell(headingRow, column).fill = {
      type: "pattern", pattern: "solid", fgColor: { argb: colours.headingFill }
    };
  }
  // Repeat the header block on every printed page, like the template does.
  sheet.pageSetup.printTitlesRow = `1:${headingRow}`;

  // Boxes and their item rows
  for (const parcel of invoice.boxes) {
    const dimensions = parcel.lengthCm && parcel.widthCm && parcel.heightCm
      ? `${parcel.lengthCm.toFixed(2)} * ${parcel.widthCm.toFixed(2)} * ${parcel.heightCm.toFixed(2)}`
      : "NOT PROVIDED";
    addRow(
      [{
        column: 1,
        value: `BOX NO: ${parcel.boxNumber}${parcel.parcelNumber ? ` , HAWB:${parcel.parcelNumber.toUpperCase()}` : ""} , DIMENSIONS (CMS) ${dimensions} , ACTUAL WEIGHT - ${parcel.actualWeightKg.toFixed(2)} KG`,
        bold: true,
        align: "center"
      }],
      [[1, lastColumn]],
      rowHeights.boxHeader
    );

    for (const item of parcel.items) {
      const itemRow = addRow(
        [
          { column: 1, value: item.serialNumber, align: "center" },
          { column: 2, value: item.description },
          { column: 6, value: item.hsCode, align: "center" },
          { column: 7, value: item.unitType, align: "center" },
          { column: 8, value: item.quantity, align: "center" },
          { column: 10, value: item.unitRate, align: "center" },
          { column: 11, value: item.amount, align: "center" }
        ],
        [[2, 5], [8, 9]],
        rowHeights.item
      );
      // Money columns carry two decimals, as on the template.
      sheet.getCell(itemRow, 10).numFmt = "0.00";
      sheet.getCell(itemRow, 11).numFmt = "0.00";
    }
  }

  // Amount chargeable
  const totalRow = addRow(
    [
      { column: 1, value: "AMOUNT CHARGEABLE", bold: true },
      { column: 4, value: invoice.totalAmountInWords, bold: true },
      { column: 9, value: `TOTAL: ${invoice.totalAmount.toFixed(2)} ${invoice.currency}`, bold: true, align: "right" }
    ],
    [[1, 3], [4, 8], [9, lastColumn]],
    rowHeights.total
  );
  sheet.getRow(totalRow).font = { name: "Calibri", size: 9, bold: true };

  // Notes / signature footer
  addRow(
    [
      { column: 1, value: "NOTES", bold: true },
      { column: 6, value: "SIGNATURE / STAMP", bold: true }
    ],
    [[1, 5], [6, lastColumn]],
    rowHeights.sectionLabel
  );
  addRow(
    [{ column: 1, value: invoice.note, bold: true }],
    [[1, 5], [6, lastColumn]],
    rowHeights.footerNote
  );

  // Matches the footer line the PDF prints.
  addRow(
    [{ column: 1, value: customsInvoiceFooterNote, align: "center" }],
    [[1, lastColumn]],
    rowHeights.generatedBy
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * The import sheet: Field | Value pairs for the details the printed invoice does
 * not carry in a machine-readable way- the CSB route, service type, consignor
 * details and Aadhaar number.
 *
 * Re-uploading this workbook prefills the shipment form from these values, so
 * the sheet is written even when a field is blank: the customer can fill it in
 * and upload it back.
 */
