import fs from "node:fs";
import path from "node:path";
import * as CFB from "cfb";
import XLSX from "xlsx";
import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import {
  OPS_EDI_COLUMNS,
  OPS_EDI_HEADERS,
  opsEdiCellValue,
  type OpsEdiContext,
  type OpsEdiWarning
} from "./opsEdiColumns.js";

const OPS_EDI_COLUMN_COUNT = OPS_EDI_COLUMNS.length;
const OPS_EDI_TEMPLATE_ENV = "OPS_EDI_TEMPLATE_PATH";

// BIFF8 records used by the supplied SLC025 workbook.
const BIFF_DIMENSIONS_RECORD = 0x0200;
const BIFF_ROW_RECORD = 0x0208;
const BIFF_LABEL_RECORD = 0x0204;
const BIFF_LABELSST_RECORD = 0x00fd;
const BIFF_NUMBER_RECORD = 0x0203;
const BIFF_RK_RECORD = 0x027e;
const BIFF_FORMULA_RECORD = 0x0006;
const BIFF_STRING_RECORD = 0x0207;
const BIFF_BLANK_RECORD = 0x0201;
const BIFF_MULRK_RECORD = 0x00bd;
const BIFF_MULBLANK_RECORD = 0x00be;

const BIFF_CELL_RECORDS = new Set([
  BIFF_LABEL_RECORD,
  BIFF_LABELSST_RECORD,
  BIFF_NUMBER_RECORD,
  BIFF_RK_RECORD,
  BIFF_FORMULA_RECORD,
  BIFF_BLANK_RECORD,
  BIFF_MULRK_RECORD,
  BIFF_MULBLANK_RECORD
]);

type BiffRecord = {
  id: number;
  payload: Buffer;
};

type BiffCell = {
  row: number;
  column: number;
  xf: number;
};

type StyleVariants = {
  value: number;
  blank: number;
};

function templatePath(): string {
  const configured = process.env[OPS_EDI_TEMPLATE_ENV]?.trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "assets", "ops-edi-template.xls"),
    path.resolve(process.cwd(), "backend", "assets", "ops-edi-template.xls"),
    path.resolve(process.cwd(), "..", "backend", "assets", "ops-edi-template.xls"),
    path.resolve(process.cwd(), "..", "SLC025 main edi.xls")
  ].filter((candidate): candidate is string => Boolean(candidate));

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("The OPS EDI template is not installed. Add backend/assets/ops-edi-template.xls or set OPS_EDI_TEMPLATE_PATH.");
  }
  return found;
}

function readU16(buffer: Uint8Array, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8);
}

function parseBiffRecords(buffer: Buffer): BiffRecord[] {
  const records: BiffRecord[] = [];
  for (let offset = 0; offset + 4 <= buffer.length;) {
    const id = readU16(buffer, offset);
    const length = readU16(buffer, offset + 2);
    const end = offset + 4 + length;
    if (end > buffer.length) throw new Error("The OPS EDI template has a truncated BIFF record.");
    records.push({ id, payload: Buffer.from(buffer.subarray(offset + 4, end)) });
    offset = end;
  }
  if (records.length === 0) throw new Error("The OPS EDI template has no BIFF records.");
  return records;
}

function encodeBiffRecord(record: BiffRecord): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(record.id, 0);
  header.writeUInt16LE(record.payload.length, 2);
  return Buffer.concat([header, record.payload]);
}

function readRecordRow(record: BiffRecord): number | undefined {
  if (record.id === BIFF_ROW_RECORD || BIFF_CELL_RECORDS.has(record.id)) {
    return record.payload.length >= 2 ? readU16(record.payload, 0) : undefined;
  }
  return undefined;
}

function cellEntries(record: BiffRecord): BiffCell[] {
  if (!BIFF_CELL_RECORDS.has(record.id)) return [];
  const { payload } = record;
  const row = readU16(payload, 0);

  if (record.id === BIFF_MULBLANK_RECORD || record.id === BIFF_MULRK_RECORD) {
    if (payload.length < 6) return [];
    const firstColumn = readU16(payload, 2);
    const lastColumn = readU16(payload, payload.length - 2);
    const stride = record.id === BIFF_MULBLANK_RECORD ? 2 : 6;
    return Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => ({
      row,
      column: firstColumn + index,
      xf: readU16(payload, 4 + index * stride)
    }));
  }

  if (payload.length < 6) return [];
  return [{
    row,
    column: readU16(payload, 2),
    xf: readU16(payload, 4)
  }];
}

function assertTemplateHeaders(sheet: XLSX.WorkSheet) {
  const actual = OPS_EDI_HEADERS.map((_header, index) => sheet[XLSX.utils.encode_cell({ r: 0, c: index })]?.v ?? "");
  if (actual.some((header, index) => header !== OPS_EDI_HEADERS[index])) {
    throw new Error("The OPS EDI template headers do not match the approved SLC025 format.");
  }
}

