import { env } from "../config/env.js";
import { isValidAadhaarNumber } from "./aadhaarValidation.service.js";

const sandboxAadhaarFullUrl = "https://sandbox.surepass.app/api/v1/ocr/aadhaar-full";
const surepassTimeoutMs = 20_000;

type SurepassEnvironment = "sandbox" | "production";

function resolveSurepassAadhaarFullUrl(): string | null {
  const explicitUrl = env.SUREPASS_AADHAAR_FULL_URL;
  if (env.NODE_ENV === "production" && env.SUREPASS_API_ENV !== "production") return null;
  if (env.SUREPASS_API_ENV === "production" && !explicitUrl) return null;

  const endpoint = explicitUrl ?? sandboxAadhaarFullUrl;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
  if (env.SUREPASS_API_ENV === "production" && parsed.hostname.toLowerCase() === "sandbox.surepass.app") return null;
  if (env.SUREPASS_API_ENV === "sandbox" && parsed.hostname.toLowerCase() !== "sandbox.surepass.app") return null;
  return parsed.toString();
}

export function getSurepassAadhaarOcrConfiguration(): {
  environment: SurepassEnvironment;
  configured: boolean;
} {
  return {
    environment: env.SUREPASS_API_ENV,
    configured: Boolean(env.SUREPASS_API_TOKEN && resolveSurepassAadhaarFullUrl()),
  };
}

export function getSurepassAadhaarOcrProviderName(): string {
  return env.SUREPASS_API_ENV === "production" ? "SUREPASS_PRODUCTION" : "SUREPASS_SANDBOX";
}

export type AadhaarOcrFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
};

export type AadhaarOcrPrefill = {
  fullName: string;
  aadhaarNumber: string;
  address: {
    fullAddress: string;
    addressLine1: string;
    addressLine2: string;
    townOrCity: string;
    county: string;
    postcode: string;
  };
  warnings: string[];
};

export class SurepassAadhaarOcrError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "SurepassAadhaarOcrError";
  }
}

type SurepassOcrField = {
  value?: unknown;
  is_masked?: unknown;
  input_validation?: unknown;
};

type SurepassOcrAddress = {
  value?: unknown;
  first_line?: unknown;
  second_line?: unknown;
  locality?: unknown;
  landmark?: unknown;
  house_number?: unknown;
  district?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
};

type SurepassOcrSide = {
  full_name?: SurepassOcrField;
  aadhaar_number?: SurepassOcrField;
  address?: SurepassOcrAddress;
  zip?: SurepassOcrField;
};

