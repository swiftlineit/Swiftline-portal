import fs from "node:fs";
import path from "node:path";
import * as CFB from "cfb";
import XLSX from "xlsx";
import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import {
  MHBS_EDI_COLUMNS,
  MHBS_EDI_HEADERS,
  mhbsEdiCellValue,
  type MhbsEdiWarning
} from "./mhbsEdiColumns.js";

const MHBS_EDI_COLUMN_COUNT = MHBS_EDI_COLUMNS.length;
const MHBS_EDI_TEMPLATE_ENV = "MHBS_EDI_TEMPLATE_PATH";

// BIFF8 records used by the supplied MHBS workbook.
const BIFF_DIMENSIONS_RECORD = 0x0200;
const BIFF_ROW_RECORD = 0x0208;
const BIFF_LABEL_RECORD = 0x0204;
const BIFF_FORMULA_RECORD = 0x0006;
const BIFF_STRING_RECORD = 0x0207;
const BIFF_BLANK_RECORD = 0x0201;

const BIFF_CELL_RECORDS = new Set([
  BIFF_LABEL_RECORD,
  0x00fd, // LABELSST
  0x0203, // NUMBER
  0x027e, // RK
  BIFF_FORMULA_RECORD,
  BIFF_BLANK_RECORD,
  0x00bd, // MULRK
  0x00be // MULBLANK
]);

type BiffRecord = { id: number; payload: Buffer };
type BiffCell = { row: number; column: number; xf: number };
type StyleVariants = { value: number; blank: number };

function templatePath(): string {
  const configured = process.env[MHBS_EDI_TEMPLATE_ENV]?.trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "assets", "mhbs-edi-template.xls"),
    path.resolve(process.cwd(), "backend", "assets", "mhbs-edi-template.xls"),
    path.resolve(process.cwd(), "..", "backend", "assets", "mhbs-edi-template.xls")
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("The MHBS EDI template is not installed. Add backend/assets/mhbs-edi-template.xls or set MHBS_EDI_TEMPLATE_PATH.");
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
    if (end > buffer.length) throw new Error("The MHBS EDI template has a truncated BIFF record.");
    records.push({ id, payload: Buffer.from(buffer.subarray(offset + 4, end)) });
    offset = end;
  }
  if (!records.length) throw new Error("The MHBS EDI template has no BIFF records.");
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
  if (payload.length < 6) return [];
  const row = readU16(payload, 0);
  if (record.id === 0x00be || record.id === 0x00bd) {
    const firstColumn = readU16(payload, 2);
    const lastColumn = readU16(payload, payload.length - 2);
    const stride = record.id === 0x00be ? 2 : 6;
    return Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => ({
      row,
      column: firstColumn + index,
      xf: readU16(payload, 4 + index * stride)
    }));
  }
  return [{ row, column: readU16(payload, 2), xf: readU16(payload, 4) }];
}

function assertTemplateHeaders(sheet: XLSX.WorkSheet): void {
  const actual = MHBS_EDI_HEADERS.map((_header, index) => (
    sheet[XLSX.utils.encode_cell({ r: 0, c: index })]?.v ?? ""
  ));
  if (actual.some((header, index) => header !== MHBS_EDI_HEADERS[index])) {
    throw new Error("The MHBS EDI template headers do not match the approved SLC025 format.");
  }
}

function mostCommon(values: number[], fallback?: number): number {
  if (!values.length) {
    if (fallback !== undefined) return fallback;
    throw new Error("The MHBS EDI template is missing a required cell style.");
  }
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]![0];
}

