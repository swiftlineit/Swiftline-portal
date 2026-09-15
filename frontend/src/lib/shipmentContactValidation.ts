import { getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

// Shared field-level validation for the shipment (create shipment) forms, used by
// both the admin dashboard and the client portal review pages, and by the
// consignor rules in shipmentConsignor.ts. Messages embed the field noun (email,
// mobile number, postcode) so the pages can map an issue back to its field.

export const shipmentEmailMessage = "Enter a valid email address (Gmail, Yahoo, or a business domain)";
export const shipmentMobileMessage = "Enter a valid mobile number for the selected country code";
export const shipmentMobileCountryMismatchMessage = "Mobile country code must match the destination country";
export const shipmentPostcodeMessage = "Enter a valid postcode for the destination country";

// Gmail and Yahoo families are the only consumer providers accepted. Any other
// free provider (Outlook, Hotmail, iCloud, AOL, Proton, GMX, Yandex, Mail.com …)
// is rejected; genuine business/company domains are accepted on a valid TLD.
const allowedFreeEmailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "ymail.com",
  "rocketmail.com"
]);

// Yahoo ships under dozens of country domains, so it is matched by pattern rather
// than an exhaustive list: yahoo.com, yahoo.in, yahoo.co.uk, yahoo.com.au, …
const yahooDomainPattern = /^yahoo\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

// Brand names that may only appear as one of their real domains. This catches the
// reported bug (gmail.co) and its cousins (gmail.con, yaho0-style typos land here
// too), and blocks other consumer providers outright since none are whitelisted.
const reservedEmailBrands = new Set([
  "gmail",
  "googlemail",
  "ymail",
  "rocketmail",
  "yahoo",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "icloud",
  "me",
  "mac",
  "aol",
  "aim",
  "proton",
  "protonmail",
  "gmx",
  "yandex",
  "mail",
  "inbox",
  "zoho"
]);

// Common fat-finger variants of ".com" that should never be accepted as a TLD.
const blockedEmailTlds = new Set(["con", "conm", "comm", "cpm", "coom", "ocm", "vom", "xom", "om", "cm"]);

const basicEmailPattern = /^[^\s@]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isAcceptableShipmentEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (!basicEmailPattern.test(email)) return false;

  const domain = email.split("@")[1] ?? "";
  const labels = domain.split(".");
  const brand = labels[0] ?? "";
  const tld = labels.at(-1) ?? "";

  if (!brand) return false;
  if (blockedEmailTlds.has(tld)) return false;

  if (reservedEmailBrands.has(brand)) {
    if (allowedFreeEmailDomains.has(domain)) return true;
    if (brand === "yahoo") return yahooDomainPattern.test(domain);
    // Reserved brand on any other domain is a typo or a blocked free provider.
    return false;
  }

  // Business / company domain: accept on a plausible alphabetic TLD.
  return /^[a-z]{2,24}$/.test(tld);
}

/** Undefined when acceptable; otherwise the message to surface. Empty is treated as valid here- callers own the required check. */
export function getShipmentEmailError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  return isAcceptableShipmentEmail(value) ? undefined : shipmentEmailMessage;
}

/**
 * Validates the mobile number against the selected dial code using libphonenumber,
 * so the format has to match the country the code belongs to. Empty is treated as
 * valid here- callers own the required check.
 */
export function getShipmentMobileError(dialCode: string, mobileNumber: string): string | undefined {
  const code = dialCode.trim();
  const digits = mobileNumber.replace(/\D/g, "");
  if (!digits) return undefined;
  if (!code) return shipmentMobileMessage;

  const normalizedCode = code.startsWith("+") ? code : `+${code}`;
  const parsed = parsePhoneNumberFromString(`${normalizedCode}${digits}`);
  return parsed?.isValid() ? undefined : shipmentMobileMessage;
}

/**
 * The dial code libphonenumber assigns a destination (GB -> "+44"), used to
 * pre-select the consignee code when the destination country changes. Same
 * library as the validators, so an auto-selected code always validates.
 * Undefined for blank or unknown countries- callers then leave the field alone.
 */
export function getDialCodeForCountryCode(countryCode: string): string | undefined {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  try {
    return `+${getCountryCallingCode(code as CountryCode)}`;
  } catch {
    return undefined;
  }
}

/**
 * The dial code must belong to the destination country: a number that is valid
 * elsewhere is still the wrong number for this lane. Compared on calling codes
 * rather than the parsed region, because +1 is shared by the whole North
 * American numbering plan. Undefined when acceptable; empty codes and unknown
 * countries never fail here- presence checks own those cases.
 */
export function getShipmentMobileCountryMismatchError(countryCode: string, dialCode: string, place = "destination country"): string | undefined {
  if (!dialCode.trim()) return undefined;
  const expected = getDialCodeForCountryCode(countryCode);
  if (!expected) return undefined;
  const entered = dialCode.trim().startsWith("+") ? dialCode.trim() : `+${dialCode.trim()}`;
  return entered === expected ? undefined : `Mobile country code must match the ${place}`;
}

// UK format is enforced strictly (the app is UK-delivery focused); other countries
// get a light sanity check so valid international postcodes are not blocked.
const ukPostcodePattern = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/;
const genericPostcodePattern = /^[A-Za-z0-9][A-Za-z0-9\s-]{1,11}$/;

export function isPostcodeValidForCountry(countryCode: string, postcode: string): boolean {
  const value = postcode.trim();
  if (!value) return false;
  if (countryCode.toUpperCase() === "GB") return ukPostcodePattern.test(value.toUpperCase());
  return genericPostcodePattern.test(value);
}

/** Undefined when acceptable; otherwise the message to surface. Empty is treated as valid here- callers own the required check. */
export function getPostcodeError(countryCode: string, postcode: string): string | undefined {
  if (!postcode.trim()) return undefined;
  return isPostcodeValidForCountry(countryCode, postcode) ? undefined : shipmentPostcodeMessage;
}
