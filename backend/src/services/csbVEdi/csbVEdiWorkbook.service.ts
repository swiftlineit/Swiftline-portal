import * as CFB from "cfb";
import XLSX from "xlsx";
import { CSB_V_EDI_HEADERS } from "./csbVEdiColumns.js";

const BIFF_FONT_RECORD = 0x0031;
const CSB_V_EDI_FONT_SIZE = 11;

function applyLegacyEdiFontSize(buffer: Buffer): Buffer {
  const container = CFB.read(buffer, { type: "buffer" });
  const workbook = container.FileIndex.find((entry) => entry.name === "Workbook");
  if (!workbook) throw new Error("The CSB-V EDI workbook has no Workbook stream.");

  const stream = Buffer.from(workbook.content as Uint8Array);
  let fontRecordsUpdated = 0;
  for (let offset = 0; offset + 4 <= stream.length;) {
    const recordId = stream.readUInt16LE(offset);
    const recordLength = stream.readUInt16LE(offset + 2);
    const recordEnd = offset + 4 + recordLength;
    if (recordEnd > stream.length) break;

    if (recordId === BIFF_FONT_RECORD && recordLength >= 2) {
      stream.writeUInt16LE(CSB_V_EDI_FONT_SIZE * 20, offset + 4);
      fontRecordsUpdated += 1;
    }
    offset = recordEnd;
  }

  if (fontRecordsUpdated === 0) throw new Error("The CSB-V EDI workbook has no font record.");
  workbook.content = stream;
  workbook.size = stream.length;
  return Buffer.from(CFB.write(container, { type: "buffer" }));
}

export function buildCsbVEdiWorkbookBuffer(rows: Array<Array<string | number>>) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([[...CSB_V_EDI_HEADERS], ...rows]);
  worksheet["!cols"] = CSB_V_EDI_HEADERS.map((header) => ({ wch: Math.max(header.length + 2, 16) }));
  XLSX.utils.book_append_sheet(workbook, worksheet, "CSB-V EDI");
  return applyLegacyEdiFontSize(Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "biff8" })));
}
