import mongoose from "mongoose";
import {
  countryRateServiceValues,
  rateCardBandValues,
  type CountryRateService,
  type RateCardBand
} from "./countryRateCard.model.js";

/**
 * Surcharges, insurance and discount configured for one shipping route.
 *
 * A "route" is a destination country plus a service (Courier or Cargo)- the same
 * key the weight slabs in `countryRateCard.model.ts` are grouped by. The slabs are
 * stored one document per weight band, so these values deliberately live in their
 * own single document per route: an admin sets the fuel percentage once instead of
 * repeating it on every slab, and two slabs can never disagree about it.
 *
 * Amounts are plain rupees, matching `chargesPerKg` on the rate card and the
 * arithmetic in `shipmentPricing.service.ts`. Conversion to minor units happens
 * once, at the invoicing and credit boundaries.
 *
 * A route with no document prices exactly as it did before this config existed:
 * every surcharge reads zero. That is what keeps historical shipments and
 * unconfigured routes unchanged, so no migration is required.
 */
export interface ICountryRouteCharge extends mongoose.Document {
  band?: RateCardBand | null;
  businessAccountId?: mongoose.Types.ObjectId | null;
  countryCode: string;
  service: CountryRateService;
  /** Percentage of base freight. The industry-standard way fuel is billed. */
  fuelSurchargePercent: number;
  /** Flat amount, added only when the consignee postcode matches `remoteAreaPostcodes`. */
  remoteAreaCharge: number;
  /**
   * Uppercase postcode prefixes that make a destination remote. A consignee
   * postcode is remote when it starts with any entry, compared with spaces and
   * hyphens removed so "SW1A 1AA" and "SW1A-1AA" match the same "SW1A" prefix.
   */
  remoteAreaPostcodes: string[];
  /** Flat amount charged once per shipment, regardless of parcel count. */
  handlingCharge: number;
  /** Percentage of the declared goods value, charged only when the customer opts in. */
  insurancePercent: number;
  /** Floor for the insurance premium, so a low-value shipment still covers the cost of cover. */
  insuranceMinimum: number;
  /**
   * Percentage taken off the GST-inclusive subtotal. This is a ROUTE-level discount: it
   * applies to every customer shipping to this country on this service, not to one
   * negotiated account.
   */
  discountPercent: number;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

// Percentages are bounded so a typed-in "1800" cannot silently multiply a
// shipment's price by nineteen.
const percentField = { type: Number, required: true, min: 0, max: 100, default: 0 };
const amountField = { type: Number, required: true, min: 0, default: 0 };

const countryRouteChargeSchema = new mongoose.Schema<ICountryRouteCharge>(
  {
    band: { type: String, enum: rateCardBandValues, index: true },
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", index: true },
    countryCode: { type: String, uppercase: true, trim: true, required: true, minlength: 2, maxlength: 2 },
    service: { type: String, enum: countryRateServiceValues, required: true },
    fuelSurchargePercent: percentField,
    remoteAreaCharge: amountField,
    remoteAreaPostcodes: {
      type: [{ type: String, uppercase: true, trim: true, maxlength: 20 }],
      default: []
    },
    handlingCharge: amountField,
    insurancePercent: percentField,
    insuranceMinimum: amountField,
    discountPercent: percentField,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

// One configuration per route. The pricing engine relies on this being unique:
// it reads a single document, never merges two.
countryRouteChargeSchema.index({ businessAccountId: 1, band: 1, countryCode: 1, service: 1 }, { unique: true, name: "rate_card_owner_route_unique" });
countryRouteChargeSchema.pre("validate", function () {
  if (Boolean(this.band) === Boolean(this.businessAccountId)) this.invalidate("businessAccountId", "Route charges must belong to exactly one private account or global/legacy band.");
});

export const CountryRouteCharge = mongoose.model<ICountryRouteCharge>(
  "CountryRouteCharge",
  countryRouteChargeSchema
);
