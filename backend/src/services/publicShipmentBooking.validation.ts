import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { isValidAadhaarNumber, normalizeAadhaarNumber } from "./aadhaarValidation.service.js";
import { findRestrictedCategories } from "./restrictedGoods.service.js";
import { parcelItemUnitTypeValues } from "./parcelItems.service.js";
import { shipmentContentTypeValues } from "../models/shipmentDraft.model.js";

const cleanText = (max: number) => z.string().trim().max(max);
const requiredText = (label: string, max = 120) => cleanText(max).min(1, `${label} is required.`);

const addressSchema = z.object({
  entityType: z.enum(["INDIVIDUAL", "COMPANY"]),
  companyName: cleanText(160).default(""),
  contactName: requiredText("Contact name", 160),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(320),
  mobileCountryCode: z.string().trim().regex(/^\+[1-9]\d{0,3}$/, "Enter a valid country calling code."),
  mobileNumber: z.string().trim().regex(/^\d{6,14}$/, "Enter a valid mobile number."),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Select a destination country."),
  countryName: requiredText("Country", 80),
  postcode: requiredText("Postal code", 20).transform((value) => value.toUpperCase()),
  addressLine1: requiredText("Address line 1", 160),
  addressLine2: cleanText(160).default(""),
  townOrCity: requiredText("Town or city", 100),
  county: cleanText(100).default(""),
  deliveryInstructions: cleanText(300).default(""),
}).superRefine((value, context) => {
  if (value.entityType === "COMPANY" && !value.companyName) {
    context.addIssue({ code: "custom", path: ["companyName"], message: "Company name is required for a company booking." });
  }
  if (!parsePhoneNumberFromString(`${value.mobileCountryCode}${value.mobileNumber}`)?.isValid()) {
    context.addIssue({ code: "custom", path: ["mobileNumber"], message: "Enter a valid mobile number for the selected country code." });
  }
  if (value.countryCode === "IN" && !/^[1-9]\d{5}$/.test(value.postcode)) {
    context.addIssue({ code: "custom", path: ["postcode"], message: "Enter a valid 6 digit PIN code." });
  }
});

const senderSchema = addressSchema.safeExtend({
  countryCode: z.literal("IN"),
  countryName: z.literal("India"),
  mobileCountryCode: z.literal("+91"),
  aadhaarNumber: z.string().transform(normalizeAadhaarNumber).refine(isValidAadhaarNumber, "Enter a valid 12 digit Aadhaar number."),
});

const itemSchema = z.object({
  description: requiredText("Description", 120).superRefine((value, context) => {
    const matches = findRestrictedCategories(value);
    if (matches.length) context.addIssue({ code: "custom", message: `${matches.join(", ")} cannot be shipped.` });
  }),
  hsnCode: z.string().trim().regex(/^$|^\d{4}(?:\d{2}(?:\d{2}(?:\d{2})?)?)?$/, "Use a 4, 6, 8 or 10 digit HS code."),
  unitType: z.enum(parcelItemUnitTypeValues),
  quantity: z.number().positive("Quantity must be greater than zero.").max(100000),
  unitRate: z.number().positive("Unit value must be greater than zero.").max(100000000),
});

const parcelSchema = z.object({
  weightKg: z.number().positive("Weight must be greater than zero.").max(1000),
  lengthCm: z.number().positive("Length must be greater than zero.").max(1000),
  widthCm: z.number().positive("Width must be greater than zero.").max(1000),
  heightCm: z.number().positive("Height must be greater than zero.").max(1000),
  shipmentContentType: z.enum(shipmentContentTypeValues),
  shipmentReference1: requiredText("Shipment reference", 120).transform((value) => value.toUpperCase()),
  shipmentReference2: cleanText(120).default("").transform((value) => value.toUpperCase()),
  items: z.array(itemSchema).min(1, "Add at least one item.").max(20),
});

export const publicShipmentDraftPayloadSchema = z.object({
  sender: senderSchema,
  consignee: addressSchema,
  serviceType: z.enum(["COURIER", "CARGO"]),
  csbType: z.enum(["CSB_IV", "CSB_V"]),
  kycUseForAllParcels: z.boolean().default(true),
  parcels: z.array(parcelSchema).min(1, "Add at least one parcel.").max(10, "A booking can contain up to 10 parcels."),
}).superRefine((value, context) => {
  if (value.consignee.countryCode === "IN") {
    context.addIssue({
      code: "custom",
      path: ["consignee", "countryCode"],
      message: "Public online booking currently supports international destinations only.",
    });
  }
  if (value.csbType === "CSB_V") {
    value.parcels.forEach((parcel, parcelIndex) => parcel.items.forEach((item, itemIndex) => {
      if (!item.hsnCode) context.addIssue({
        code: "custom",
        path: ["parcels", parcelIndex, "items", itemIndex, "hsnCode"],
        message: "HS code is required for CSB-V.",
      });
    }));
  }
  const comparable = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const comparablePhone = (code: string, number: string) => `${code}${number}`.replace(/\D/g, "").replace(/^0+/, "").slice(-10);
  if (comparable(value.sender.contactName) === comparable(value.consignee.contactName)) {
    context.addIssue({ code: "custom", path: ["consignee", "contactName"], message: "Sender and receiver contact names must be different." });
  }
  if (comparable(value.sender.email) === comparable(value.consignee.email)) {
    context.addIssue({ code: "custom", path: ["consignee", "email"], message: "Sender and receiver email addresses must be different." });
  }
  if (comparablePhone(value.sender.mobileCountryCode, value.sender.mobileNumber) === comparablePhone(value.consignee.mobileCountryCode, value.consignee.mobileNumber)) {
    context.addIssue({ code: "custom", path: ["consignee", "mobileNumber"], message: "Sender and receiver mobile numbers must be different." });
  }
});

export const publicShipmentQuoteAcceptanceSchema = z.object({
  acceptedTerms: z.literal(true),
  acceptedCancellationPolicy: z.literal(true),
  acceptedProhibitedGoods: z.literal(true),
  recaptchaToken: z.string().trim().max(4096).optional(),
});

export type PublicShipmentDraftPayload = z.infer<typeof publicShipmentDraftPayloadSchema>;
