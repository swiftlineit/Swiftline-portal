import ExcelJS from "exceljs";
import type { IShipmentManifest } from "../models/shipmentManifest.model.js";
import {
  manifestRows,
  shipmentManifestDeclaration,
  shipmentManifestSections,
  shipmentManifestTableHeadings
} from "./shipmentManifestPdf.service.js";
import type { ShipmentManifestConsignorAadhaarByDraft } from "./shipmentManifestConsignorAadhaar.service.js";

const colours = {
  ink: "FF111111",
  border: "FF222222",
  muted: "FFF2F2F2",
  white: "FFFFFFFF"
};

const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: colours.border } },
  left: { style: "thin", color: { argb: colours.border } },
  bottom: { style: "thin", color: { argb: colours.border } },
  right: { style: "thin", color: { argb: colours.border } }
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function manifestDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  }).format(value);
}

function filled(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function cellValue(value: string, column: number): string | number {
  if (value === "") return "";
  if (column === 0 || column === 9) return Number(value);
  if (column === 11 || column === 12) return Number.isFinite(Number(value)) ? Number(value) : value;
  return value;
}

function rowHeight(values: string[]) {
  const widths = [7, 24, 24, 38, 16, 18, 24, 38, 16, 7, 45, 11, 11, 15];
  const lines = values.reduce((tallest, value, index) => {
    const width = widths[index] ?? 12;
    const wrapped = value.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / width)), 0);
    return Math.max(tallest, wrapped);
  }, 1);
  return Math.min(409, Math.max(22, lines * 12 + 6));
}

/**
 * Builds the Shipment Manifest handover Excel document. Its parcel rows and
 * headings are shared with the Shipment Manifest PDF; the Operations Manifest
 * export intentionally continues using its separate fixed-layout workbook.
 */
