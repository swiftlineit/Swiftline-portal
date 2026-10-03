import fs from "node:fs";
import path from "node:path";
import * as CFB from "cfb";
import XLSX from "xlsx";
import { CSB_V_EDI2_HEADERS, type CsbVEdi2Cell } from "./csbVEdi2Columns.js";

type BiffRecord = { id: number; payload: Buffer };
const ROW = 0x0208;
const BLANK = 0x0201;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const DIMENSIONS = 0x0200;
const INDEX = 0x020b;
const DBCELL = 0x00d7;
const CELL_IDS = new Set([BLANK, LABEL, NUMBER, 0x00fd, 0x027e, 0x00bd, 0x00be]);

function templatePath() {
  const candidates = [
    process.env.CSB_V_EDI2_TEMPLATE_PATH?.trim(),
    path.resolve(process.cwd(), "assets", "csb-v-edi2-template.xls"),
    path.resolve(process.cwd(), "backend", "assets", "csb-v-edi2-template.xls"),
    path.resolve(process.cwd(), "..", "backend", "assets", "csb-v-edi2-template.xls")
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("The CSB-V EDI2 template is not installed.");
  return found;
}

function parseRecords(stream: Buffer): BiffRecord[] {
  const records: BiffRecord[] = [];
  for (let offset = 0; offset + 4 <= stream.length;) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (offset + 4 + length > stream.length) throw new Error("The CSB-V EDI2 template has a truncated BIFF record.");
    records.push({ id, payload: Buffer.from(stream.subarray(offset + 4, offset + 4 + length)) });
    offset += 4 + length;
  }
  return records;
}

function encodeRecord(record: BiffRecord): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(record.id, 0);
  header.writeUInt16LE(record.payload.length, 2);
  return Buffer.concat([header, record.payload]);
}

function recordRow(record: BiffRecord): number | undefined {
  return (record.id === ROW || CELL_IDS.has(record.id)) && record.payload.length >= 2
    ? record.payload.readUInt16LE(0) : undefined;
}

function dataStyles(records: BiffRecord[]): number[] {
  const styles: Array<number | undefined> = Array(CSB_V_EDI2_HEADERS.length).fill(undefined);
  for (const { id, payload } of records) {
    if (!CELL_IDS.has(id) || payload.length < 6 || payload.readUInt16LE(0) !== 1) continue;
    const first = payload.readUInt16LE(2);
    if (id === 0x00bd || id === 0x00be) {
      const last = payload.readUInt16LE(payload.length - 2);
      const stride = id === 0x00bd ? 6 : 2;
      for (let column = first; column <= last; column++) styles[column] = payload.readUInt16LE(4 + (column - first) * stride);
    } else styles[first] = payload.readUInt16LE(4);
  }
  if (styles.some((style) => style === undefined)) throw new Error("The CSB-V EDI2 template is missing data-cell formatting.");
  return styles as number[];
}

function cellRecord(row: number, column: number, xf: number, value: CsbVEdi2Cell): BiffRecord {
  const base = Buffer.alloc(6);
  base.writeUInt16LE(row, 0);
  base.writeUInt16LE(column, 2);
  base.writeUInt16LE(xf, 4);
  if (value === "") return { id: BLANK, payload: base };
  if (typeof value === "number") {
    const payload = Buffer.alloc(14);
    base.copy(payload);
    payload.writeDoubleLE(value, 6);
    return { id: NUMBER, payload };
  }
  const encoded = Buffer.from(value, "utf16le");
  const payload = Buffer.alloc(9 + encoded.length);
  base.copy(payload);
  payload.writeUInt16LE(value.length, 6);
  payload[8] = 1;
  encoded.copy(payload, 9);
  return { id: LABEL, payload };
}

/** Patches data records only; XLSX.write would discard the supplied BIFF8 fonts and styles. */
export function buildCsbVEdi2WorkbookBuffer(rows: CsbVEdi2Cell[][]): Buffer {
  if (rows.length > 65_534 || rows.some((row) => row.length !== CSB_V_EDI2_HEADERS.length)) {
    throw new Error("The CSB-V EDI2 rows do not fit the supplied workbook.");
  }
  const source = fs.readFileSync(templatePath());
  const parsed = XLSX.read(source, { type: "buffer" });
  const sheet = parsed.Sheets.Sheet1;
  if (!sheet || CSB_V_EDI2_HEADERS.some((header, column) => sheet[XLSX.utils.encode_cell({ r: 0, c: column })]?.v !== header)) {
    throw new Error("The CSB-V EDI2 template headers do not match the supplied format.");
  }
  const container = CFB.read(source, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  if (!workbook) throw new Error("The CSB-V EDI2 template has no Workbook stream.");
  const records = parseRecords(Buffer.from(workbook.content as Uint8Array));
  const styles = dataStyles(records);
  const templateRow = records.find((record) => record.id === ROW && recordRow(record) === 1);
  if (!templateRow) throw new Error("The CSB-V EDI2 template has no data-row formatting.");

  const rowRecords = rows.map((_row, index) => {
    const payload = Buffer.from(templateRow.payload);
    payload.writeUInt16LE(index + 1, 0);
    return { id: ROW, payload };
  });
  const cellRecords = rows.flatMap((row, index) => row.map((value, column) => cellRecord(index + 1, column, styles[column]!, value)));
  const output: BiffRecord[] = [];
  let insertedRows = false;
  let insertedCells = false;
  for (const record of records) {
    if (record.id === INDEX || record.id === DBCELL) continue; // Their row offsets change with every export.
    if (record.id === DIMENSIONS) {
      const payload = Buffer.from(record.payload);
      payload.writeUInt32LE(rows.length + 1, 4);
      output.push({ id: record.id, payload });
      continue;
    }
    if (record.id === ROW && recordRow(record) === 1 && !insertedRows) {
      output.push(...rowRecords);
      insertedRows = true;
    }
    if (CELL_IDS.has(record.id) && recordRow(record) === 1 && !insertedCells) {
      output.push(...cellRecords);
      insertedCells = true;
    }
    if (recordRow(record) === 1) continue;
    output.push(record);
  }
  if (!insertedRows || !insertedCells) throw new Error("The CSB-V EDI2 template has no placeholder row.");
  const stream = Buffer.concat(output.map(encodeRecord));
  workbook.content = stream;
  workbook.size = stream.length;
  return Buffer.from(CFB.write(container, { type: "buffer" }));
}
