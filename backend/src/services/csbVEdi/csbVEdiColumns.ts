import type { ManifestDocumentConsignment, ManifestDocumentItem, ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import { ediDate, ediText } from "../edi/ediTransforms.js";

export const CSB_V_EDI_HEADERS = [
  "HAWB_Number", "No_of_Bags_Pkgs_Pieces_ULD", "Declared_Weight", "Import_Export_Code", "Terms_of_Invoice",
  "MHBS_NO", "Export_Using_Ecom", "MEIS_Scheme", "AD_Code", "CRN_NO", "CRN_MHBS_NO", "Consignor_Name",
  "Consignor_Address_1", "Consignor_Address_2", "Consignor_State", "Consignor_City", "Consignor_Postal_Code",
  "Consignor_Country", "Consignee_Name", "Consignee_Address_1", "Consignee_Address_2", "Consignee_State",
  "Consignee_City", "Consignee_Postal_Code", "Consignee_Country", "Inv_No", "Inv_Dt", "CTSH",
  "Description_of_Goods", "Quantity", "UOM", "Unit_Price", "Total_Item_value", "Item_Cur",
  "Total_Taxable_Value", "Taxable_Value_Cur", "Total_IGST_Paid", "Total_CESS_Paid", "Bond_or_UT",
  "Gstin_type", "Gstin_id", "State_Code", "ACCOUNT_NO", "GOV_NONGOV_TYPE", "NFEI_FLAG"
] as const;

export type CsbVEdiDraftContext = {
  csbType?: string;
  csbVGstin?: string;
  csbVAccountNumber?: string;
  csbVInvoiceNumber?: string;
  consigneeEnteredAddress?: { stateCode?: string };
};

export type CsbVEdiRowContext = {
  consignment: ManifestDocumentConsignment;
  row: ManifestDocumentParcelRow;
  draft: CsbVEdiDraftContext;
  bagNumbers: string[];
  departureDate: string;
};

function uniqueBagNumbers(consignment: ManifestDocumentConsignment) {
  return [...new Set(consignment.parcels.flatMap((parcel) => parcel.bagNumber.split(/[|,]/).map((value) => value.trim()).filter(Boolean)))];
}

function itemValues(items: ManifestDocumentItem[], select: (item: ManifestDocumentItem) => string | number) {
  const values = items.map(select);
  return values.length === 1 ? (values[0] ?? "") : values.join(",");
}

function itemRows(row: ManifestDocumentParcelRow): ManifestDocumentItem[] {
  return row.items?.length ? row.items : [{ description: row.description, hsnCode: "", unitType: "", quantity: 1, unitRate: 0 }];
}

function itemTotal(item: ManifestDocumentItem) {
  return Number(item.quantity ?? 0) * Number(item.unitRate ?? 0);
}

function repeatedItemValue(value: string, count: number) {
  return Array.from({ length: count }, () => value).join(",");
}

/** Creates one CSB-V EDI row for one sealed parcel. */
export function buildCsbVEdiRow(context: CsbVEdiRowContext): Array<string | number> {
  const { consignment, row, draft } = context;
  const items = itemRows(row);
  const bagNumbers = context.bagNumbers.length ? context.bagNumbers : uniqueBagNumbers(consignment);
  const bagList = bagNumbers.join("|");
  const hawb = ediText(row.consignmentNumber);
  const partyConsignor = row.consignor.party;
  const partyConsignee = row.consignee.party;
  const shipmentWeight = consignment.parcels.reduce((total, parcel) => total + Number(parcel.weightKg || 0), 0);
  const repeatedHawb = Array.from({ length: Math.max(consignment.parcels.length, 1) }, () => hawb).join("|");

  return [
    hawb,
    Math.max(consignment.parcels.length, 1),
    shipmentWeight,
    "1305023269",
    "FOB",
    bagList,
    "Y",
    "N",
    "0292087-5000008",
    repeatedHawb,
    bagList,
    ediText(partyConsignor?.companyName || partyConsignor?.contactName),
    ediText(partyConsignor?.addressLine1),
    ediText(partyConsignor?.addressLine2),
    ediText(partyConsignor?.state),
    ediText(partyConsignor?.city),
    ediText(partyConsignor?.postcode),
    ediText(partyConsignor?.countryName || partyConsignor?.countryCode),
    ediText(partyConsignee?.companyName || partyConsignee?.contactName),
    ediText(partyConsignee?.addressLine1),
    ediText(partyConsignee?.addressLine2),
    ediText(partyConsignee?.state),
    ediText(partyConsignee?.city),
    ediText(partyConsignee?.postcode),
    ediText(partyConsignee?.countryName || partyConsignee?.countryCode),
    ediText(draft.csbVInvoiceNumber),
    ediDate(context.departureDate),
    itemValues(items, (item) => ediText(item.hsnCode)),
    itemValues(items, (item) => ediText(item.description)),
    itemValues(items, (item) => Number(item.quantity ?? 0)),
    itemValues(items, (item) => ediText(item.unitType)),
    itemValues(items, (item) => Number(item.unitRate ?? 0)),
    itemValues(items, itemTotal),
    repeatedItemValue("INR", items.length),
    itemValues(items, itemTotal),
    repeatedItemValue("INR", items.length),
    repeatedItemValue("0.00", items.length),
    repeatedItemValue("0.00", items.length),
    "Y",
    "GSTIN (Normal)",
    ediText(draft.csbVGstin),
    ediText(draft.consigneeEnteredAddress?.stateCode),
    ediText(draft.csbVAccountNumber),
    "P",
    "N"
  ];
}

export function buildCsbVEdiRows(
  consignments: ManifestDocumentConsignment[],
  drafts: Map<string, CsbVEdiDraftContext>,
  departureDate: string,
) {
  return consignments.flatMap((consignment) => {
    const draft = drafts.get(consignment.shipmentDraftId) ?? {};
    const bagNumbers = uniqueBagNumbers(consignment);
    return consignment.parcels.map((row) => buildCsbVEdiRow({ consignment, row, draft, bagNumbers, departureDate }));
  });
}
