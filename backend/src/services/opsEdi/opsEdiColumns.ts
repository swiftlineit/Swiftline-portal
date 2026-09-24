import { fullManifestParcelDescription, type ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import type { ManifestPartySnapshot } from "../shipmentManifest.service.js";
import { ediCountryName } from "../reference/countryNames.js";
import {
  ediAadhaarNumber,
  ediAddressLine,
  ediDate,
  ediText,
  ediValue,
  titleCaseState
} from "../edi/ediTransforms.js";

export type OpsEdiContext = {
  departureDate: string;
  aadhaarFor: (row: ManifestDocumentParcelRow) => string;
};

export type OpsEdiCellValue = string | number;

export type OpsEdiColumn = {
  header: string;
  type: "text" | "number";
  value: (row: ManifestDocumentParcelRow, context: OpsEdiContext) => OpsEdiCellValue;
  formula?: (excelRow: number) => string;
  warnWhenBlank?: boolean;
};

const emptyParty: ManifestPartySnapshot = {
  companyName: "",
  contactName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postcode: "",
  countryCode: "",
  countryName: "",
  phone: ""
};

const consignor = (row: ManifestDocumentParcelRow) => row.consignor.party ?? emptyParty;
const consignee = (row: ManifestDocumentParcelRow) => row.consignee.party ?? emptyParty;
const hawb = (row: ManifestDocumentParcelRow) => ediText(row.parcelNumber).toUpperCase();
const description = (row: ManifestDocumentParcelRow) => ediText(fullManifestParcelDescription(row.items, row.description));
const value = (row: ManifestDocumentParcelRow) => ediValue(row.declaredValueMinor);
const bagNumber = (row: ManifestDocumentParcelRow) => ediText(row.bagNumber);

/** The exact 46-column order from the supplied SLC025 OPS EDI workbook. */
export const OPS_EDI_COLUMNS: readonly OpsEdiColumn[] = [
  { header: "HAWB_Number", type: "text", value: (row) => hawb(row), warnWhenBlank: true },
  { header: "Description_of_Goods", type: "text", value: (row) => description(row), warnWhenBlank: true },
  { header: "CTSH", type: "text", value: () => "" },
  { header: "Dec_Value", type: "number", value: (row) => value(row), warnWhenBlank: true },
  { header: "Currency", type: "text", value: () => "INR", warnWhenBlank: true },
  { header: "Bag_Box", type: "number", value: () => 1, warnWhenBlank: true },
  { header: "Qty", type: "number", value: () => 1, warnWhenBlank: true },
  { header: "UOM", type: "text", value: () => "" },
  { header: "Unit_Price", type: "number", value: () => 0, warnWhenBlank: true },
  { header: "DOX_SPX", type: "text", value: () => "SPX", warnWhenBlank: true },
  { header: "Weight", type: "number", value: (row) => row.weightKg, warnWhenBlank: true },
  { header: "IEC_CODE", type: "text", value: () => "" },
  { header: "IEC_BR_CODE", type: "text", value: () => "" },
  { header: "Consignor_Name", type: "text", value: (row) => ediText(consignor(row).contactName || consignor(row).companyName), warnWhenBlank: true },
  { header: "CnrAddress_1", type: "text", value: (row) => ediAddressLine(consignor(row).addressLine1), warnWhenBlank: true },
  { header: "CnrAddress_2", type: "text", value: (row) => ediAddressLine(consignor(row).addressLine2) },
  { header: "CnrCity", type: "text", value: (row) => ediText(consignor(row).city), warnWhenBlank: true },
  { header: "CnrState", type: "text", value: (row) => titleCaseState(consignor(row).state), warnWhenBlank: true },
  { header: "CnrPostal_Code", type: "text", value: (row) => ediText(consignor(row).postcode), warnWhenBlank: true },
  { header: "CnrCountry", type: "text", value: (row) => ediCountryName(consignor(row).countryCode || consignor(row).countryName), warnWhenBlank: true },
  { header: "Consignee_Name", type: "text", value: (row) => ediText(consignee(row).companyName || consignee(row).contactName), warnWhenBlank: true },
  { header: "CneeAddress_1", type: "text", value: (row) => ediAddressLine(consignee(row).addressLine1), warnWhenBlank: true },
  { header: "CneeAddress_2", type: "text", value: (row) => ediAddressLine(consignee(row).addressLine2) },
  { header: "CneeCity", type: "text", value: (row) => ediText(consignee(row).city), warnWhenBlank: true },
  { header: "CneePostal_Code", type: "text", value: (row) => ediText(consignee(row).postcode), warnWhenBlank: true },
  { header: "CneeState", type: "text", value: (row) => titleCaseState(consignee(row).state) },
  { header: "CneeCountry", type: "text", value: (row) => ediCountryName(consignee(row).countryCode || consignee(row).countryName), warnWhenBlank: true },
  { header: "Export_Invoice_no", type: "text", value: (row) => hawb(row), warnWhenBlank: true },
  { header: "Date_of_EXPORT_Invoice", type: "text", value: (_row, context) => ediDate(context.departureDate), warnWhenBlank: true },
  { header: "Total_Item_value", type: "number", value: (row) => value(row), warnWhenBlank: true },
  { header: "Total_Taxable_Value", type: "number", value: () => 0, warnWhenBlank: true },
  { header: "Total_IGST_Paid", type: "number", value: () => 0, warnWhenBlank: true },
  { header: "Total_CESS_Paid", type: "number", value: () => 0, warnWhenBlank: true },
  { header: "Terms_of_Invoice", type: "text", value: () => "FOB", warnWhenBlank: true },
  { header: "Kyc Type", type: "text", value: () => "Aadhaar Number", warnWhenBlank: true },
  { header: "Kyc No", type: "number", value: (_row, context) => ediAadhaarNumber(context.aadhaarFor(_row)), warnWhenBlank: true },
  { header: "State_Code", type: "text", value: () => "" },
  { header: "AD CODE", type: "text", value: () => "" },
  { header: "Bond_or_UT", type: "text", value: () => "UT", warnWhenBlank: true },
  { header: "Export_Using_Ecom", type: "text", value: () => "N", warnWhenBlank: true },
  { header: "MEIS_Scheme", type: "text", value: () => "N", warnWhenBlank: true },
  {
    header: "SYSTEM NO",
    type: "text",
    value: (row) => `ZX-${hawb(row)}`,
    formula: (excelRow) => `CONCATENATE("ZX-",A${excelRow})`
  },
  {
    header: "SYS_KYC_NO",
    type: "text",
    value: (_row, context) => `KYC-${ediAadhaarNumber(context.aadhaarFor(_row)) || ""}`,
    formula: (excelRow) => `CONCATENATE("KYC-",AJ${excelRow})`
  },
  { header: "ACCOUNT_NO", type: "number", value: () => 0, warnWhenBlank: true },
  { header: "GOV_NONGOV_TYPE", type: "text", value: () => "N", warnWhenBlank: true },
  { header: "NFEI_FLAG", type: "text", value: () => "N", warnWhenBlank: true }
];

export const OPS_EDI_HEADERS = OPS_EDI_COLUMNS.map((column) => column.header);

export type OpsEdiWarning = {
  row: number;
  column: string;
  message: string;
};

export function opsEdiCellValue(
  column: OpsEdiColumn,
  row: ManifestDocumentParcelRow,
  context: OpsEdiContext
): OpsEdiCellValue {
  return column.value(row, context);
}

export function collectOpsEdiWarnings(
  rows: ManifestDocumentParcelRow[],
  context: OpsEdiContext
): OpsEdiWarning[] {
  const warnings: OpsEdiWarning[] = [];
  rows.forEach((row, rowIndex) => {
    OPS_EDI_COLUMNS.forEach((column) => {
      if (!column.warnWhenBlank) return;
      const valueForCell = opsEdiCellValue(column, row, context);
      if (valueForCell !== "" && valueForCell !== null && valueForCell !== undefined) return;
      warnings.push({
        row: rowIndex + 2,
        column: column.header,
        message: `Row ${rowIndex + 2}, ${column.header} is blank.`
      });
    });
  });
  return warnings;
}
