import mongoose from "mongoose";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import type { CountryRateService, RateCardBand } from "../models/countryRateCard.model.js";
import { rateCardFilter } from "./rateCardScope.service.js";

/**
 * Route charge configuration in the shape the pricing engine consumes.
 *
 * Kept as a plain value type rather than the Mongoose document so pricing stays
 * a pure calculation over data it was handed, and so an unconfigured route can be
 * represented by `emptyRouteCharges` instead of a null check at every use.
 */
export type RouteCharges = {
  fuelSurchargePercent: number;
  remoteAreaCharge: number;
  remoteAreaPostcodes: string[];
  handlingCharge: number;
  insurancePercent: number;
  insuranceMinimum: number;
  discountPercent: number;
  /**
   * When the configuration was last edited, or null for an unconfigured route.
   * The price lock hashes this so a mid-booking config change is detected even
   * when it happens to leave the total unchanged.
   */
  updatedAt: Date | null;
};

/**
 * The configuration a route has before an admin sets one: no surcharges, no
 * insurance, no discount. Pricing this against an existing shipment reproduces
 * the pre-surcharge total exactly.
 */
export const emptyRouteCharges: RouteCharges = {
  fuelSurchargePercent: 0,
  remoteAreaCharge: 0,
  remoteAreaPostcodes: [],
  handlingCharge: 0,
  insurancePercent: 0,
  insuranceMinimum: 0,
  discountPercent: 0,
  updatedAt: null
};

/**
 * Strips the characters that vary between how people write the same postcode, so
 * prefix matching is not defeated by a space or a hyphen.
 */
export function normalizePostcode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[\s-]/g, "") : "";
}

/**
 * Whether a destination postcode falls in a remote area for this route.
 *
 * Prefix matching, so an operator can list a broad "HS" for the Outer Hebrides or
 * a precise "HS12AB" for one delivery point without needing two mechanisms. An
 * empty postcode is never remote- an unknown destination must not silently
 * attract a surcharge the customer cannot see the reason for.
 */
export function isRemoteAreaPostcode(postcode: unknown, remoteAreaPostcodes: string[]): boolean {
  const normalized = normalizePostcode(postcode);
  if (!normalized) return false;

  return remoteAreaPostcodes.some((prefix) => {
    const normalizedPrefix = normalizePostcode(prefix);
    return Boolean(normalizedPrefix) && normalized.startsWith(normalizedPrefix);
  });
}

/**
 * Loads the configuration for one route, falling back to the zero-charge default.
 *
 * Accepts a session so pricing during a booking transaction reads the same
 * snapshot as the rest of that transaction.
 */
export async function getRouteCharges(input: {
  countryCode: string;
  service: CountryRateService;
  band?: RateCardBand | null;
  businessAccountId?: string | mongoose.Types.ObjectId | null;
  session?: mongoose.ClientSession;
}): Promise<RouteCharges> {
  const query = CountryRouteCharge.findOne({
    ...rateCardFilter(input),
    countryCode: input.countryCode.trim().toUpperCase(),
    service: input.service
  }).lean();
  if (input.session) query.session(input.session);

  const configuration = await query.exec();
  if (!configuration) return emptyRouteCharges;

  return {
    fuelSurchargePercent: configuration.fuelSurchargePercent,
    remoteAreaCharge: configuration.remoteAreaCharge,
    remoteAreaPostcodes: configuration.remoteAreaPostcodes ?? [],
    handlingCharge: configuration.handlingCharge,
    insurancePercent: configuration.insurancePercent,
    insuranceMinimum: configuration.insuranceMinimum,
    discountPercent: configuration.discountPercent,
    updatedAt: configuration.updatedAt ?? null
  };
}
