import type {
  IShipmentDraft,
  ShipmentAddressSnapshot,
  ShipmentParcel
} from "../../models/shipmentDraft.model.js";
import { normalizeCsbType } from "../csbType.service.js";
import {
  composeShipmentDescription,
  getDeclaredGoodsValue,
  getParcelItemAmount,
  getShipmentDescriptionLimitMessage,
  normalizeParcelItems
} from "../parcelItems.service.js";

/**
 * Destinations a DPD label is requested for.
 *
 * The country selector stores the ISO code "GB"; "UK" is accepted alongside it
 * because imported and hand-keyed addresses use the two interchangeably. Crown
 * dependencies (IM, JE, GG) are deliberately absent - they are separate ISO
 * codes and have not been confirmed against this account.
 */
const dpdLabelCountryCodes = new Set(["GB", "UK"]);

export function isDpdLabelDestination(countryCode: string | undefined | null) {
  return dpdLabelCountryCodes.has((countryCode ?? "").trim().toUpperCase());
}

export interface AlsDocketItem {
  actual_weight: string;
  length: string;
  width: string;
  height: string;
  number_of_boxes: "1";
}

export interface AlsFreeFormLineItem {
  total: string;
  no_of_packages: string;
  box_no: string;
  rate: string;
  hscode: string;
  description: string;
  unit_of_measurement: string;
  unit_weight: string;
  igst_amount: "0.00";
}

/**
 * The create_docket request body.
 *
 * Shaped from a booking ALS actually accepted rather than from the published
 * spec, which is wrong in several places - the literal fields below carry the
 * corrections inline.
 */
export interface AlsCreateDocketPayload {
  tracking_no: string;
  customer_id: number;
  origin_code: "IN";
  destination_code: string;
  product_code: "NONDOX";
  booking_date: string;
  booking_time: string;
  pcs: string;
  shipment_value: string;
  shipment_value_currency: "GBP";
  actual_weight: string;
  shipment_invoice_no: string;
  shipment_invoice_date: string;
  shipment_content: string;
  remark: string;
  entry_type: 2;
  api_service_code: string;
  new_docket_free_form_invoice: "1";
  free_form_invoice_type_id: "1";
  free_form_currency: "GBP";
  terms_of_trade: "CFR";
  free_form_note_master_code: 0;
  shipper_name: string;
  shipper_company_name: string;
  shipper_contact_no: string;
  shipper_email: string;
  shipper_address_line_1: string;
  shipper_address_line_2: string;
  shipper_address_line_3: string;
  shipper_city: string;
  shipper_state: string;
  shipper_country: "IN";
  shipper_zip_code: string;
  shipper_gstin_type: string;
  shipper_gstin_no: string;
  consignee_name: string;
  consignee_company_name: string;
  consignee_contact_no: string;
  consignee_email: string;
  consignee_address_line_1: string;
  consignee_address_line_2: string;
  consignee_address_line_3: string;
  consignee_city: string;
  consignee_state: string;
  consignee_country: string;
  consignee_zip_code: string;
  consignee_gstin_type: string;
  consignee_gstin_no: string;
  docket_items: AlsDocketItem[];
  free_form_line_items: AlsFreeFormLineItem[];
}

/**
 * A shipment that cannot be expressed as a DPD booking.
 *
 * Raised before any request leaves the portal, so an incomplete shipment costs
 * nothing and is reported as a correction rather than a carrier failure.
 */
export class AlsPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlsPayloadError";
  }
}

