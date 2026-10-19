import mongoose from "mongoose";
import {
  countryRateServiceValues,
  rateCardBandValues,
  type CountryRateService,
  type RateCardBand
} from "./countryRateCard.model.js";

export const rateCardShareChannelValues = ["PORTAL", "EMAIL", "WHATSAPP"] as const;
export type RateCardShareChannel = (typeof rateCardShareChannelValues)[number];

export const rateCardShareStatusValues = ["ACTIVE", "REVOKED"] as const;
export type RateCardShareStatus = (typeof rateCardShareStatusValues)[number];

// A positive `value` marks rates up, a negative one discounts them. One signed
// number rather than a mode-plus-direction pair keeps the arithmetic in
// applyAdjustment a single expression and makes "-10%" unambiguous.
export const rateCardAdjustmentModeValues = ["NONE", "PERCENT", "FLAT"] as const;
export type RateCardAdjustmentMode = (typeof rateCardAdjustmentModeValues)[number];

/**
 * A row frozen at share time. `baseChargesPerKg` is what the live rate card held
 * and `chargesPerKg` is what the customer was actually quoted, so a later
 * dispute can be settled from the share alone without reconstructing what the
 * adjustment was or what the rate card looked like that day.
 */
export interface IRateCardShareRow {
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  fromKg: number;
  toKg: number;
  baseChargesPerKg: number;
  chargesPerKg: number;
  maxBoxKg: number;
  gstTreatment?: "INCLUDED" | "EXCLUDED";
  gstRatePercent?: number;
}

export interface IRateCardShareRouteCharge {
  countryCode: string;
  service: CountryRateService;
  fuelSurchargePercent: number;
  remoteAreaCharge: number;
  remoteAreaPostcodes: string[];
  handlingCharge: number;
  insurancePercent: number;
  insuranceMinimum: number;
  discountPercent: number;
}

export interface IRateCardShareRecipientAccount {
  businessAccountId: mongoose.Types.ObjectId;
  companyName: string;
}

export interface IRateCardShareEmailRecipient {
  email: string;
  name: string;
}

export interface IRateCardSharePhoneRecipient {
  phone: string;
  name: string;
}

export interface IRateCardShareRead {
  userId: mongoose.Types.ObjectId;
  readAt: Date;
}

export interface IRateCardShareTerms {
  validFrom: Date;
  validUntil: Date;
  fuelSurchargePercent: number;
  gstPercent: number;
  minChargeableWeightKg: number;
  volumetricDivisor: number;
  remarks: string;
  customTerms: string[];
}

export interface IRateCardShare extends mongoose.Document {
  band?: RateCardBand | null;
  businessAccountId?: mongoose.Types.ObjectId | null;
  privateRateCardVersion?: number;
  shareNumber: string;
  title: string;
  currency: string;
  channels: RateCardShareChannel[];
  rows: IRateCardShareRow[];
  routeCharges: IRateCardShareRouteCharge[];
  adjustmentMode: RateCardAdjustmentMode;
  adjustmentValue: number;
  terms: IRateCardShareTerms;
  recipientAccounts: IRateCardShareRecipientAccount[];
  recipientEmails: IRateCardShareEmailRecipient[];
  recipientPhones: IRateCardSharePhoneRecipient[];
  // SHA-256 of the link secret. The raw token is returned once, at creation, and
  // is never recoverable from the database- a leaked dump cannot open shares.
  publicTokenHash: string;
  publicTokenExpiresAt: Date;
  status: RateCardShareStatus;
  revokedAt?: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  readBy: IRateCardShareRead[];
  publicViewCount: number;
  lastViewedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const rateCardShareRowSchema = new mongoose.Schema<IRateCardShareRow>({
  countryCode: { type: String, uppercase: true, trim: true, required: true, minlength: 2, maxlength: 2 },
  countryName: { type: String, trim: true, required: true, maxlength: 80 },
  service: { type: String, enum: countryRateServiceValues, required: true },
  fromKg: { type: Number, required: true, min: 0 },
  toKg: { type: Number, required: true, min: 0 },
  baseChargesPerKg: { type: Number, required: true, min: 0 },
  chargesPerKg: { type: Number, required: true, min: 0 },
  maxBoxKg: { type: Number, required: true, min: 0 },
  gstTreatment: { type: String, enum: ["INCLUDED", "EXCLUDED"], default: "EXCLUDED" },
  gstRatePercent: { type: Number, min: 0, max: 100, default: 0 }
}, { _id: false });

const rateCardShareRouteChargeSchema = new mongoose.Schema<IRateCardShareRouteCharge>({
  countryCode: { type: String, uppercase: true, trim: true, required: true, minlength: 2, maxlength: 2 },
  service: { type: String, enum: countryRateServiceValues, required: true },
  fuelSurchargePercent: { type: Number, min: 0, max: 100, default: 0 },
  remoteAreaCharge: { type: Number, min: 0, default: 0 },
  remoteAreaPostcodes: { type: [{ type: String, trim: true, uppercase: true }], default: [] },
  handlingCharge: { type: Number, min: 0, default: 0 },
  insurancePercent: { type: Number, min: 0, max: 100, default: 0 },
  insuranceMinimum: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 }
}, { _id: false });

