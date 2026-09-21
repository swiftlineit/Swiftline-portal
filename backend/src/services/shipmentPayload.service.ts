import type { IShipmentDraft, ShipmentAddressSnapshot } from "../models/shipmentDraft.model.js";
import { maxParcelsPerShipment } from "./parcelItems.service.js";
import { carrierShipmentSourceIdentity } from "./shipmentSourceIdentity.service.js";

/**
 * The service every Swiftline shipment is booked under.
 *
 * Held as one constant because it is the only service offered and it has to
 * agree in three places: the booking record, the booking snapshot that feeds
 * invoices and manifests, and the printed label.
 */
export const SWIFTLINE_SERVICE_CODE = "EXPRESS WORLDWIDE";

const supportedShipmentContentTypes = new Set([
  "DOCUMENTS", "PARCEL", "MERCHANDISE", "SAMPLES", "GIFTS", "RETURNS", "OTHER"
]);
const ukPostcodePattern = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/;

export interface ShipmentPayload {
  serviceCode: string;
  references: {
    invoiceNumber: string;
    shipmentReference?: string;
    reference1?: string;
    reference2?: string;
  };
  consignee: {
    companyName?: string;
    contactName: string;
    email?: string;
    phone: string;
    countryCode: string;
    postcode: string;
    addressLine1: string;
    addressLine2?: string;
    townOrCity: string;
    county?: string;
    deliveryInstructions?: string;
  };
  parcels: Array<{
    sequence: number;
    weightKg: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    shipmentContentType: string;
    contentsDescription: string;
  }>;
}

function getConsigneeAddress(draft: IShipmentDraft): ShipmentAddressSnapshot {
  return draft.consigneeValidatedAddress ?? draft.consigneeEnteredAddress;
}

/**
 * The normalized view of a draft that booking validates and snapshots.
 *
 * Built from the validated consignee address when one exists, so a booking
 * records the address that was actually checked rather than what was typed.
 */
