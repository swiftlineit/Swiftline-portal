import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";

/**
 * Dial-code <-> destination-country matching for consignee mobiles.
 *
 * libphonenumber is the single source of truth on both sides of the stack, so
 * the code a destination auto-selects is always one the validators accept.
 * Comparison is on calling codes rather than the parsed region: +1 is shared
 * by the whole North American numbering plan, so a region check would reject
 * genuine Canadian numbers as American.
 */

/** "44" for GB, "91" for IN... Undefined when the code is not a real country. */
export function getCallingCodeForCountry(countryCode: string): string | undefined {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  try {
    return getCountryCallingCode(code as CountryCode);
  } catch {
    return undefined;
  }
}

/**
 * Whether the dial code belongs to the destination country. Unknown
 * destinations have nothing to match against, so they never fail here-
 * presence and number-format checks still apply elsewhere.
 */
export function isDialCodeForCountry(countryCode: string, dialCode: string): boolean {
  const expected = getCallingCodeForCountry(countryCode);
  if (!expected) return true;
  return dialCode.trim().replace(/^\+/, "") === expected;
}
