import { fullManifestParcelDescription, type ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import type { ManifestPartySnapshot } from "../shipmentManifest.service.js";
import { ediCountryName } from "../reference/countryNames.js";
import {
  EDI_AD_CODE,
  EDI_BOND,
  EDI_CURRENCY,
  EDI_GSTIN_TYPE,
  EDI_IGST_PAID,
  EDI_PAY_TYPE
} from "./ediConstants.js";
import {
  ediAadhaarNumber,
  ediAddressLine,
  ediDate,
  ediText,
  ediValue,
  titleCaseState
} from "./ediTransforms.js";

// Everything the EDI needs beyond a single parcel row: the shared MAWB/date from the
// manifest header, and the full (unredacted) consignor Aadhaar, which is read live
// per row because snapshots only keep it masked.
export type EdiContext = {
  mawbNumber: string;
  departureDate: string; // yyyy-MM-dd from the sealed header
  aadhaarFor: (row: ManifestDocumentParcelRow) => string; // 12 digits, or ""
};

export type EdiColumnSource = "HEADER" | "SNAP" | "LIVE" | "CALC" | "CONST";

export type EdiColumn = {
  header: string;
  source: EdiColumnSource;
  type: "text" | "number";
  // When true, the writer keeps this text value as-is instead of upper-casing it-
  // used for the deliberately title-cased state and the "Aadhaar Number" label.
  preserveCase?: boolean;
  value: (row: ManifestDocumentParcelRow, ctx: EdiContext) => string | number;
};

const emptyParty: ManifestPartySnapshot = {
  companyName: "", contactName: "", addressLine1: "", addressLine2: "",
  city: "", state: "", postcode: "", countryCode: "", countryName: "", phone: ""
};

const consignor = (row: ManifestDocumentParcelRow) => row.consignor.party ?? emptyParty;
const consignee = (row: ManifestDocumentParcelRow) => row.consignee.party ?? emptyParty;

// Identity rules from §4.9, defined once so a change propagates to every column that
// mirrors them.
const hawbOf = (row: ManifestDocumentParcelRow) => ediText(row.parcelNumber).toUpperCase();
const mhbsOf = (row: ManifestDocumentParcelRow) => ediText(row.bagNumber);
const valueOf = (row: ManifestDocumentParcelRow) => ediValue(row.declaredValueMinor);

/**
 * The one place the EDI's 36 columns, their order, and their sources are defined.
 * The writer only reads `header` and calls `value`- it never references a column by
 * index, so adding, removing, or reordering a column is a single edit here.
 */
export const EDI_COLUMNS: readonly EdiColumn[] = [
  { header: "MAWBNumber", source: "HEADER", type: "text", value: (_row, ctx) => ediText(ctx.mawbNumber).toUpperCase() },
  { header: "HAWBNumber", source: "SNAP", type: "text", value: (row) => hawbOf(row) },
  { header: "ConsignorName", source: "SNAP", type: "text", value: (row) => ediText(consignor(row).contactName || consignor(row).companyName) },
  { header: "ConsignorAddress1", source: "SNAP", type: "text", value: (row) => ediAddressLine(consignor(row).addressLine1) },
  { header: "ConsignorAddress2", source: "SNAP", type: "text", value: (row) => ediAddressLine(consignor(row).addressLine2) },
  { header: "ConsignorCity", source: "SNAP", type: "text", value: (row) => ediText(consignor(row).city) },
  { header: "ConsignorState", source: "SNAP", type: "text", preserveCase: true, value: (row) => titleCaseState(consignor(row).state) },
  { header: "ConsignorPostalCode", source: "SNAP", type: "text", value: (row) => ediText(consignor(row).postcode) },
  { header: "ConsignorCountry", source: "CALC", type: "text", value: (row) => ediCountryName(consignor(row).countryCode || consignor(row).countryName) },
  { header: "ConsigneeName", source: "SNAP", type: "text", value: (row) => ediText(consignee(row).contactName) },
  { header: "ConsigneeAddress1", source: "SNAP", type: "text", value: (row) => ediAddressLine(consignee(row).addressLine1) },
  { header: "ConsigneeAddress2", source: "SNAP", type: "text", value: (row) => ediAddressLine(consignee(row).addressLine2) },
  { header: "ConsigneeCity", source: "SNAP", type: "text", value: (row) => ediText(consignee(row).city) },
  { header: "ConsigneeState", source: "SNAP", type: "text", preserveCase: true, value: (row) => titleCaseState(consignee(row).state) },
  { header: "ConsigneePostalCode", source: "SNAP", type: "text", value: (row) => ediText(consignee(row).postcode) },
  { header: "ConsigneeCountry", source: "CALC", type: "text", value: (row) => ediCountryName(consignee(row).countryCode || consignee(row).countryName) },
  { header: "PKG", source: "CONST", type: "number", value: () => 1 },
  { header: "Weight", source: "SNAP", type: "number", value: (row) => row.weightKg },
  { header: "DescriptionofGoods", source: "SNAP", type: "text", value: (row) => ediText(fullManifestParcelDescription(row.items, row.description)) },
  { header: "Value", source: "SNAP", type: "number", value: (row) => valueOf(row) },
  { header: "ExportInvoiceNo", source: "CALC", type: "text", value: (row) => hawbOf(row) },
  { header: "GSTInvoiceNo", source: "CALC", type: "text", value: (row) => hawbOf(row) },
  { header: "InvoiceValue", source: "CALC", type: "number", value: (row) => valueOf(row) },
  { header: "CurrencyType", source: "CONST", type: "text", value: () => EDI_CURRENCY },
  { header: "PayType", source: "CONST", type: "text", value: () => EDI_PAY_TYPE },
  { header: "IGSTPaid", source: "CONST", type: "number", value: () => EDI_IGST_PAID },
  { header: "Bond", source: "CONST", type: "text", value: () => EDI_BOND },
  { header: "MHBSNo", source: "SNAP", type: "text", value: (row) => mhbsOf(row) },
  { header: "GSTINType", source: "CONST", type: "text", preserveCase: true, value: () => EDI_GSTIN_TYPE },
  { header: "GSTINNumber", source: "LIVE", type: "number", value: (row, ctx) => ediAadhaarNumber(ctx.aadhaarFor(row)) },
  { header: "GSTDate", source: "HEADER", type: "text", value: (_row, ctx) => ediDate(ctx.departureDate) },
  { header: "ExportDate", source: "HEADER", type: "text", value: (_row, ctx) => ediDate(ctx.departureDate) },
  { header: "ADCode", source: "CONST", type: "text", value: () => EDI_AD_CODE },
  { header: "CRN_NO", source: "CALC", type: "text", value: (row) => hawbOf(row) },
  { header: "CRN_MHBS_NO", source: "CALC", type: "text", value: (row) => mhbsOf(row) },
  { header: "FOB_Value", source: "CALC", type: "number", value: (row) => valueOf(row) }
];

export const EDI_HEADERS: readonly string[] = EDI_COLUMNS.map((column) => column.header);
