import { BookingPause, deriveBookingPauseStatus, type IBookingPause } from "../models/bookingPause.model.js";
import { DpdBookingSetting } from "../models/dpdBookingSetting.model.js";
import { isAlsEnabled, readAlsConfiguration } from "./als/alsClient.service.js";
import { EUROPE_COUNTRY_SET, normalizeCountryCode } from "./reference/europeCountryCodes.js";

export type BookingPauseCheckResult = {
  paused: boolean;
  pause?: IBookingPause;
  reason?: string;
};

function matchesCountry(pause: IBookingPause, normalizedCode: string): boolean {
  const tokens = pause.countries ?? [];
  if (tokens.includes("ALL" as never)) return true;
  if (tokens.includes(normalizedCode as never)) return true;
  if (tokens.includes("EUROPE" as never) && EUROPE_COUNTRY_SET.has(normalizedCode)) return true;
  // Alias already normalized (UK -> GB)
  return false;
}

/**
 * True when any active pause covers `countryCode` at `at`.
 * Checks active && startAt <= at <= endAt and country match (ALL/EUROPE/ISO2).
 */
export async function isBookingPaused(
  countryCode: string | null | undefined,
  at = new Date()
): Promise<BookingPauseCheckResult> {
  const normalized = normalizeCountryCode(countryCode);
  if (!normalized) return { paused: false };

  const now = at instanceof Date ? at : new Date(at);

  const activePauses = await BookingPause.find({
    active: true,
    startAt: { $lte: now },
    endAt: { $gte: now }
  })
    .sort({ startAt: 1 })
    .lean()
    .exec() as unknown as IBookingPause[];

  for (const pause of activePauses) {
    if (matchesCountry(pause, normalized)) {
      return { paused: true, pause, reason: pause.reason };
    }
  }

  return { paused: false };
}

export async function findActiveBookingPauses(at = new Date()): Promise<IBookingPause[]> {
  const now = at instanceof Date ? at : new Date(at);
  const pauses = await BookingPause.find({
    active: true,
    startAt: { $lte: now },
    endAt: { $gte: now }
  })
    .sort({ startAt: 1 })
    .lean()
    .exec() as unknown as IBookingPause[];
  return pauses;
}

export async function getBookingPauseStatusMap(at = new Date()) {
  return deriveBookingPauseStatus;
}

/** DPD booking is available only when both the operational and ALS switches are ready. */
export function isDpdLabelBookingAvailable(input: {
  bookingEnabled: boolean | undefined;
  alsEnabled: boolean;
  alsConfigurationReady: boolean;
}) {
  return (input.bookingEnabled ?? true) && input.alsEnabled && input.alsConfigurationReady;
}

export async function isDpdBookingEnabled(): Promise<boolean> {
  const setting = await DpdBookingSetting.findOne({ key: "GLOBAL" }).select("enabled").lean().exec();
  return isDpdLabelBookingAvailable({
    bookingEnabled: setting?.enabled,
    alsEnabled: isAlsEnabled(),
    alsConfigurationReady: readAlsConfiguration().ok
  });
}

export { deriveBookingPauseStatus, normalizeCountryCode, EUROPE_COUNTRY_SET };
