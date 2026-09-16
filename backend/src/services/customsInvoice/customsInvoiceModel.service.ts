// The customs ("shipment") invoice: the goods declaration that travels with an
// export shipment. It is a DIFFERENT document from the GST tax invoice built by
// shipmentInvoice.service.ts- that one bills freight and 18% GST to the customer,
// this one declares what is inside the boxes and what the goods are worth.
//
// It is not stored: the model is derived from the shipment draft every time it is
// rendered, so an amendment automatically produces an up-to-date document with no
// revision history and no version header (unlike the tax invoice).

import {
  getDeclaredGoodsValue,
  getParcelItemAmount,
  normalizeParcelItems,
  roundMoney
} from "../parcelItems.service.js";
import { defaultDeclarationNote } from "./customsInvoiceConstants.js";
import { formatCsbType } from "../csbType.service.js";

export { defaultDeclarationNote };

export type CustomsInvoiceParty = {
  name: string;
  companyName: string;
  // `address` is the joined single-line form the printed invoice shows; the
  // discrete parts below feed the import sheet so an upload can refill the form.
  address: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  state: string;
  countryName: string;
  postcode: string;
  email: string;
  mobileNumber: string;
  phone: string;
};

export type CustomsInvoiceItem = {
  serialNumber: number;
  description: string;
  hsCode: string;
  unitType: string;
  quantity: number;
  unitRate: number;
  amount: number;
};

export type CustomsInvoiceBox = {
  boxNumber: number;
  /** House airway bill (Swiftline parcel number). Empty when the shipment is not booked yet. */
  parcelNumber: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  actualWeightKg: number;
  items: CustomsInvoiceItem[];
};

export type CustomsInvoiceModel = {
  invoiceNumber: string;
  invoiceDate: Date;
  otherReference: string;
  aadhaarNumber: string;
  shipper: CustomsInvoiceParty;
  consignee: CustomsInvoiceParty;
  countryOfOrigin: string;
  destination: string;
  note: string;
  // Carried for the import sheet rather than the printed invoice: re-uploading
  // the workbook restores the customs route and service the shipment was set to.
  shipmentType: string;
  serviceType: string;
  boxes: CustomsInvoiceBox[];
  currency: string;
  totalAmount: number;
  totalAmountInWords: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Joins the address lines the sample prints as a single block. */
function joinAddress(parts: Array<unknown>): string {
  return parts.map(text).filter(Boolean).join(", ");
}

const onesWords = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen"
];
const tensWords = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(value: number): string {
  if (value < 20) return onesWords[value] ?? "";
  const tens = tensWords[Math.floor(value / 10)] ?? "";
  const ones = onesWords[value % 10] ?? "";
  return [tens, ones].filter(Boolean).join(" ");
}

/**
 * Indian numbering (crore / lakh / thousand), matching the sample's
 * "Nine Thousand One Hundred And Ninety Rupees Only".
 */
export function amountToWords(amount: number, currencyLabel = "Rupees"): string {
  const whole = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - whole) * 100);
  if (whole === 0 && paise === 0) return `Zero ${currencyLabel} Only`;

  const segments: string[] = [];
  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const hundred = Math.floor((whole % 1000) / 100);
  const rest = whole % 100;

  if (crore) segments.push(`${twoDigitWords(crore)} Crore`);
  if (lakh) segments.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) segments.push(`${twoDigitWords(thousand)} Thousand`);
  if (hundred) segments.push(`${onesWords[hundred]} Hundred`);
  // "And" only joins the trailing two-digit part, as on the sample invoice.
  if (rest) segments.push(`${segments.length ? "And " : ""}${twoDigitWords(rest)}`);

  const words = `${segments.join(" ")} ${currencyLabel}`;
  return paise
    ? `${words} And ${twoDigitWords(paise)} Paise Only`
    : `${words} Only`;
}

type DraftLike = {
  consignorAddress?: Record<string, unknown> | null;
  consigneeEnteredAddress?: Record<string, unknown> | null;
  consigneeValidatedAddress?: Record<string, unknown> | null;
  csbType?: unknown;
  serviceType?: unknown;
  parcelList: Array<Record<string, unknown>>;
  kycUseForAllParcels?: boolean;
  declarationNote?: unknown;
};

