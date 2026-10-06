import { indiaDateTimeLocalToIso, isoToIndiaDateTimeLocal } from "./indiaDateTime";

const UK_TIME_ZONE = "Europe/London";
const UK_DESTINATION_IATA_CODES = new Set([
  "ABZ", "BEB", "BFS", "BHD", "BHX", "BOH", "BRR", "BRS", "CWL", "DND",
  "EDI", "EMA", "EXT", "GLA", "HUY", "INV", "KOI", "LBA", "LCY", "LGW",
  "LHR", "LPL", "LSI", "LTN", "MAN", "NCL", "NQY", "NWI", "PIK", "SEN",
  "SOU", "STN", "SYY", "TRE", "WIC",
]);
const dateTimeLocalPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function wallTimeAt(timestamp: number, timeZone: string): WallTime {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

function sameWallTime(left: WallTime, right: WallTime) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function timeZoneOffsetAt(timestamp: number, timeZone: string) {
  const wallTime = wallTimeAt(timestamp, timeZone);
  return Date.UTC(
    wallTime.year,
    wallTime.month - 1,
    wallTime.day,
    wallTime.hour,
    wallTime.minute,
    wallTime.second,
  ) - timestamp;
}

/** Format an API instant as a datetime-local wall time in the requested zone. */
function isoToDateTimeLocal(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const wallTime = wallTimeAt(date.getTime(), timeZone);
  return `${String(wallTime.year).padStart(4, "0")}-${String(wallTime.month).padStart(2, "0")}-${String(wallTime.day).padStart(2, "0")}T${String(wallTime.hour).padStart(2, "0")}:${String(wallTime.minute).padStart(2, "0")}`;
}

/**
 * Convert a datetime-local wall time to an API instant. Invalid calendar values,
 * skipped DST times, and duplicated DST times are rejected rather than guessed.
 */
function dateTimeLocalToIso(value: string, timeZone: string) {
  const match = dateTimeLocalPattern.exec(value.trim());
  if (!match) return "";
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
  const requested: WallTime = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
  };
  const localEpoch = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
  );
  const normalized = new Date(localEpoch);
  if (
    normalized.getUTCFullYear() !== requested.year
    || normalized.getUTCMonth() + 1 !== requested.month
    || normalized.getUTCDate() !== requested.day
    || requested.hour > 23
    || requested.minute > 59
    || requested.second > 59
  ) return "";

  // Nearby offsets cover both sides of a DST transition in the destination zone.
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 3) {
    offsets.add(timeZoneOffsetAt(localEpoch + delta * 60 * 60 * 1000, timeZone));
  }
  const matches = [...offsets]
    .map((offset) => localEpoch - offset)
    .filter((candidate) => sameWallTime(wallTimeAt(candidate, timeZone), requested));
  return matches.length === 1 ? new Date(matches[0]).toISOString() : "";
}

export function isoToUkDateTimeLocal(value: string) {
  return isoToDateTimeLocal(value, UK_TIME_ZONE);
}

export function ukDateTimeLocalToIso(value: string) {
  return dateTimeLocalToIso(value, UK_TIME_ZONE);
}

export function formatUkDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    timeZone: UK_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Flight arrival time is local to the destination airport only for UK airports.
 * Shipment destination countries do not affect the flight's scheduled time.
 */
export function isUkFlightDestination(destinationIataCode: string | null | undefined) {
  return UK_DESTINATION_IATA_CODES.has((destinationIataCode ?? "").trim().toUpperCase());
}

export function flightArrivalTimeZoneLabel(destinationIataCode: string | null | undefined) {
  return isUkFlightDestination(destinationIataCode) ? "UK time" : "IST";
}

export function isoToFlightArrivalDateTimeLocal(value: string, destinationIataCode: string | null | undefined) {
  return isUkFlightDestination(destinationIataCode)
    ? isoToUkDateTimeLocal(value)
    : isoToIndiaDateTimeLocal(value);
}

export function flightArrivalDateTimeLocalToIso(value: string, destinationIataCode: string | null | undefined) {
  return isUkFlightDestination(destinationIataCode)
    ? ukDateTimeLocalToIso(value)
    : indiaDateTimeLocalToIso(value);
}

export function formatFlightArrivalDateTime(value: string, destinationIataCode: string | null | undefined) {
  if (isUkFlightDestination(destinationIataCode)) return formatUkDateTime(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
