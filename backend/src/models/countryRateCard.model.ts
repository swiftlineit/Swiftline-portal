import mongoose from "mongoose";

export const countryRateServiceValues = ["COURIER", "CARGO"] as const;
export type CountryRateService = (typeof countryRateServiceValues)[number];
/** Band D is reserved for GST-inclusive public online booking rates. */
export const rateCardBandValues = ["BAND_A", "BAND_B", "BAND_C", "BAND_D"] as const;
export type RateCardBand = (typeof rateCardBandValues)[number];
export const internalRateCardBandValues = ["BAND_A", "BAND_B", "BAND_C"] as const;
export type InternalRateCardBand = (typeof internalRateCardBandValues)[number];
export const rateCardGstTreatmentValues = ["INCLUDED", "EXCLUDED"] as const;
export type RateCardGstTreatment = (typeof rateCardGstTreatmentValues)[number];

export interface ICountryRateCard extends mongoose.Document {
  band: RateCardBand;
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  fromKg: number;
  toKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
  gstTreatment: RateCardGstTreatment;
  gstRatePercent: number;
  gstApplyToAllRates: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const countryRateCardSchema = new mongoose.Schema<ICountryRateCard>(
  {
    band: { type: String, enum: rateCardBandValues, required: true, index: true },
    countryCode: { type: String, uppercase: true, trim: true, required: true, minlength: 2, maxlength: 2, index: true },
    countryName: { type: String, trim: true, required: true, maxlength: 80 },
    service: { type: String, enum: countryRateServiceValues, required: true, index: true },
    fromKg: { type: Number, required: true, min: 0 },
    toKg: { type: Number, required: true, min: 0 },
    chargesPerKg: { type: Number, required: true, min: 0 },
    maxBoxKg: { type: Number, required: true, min: 0 },
    gstTreatment: { type: String, enum: rateCardGstTreatmentValues, default: "EXCLUDED" },
    gstRatePercent: { type: Number, min: 0, max: 100, default: 0 },
    gstApplyToAllRates: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

countryRateCardSchema.index({ band: 1, countryCode: 1, service: 1, fromKg: 1, toKg: 1 });

export const CountryRateCard = mongoose.model<ICountryRateCard>(
  "CountryRateCard",
  countryRateCardSchema
);
