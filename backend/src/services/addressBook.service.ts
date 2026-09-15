import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import type { AddressBookPostalAddress, IAddressBookEntry } from "../models/addressBookEntry.model.js";
import { isValidAadhaarNumber, normalizeAadhaarNumber } from "./aadhaarValidation.service.js";
import { mapGoogleComponentsToGenericAddress } from "./addressMapping.service.js";
import { isDialCodeForCountry } from "./phoneCountry.service.js";
import { autocompletePlaces, getPlaceDetails } from "./googlePlaces.service.js";
import { validateUkAddressWithPaf } from "./idealPostcodes.service.js";
import { getCountryCodeByName, getPortalCountryNames } from "./reference/portalCountries.js";

const portalCountryNames = getPortalCountryNames();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ukPostcodePattern = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/;

export const addressBookInputSchema = z.object({
  type: z.enum(["SENDER", "RECIPIENT"]),
  label: z.string().trim().min(1, "Address label is required").max(80),
  isFavourite: z.boolean().optional().default(false),
  companyName: z.string().trim().toUpperCase().max(120).optional().default(""),
  contactName: z.string().trim().toUpperCase().min(1, "Contact name is required").max(120),
  email: z.string().trim().toLowerCase().min(1, "Email is required").max(160)
    .refine((value) => emailPattern.test(value), "Enter a valid email address"),
  mobileCountryCode: z.string().trim().min(1, "Mobile country code is required").max(8)
    .transform((value) => value.startsWith("+") ? value : `+${value.replace(/\D/g, "")}`),
  mobileNumber: z.string().trim().min(1, "Mobile number is required").max(30),
  aadhaarNumber: z.string().trim().max(20).transform(normalizeAadhaarNumber)
    .refine((value) => !value || isValidAadhaarNumber(value), "Enter a valid 12-digit Aadhaar number")
    .optional(),
  countryCode: z.string().trim().toUpperCase().length(2, "Select a valid country"),
  countryName: z.string().trim().min(1, "Country is required").max(80),
  addressLine1: z.string().trim().toUpperCase().min(1, "Address line 1 is required").max(120),
  addressLine2: z.string().trim().toUpperCase().max(120).optional().default(""),
  townOrCity: z.string().trim().toUpperCase().min(1, "Town or city is required").max(80),
  county: z.string().trim().toUpperCase().max(80).optional().default(""),
  postcode: z.string().trim().toUpperCase().min(1, "Postcode is required").max(20),
  instructions: z.string().trim().toUpperCase().max(500).optional().default(""),
  providerPlaceId: z.string().trim().max(255).optional().default("")
}).superRefine((value, context) => {
  if (!parsePhoneNumberFromString(`${value.mobileCountryCode}${value.mobileNumber}`)?.isValid()) {
    context.addIssue({ code: "custom", path: ["mobileNumber"], message: "Enter a valid mobile number including its country code" });
  } else if (!isDialCodeForCountry(value.countryCode, value.mobileCountryCode)) {
    // A code from another country would fail again the moment the entry is
    // picked into a shipment, so it is refused here instead.
    context.addIssue({ code: "custom", path: ["mobileCountryCode"], message: "Mobile country code must match the address country" });
  }
  if (value.type === "SENDER" && value.countryCode !== "IN") {
    context.addIssue({ code: "custom", path: ["countryCode"], message: "Shipment sender addresses must be in India" });
  }
  if (value.type !== "SENDER" && value.aadhaarNumber) {
    context.addIssue({ code: "custom", path: ["aadhaarNumber"], message: "Aadhaar can only be saved for sender addresses" });
  }
  if (value.countryCode === "GB" && !ukPostcodePattern.test(value.postcode)) {
    context.addIssue({ code: "custom", path: ["postcode"], message: "Enter a valid UK postcode" });
  }
  const expectedCountryCode = getCountryCodeByName(value.countryName);
  if (expectedCountryCode && expectedCountryCode !== value.countryCode) {
    context.addIssue({ code: "custom", path: ["countryName"], message: "Country name and country code do not match" });
  }
});

export type AddressBookInput = z.infer<typeof addressBookInputSchema>;

export const addressBookImportInputSchema = z.array(addressBookInputSchema).min(1).max(500);

export function postalAddressFrom(input: AddressBookInput | IAddressBookEntry): AddressBookPostalAddress {
  return {
    countryCode: input.countryCode,
    countryName: input.countryName,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? "",
    townOrCity: input.townOrCity,
    county: input.county ?? "",
    postcode: input.postcode
  };
}

export const postalAddressFields = [
  "countryCode", "countryName", "addressLine1", "addressLine2", "townOrCity", "county", "postcode"
] as const;