function mostCommon(values: number[], fallback: number | undefined): number {
  if (!values.length) {
    if (fallback !== undefined) return fallback;
    throw new Error("The OPS EDI template is missing a required cell style.");
  }
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]![0];
}

/**
 * Reads the template's actual XF style choices instead of asking XLSX to
 * recreate them. Some optional address/state cells intentionally use a
 * different alignment when blank, so both variants are retained.
 */
function readStyleVariants(records: BiffRecord[], sheet: XLSX.WorkSheet): StyleVariants[] {
  const candidates = Array.from({ length: OPS_EDI_COLUMN_COUNT }, () => ({ value: [] as number[], blank: [] as number[] }));

  for (const record of records) {
    for (const cell of cellEntries(record)) {
      if (cell.row < 1 || cell.row > 43 || cell.column >= OPS_EDI_COLUMN_COUNT) continue;
      const address = XLSX.utils.encode_cell({ r: cell.row, c: cell.column });
      const sourceValue = sheet[address]?.v;
      const hasValue = sourceValue !== undefined && sourceValue !== null && sourceValue !== "";
      candidates[cell.column]![hasValue ? "value" : "blank"].push(cell.xf);
    }
  }

  return candidates.map((candidate) => {
    const value = mostCommon(candidate.value, candidate.blank[0]);
    const blank = mostCommon(candidate.blank, value);
    return { value, blank };
  });
}

function templateRowRecord(records: BiffRecord[]): BiffRecord {
  const row = records.find((record) => (
    record.id === BIFF_ROW_RECORD && readRecordRow(record) === 1
  ));
  if (!row) throw new Error("The OPS EDI template is missing its data-row formatting.");
  return row;
}

function rowRecord(template: BiffRecord, row: number): BiffRecord {
  const payload = Buffer.from(template.payload);
  payload.writeUInt16LE(row, 0);
  return { id: BIFF_ROW_RECORD, payload };
}

function blankRecord(row: number, column: number, xf: number): BiffRecord {
  const payload = Buffer.alloc(6);
  payload.writeUInt16LE(row, 0);
  payload.writeUInt16LE(column, 2);
  payload.writeUInt16LE(xf, 4);
  return { id: BIFF_BLANK_RECORD, payload };
}

function labelRecord(row: number, column: number, xf: number, value: string): BiffRecord {
  const text = Buffer.from(value, "utf16le");
  const payload = Buffer.alloc(9 + text.length);
  payload.writeUInt16LE(row, 0);
  payload.writeUInt16LE(column, 2);
  payload.writeUInt16LE(xf, 4);
  payload.writeUInt16LE(value.length, 6);
  payload[8] = 1; // BIFF8 high-byte (UTF-16LE) string.
  text.copy(payload, 9);
  return { id: BIFF_LABEL_RECORD, payload };
}

function numberRecord(row: number, column: number, xf: number, value: number): BiffRecord {
  const payload = Buffer.alloc(14);
  payload.writeUInt16LE(row, 0);
  payload.writeUInt16LE(column, 2);
  payload.writeUInt16LE(xf, 4);
  payload.writeDoubleLE(value, 6);
  return { id: BIFF_NUMBER_RECORD, payload };
}

function stringRecord(value: string): BiffRecord {
  const text = Buffer.from(value, "utf16le");
  const payload = Buffer.alloc(3 + text.length);
  payload.writeUInt16LE(value.length, 0);
  payload[2] = 1; // BIFF8 high-byte (UTF-16LE) string.
  text.copy(payload, 3);
  return { id: BIFF_STRING_RECORD, payload };
}

type FormulaRecordTemplate = Buffer;

function readFormulaTemplates(records: BiffRecord[]): Map<number, FormulaRecordTemplate> {
  const result = new Map<number, FormulaRecordTemplate>();
  for (const record of records) {
    if (record.id !== BIFF_FORMULA_RECORD || record.payload.length < 6) continue;
    const row = readU16(record.payload, 0);
    const column = readU16(record.payload, 2);
    if ((column === 41 || column === 42) && row === 1 && !result.has(column)) {
      result.set(column, encodeBiffRecord(record));
    }
  }
  if (!result.has(41) || !result.has(42)) {
    throw new Error("The OPS EDI template is missing the approved formula columns.");
  }
  return result;
}

function formulaRecord(template: FormulaRecordTemplate, excelRow: number, value: string): BiffRecord[] {
  const record = Buffer.from(template);
  const rowIndex = excelRow - 1;
  record.writeUInt16LE(rowIndex, 4);
  // The approved formulas use a relative cell reference. Its row offset follows
  // the formula's string literal, so locate the reference token in the copied
  // BIFF record rather than assuming the formula payload lengths are identical.
  const referenceToken = record.indexOf(0x44, 4 + 22);
  if (referenceToken < 0) throw new Error("The OPS EDI formula template is invalid.");
  record.writeUInt16LE(rowIndex, referenceToken + 1);

  const parsed = parseBiffRecords(record);
  if (parsed.length !== 1 || parsed[0]!.id !== BIFF_FORMULA_RECORD) {
    throw new Error("The OPS EDI formula template is invalid.");
  }
  return [parsed[0]!, stringRecord(value)];
}