export async function buildShipmentManifestHandoverWorkbook(
  manifest: IShipmentManifest,
  aadhaarByDraft: ShipmentManifestConsignorAadhaarByDraft = new Map()
): Promise<Buffer> {
  const header = manifest.headerSnapshot as Record<string, unknown>;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Swiftline Portal";
  workbook.company = "Swiftline Cargo and Express Logistics";
  workbook.subject = `Shipment manifest ${manifest.manifestNumber}`;
  workbook.created = manifest.generatedAt;

  const worksheet = workbook.addWorksheet("Manifest", {
    views: [{ state: "normal", showGridLines: false, zoomScale: 85 }],
    pageSetup: {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 }
    },
    properties: { defaultRowHeight: 20 }
  });
  worksheet.columns = [
    { width: 7 }, { width: 24 }, { width: 24 }, { width: 38 },
    { width: 16 }, { width: 18 }, { width: 24 }, { width: 38 },
    { width: 16 }, { width: 7 }, { width: 45 }, { width: 11 },
    { width: 11 }, { width: 15 }
  ];

  worksheet.mergeCells("A1:N1");
  worksheet.getCell("A1").value = "MANIFEST";
  worksheet.getRow(1).height = 32;
  worksheet.getCell("A1").font = { bold: true, size: 18, color: { argb: colours.ink } };
  worksheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getCell("A1").border = border;

  worksheet.getRow(2).height = 8;
  for (let row = 3; row <= 8; row += 1) worksheet.getRow(row).height = 19;

  const styleMergedHeaderRange = (
    range: string,
    top: number,
    left: number,
    bottom: number,
    right: number,
    value: string,
    options: { bold?: boolean; vertical?: "top" | "middle" } = {}
  ) => {
    // Keep cell-specific perimeter borders through the merge. Applying one
    // style to a normal merged range made Excel show only the left-side line.
    worksheet.mergeCellsWithoutStyle(range);
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const cell = worksheet.getCell(row, column);
        cell.font = { size: 9, bold: options.bold ?? false, color: { argb: colours.ink } };
        cell.fill = filled(colours.white);
        cell.alignment = {
          vertical: options.vertical ?? "middle",
          horizontal: "left",
          wrapText: true
        };
        cell.border = {
          ...(row === top ? { top: border.top } : {}),
          ...(row === bottom ? { bottom: border.bottom } : {}),
          ...(column === left ? { left: border.left } : {}),
          ...(column === right ? { right: border.right } : {})
        };
      }
    }
    worksheet.getCell(top, left).value = value;
  };

  // Match the PDF's header: FROM and TO blocks at left, followed by DATE and
  // the five shipment details in individually bordered rows on the right.
  styleMergedHeaderRange("A3:D3", 3, 1, 3, 4, "FROM,", { bold: true });
  styleMergedHeaderRange("E3:H3", 3, 5, 3, 8, "TO,", { bold: true });
  styleMergedHeaderRange("I3:N3", 3, 9, 3, 14, `DATE: ${manifestDate(manifest.generatedAt)}`, { bold: true });
  styleMergedHeaderRange("A4:D8", 4, 1, 8, 4, text(header.origin).toUpperCase() || "-", { bold: true, vertical: "top" });
  styleMergedHeaderRange("E4:H8", 4, 5, 8, 8, text(header.destination).toUpperCase() || "-", { bold: true, vertical: "top" });
  [
    `TOTAL PCS : ${manifest.totalPieces}`,
    `TOTAL WEIGHT: ${manifest.totalWeightKg.toFixed(2)}`,
    `MANIFEST #: ${manifest.manifestNumber}`,
    `COLOADER:${text(header.coloader) ? ` ${text(header.coloader)}` : ""}`,
    `PAYMENT TYPE:${text(header.paymentType) ? ` ${text(header.paymentType)}` : ""}`
  ].forEach((value, index) => {
    const row = index + 4;
    styleMergedHeaderRange(`I${row}:N${row}`, row, 9, row, 14, value, { bold: true });
  });

  worksheet.getRow(9).height = 8;
  const headingRow = worksheet.getRow(10);
  headingRow.values = [...shipmentManifestTableHeadings];
  headingRow.height = 30;
  for (let column = 1; column <= shipmentManifestTableHeadings.length; column += 1) {
    const cell = headingRow.getCell(column);
    cell.font = { bold: true, size: 9, color: { argb: colours.ink } };
    cell.fill = filled(colours.muted);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = border;
  }

  const sections = shipmentManifestSections(manifest);
  const rowsBySection = sections.length
    ? sections
    : [{ key: "manifest", label: "", lines: manifest.lineSnapshots }];
  let rowIndex = 0;
  const addRows = (rows: string[][]) => rows.forEach((values) => {
    const row = worksheet.addRow(values.map(cellValue));
    row.height = rowHeight(values);
    values.forEach((_value, index) => {
      const cell = row.getCell(index + 1);
      cell.font = { size: 9, color: { argb: colours.ink } };
      cell.alignment = {
        horizontal: [2, 3, 4, 6, 7, 8, 10, 13].includes(index) ? "left" : "center",
        vertical: "middle",
        wrapText: true
      };
      cell.border = border;
    });
    row.getCell(12).numFmt = "0.00";
    row.getCell(13).numFmt = "0.00";
  });
  rowsBySection.forEach((section, sectionIndex) => {
    if (sections.length) {
      if (sectionIndex > 0) worksheet.addRow([]).height = 20;
      const sectionRow = worksheet.addRow([section.label]);
      worksheet.mergeCells(`A${sectionRow.number}:N${sectionRow.number}`);
      sectionRow.height = 24;
      for (let column = 1; column <= shipmentManifestTableHeadings.length; column += 1) {
        const cell = sectionRow.getCell(column);
        cell.font = { bold: true, size: 10, color: { argb: colours.ink } };
        cell.fill = filled(colours.muted);
        cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        cell.border = border;
      }
    }
    const rows = manifestRows(section.lines, rowIndex, aadhaarByDraft);
    rowIndex += rows.length;
    addRows(rows);
  });

  const afterRows = Math.max(worksheet.rowCount, 10) + 2;
  const declaration = shipmentManifestDeclaration(manifest);
  worksheet.mergeCells(`A${afterRows}:N${afterRows}`);
  const declarationCell = worksheet.getCell(`A${afterRows}`);
  declarationCell.value = declaration;
  declarationCell.font = { size: 9, color: { argb: colours.ink } };
  declarationCell.alignment = { vertical: "top", horizontal: "justify", wrapText: true };
  declarationCell.border = border;
  worksheet.getRow(afterRows).height = 78;

  const signatureLine = afterRows + 1;
  worksheet.mergeCells(`A${signatureLine}:F${signatureLine}`);
  worksheet.mergeCells(`G${signatureLine}:N${signatureLine}`);
  worksheet.getRow(signatureLine).height = 24;
  for (const address of [`A${signatureLine}`, `G${signatureLine}`]) {
    worksheet.getCell(address).border = { bottom: { style: "thin", color: { argb: colours.border } } };
  }
  const signatureLabels = afterRows + 2;
  worksheet.mergeCells(`A${signatureLabels}:F${signatureLabels}`);
  worksheet.mergeCells(`G${signatureLabels}:N${signatureLabels}`);
  worksheet.getCell(`A${signatureLabels}`).value = `FOR ${text(header.origin).toUpperCase() || "ORIGIN"} (SIGN AND STAMP)`;
  worksheet.getCell(`G${signatureLabels}`).value = "(NAME)";
  for (const address of [`A${signatureLabels}`, `G${signatureLabels}`]) {
    worksheet.getCell(address).font = { bold: true, size: 9, color: { argb: colours.ink } };
    worksheet.getCell(address).alignment = { horizontal: "center", vertical: "middle" };
  }

  worksheet.pageSetup.printArea = `A1:N${signatureLabels}`;
  worksheet.headerFooter.oddFooter = `Swiftline Portal | Manifest ${manifest.manifestNumber} | Page &P of &N`;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
