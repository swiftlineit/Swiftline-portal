import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import { ediText } from "../edi/ediTransforms.js";

export type MhbsEdiColumn = {
  header: string;
  value: (row: ManifestDocumentParcelRow) => string;
  formula?: (excelRow: number) => string;
  warnWhenBlank?: boolean;
};

export type MhbsEdiWarning = {
  row: number;
  column: string;
  message: string;
};

function hawb(row: ManifestDocumentParcelRow): string {
  return ediText(row.parcelNumber).toUpperCase();
}

function mhbs(row: ManifestDocumentParcelRow): string {
  return ediText(row.bagNumber).toUpperCase();
}

/** The exact three-column order from the supplied MHBS BIFF8 workbook. */
export const MHBS_EDI_COLUMNS: readonly MhbsEdiColumn[] = [
  { header: "HAWB_Number", value: hawb, warnWhenBlank: true },
  { header: "MHBS_NO", value: mhbs, warnWhenBlank: true },
  {
    header: "SYSTEM NO",
    value: (row) => `ZX-${hawb(row)}`,
    formula: (excelRow) => `CONCATENATE("ZX-",A${excelRow})`
  }
];

export const MHBS_EDI_HEADERS = MHBS_EDI_COLUMNS.map((column) => column.header);

export function mhbsEdiCellValue(column: MhbsEdiColumn, row: ManifestDocumentParcelRow): string {
  return column.value(row);
}

export function collectMhbsEdiWarnings(rows: ManifestDocumentParcelRow[]): MhbsEdiWarning[] {
  const warnings: MhbsEdiWarning[] = [];
  rows.forEach((row, rowIndex) => {
    MHBS_EDI_COLUMNS.forEach((column) => {
      if (!column.warnWhenBlank) return;
      if (mhbsEdiCellValue(column, row) !== "") return;
      warnings.push({
        row: rowIndex + 2,
        column: column.header,
        message: `Row ${rowIndex + 2}, ${column.header} is blank.`
      });
    });
  });
  return warnings;
}