const rateCardShareTermsSchema = new mongoose.Schema<IRateCardShareTerms>({
  validFrom: { type: Date, required: true },
  validUntil: { type: Date, required: true },
  fuelSurchargePercent: { type: Number, default: 0, min: 0, max: 100 },
  gstPercent: { type: Number, default: 0, min: 0, max: 100 },
  minChargeableWeightKg: { type: Number, default: 0, min: 0 },
  volumetricDivisor: { type: Number, default: 0, min: 0 },
  remarks: { type: String, trim: true, maxlength: 1000, default: "" },
  customTerms: { type: [{ type: String, trim: true, maxlength: 300 }], default: [] }
}, { _id: false });

const rateCardShareSchema = new mongoose.Schema<IRateCardShare>({
  band: { type: String, enum: rateCardBandValues, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", index: true },
  privateRateCardVersion: { type: Number, min: 0 },
  shareNumber: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  currency: { type: String, required: true, uppercase: true, trim: true, default: "INR", maxlength: 3 },
  channels: { type: [{ type: String, enum: rateCardShareChannelValues }], default: [] },
  rows: { type: [rateCardShareRowSchema], default: [] },
  routeCharges: { type: [rateCardShareRouteChargeSchema], default: [] },
  adjustmentMode: { type: String, enum: rateCardAdjustmentModeValues, default: "NONE" },
  adjustmentValue: { type: Number, default: 0 },
  terms: { type: rateCardShareTermsSchema, required: true },
  recipientAccounts: {
    type: [new mongoose.Schema<IRateCardShareRecipientAccount>({
      businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true },
      companyName: { type: String, trim: true, maxlength: 200, default: "" }
    }, { _id: false })],
    default: []
  },
  recipientEmails: {
    type: [new mongoose.Schema<IRateCardShareEmailRecipient>({
      email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
      name: { type: String, trim: true, maxlength: 200, default: "" }
    }, { _id: false })],
    default: []
  },
  recipientPhones: {
    type: [new mongoose.Schema<IRateCardSharePhoneRecipient>({
      // Stored E.164 without the leading "+", which is the shape wa.me expects.
      phone: { type: String, required: true, trim: true, maxlength: 20 },
      name: { type: String, trim: true, maxlength: 200, default: "" }
    }, { _id: false })],
    default: []
  },
  publicTokenHash: { type: String, required: true, trim: true, index: true },
  publicTokenExpiresAt: { type: Date, required: true },
  status: { type: String, enum: rateCardShareStatusValues, default: "ACTIVE", required: true, index: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Drives the unread glow on the client tray: a share is unread for a member
  // until their own user id lands here, so one colleague opening it does not
  // clear the badge for the rest of the account.
  readBy: {
    type: [new mongoose.Schema<IRateCardShareRead>({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      readAt: { type: Date, required: true }
    }, { _id: false })],
    default: []
  },
  publicViewCount: { type: Number, default: 0, min: 0 },
  lastViewedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }
}, { timestamps: true });

rateCardShareSchema.pre("validate", function () {
  if (Boolean(this.band) === Boolean(this.businessAccountId)) {
    this.invalidate("businessAccountId", "A rate card share must have one business owner or one legacy/global band.");
  }
});

// The client tray query: shares aimed at my accounts, newest first.
//
// `channels` is deliberately absent even though the tray also filters on it.
// MongoDB refuses to build a compound index spanning two array fields, and
// `channels` and `recipientAccounts` are both arrays- including it makes every
// insert that populates both fail. The account and status keys already cut the
// scan down to one customer's shares; the channel match runs over that handful.
rateCardShareSchema.index({ "recipientAccounts.businessAccountId": 1, status: 1, createdAt: -1 });
rateCardShareSchema.index({ createdAt: -1 });

export const RateCardShare = mongoose.model<IRateCardShare>("RateCardShare", rateCardShareSchema);