function updateDimensions(record: BiffRecord, dataLastRow: number): BiffRecord {
  if (record.id !== BIFF_DIMENSIONS_RECORD || record.payload.length < 12) return record;
  const payload = Buffer.from(record.payload);
  // BIFF Dimensions stores the final row/column as exclusive upper bounds.
  payload.writeUInt32LE(dataLastRow, 4);
  payload.writeUInt16LE(OPS_EDI_COLUMN_COUNT, 10);
  return { id: record.id, payload };
}

function dataRecord(record: BiffRecord): boolean {
  const row = readRecordRow(record);
  return (row !== undefined && row >= 1) || record.id === BIFF_STRING_RECORD;
}

function buildDataRecords(
  rows: ManifestDocumentParcelRow[],
  context: OpsEdiContext,
  styles: StyleVariants[],
  rowTemplate: BiffRecord,
  formulaTemplates: Map<number, FormulaRecordTemplate>
): BiffRecord[] {
  const records: BiffRecord[] = [];

  rows.forEach((row, rowIndex) => {
    const zeroBasedRow = rowIndex + 1;
    const excelRow = rowIndex + 2;
    records.push(rowRecord(rowTemplate, zeroBasedRow));

    OPS_EDI_COLUMNS.forEach((column, columnIndex) => {
      const value = opsEdiCellValue(column, row, context);
      if (column.formula) {
        records.push(...formulaRecord(
          formulaTemplates.get(columnIndex)!,
          excelRow,
          String(value)
        ));
        return;
      }

      const xf = styles[columnIndex]![value === "" ? "blank" : "value"];
      if (value === "") {
        records.push(blankRecord(zeroBasedRow, columnIndex, xf));
      } else if (column.type === "number") {
        records.push(numberRecord(zeroBasedRow, columnIndex, xf, Number(value)));
      } else {
        records.push(labelRecord(zeroBasedRow, columnIndex, xf, String(value)));
      }
    });
  });

  return records;
}

export type OpsEdiWorkbookResult = {
  buffer: Buffer;
  warnings: OpsEdiWarning[];
};

/**
 * Populates the supplied BIFF8 workbook by patching its cell records directly.
 * The workbook is deliberately not round-tripped through XLSX.write: that
 * conversion discards the legacy XF records that define this EDI's exact
 * fonts, borders, alignment, row heights and protection metadata.
 */
export function buildOpsEdiWorkbookBuffer(
  rows: ManifestDocumentParcelRow[],
  context: OpsEdiContext,
  warnings: OpsEdiWarning[] = []
): OpsEdiWorkbookResult {
  const source = fs.readFileSync(templatePath());
  const sourceXlsx = XLSX.read(source, {
    type: "buffer",
    cellNF: true,
    cellStyles: true,
    cellFormula: true
  });
  const sourceSheet = sourceXlsx.Sheets.Sheet1;
  if (!sourceSheet) throw new Error("The OPS EDI template is missing Sheet1.");
  assertTemplateHeaders(sourceSheet);

  const container = CFB.read(source, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  if (!workbook) throw new Error("The OPS EDI template has no Workbook stream.");

  const sourceRecords = parseBiffRecords(Buffer.from(workbook.content as Uint8Array));
  const styles = readStyleVariants(sourceRecords, sourceSheet);
  const rowTemplate = templateRowRecord(sourceRecords);
  const formulaTemplates = readFormulaTemplates(sourceRecords);
  const dataLastRow = Math.max(1, rows.length + 1);

  // The template contains sample data rows and a short formatted extension.
  // Remove only row/cell records for those data rows, leaving the workbook,
  // sheet, print, border and protection records untouched. New rows are then
  // inserted immediately before the worksheet's trailing view records.
  let lastDataRecordIndex = -1;
  sourceRecords.forEach((record, index) => {
    if (dataRecord(record)) lastDataRecordIndex = index;
  });
  if (lastDataRecordIndex < 0) throw new Error("The OPS EDI template has no data-row records.");

  const prefix: BiffRecord[] = [];
  const suffix: BiffRecord[] = [];
  sourceRecords.forEach((record, index) => {
    const updated = updateDimensions(record, dataLastRow);
    if (dataRecord(record)) return;
    if (index <= lastDataRecordIndex) prefix.push(updated);
    else suffix.push(updated);
  });

  const generatedRecords = buildDataRecords(
    rows,
    context,
    styles,
    rowTemplate,
    formulaTemplates
  );
  const outputStream = Buffer.concat([
    ...prefix.map(encodeBiffRecord),
    ...generatedRecords.map(encodeBiffRecord),
    ...suffix.map(encodeBiffRecord)
  ]);

  workbook.content = outputStream;
  workbook.size = outputStream.length;
  return {
    buffer: Buffer.from(CFB.write(container, { type: "buffer" })),
    warnings
  };
}