function required(value: string | undefined, label: string) {
  const normalized = (value ?? "").trim();
  if (!normalized) throw new AlsPayloadError(`${label} is required for the DPD label.`);
  return normalized;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function digitsOnly(...parts: Array<string | undefined>) {
  return parts.map((part) => part ?? "").join("").replace(/\D/g, "");
}

function decimal(value: number) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * The unit ALS accepts on a customs invoice line.
 *
 * ALS validates this against its own list and reports an unrecognised value as
 * a missing one ("SHIPMENT INVOICE UNIT TYPE are mandatory field"), which is
 * what the portal's own vocabulary - Pkt, Pcs, Set, Box, Kg, Pair - was
 * rejected for. "Pc" is the only value the ALS documentation shows being
 * accepted, so every line is declared in pieces.
 *
 * The portal keeps the real unit on the parcel item, and the customs line still
 * carries the description, quantity and unit weight, so nothing is lost from the
 * declaration itself. Ask ITD for their unit code list to map these properly.
 */
const alsUnitOfMeasurement = "Pc";

function indiaDateParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}:${part("second")}`
  };
}

/**
 * The customs declaration ALS calls a "shipment invoice".
 *
 * Mandatory: sending `new_docket_free_form_invoice: "0"` is rejected with
 * "SHIPMENT INVOICE are mandatory". This is the goods declaration, not the
 * Swiftline GST invoice, which is issued separately and stays in INR.
 */
function freeFormLineItems(
  parcels: ShipmentParcel[],
  inrPerGbp: number,
  requireHsnCode: boolean
): AlsFreeFormLineItem[] {
  return parcels.flatMap((parcel, parcelIndex) => {
    const items = normalizeParcelItems(parcel);
    if (!items.length) {
      throw new AlsPayloadError(`Parcel ${parcelIndex + 1} needs at least one goods item for the DPD label.`);
    }

    const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isFinite(totalUnits) || totalUnits <= 0) {
      throw new AlsPayloadError(`Parcel ${parcelIndex + 1} item quantities must be greater than zero for the DPD label.`);
    }
    const unitWeight = parcel.weightKg / totalUnits;

    return items.map((item, itemIndex) => {
      const itemLabel = `Parcel ${parcelIndex + 1} item ${itemIndex + 1}`;
      if (!item.description.trim()) throw new AlsPayloadError(`${itemLabel} needs a description for the DPD label.`);
      // CSB-IV does not require an HS code, so the line goes out with an empty
      // one rather than being blocked here: the declaration carries what the
      // sender declared and nothing invented on their behalf. CSB-V clears on the
      // full customs checklist and is still refused without a code.
      if (requireHsnCode && !item.hsnCode.trim()) {
        throw new AlsPayloadError(`${itemLabel} needs an HS code for the DPD label.`);
      }
      if (!item.unitType.trim()) throw new AlsPayloadError(`${itemLabel} needs a unit type for the DPD label.`);

      return {
        total: decimal(getParcelItemAmount(item) / inrPerGbp),
        no_of_packages: String(item.quantity),
        box_no: String(parcel.sequence || parcelIndex + 1),
        rate: decimal(item.unitRate / inrPerGbp),
        hscode: item.hsnCode,
        description: truncate(item.description, 120),
        unit_of_measurement: alsUnitOfMeasurement,
        unit_weight: decimal(unitWeight),
        igst_amount: "0.00" as const
      };
    });
  });
}

function consigneeAddress(draft: IShipmentDraft): ShipmentAddressSnapshot {
  return draft.consigneeValidatedAddress ?? draft.consigneeEnteredAddress;
}

type AlsShipperFields = Pick<
  AlsCreateDocketPayload,
  | "shipper_name"
  | "shipper_company_name"
  | "shipper_contact_no"
  | "shipper_email"
  | "shipper_address_line_1"
  | "shipper_address_line_2"
  | "shipper_address_line_3"
  | "shipper_city"
  | "shipper_state"
  | "shipper_country"
  | "shipper_zip_code"
  | "shipper_gstin_type"
  | "shipper_gstin_no"
>;

/**
 * The shipper Swiftline is recorded as on every ALS booking.
 *
 * ALS keeps a consignor on the portal account, and create_docket overwrites it
 * with whatever the request carries: one booking sent with a customer's own
 * consignor replaced the account's details with theirs. Sending the same block
 * every time keeps the carrier's record stable no matter who is shipping.
 *
 * This is the only place the shipper is decided. The customer's real consignor
 * is untouched everywhere else - the Swiftline label, EDI export, manifests, the
 * customs invoice and the GST invoice all read `draft.consignorAddress`.
 */
const swiftlineShipper: AlsShipperFields = {
  shipper_name: "Ravi Yadav",
  shipper_company_name: "Swiftline Cargo & Express Logistics Pvt Ltd",
  shipper_contact_no: "7027116600",
  shipper_email: "info@swiftlincargo.co.uk",
  shipper_address_line_1: "Second Floor, Krishna Complex",
  shipper_address_line_2: "Sector-10, Near 33 KVS Station",
  shipper_address_line_3: "Uttam Nagar, Rewari, Haryana 123401",
  shipper_city: "Rewari",
  shipper_state: "Haryana",
  shipper_country: "IN",
  shipper_zip_code: "123401",
  // Swiftline files no tax identity with ALS. A live booking was accepted with
  // both empty, and keeping them empty is what stops a customer's Aadhaar number
  // reaching the carrier as somebody else's tax id.
  shipper_gstin_type: "",
  shipper_gstin_no: ""
};

function consigneeFields(consignee: ShipmentAddressSnapshot) {
  const contactName = required(consignee.contactName || consignee.companyName, "Consignee name");
  const companyName = required(consignee.companyName || consignee.contactName, "Consignee company name");
  const city = required(consignee.townOrCity, "Consignee city");

  return {
    consignee_name: truncate(contactName, 120),
    consignee_company_name: truncate(companyName, 120),
    consignee_contact_no: required(
      digitsOnly(consignee.mobileCountryCode, consignee.mobileNumber),
      "Consignee phone number"
    ),
    consignee_email: truncate(required(consignee.email, "Consignee email"), 160),
    consignee_address_line_1: truncate(required(consignee.addressLine1, "Consignee address line 1"), 120),
    consignee_address_line_2: truncate(consignee.addressLine2 || city, 120),
    consignee_address_line_3: "",
    consignee_city: truncate(city, 80),
    consignee_state: truncate(consignee.county || city, 80),
    consignee_country: required(consignee.countryCode, "Consignee country code").toUpperCase(),
    consignee_zip_code: truncate(required(consignee.postcode, "Consignee postcode"), 20),
    consignee_gstin_type: "",
    consignee_gstin_no: ""
  };
}

export function buildAlsCreateDocketPayload(input: {
  draft: IShipmentDraft;
  serviceCode: string;
  inrPerGbp: number;
  customerId: number;
  trackingNumber: string;
  bookedAt: Date;
}): AlsCreateDocketPayload {
  const { draft, serviceCode, inrPerGbp, customerId, trackingNumber, bookedAt } = input;

  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new AlsPayloadError("ALS authentication did not return a valid customer ID.");
  }
  if (!Number.isFinite(inrPerGbp) || inrPerGbp <= 0) {
    throw new AlsPayloadError("ALS_INR_PER_GBP must be configured before a DPD label can be created.");
  }

  const declaredGoodsValueInr = getDeclaredGoodsValue(draft.parcelList);
  if (declaredGoodsValueInr <= 0) {
    throw new AlsPayloadError("Declared goods value must be greater than zero for the DPD label.");
  }

  const consignee = consigneeAddress(draft);
  const booking = indiaDateParts(bookedAt);
  const totalWeight = draft.parcelList.reduce((sum, parcel) => sum + parcel.weightKg, 0);
  const shipmentContent = composeShipmentDescription(draft.parcelList);
  const descriptionLimitMessage = getShipmentDescriptionLimitMessage(draft.parcelList);
  if (descriptionLimitMessage) throw new AlsPayloadError(descriptionLimitMessage);

  return {
    tracking_no: required(trackingNumber, "Swiftline tracking number"),
    customer_id: customerId,
    origin_code: "IN",
    destination_code: required(consignee.countryCode, "Destination country").toUpperCase(),
    product_code: "NONDOX",
    booking_date: booking.date,
    booking_time: booking.time,
    pcs: String(draft.parcelList.length),
    shipment_value: decimal(Math.max(0.01, declaredGoodsValueInr / inrPerGbp)),
    shipment_value_currency: "GBP",
    actual_weight: decimal(totalWeight),
    // ALS wants an invoice reference even though Swiftline issues its own INR
    // invoice after booking. The AWB is unique and avoids coupling the carrier
    // request to a document that does not exist yet.
    shipment_invoice_no: truncate(required(trackingNumber, "Shipment invoice reference"), 80),
    shipment_invoice_date: booking.date,
    // ALS accepts the full shipment-level description above the old 120
    // character per-parcel summary. Keep every item in normal order and rely
    // on the booking-wide 240-character validation rather than silently
    // dropping the tail of the declaration.
    shipment_content: required(shipmentContent, "Shipment contents"),
    remark: truncate(consignee.deliveryInstructions || "", 250),
    entry_type: 2,
    api_service_code: serviceCode,
    // Required. "0" is rejected with "SHIPMENT INVOICE are mandatory", and
    // free_form_invoice_type_id appears only in the spec's examples, never in
    // its field table.
    new_docket_free_form_invoice: "1",
    free_form_invoice_type_id: "1",
    free_form_currency: "GBP",
    // The spec says FOB; the booking that succeeded used CFR.
    terms_of_trade: "CFR",
    free_form_note_master_code: 0,
    ...swiftlineShipper,
    ...consigneeFields(consignee),
    docket_items: draft.parcelList.map((parcel, index) => {
      if (!parcel.lengthCm || !parcel.widthCm || !parcel.heightCm) {
        throw new AlsPayloadError(`Parcel ${index + 1} needs length, width and height for the DPD label.`);
      }

      return {
        actual_weight: decimal(parcel.weightKg),
        length: decimal(parcel.lengthCm),
        width: decimal(parcel.widthCm),
        height: decimal(parcel.heightCm),
        number_of_boxes: "1" as const
      };
    }),
    free_form_line_items: freeFormLineItems(
      draft.parcelList,
      inrPerGbp,
      normalizeCsbType(draft.csbType) === "CSB_V"
    )
  };
}

/** Contact details and tax identifiers are kept out of the stored snapshot. */
export function sanitizeAlsRequestSnapshot(payload: AlsCreateDocketPayload): Record<string, unknown> {
  return {
    ...payload,
    shipper_contact_no: payload.shipper_contact_no ? "[redacted-phone]" : "",
    shipper_email: payload.shipper_email ? "[redacted-email]" : "",
    shipper_gstin_no: payload.shipper_gstin_no ? "[redacted-id]" : "",
    consignee_contact_no: payload.consignee_contact_no ? "[redacted-phone]" : "",
    consignee_email: payload.consignee_email ? "[redacted-email]" : ""
  };
}
