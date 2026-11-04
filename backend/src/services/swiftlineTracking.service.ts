import { SwiftlineStationCounter } from "../models/swiftlineStationCounter.model.js";
import { displaySwiftlineParcelNumber } from "./swiftlineParcelIdentifier.service.js";

export {
  displaySwiftlineParcelNumber,
  findSwiftlineParcelIdentifierCollisions
} from "./swiftlineParcelIdentifier.service.js";
export type { SwiftlineParcelIdentifierAuditRecord } from "./swiftlineParcelIdentifier.service.js";

function indiaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    displayDate: `${value("day")}${value("month")}${value("year").slice(-2)}`,
    dateKey: `${value("year")}${value("month")}${value("day")}`
  };
}

export function normalizeStationCode(stationCode: string) {
  const normalized = stationCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("STATION_CODE_REQUIRED");
  }
  return normalized;
}

export function resolveStationCode(stationCode: string | undefined, branchCode: string) {
  if (stationCode?.trim()) {
    try {
      return normalizeStationCode(stationCode);
    } catch {
      // Older branches may still have a two-character label code. Their
      // branch code remains a safe fallback until the station code is updated.
    }
  }

  const prefix = branchCode.split("-")[0]?.trim().toUpperCase() ?? "";
  return normalizeStationCode(prefix);
}

export function formatSwiftlineTrackingNumber(input: {
  stationCode: string;
  date: Date;
  sequence: number;
}) {
  const { displayDate } = indiaDateParts(input.date);
  return `SLC${normalizeStationCode(input.stationCode)}${displayDate}${String(input.sequence).padStart(3, "0")}`;
}

export type SwiftlineParcelNumberFormat = "LEGACY" | "COMPACT";

const swiftlineTrackingNumberPattern = /^SLC[A-Z]{3}\d{9,}$/i;
const legacySwiftlineParcelNumberPattern = /^(SLC[A-Z]{3}\d{9,})-(0[1-9]|[1-9]\d|100)$/i;

export function configuredSwiftlineParcelNumberFormat(): SwiftlineParcelNumberFormat {
  return process.env.SWIFTLINE_PARCEL_NUMBER_FORMAT?.trim().toUpperCase() === "COMPACT"
    ? "COMPACT"
    : "LEGACY";
}

export function formatSwiftlineParcelNumber(
  trackingNumber: string,
  parcelIndex: number,
  format: SwiftlineParcelNumberFormat = configuredSwiftlineParcelNumberFormat()
) {
  const suffix = String(parcelIndex + 1).padStart(2, "0");
  return format === "COMPACT" ? `${trackingNumber}${suffix}` : `${trackingNumber}-${suffix}`;
}

/** Returns the 1-based piece sequence from either Swiftline parcel spelling. */
export function swiftlineParcelNumberSequence(value: string, trackingNumber: string) {
  const normalized = value.trim().toUpperCase();
  const base = trackingNumber.trim().toUpperCase();
  if (!base || !normalized.startsWith(base)) return null;

  const suffix = normalized.slice(base.length).replace(/^-/, "");
  if (!/^(0[1-9]|[1-9]\d|100)$/.test(suffix)) return null;
  return Number(suffix);
}

/** Keeps the old display during compatibility rollout; COMPACT switches UI and documents together. */
export function formatSwiftlineParcelNumberForDisplay(
  value: string,
  trackingNumber?: string,
  format: SwiftlineParcelNumberFormat = configuredSwiftlineParcelNumberFormat()
) {
  const normalized = value.trim().toUpperCase();
  return format === "COMPACT"
    ? displaySwiftlineParcelNumber(normalized, trackingNumber)
    : normalized;
}

/** Exact lookup candidates for old and new barcodes, without stripping arbitrary punctuation. */
export function swiftlineParcelNumberAliases(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return [];

  const aliases = new Set([normalized]);
  const legacyMatch = legacySwiftlineParcelNumberPattern.exec(normalized);
  if (legacyMatch) {
    aliases.add(`${legacyMatch[1]}${legacyMatch[2]}`);
  } else {
    for (const suffixLength of [2, 3]) {
      const base = normalized.slice(0, -suffixLength);
      const suffix = normalized.slice(-suffixLength);
      const validSuffix = suffixLength === 2
        ? /^(0[1-9]|[1-9]\d)$/.test(suffix)
        : suffix === "100";
      if (validSuffix && swiftlineTrackingNumberPattern.test(base)) {
        aliases.add(`${base}-${suffix}`);
      }
    }
  }
  return [...aliases];
}

/** Resolves user input to the exact identifier already stored on a shipment. */
export function resolveStoredSwiftlineParcelNumber(value: string, storedValues: readonly string[]) {
  const normalized = displaySwiftlineParcelNumber(value);
  const matches = storedValues.filter((stored) => displaySwiftlineParcelNumber(stored) === normalized);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export async function allocateSwiftlineTrackingNumber(input: {
  stationCode: string;
  date?: Date;
}) {
  const date = input.date ?? new Date();
  const { dateKey } = indiaDateParts(date);
  const stationCode = normalizeStationCode(input.stationCode);
  const counter = await SwiftlineStationCounter.findOneAndUpdate(
    { stationCode, dateKey },
    {
      $inc: { sequence: 1 },
      $setOnInsert: { stationCode, dateKey }
    },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();

  if (!counter) throw new Error("SWIFTLINE_TRACKING_ALLOCATION_FAILED");
  return formatSwiftlineTrackingNumber({
    stationCode: input.stationCode,
    date,
    sequence: counter.sequence
  });
}
