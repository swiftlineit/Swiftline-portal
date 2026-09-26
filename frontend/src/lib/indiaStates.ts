/**
 * States and union territories that can be used for an Indian consignor
 * address. The display names are kept canonical so address-provider values,
 * existing drafts, and user selections resolve to the same value.
 */
export const indiaStates = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry"
] as const;

export type IndiaState = (typeof indiaStates)[number];

function stateKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("en-IN")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

const canonicalByKey = new Map<string, IndiaState>(indiaStates.map((state) => [stateKey(state), state]));

const aliases: Record<string, IndiaState> = {
  andaman: "Andaman and Nicobar Islands",
  andamanandnicobarislands: "Andaman and Nicobar Islands",
  dadraandnagarhaveli: "Dadra and Nagar Haveli and Daman and Diu",
  damananddiu: "Dadra and Nagar Haveli and Daman and Diu",
  delhinct: "Delhi",
  nationalcapitalterritoryofdelhi: "Delhi",
  nctofdelhi: "Delhi",
  jammukashmir: "Jammu and Kashmir",
  orissa: "Odisha",
  pondicherry: "Puducherry",
  uttaranchal: "Uttarakhand"
};

/**
 * Resolves the state text returned by address providers or stored in older
 * drafts to a canonical option. Google may return a state with a country
 * suffix, so matching also checks the normalized text for a known option.
 * Unknown text is returned in its trimmed form so legacy data is not silently
 * discarded; new selections always come from `indiaStates`.
 */
export function normalizeIndiaState(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const key = stateKey(trimmed);
  const direct = canonicalByKey.get(key) ?? aliases[key];
  if (direct) return direct;

  const candidates = [...canonicalByKey.entries()].sort(([left], [right]) => right.length - left.length);
  const embedded = candidates.find(([candidateKey]) => key.includes(candidateKey));
  if (embedded) return embedded[1];

  const alias = Object.entries(aliases)
    .sort(([left], [right]) => right.length - left.length)
    .find(([aliasKey]) => key.includes(aliasKey));
  return alias?.[1] ?? trimmed;
}