function partyFrom(source: Record<string, unknown> | null | undefined, fallbackCountry = ""): CustomsInvoiceParty {
  const record = source ?? {};
  return {
    name: text(record.contactName) || text(record.companyName),
    companyName: text(record.companyName) || text(record.contactName),
    address: joinAddress([record.addressLine1, record.addressLine2, record.townOrCity, record.county]),
    addressLine1: text(record.addressLine1),
    addressLine2: text(record.addressLine2),
    townOrCity: text(record.townOrCity),
    state: text(record.county),
    countryName: text(record.countryName) || text(record.countryCode) || fallbackCountry,
    postcode: text(record.postcode),
    email: text(record.email),
    mobileNumber: text(record.mobileNumber),
    phone: [text(record.mobileCountryCode), text(record.mobileNumber)].filter(Boolean).join(" ")
  };
}

/**
 * Builds the invoice model from a shipment draft.
 *
 * Every content item becomes its own row, grouped under its box header, exactly
 * as the sample lays it out. The total is the declared goods value only- freight,
 * GST and the CSB-V clearance charge belong to the tax invoice, not here.
 */
export function buildCustomsInvoiceModel(input: {
  draft: DraftLike;
  invoiceNumber: string;
  invoiceDate?: Date;
  currency?: string;
  /** Swiftline parcel numbers in parcel order, from the carrier booking when booked. */
  parcelNumbers?: string[];
}): CustomsInvoiceModel {
  const draft = input.draft;
  // The validated consignee address is preferred when one exists, so the invoice
  // shows the address the shipment is actually going to.
  const consigneeSource = draft.consigneeValidatedAddress ?? draft.consigneeEnteredAddress;

  const boxes: CustomsInvoiceBox[] = draft.parcelList.map((parcel, index) => {
    const items = normalizeParcelItems(parcel as never).map((item, itemIndex) => ({
      serialNumber: itemIndex + 1,
      description: item.description.toUpperCase(),
      hsCode: item.hsnCode,
      unitType: item.unitType,
      quantity: item.quantity,
      unitRate: item.unitRate,
      amount: getParcelItemAmount(item)
    }));

    return {
      boxNumber: Number(parcel.sequence) || index + 1,
      parcelNumber: text(input.parcelNumbers?.[index]),
      lengthCm: numberOrNull(parcel.lengthCm),
      widthCm: numberOrNull(parcel.widthCm),
      heightCm: numberOrNull(parcel.heightCm),
      actualWeightKg: Number(parcel.weightKg) || 0,
      items
    };
  });

  // The Aadhaar shown as OTHER REFERENCE comes from the shipment's KYC: the
  // shared consignor number, or the first parcel's when KYC is per parcel.
  const aadhaarNumber = draft.kycUseForAllParcels === false
    ? text(draft.parcelList[0]?.aadhaarNumber)
    : text(draft.consignorAddress?.aadhaarNumber);

  // The customer's own reference, captured on the shipment form.
  const otherReference = text(draft.parcelList[0]?.shipmentReference1);
  const currency = input.currency ?? "INR";
  const totalAmount = roundMoney(getDeclaredGoodsValue(draft.parcelList as never));

  return {
    invoiceNumber: input.invoiceNumber,
    invoiceDate: input.invoiceDate ?? new Date(),
    otherReference,
    aadhaarNumber,
    shipper: partyFrom(draft.consignorAddress, "INDIA"),
    consignee: partyFrom(consigneeSource),
    countryOfOrigin: "INDIA",
    destination: text(consigneeSource?.countryCode) || text(consigneeSource?.countryName),
    // Empty unless staff entered one; the NOTE row simply prints blank.
    note: text(draft.declarationNote),
    shipmentType: formatCsbType(draft.csbType),
    serviceType: draft.serviceType === "CARGO" ? "Cargo" : "Courier",
    boxes,
    currency,
    totalAmount,
    totalAmountInWords: amountToWords(totalAmount, currency === "INR" ? "Rupees" : currency)
  };
}