type SurepassOcrResponse = {
  success?: unknown;
  data?: {
    front_side?: SurepassOcrSide[];
    back_side?: SurepassOcrSide[];
  } | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fieldValue(field: SurepassOcrField | undefined): string {
  return text(field?.value);
}

function uniqueParts(values: unknown[], excluding: string[] = []): string[] {
  const excluded = new Set(excluding.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  return values
    .map(text)
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (!key || excluded.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function validUnmaskedAadhaar(field: SurepassOcrField | undefined): string {
  const value = fieldValue(field);
  return field?.is_masked !== true
    && isValidAadhaarNumber(value)
    ? value.replace(/\D/g, "")
    : "";
}

const directionalCityFragments = new Set([
  "north", "south", "east", "west", "central",
  "north east", "northeast", "north-east",
  "north west", "northwest", "north-west",
  "south east", "southeast", "south-east",
  "south west", "southwest", "south-west",
]);

function resolveTownOrCity(cityValue: string, fullAddress: string): { value: string; warning: string } {
  if (cityValue && !directionalCityFragments.has(cityValue.toLocaleLowerCase())) {
    return { value: cityValue, warning: "" };
  }
  if (!cityValue && !fullAddress) return { value: "", warning: "" };

  const postOffice = fullAddress.match(/\bP\.?\s*O\.?\s*:\s*([^,]+)/i)?.[1]?.trim() ?? "";
  return {
    value: postOffice,
    warning: postOffice
      ? "We used the post office name for the city. Check it before saving."
      : "We couldn't read the city. Enter it before saving.",
  };
}

function splitAddressLines(fullAddress: string, city: string, state: string, postcode: string): { line1: string; line2: string } {
  let value = fullAddress.trim();
  if (postcode) {
    const escapedPostcode = postcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`\\s*[-,]?\\s*${escapedPostcode}$`), "").trim();
  }
  for (const suffixValue of [state, city]) {
    if (!suffixValue) continue;
    const stateSuffix = `, ${suffixValue}`;
    if (value.toLocaleLowerCase().endsWith(stateSuffix.toLocaleLowerCase())) {
      value = value.slice(0, -stateSuffix.length).trim();
    }
  }
  if (value.length <= 120) return { line1: value, line2: "" };

  const comma = value.lastIndexOf(", ", 120);
  const whitespace = value.lastIndexOf(" ", 120);
  const splitAt = comma > 0 ? comma : whitespace;
  if (splitAt <= 0) return { line1: value.slice(0, 120), line2: value.slice(120).trim() };
  return {
    line1: value.slice(0, splitAt + (comma > 0 ? 1 : 0)).trim(),
    line2: value.slice(splitAt + (comma > 0 ? 2 : 1)).trim(),
  };
}

/** Maps Surepass's documented full-OCR response to the existing consignor fields. */
export function mapSurepassAadhaarFullResponse(response: SurepassOcrResponse): AadhaarOcrPrefill {
  const front = response.data?.front_side ?? [];
  const back = response.data?.back_side ?? [];
  const fullName = front.map((side) => fieldValue(side.full_name)).find(Boolean) ?? "";
  const address = back.find((side) => side.address)?.address ?? {};

  const providerFullAddress = text(address.value);
  const houseNumber = text(address.house_number);
  const firstLine = text(address.first_line);
  const componentLine1 = firstLine
    ? houseNumber && !firstLine.toLocaleLowerCase().includes(houseNumber.toLocaleLowerCase())
      ? `${houseNumber}, ${firstLine}`
      : firstLine
    : uniqueParts([houseNumber, address.locality])[0] ?? "";
  const componentLine2 = uniqueParts(
    [address.second_line, address.locality, address.landmark, address.district],
    [componentLine1, text(address.city), text(address.state)],
  ).join(", ");
  const fullAddress = providerFullAddress || uniqueParts([
    componentLine1,
    componentLine2,
    address.city,
    address.state,
    address.zip ?? back.map((side) => fieldValue(side.zip)).find(Boolean),
  ]).join(", ");
  const postcode = text(address.zip) || back.map((side) => fieldValue(side.zip)).find(Boolean) || "";
  const providerCity = text(address.city);
  const townOrCity = resolveTownOrCity(providerCity, providerFullAddress);
  const addressLines = providerFullAddress
    ? splitAddressLines(
      providerFullAddress,
      providerCity && !directionalCityFragments.has(providerCity.toLocaleLowerCase()) ? providerCity : "",
      text(address.state),
      postcode,
    )
    : { line1: componentLine1 || fullAddress, line2: componentLine2 };

  const frontNumberFields = front.map((side) => side.aadhaar_number).filter(Boolean);
  const backNumberFields = back.map((side) => side.aadhaar_number).filter(Boolean);
  const frontNumber = frontNumberFields.map(validUnmaskedAadhaar).find(Boolean) ?? "";
  const backNumber = backNumberFields.map(validUnmaskedAadhaar).find(Boolean) ?? "";
  const conflictingNumbers = Boolean(frontNumber && backNumber && frontNumber !== backNumber);
  const aadhaarNumber = conflictingNumbers ? "" : frontNumber || backNumber;
  const numberFields = [...frontNumberFields, ...backNumberFields];
  const anyNumberReturned = numberFields.some(fieldValue);
  const warnings = conflictingNumbers
    ? ["The Aadhaar numbers read from each side did not match, so the number was not filled."]
    : anyNumberReturned && !aadhaarNumber
      ? numberFields.some((field) => field?.is_masked === true)
        ? ["The source document's Aadhaar number is masked, so it was not filled. Use an unmasked document or enter the number manually."]
        : numberFields.some((field) => field?.input_validation !== true)
          ? ["Surepass did not validate the extracted Aadhaar number, so it was not filled. Review the source or enter it manually."]
          : ["The extracted Aadhaar number failed the local checksum check, so it was not filled. Review the source or enter it manually."]
      : [];
  const validCandidateFields = [...frontNumberFields, ...backNumberFields]
    .filter((field) => Boolean(aadhaarNumber) && validUnmaskedAadhaar(field) === aadhaarNumber);
  if (aadhaarNumber && validCandidateFields.some((field) => field?.input_validation !== true)) {
    warnings.push("We couldn't confirm the Aadhaar number. Check it against the card before saving.");
  }
  if (townOrCity.warning) warnings.push(townOrCity.warning);

  return {
    fullName,
    aadhaarNumber,
    address: {
      fullAddress,
      addressLine1: addressLines.line1,
      addressLine2: addressLines.line2,
      townOrCity: townOrCity.value,
      county: text(address.state),
      postcode,
    },
    warnings,
  };
}

export async function scanAadhaarWithSurepass(input: {
  front: AadhaarOcrFile;
  back: AadhaarOcrFile;
  arePdfs: boolean;
}): Promise<AadhaarOcrPrefill> {
  const endpoint = resolveSurepassAadhaarFullUrl();
  if (!env.SUREPASS_API_TOKEN || !endpoint) {
    throw new SurepassAadhaarOcrError("Aadhaar scanning is not configured.", 503);
  }

  const form = new FormData();
  const front = new Blob([new Uint8Array(input.front.buffer)], { type: input.front.mimetype });
  const back = new Blob([new Uint8Array(input.back.buffer)], { type: input.back.mimetype });
  const extensionFor = (file: AadhaarOcrFile) => input.arePdfs
    ? "pdf"
    : file.mimetype === "image/png" ? "png" : "jpg";
  form.append("front", front, `aadhaar-front.${extensionFor(input.front)}`);
  form.append("back", back, `aadhaar-back.${extensionFor(input.back)}`);
  if (input.arePdfs) form.append("use_pdf", "true");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SUREPASS_API_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(surepassTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SurepassAadhaarOcrError("Aadhaar scanning timed out. Please try again.", 504);
    }
    throw new SurepassAadhaarOcrError("Aadhaar scanning is temporarily unavailable. Please try again.", 502);
  }

  let payload: SurepassOcrResponse;
  try {
    payload = await response.json() as SurepassOcrResponse;
  } catch {
    throw new SurepassAadhaarOcrError("Aadhaar scanning returned an unreadable response.", 502);
  }

  if (!response.ok || payload.success !== true || !payload.data) {
    throw new SurepassAadhaarOcrError(
      "Surepass could not read these Aadhaar files. Check both sides and try clearer images.",
      response.status === 400 || response.status === 422 ? 422 : 502,
    );
  }

  const result = mapSurepassAadhaarFullResponse(payload);
  if (!result.fullName && !result.address.fullAddress && !result.aadhaarNumber) {
    throw new SurepassAadhaarOcrError(
      "No consignor details could be read. Check both sides and try clearer images.",
      422,
    );
  }
  return result;
}
