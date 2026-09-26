"use client";

// States and cities for the address dropdowns, fetched from the reference API.
//
// The underlying dataset is 45 MB, so none of it is bundled: the server serves
// one country's states or one state's cities at a time. Results are held in a
// module-level cache because geography does not change between deploys, and a
// wizard can revisit the same country several times in one session.

import { fetchWithAuth } from "@/lib/shipmentsList";
import { readJsonSafely } from "@/lib/auth";
import { resolveCountry } from "@/lib/countryLookup";
import { apiUrl } from "@/lib/api";

export type GeographyState = { name: string; code: string };

// CSB-V EDI uses the numeric FIPS state code for U.S. destinations. The
// reference dataset exposes the ISO subdivision code (for example, OH), so
// keep this small translation at the booking boundary rather than changing
// the shared geography code used for city lookups.
const usNumericStateCodes: Record<string, string> = {
  alabama: "01",
  alaska: "02",
  arizona: "04",
  arkansas: "05",
  california: "06",
  colorado: "08",
  connecticut: "09",
  delaware: "10",
  "district of columbia": "11",
  florida: "12",
  georgia: "13",
  hawaii: "15",
  idaho: "16",
  illinois: "17",
  indiana: "18",
  iowa: "19",
  kansas: "20",
  kentucky: "21",
  louisiana: "22",
  maine: "23",
  maryland: "24",
  massachusetts: "25",
  michigan: "26",
  minnesota: "27",
  mississippi: "28",
  missouri: "29",
  montana: "30",
  nebraska: "31",
  nevada: "32",
  "new hampshire": "33",
  "new jersey": "34",
  "new mexico": "35",
  "new york": "36",
  "north carolina": "37",
  "north dakota": "38",
  ohio: "39",
  oklahoma: "40",
  oregon: "41",
  pennsylvania: "42",
  "rhode island": "44",
  "south carolina": "45",
  "south dakota": "46",
  tennessee: "47",
  texas: "48",
  utah: "49",
  vermont: "50",
  virginia: "51",
  washington: "53",
  "west virginia": "54",
  wisconsin: "55",
  wyoming: "56"
};

const statesCache = new Map<string, GeographyState[]>();
const citiesCache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<unknown>>();

// Resolved against the full country catalogue rather than a short address list:
// the reference dataset already holds states for 229 countries, and the only
// thing that used to stop Croatia getting a real state dropdown was a name this
// lookup did not recognise. A country the dataset does not cover still returns
// an empty list, and the caller falls back to a free-text field.
const getCountryCode = (countryName: string) =>
  resolveCountry(countryName)?.iso2.toUpperCase() ?? "";

// One request per key, even when several controls mount at once.
function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;

  if (existing) return existing;

  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);

  return promise;
}

export async function fetchStates(
  countryName: string,
  endpointRoot = "/api/v1/reference",
): Promise<GeographyState[]> {
  const countryCode = getCountryCode(countryName);
  const cacheKey = `${endpointRoot}:${countryCode}`;

  if (!countryCode) return [];
  if (statesCache.has(cacheKey)) return statesCache.get(cacheKey) ?? [];

  return dedupe(`states:${endpointRoot}:${countryCode}`, async () => {
    try {
      const path = `${endpointRoot}/countries/${countryCode}/states`;
      const response = endpointRoot.includes("/public/")
        ? await fetch(apiUrl(path), { credentials: "include" })
        : await fetchWithAuth(path);
      const payload = (await readJsonSafely(response)) as {
        success?: boolean;
        states?: GeographyState[];
      };
      const states =
        response.ok && payload.success && Array.isArray(payload.states)
          ? payload.states
          : [];

      statesCache.set(cacheKey, states);
      return states;
    } catch {
      // A lookup failure must not block the form: the caller falls back to a
      // free-text field rather than presenting an empty dropdown.
      return [];
    }
  });
}

export async function fetchCities(
  countryName: string,
  stateCode: string,
  endpointRoot = "/api/v1/reference",
): Promise<string[]> {
  const countryCode = getCountryCode(countryName);
  const state = stateCode.trim();

  if (!countryCode || !state) return [];

  const key = `${endpointRoot}:${countryCode}:${state}`;

  if (citiesCache.has(key)) return citiesCache.get(key) ?? [];

  return dedupe(`cities:${endpointRoot}:${key}`, async () => {
    try {
      const path = `${endpointRoot}/countries/${countryCode}/states/${encodeURIComponent(state)}/cities`;
      const response = endpointRoot.includes("/public/")
        ? await fetch(apiUrl(path), { credentials: "include" })
        : await fetchWithAuth(path);
      const payload = (await readJsonSafely(response)) as {
        success?: boolean;
        cities?: string[];
      };
      const cities =
        response.ok && payload.success && Array.isArray(payload.cities)
          ? payload.cities
          : [];

      citiesCache.set(key, cities);
      return cities;
    } catch {
      return [];
    }
  });
}

// The dataset stores states by name; the form stores the name too, so the code
// has to be recovered to look up that state's cities.
export function findStateCode(states: GeographyState[], stateName: string) {
  const target = stateName.trim().toLowerCase();

  return (
    states.find((state) => state.name.toLowerCase() === target)?.code ?? ""
  );
}

export function findShipmentStateCode(
  countryName: string,
  states: GeographyState[],
  stateName: string,
) {
  const countryCode = getCountryCode(countryName);
  if (countryCode === "US") {
    const numericCode = usNumericStateCodes[stateName.trim().toLowerCase()];
    if (numericCode) return numericCode;
  }

  return findStateCode(states, stateName);
}

function normalizePlaceName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Resolves a state name from an address provider to the exact spelling used by
 * the reference list, so it can be selected in the dropdown.
 *
 * Providers punctuate and accent differently from the dataset, and some return
 * a subdivision code rather than a name. Returns "" when nothing matches, which
 * leaves the field empty for the user to pick rather than showing a value the
 * dropdown cannot represent.
 */
export function matchStateName(states: GeographyState[], stateName: string) {
  const target = normalizePlaceName(stateName);

  if (!target) return "";

  const match = states.find(
    (state) =>
      normalizePlaceName(state.name) === target ||
      normalizePlaceName(state.code) === target,
  );

  return match?.name ?? "";
}