function readStyleVariants(
  records: BiffRecord[],
  sheet: XLSX.WorkSheet,
  templateRow: number,
  fallback?: StyleVariants[]
): StyleVariants[] {
  return Array.from({ length: MHBS_EDI_COLUMN_COUNT }, (_, column) => {
    const valueStyles: number[] = [];
    const blankStyles: number[] = [];
    for (const record of records) {
      for (const cell of cellEntries(record)) {
        if (cell.row !== templateRow || cell.column !== column) continue;
        const address = XLSX.utils.encode_cell({ r: templateRow, c: column });
        const sourceValue = sheet[address]?.v;
        (sourceValue === undefined || sourceValue === null || sourceValue === "" ? blankStyles : valueStyles).push(cell.xf);
      }
    }
    const fallbackColumn = fallback?.[column];
    const value = mostCommon(valueStyles, fallbackColumn?.value ?? fallbackColumn?.blank);
    const blank = mostCommon(blankStyles, value);
    return { value, blank };
  });
}

function rowTemplate(records: BiffRecord[], row: number): BiffRecord {
  const template = records.find((record) => record.id === BIFF_ROW_RECORD && readRecordRow(record) === row);
  if (!template) throw new Error(`The MHBS EDI template is missing its data-row formatting for row ${row + 1}.`);
  return template;
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

function stringRecord(value: string): BiffRecord {
  const text = Buffer.from(value, "utf16le");
  const payload = Buffer.alloc(3 + text.length);
  payload.writeUInt16LE(value.length, 0);
  payload[2] = 1; // BIFF8 high-byte (UTF-16LE) string.
  text.copy(payload, 3);
  return { id: BIFF_STRING_RECORD, payload };
}

function formulaTemplate(records: BiffRecord[], row: number): Buffer {
  const formula = records.find((record) => (
    record.id === BIFF_FORMULA_RECORD &&
    record.payload.length >= 6 &&
    readU16(record.payload, 0) === row &&
    readU16(record.payload, 2) === 2
  ));
  if (!formula) throw new Error(`The MHBS EDI template is missing its formula for row ${row + 1}.`);
  return encodeBiffRecord(formula);
}

function formulaRecord(template: Buffer, excelRow: number, xf: number, value: string): BiffRecord[] {
  const record = Buffer.from(template);
  const rowIndex = excelRow - 1;
  record.writeUInt16LE(rowIndex, 4);
  record.writeUInt16LE(xf, 8);
  // The supplied first data row contains the complete CONCATENATE formula.
  // Update its relative A-row reference while retaining the original formula metadata.
  const referenceToken = record.indexOf(0x44, 4 + 22);
  if (referenceToken < 0) throw new Error("The MHBS EDI formula template is invalid.");
  record.writeUInt16LE(rowIndex, referenceToken + 1);
  const parsed = parseBiffRecords(record);
  if (parsed.length !== 1 || parsed[0]!.id !== BIFF_FORMULA_RECORD) {
    throw new Error("The MHBS EDI formula template is invalid.");
  }
  return [parsed[0]!, stringRecord(value)];
}

function updateDimensions(record: BiffRecord, dataLastRow: number): BiffRecord {
  if (record.id !== BIFF_DIMENSIONS_RECORD || record.payload.length < 12) return record;
  const payload = Buffer.from(record.payload);
  // BIFF Dimensions stores final row/column as exclusive upper bounds.
  payload.writeUInt32LE(dataLastRow, 4);
  payload.writeUInt16LE(MHBS_EDI_COLUMN_COUNT, 10);
  return { id: record.id, payload };
}

function dataRecord(record: BiffRecord): boolean {
  const row = readRecordRow(record);
  return (row !== undefined && row >= 1) || record.id === BIFF_STRING_RECORD;
}

function buildDataRecords(
  rows: ManifestDocumentParcelRow[],
  styles: StyleVariants[][],
  rowTemplates: [BiffRecord, BiffRecord],
  formulaTemplate: Buffer,
  formulaStyles: [number, number]
): BiffRecord[] {
  const records: BiffRecord[] = [];
  rows.forEach((row, rowIndex) => {
    const zeroBasedRow = rowIndex + 1;
    const excelRow = rowIndex + 2;
    const variant = rowIndex === 0 ? 0 : 1;
    records.push(rowRecord(rowTemplates[variant]!, zeroBasedRow));
    MHBS_EDI_COLUMNS.forEach((column, columnIndex) => {
      const value = mhbsEdiCellValue(column, row);
      if (column.formula) {
        records.push(...formulaRecord(formulaTemplate, excelRow, formulaStyles[variant]!, value));
      } else if (value === "") {
        records.push(blankRecord(zeroBasedRow, columnIndex, styles[variant]![columnIndex]!.blank));
      } else {
        records.push(labelRecord(zeroBasedRow, columnIndex, styles[variant]![columnIndex]!.value, value));
      }
    });
  });
  return records;
}

export type MhbsEdiWorkbookResult = {
  buffer: Buffer;
  warnings: MhbsEdiWarning[];
};

/**
 * Populates the approved legacy workbook by patching BIFF8 records directly.
 * XLSX.write is intentionally avoided because it discards the template's
 * fonts, borders, alignment, row heights and protection metadata.
 */
export function buildMhbsEdiWorkbookBuffer(
  rows: ManifestDocumentParcelRow[],
  warnings: MhbsEdiWarning[] = []
): MhbsEdiWorkbookResult {
  const source = fs.readFileSync(templatePath());
  const sourceXlsx = XLSX.read(source, { type: "buffer", cellNF: true, cellStyles: true, cellFormula: true });
  const sourceSheet = sourceXlsx.Sheets.Sheet1;
  if (!sourceSheet) throw new Error("The MHBS EDI template is missing Sheet1.");
  assertTemplateHeaders(sourceSheet);

  const container = CFB.read(source, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  if (!workbook) throw new Error("The MHBS EDI template has no Workbook stream.");
  const sourceRecords = parseBiffRecords(Buffer.from(workbook.content as Uint8Array));

  const firstStyles = readStyleVariants(sourceRecords, sourceSheet, 1);
  const laterStyles = readStyleVariants(sourceRecords, sourceSheet, 2, firstStyles);
  const firstRowTemplate = rowTemplate(sourceRecords, 1);
  const laterRowTemplate = rowTemplate(sourceRecords, 2);
  const directFormulaTemplate = formulaTemplate(sourceRecords, 1);
  const firstFormulaStyle = cellEntries(sourceRecords.find((record) => (
    record.id === BIFF_FORMULA_RECORD && record.payload.length >= 6 &&
    readU16(record.payload, 0) === 1 && readU16(record.payload, 2) === 2
  )) ?? { id: 0, payload: Buffer.alloc(0) })[0]?.xf;
  const laterFormulaStyle = cellEntries(sourceRecords.find((record) => (
    record.id === BIFF_FORMULA_RECORD && record.payload.length >= 6 &&
    readU16(record.payload, 0) === 2 && readU16(record.payload, 2) === 2
  )) ?? { id: 0, payload: Buffer.alloc(0) })[0]?.xf;
  if (firstFormulaStyle === undefined || laterFormulaStyle === undefined) {
    throw new Error("The MHBS EDI template is missing its formula styles.");
  }

  const dataLastRow = Math.max(1, rows.length + 1);
  let lastDataRecordIndex = -1;
  sourceRecords.forEach((record, index) => {
    if (dataRecord(record)) lastDataRecordIndex = index;
  });
  if (lastDataRecordIndex < 0) throw new Error("The MHBS EDI template has no data-row records.");

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
    [firstStyles, laterStyles],
    [firstRowTemplate, laterRowTemplate],
    directFormulaTemplate,
    [firstFormulaStyle, laterFormulaStyle]
  );
  const outputStream = Buffer.concat([
    ...prefix.map(encodeBiffRecord),
    ...generatedRecords.map(encodeBiffRecord),
    ...suffix.map(encodeBiffRecord)
  ]);
  workbook.content = outputStream;
  workbook.size = outputStream.length;
  return { buffer: Buffer.from(CFB.write(container, { type: "buffer" })), warnings };
}