export function buildShipmentPayload(draft: IShipmentDraft): ShipmentPayload {
  const address = getConsigneeAddress(draft);
  const firstParcel = draft.parcelList[0];
  const customerReference = firstParcel?.shipmentReference1?.trim() || undefined;
  const sourceIdentity = carrierShipmentSourceIdentity(draft);

  return {
    serviceCode: SWIFTLINE_SERVICE_CODE,
    references: {
      invoiceNumber: sourceIdentity.invoiceNumber,
      shipmentReference: sourceIdentity.shipmentReference,
      reference1: customerReference,
      reference2: undefined
    },
    consignee: {
      companyName: address.companyName || undefined,
      contactName: address.contactName ?? "",
      email: address.email || undefined,
      phone: `${address.mobileCountryCode ?? ""}${address.mobileNumber ?? ""}`,
      countryCode: address.countryCode.trim().toUpperCase(),
      postcode: address.postcode,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 || undefined,
      townOrCity: address.townOrCity,
      county: address.county || undefined,
      deliveryInstructions: address.deliveryInstructions || undefined
    },
    parcels: draft.parcelList.map((parcel, index) => ({
      sequence: parcel.sequence ?? index + 1,
      weightKg: parcel.weightKg,
      lengthCm: parcel.lengthCm,
      widthCm: parcel.widthCm,
      heightCm: parcel.heightCm,
      shipmentContentType: parcel.shipmentContentType,
      contentsDescription: parcel.contentsDescription
    }))
  };
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function checkMaxLength(value: string | undefined, maxLength: number, label: string, issues: string[]) {
  if (value && value.length > maxLength) {
    issues.push(`${label} must be ${maxLength} characters or fewer`);
  }
}

/**
 * Everything a shipment needs before it can be booked and labelled.
 *
 * The field limits are the ones the printed label and the customs paperwork can
 * actually carry, so an over-long value is rejected at booking rather than
 * silently truncated on the document.
 */
export function validateShipmentPayload(payload: ShipmentPayload): string[] {
  const issues: string[] = [];

  if (!hasText(payload.references.invoiceNumber)) issues.push("Invoice number is required");
  if (!hasText(payload.references.shipmentReference)) issues.push("Shipment reference is required");

  checkMaxLength(payload.references.invoiceNumber, 80, "Invoice number", issues);
  checkMaxLength(payload.references.shipmentReference, 120, "Shipment reference", issues);
  checkMaxLength(payload.references.reference1, 120, "Shipment reference 1", issues);
  checkMaxLength(payload.references.reference2, 120, "Shipment reference 2", issues);

  if (!hasText(payload.consignee.contactName)) issues.push("Consignee contact name is required");
  if (!hasText(payload.consignee.phone)) issues.push("Consignee mobile number is required");
  if (!/^[A-Z]{2}$/.test(payload.consignee.countryCode)) issues.push("Consignee country code must be a two-letter ISO code");
  if (!hasText(payload.consignee.postcode)) issues.push("Consignee postcode is required");
  if (
    payload.consignee.countryCode === "GB"
    && hasText(payload.consignee.postcode)
    && !ukPostcodePattern.test(payload.consignee.postcode.toUpperCase())
  ) {
    issues.push("Consignee postcode must be a valid UK postcode");
  }
  if (!hasText(payload.consignee.addressLine1)) issues.push("Consignee address line 1 is required");
  if (!hasText(payload.consignee.townOrCity)) issues.push("Consignee town or city is required");

  checkMaxLength(payload.consignee.companyName, 120, "Consignee company name", issues);
  checkMaxLength(payload.consignee.contactName, 120, "Consignee contact name", issues);
  checkMaxLength(payload.consignee.email, 160, "Consignee email", issues);
  checkMaxLength(payload.consignee.phone, 30, "Consignee mobile number", issues);
  checkMaxLength(payload.consignee.addressLine1, 120, "Consignee address line 1", issues);
  checkMaxLength(payload.consignee.addressLine2, 120, "Consignee address line 2", issues);
  checkMaxLength(payload.consignee.townOrCity, 80, "Consignee town or city", issues);
  checkMaxLength(payload.consignee.county, 80, "Consignee county", issues);
  checkMaxLength(payload.consignee.deliveryInstructions, 500, "Delivery instructions", issues);

  if (!payload.parcels.length) {
    issues.push("At least one parcel is required");
  }

  if (payload.parcels.length > maxParcelsPerShipment) {
    issues.push(`Number of Parcels (PCS) must be ${maxParcelsPerShipment} or fewer`);
  }

  payload.parcels.forEach((parcel, index) => {
    const label = `Parcel ${index + 1}`;

    if (parcel.sequence !== index + 1) {
      issues.push(`${label}: sequence must be ${index + 1}`);
    }

    if (!Number.isFinite(parcel.weightKg) || parcel.weightKg <= 0) {
      issues.push(`${label}: weight must be greater than zero`);
    }

    for (const [field, value] of [
      ["length", parcel.lengthCm],
      ["width", parcel.widthCm],
      ["height", parcel.heightCm]
    ] as const) {
      if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) {
        issues.push(`${label}: ${field} must be greater than zero`);
      }
    }

    if (!hasText(parcel.contentsDescription)) issues.push(`${label}: contents description is required`);
    checkMaxLength(parcel.contentsDescription, 120, `${label}: contents description`, issues);
    if (!supportedShipmentContentTypes.has(parcel.shipmentContentType)) {
      issues.push(`${label}: shipment content type is required`);
    }
  });

  return issues;
}

/** Contact details are kept out of the stored request snapshot. */
export function sanitizeShipmentRequestSnapshot(payload: ShipmentPayload): Record<string, unknown> {
  return {
    ...payload,
    consignee: {
      ...payload.consignee,
      email: payload.consignee.email ? "[redacted-email]" : undefined,
      phone: payload.consignee.phone ? "[redacted-phone]" : undefined
    }
  };
}
