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

// Keep shipment state codes separate from the reference codes used for city
// lookups. Numeric codes below come from the US Census, Statistics Canada,
// Destatis, Spain's INE, Italy's Istat, and France's Insee respectively.
const usNumericStateCodes: Record<string, string> = {
  alabama: "01",
  alaska: "02",
  "american samoa": "60",
  arizona: "04",
  arkansas: "05",
  california: "06",
  colorado: "08",
  connecticut: "09",
  delaware: "10",
  "district of columbia": "11",
  florida: "12",
  georgia: "13",
  guam: "66",
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
  "northern mariana islands": "69",
  ohio: "39",
  oklahoma: "40",
  oregon: "41",
  pennsylvania: "42",
  "puerto rico": "72",
  "rhode island": "44",
  "south carolina": "45",
  "south dakota": "46",
  tennessee: "47",
  texas: "48",
  "united states minor outlying islands": "74",
  "united states virgin islands": "78",
  utah: "49",
  vermont: "50",
  virginia: "51",
  washington: "53",
  "west virginia": "54",
  wisconsin: "55",
  wyoming: "56"
};

// Keys are the reference dataset's subdivision codes. Only map entries at the
// same administrative level as the official numeric code; provinces, counties,
// and cities not listed here retain their reference code (for example, WLV).
const numericStateCodesByCountry: Record<string, Record<string, string>> = {
  CA: {
    NL: "10", PE: "11", NS: "12", NB: "13", QC: "24", ON: "35",
    MB: "46", SK: "47", AB: "48", BC: "59", YT: "60", NT: "61", NU: "62"
  },
  DE: {
    SH: "01", HH: "02", NI: "03", HB: "04", NW: "05", HE: "06",
    RP: "07", BW: "08", BY: "09", SL: "10", BE: "11", BB: "12",
    MV: "13", SN: "14", ST: "15", TH: "16"
  },
  ES: {
    AN: "01", AR: "02", AS: "03", IB: "04", CN: "05", CB: "06", S: "06",
    CL: "07", CM: "08", CT: "09", VC: "10", EX: "11", GA: "12",
    MD: "13", MC: "14", NC: "15", PV: "16", RI: "17", CE: "18", ML: "19"
  },
  IT: {
    "21": "01", "23": "02", "25": "03", "32": "04", "34": "05",
    "36": "06", "42": "07", "45": "08", "52": "09", "55": "10",
    "57": "11", "62": "12", "65": "13", "67": "14", "72": "15",
    "75": "16", "77": "17", "78": "18", "82": "19", "88": "20"
  },
  FR: {
    "971": "01", "972": "02", "973": "03", "974": "04", "976": "06",
    IDF: "11", CVL: "24", BFC: "27", NOR: "28", HDF: "32",
    GES: "44", PDL: "52", BRE: "53", NAQ: "75", OCC: "76",
    ARA: "84", PAC: "93", "20R": "94"
  }
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

  const referenceCode = findStateCode(states, stateName);
  return numericStateCodesByCountry[countryCode]?.[referenceCode] ?? referenceCode;
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
