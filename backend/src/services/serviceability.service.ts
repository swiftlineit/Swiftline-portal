/**
 * Can Swiftline carry this, and on what terms?
 *
 * Answered before a shipment exists, from the same records that price and
 * schedule a real one- routes for transit and restrictions, rate cards for
 * weight bands, route charges for remote areas. Nothing here is a second
 * opinion: if this says a lane is unserviceable, booking would refuse it too.
 */
import mongoose from "mongoose";
import { CountryRateCard, type ICountryRateCard, type RateCardBand } from "../models/countryRateCard.model.js";
import { SwiftlineRoute, type ISwiftlineRoute } from "../models/swiftlineRoute.model.js";
import { getRouteCharges, isRemoteAreaPostcode } from "./countryRouteCharge.service.js";
import { defaultOriginCountryCode } from "./swiftlineRoute.service.js";
import { rateCardFilter, type RateCardScope } from "./rateCardScope.service.js";

export type ServiceabilityQuery = {
  destinationCountryCode: string;
  destinationPostcode?: string;
  /** Kilograms, to check against the heaviest band the rate card offers. */
  weightKg?: number;
  /** The account's commercial band, so weights match what they would be quoted. */
  rateCardBand?: RateCardBand;
  scope?: RateCardScope;
};

export type ServiceabilityOption = {
  service: "COURIER" | "CARGO";
  serviceable: boolean;
  /** Why not, when it is not. Empty when the service is available. */
  unavailableReason: string;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  transitBasis: "BUSINESS_DAYS" | "CALENDAR_DAYS" | null;
  /** Countries the parcel routes through, when the lane is not direct. */
  viaCountryCodes: string[];
  /** The heaviest single box the rate card prices for this lane. */
  maxBoxKg: number | null;
  /** Heaviest weight any band covers, which is the practical ceiling. */
  maxWeightKg: number | null;
  /** Set when a weight was supplied and no band covers it. */
  weightExceedsBands: boolean;
  restrictions: string;
  notes: string;
};

export type ServiceabilityResult = {
  destinationCountryCode: string;
  destinationPostcode: string;
  remoteArea: {
    /** Null when no remote-area list is configured for the lane at all. */
    checked: boolean;
    isRemote: boolean;
  };
  options: ServiceabilityOption[];
};

/**
 * Everything known about a destination, per service.
 *
 * Both services are always returned, including the ones that cannot carry the
 * shipment, with the reason. A checker that silently omits CARGO leaves the
 * customer unsure whether it was considered.
 */
export async function checkServiceability(query: ServiceabilityQuery): Promise<ServiceabilityResult> {
  const destinationCountryCode = query.destinationCountryCode.trim().toUpperCase();
  const services: Array<"COURIER" | "CARGO"> = ["COURIER", "CARGO"];
  const scope = query.scope ?? { band: query.rateCardBand };

  const [routes, rateCards, ...chargesByService] = await Promise.all([
    SwiftlineRoute.find({
      originCountryCode: defaultOriginCountryCode,
      destinationCountryCode
    }).lean<Array<ISwiftlineRoute>>().exec(),
    CountryRateCard.find({
      countryCode: destinationCountryCode,
      ...rateCardFilter(scope)
    }).lean<Array<ICountryRateCard>>().exec(),
    // Route charges are held per service and band, so the remote-area list is
    // asked for the same way rather than assumed to be one list per country.
    ...services.map((service) => getRouteCharges({
      countryCode: destinationCountryCode,
      service,
      ...scope
    }).catch(() => null))
  ]);

  const routeByService = new Map(routes.map((route) => [route.service, route]));
  const remotePostcodesByService = new Map(
    services.map((service, index) => [service, chargesByService[index]?.remoteAreaPostcodes ?? []])
  );

  const options = services.map<ServiceabilityOption>((service) => {
    const route = routeByService.get(service);
    const bands = rateCards.filter((card) => card.service === service);
    // The heaviest weight any band reaches. A weight past it has no price, so
    // it is the real ceiling regardless of what a single box may weigh.
    const maxWeightKg = bands.length ? Math.max(...bands.map((band) => band.toKg)) : null;
    const maxBoxKg = bands.length ? Math.max(...bands.map((band) => band.maxBoxKg)) : null;

    const weightExceedsBands = Boolean(
      query.weightKg && maxWeightKg !== null && query.weightKg > maxWeightKg
    );

    const unavailableReason = !route
      ? "No route is configured for this destination yet."
      : !route.serviceable
        ? "Swiftline does not currently carry to this destination on this service."
        : !bands.length
          ? "No rate is published for this destination on this service."
          : weightExceedsBands
            ? `The heaviest published band for this lane is ${maxWeightKg} kg.`
            : "";

    return {
      service,
      serviceable: unavailableReason === "",
      unavailableReason,
      transitDaysMin: route?.serviceable ? route.transitDaysMin : null,
      transitDaysMax: route?.serviceable ? route.transitDaysMax : null,
      transitBasis: route?.serviceable ? route.transitBasis : null,
      viaCountryCodes: route?.viaCountryCodes ?? [],
      maxBoxKg,
      maxWeightKg,
      weightExceedsBands,
      restrictions: route?.restrictions ?? "",
      notes: route?.notes ?? ""
    };
  });

  const postcode = (query.destinationPostcode ?? "").trim();
  // Any service that lists this postcode makes it remote for the customer's
  // purposes- the surcharge applies on whichever one they end up booking.
  const remoteList = [...new Set(services.flatMap((service) => remotePostcodesByService.get(service) ?? []))];

  return {
    destinationCountryCode,
    destinationPostcode: postcode,
    remoteArea: {
      // Only a real answer when there is both a postcode to test and a list to
      // test it against; otherwise the UI says "not checked" rather than "no".
      checked: Boolean(postcode && remoteList.length),
      isRemote: Boolean(postcode && remoteList.length && isRemoteAreaPostcode(postcode, remoteList))
    },
    options
  };
}
