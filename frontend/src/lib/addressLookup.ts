"use client";

// Client for the address lookup endpoints.
//
// Providers are chosen server-side by country (GB uses the Royal Mail PAF data
// behind Ideal Postcodes, everywhere else uses Google Places), so callers only
// pass the country the form has selected.

import { fetchWithAuth } from "@/lib/shipmentsList";
import { readJsonSafely } from "@/lib/auth";
import { resolveCountry } from "@/lib/countryLookup";
import { apiUrl } from "@/lib/api";

/** ISO-2 for a country name, uppercased, or "" when the name is not a country. */
const countryCodeFor = (countryName: string) =>
  resolveCountry(countryName)?.iso2.toUpperCase() ?? "";

export type AddressPrediction = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
};

export type LookupAddress = {
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  countryName: string;
};

// Shortest query worth sending. Below this a lookup matches half a country and
// is billed for nothing useful.
export const MIN_LOOKUP_LENGTH = 3;

/**
 * Google bills each autocomplete keystroke separately unless the requests
 * leading to one selection share a session token, in which case the whole
 * sequence is billed once. A caller creates one token per address entry and
 * discards it after picking a suggestion.
 */
export function createSessionToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function supportsAddressLookup(countryName: string) {
  return Boolean(countryCodeFor(countryName));
}

// GB search is by postcode (the PAF is indexed that way); everywhere else is
// free-text. The placeholder has to say which, or the field looks broken.
export function getLookupPlaceholder(countryName: string) {
  return countryCodeFor(countryName) === "GB"
    ? "Search by postcode, e.g. SW1A 1AA"
    : "Search for a street, building or area";
}

export async function autocompleteAddress(
  input: string,
  countryName: string,
  sessionToken: string,
  endpointRoot = "/api/v1/address-lookup",
): Promise<AddressPrediction[]> {
  const countryCode = countryCodeFor(countryName);

  if (!countryCode || input.trim().length < MIN_LOOKUP_LENGTH) return [];

  try {
    const request = endpointRoot.includes("/public/")
      ? (path: string, init?: RequestInit) =>
          fetch(apiUrl(path), {
            ...init,
            credentials: "include",
            headers: { "Content-Type": "application/json", ...init?.headers },
          })
      : fetchWithAuth;
    const response = await request(`${endpointRoot}/autocomplete`, {
      method: "POST",
      body: JSON.stringify({ input: input.trim(), countryCode, sessionToken }),
    });
    const payload = (await readJsonSafely(response)) as {
      success?: boolean;
      predictions?: AddressPrediction[];
    };

    if (!response.ok || !payload.success || !Array.isArray(payload.predictions))
      return [];

    return payload.predictions;
  } catch {
    // A lookup outage must never block the form; the caller falls back to the
    // manual fields, which are always present.
    return [];
  }
}

export async function getLookupAddress(
  placeId: string,
  countryName: string,
  sessionToken: string,
  endpointRoot = "/api/v1/address-lookup",
): Promise<LookupAddress | null> {
  const countryCode = countryCodeFor(countryName);

  if (!countryCode || !placeId) return null;

  try {
    const query = new URLSearchParams({ countryCode, sessionToken });
    const request = endpointRoot.includes("/public/")
      ? (path: string) => fetch(apiUrl(path), { credentials: "include" })
      : fetchWithAuth;
    const response = await request(
      `${endpointRoot}/places/${encodeURIComponent(placeId)}?${query.toString()}`,
    );
    const payload = (await readJsonSafely(response)) as {
      success?: boolean;
      address?: LookupAddress;
    };

    if (!response.ok || !payload.success || !payload.address) return null;

    return payload.address;
  } catch {
    return null;
  }
}