function normalized(value: string | undefined) {
  return (value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function postalAddressesMatch(left: AddressBookPostalAddress, right: AddressBookPostalAddress) {
  return normalized(left.countryCode) === normalized(right.countryCode)
    && normalized(left.addressLine1) === normalized(right.addressLine1)
    && normalized(left.townOrCity) === normalized(right.townOrCity)
    && normalized(left.postcode) === normalized(right.postcode);
}

export type AddressBookValidationResult = {
  status: "VALIDATED" | "CORRECTION_SUGGESTED" | "INCOMPLETE";
  provider: "IDEAL_POSTCODES" | "GOOGLE_PLACES";
  message: string;
  suggestedAddress: AddressBookPostalAddress | null;
};

export async function validateAddressBookPostalAddress(
  address: AddressBookPostalAddress
): Promise<AddressBookValidationResult> {
  if (address.countryCode === "GB") {
    const result = await validateUkAddressWithPaf({ ...address, countryCode: "GB" });
    const suggested = result.suggestedAddress ? {
      countryCode: "GB",
      countryName: "United Kingdom",
      addressLine1: result.suggestedAddress.addressLine1,
      addressLine2: result.suggestedAddress.addressLine2 ?? "",
      townOrCity: result.suggestedAddress.townOrCity,
      county: result.suggestedAddress.county ?? "",
      postcode: result.suggestedAddress.postcode
    } : null;

    if (result.outcome === "VALID") {
      return { status: "VALIDATED", provider: "IDEAL_POSTCODES", message: "Address matched Royal Mail PAF data.", suggestedAddress: suggested };
    }
    if (result.outcome === "CORRECTION_SUGGESTED") {
      return { status: "CORRECTION_SUGGESTED", provider: "IDEAL_POSTCODES", message: "A corrected UK address is available.", suggestedAddress: suggested };
    }
    return { status: "INCOMPLETE", provider: "IDEAL_POSTCODES", message: "No complete UK address match was found.", suggestedAddress: null };
  }

  const sessionToken = crypto.randomUUID();
  const query = [address.addressLine1, address.addressLine2, address.townOrCity, address.county, address.postcode].filter(Boolean).join(", ");
  const predictions = await autocompletePlaces(query, address.countryCode, sessionToken);
  if (!predictions.length) {
    return { status: "INCOMPLETE", provider: "GOOGLE_PLACES", message: "No complete address match was found.", suggestedAddress: null };
  }

  const details = await getPlaceDetails(predictions[0]!.placeId, sessionToken);
  const mapped = mapGoogleComponentsToGenericAddress(details.addressComponents);
  const suggestedAddress: AddressBookPostalAddress = {
    countryCode: (mapped.countryCode || address.countryCode).toUpperCase(),
    countryName: mapped.countryName || address.countryName,
    addressLine1: (mapped.addressLine1 || address.addressLine1).toUpperCase(),
    addressLine2: (mapped.addressLine2 || address.addressLine2 || "").toUpperCase(),
    townOrCity: (mapped.city || address.townOrCity).toUpperCase(),
    county: (mapped.state || address.county || "").toUpperCase(),
    postcode: (mapped.postalCode || address.postcode).toUpperCase()
  };

  return postalAddressesMatch(address, suggestedAddress)
    ? { status: "VALIDATED", provider: "GOOGLE_PLACES", message: "Address matched Google Places data.", suggestedAddress }
    : { status: "CORRECTION_SUGGESTED", provider: "GOOGLE_PLACES", message: "A corrected address is available.", suggestedAddress };
}

export function serializeAddressBookEntry(entry: IAddressBookEntry | Record<string, unknown>) {
  const value = entry as unknown as Record<string, unknown> & { _id?: unknown };
  return {
    id: String(value._id ?? ""),
    type: value.type,
    label: value.label,
    isFavourite: Boolean(value.isFavourite),
    companyName: value.companyName ?? "",
    contactName: value.contactName ?? "",
    email: value.email ?? "",
    mobileCountryCode: value.mobileCountryCode ?? "",
    mobileNumber: value.mobileNumber ?? "",
    hasAadhaarNumber: Boolean(value.aadhaarNumberMasked),
    aadhaarNumberMasked: value.aadhaarNumberMasked ?? "",
    countryCode: value.countryCode ?? "",
    countryName: value.countryName ?? "",
    addressLine1: value.addressLine1 ?? "",
    addressLine2: value.addressLine2 ?? "",
    townOrCity: value.townOrCity ?? "",
    county: value.county ?? "",
    postcode: value.postcode ?? "",
    instructions: value.instructions ?? "",
    providerPlaceId: value.providerPlaceId ?? "",
    validationStatus: value.validationStatus ?? "NOT_VALIDATED",
    validationProvider: value.validationProvider ?? "",
    validationMessage: value.validationMessage ?? "",
    suggestedAddress: value.suggestedAddress ?? null,
    validatedAt: value.validatedAt ?? null,
    createdAt: value.createdAt ?? null,
    updatedAt: value.updatedAt ?? null
  };
}

export function normalizeImportedCountry(value: string) {
  const input = value.trim();
  const directName = portalCountryNames.find((country) => country.toLowerCase() === input.toLowerCase());
  if (directName) return { countryName: directName, countryCode: getCountryCodeByName(directName) };
  const byCode = portalCountryNames.find((country) => getCountryCodeByName(country) === input.toUpperCase());
  return byCode ? { countryName: byCode, countryCode: getCountryCodeByName(byCode) } : null;
}
