import mongoose from "mongoose";

export const addressBookEntryTypeValues = ["SENDER", "RECIPIENT"] as const;
export type AddressBookEntryType = (typeof addressBookEntryTypeValues)[number];

export const addressBookValidationStatusValues = [
  "NOT_VALIDATED",
  "VALIDATED",
  "CORRECTION_SUGGESTED",
  "INCOMPLETE",
  "UNAVAILABLE",
  "MANUALLY_CONFIRMED"
] as const;
export type AddressBookValidationStatus = (typeof addressBookValidationStatusValues)[number];

export interface AddressBookPostalAddress {
  countryCode: string;
  countryName: string;
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  postcode: string;
}

export interface IAddressBookEntry extends mongoose.Document, AddressBookPostalAddress {
  businessAccountId: mongoose.Types.ObjectId;
  type: AddressBookEntryType;
  label: string;
  isFavourite: boolean;
  companyName?: string;
  contactName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  aadhaarNumberEncrypted: string;
  aadhaarNumberMasked: string;
  instructions?: string;
  providerPlaceId?: string;
  validationStatus: AddressBookValidationStatus;
  validationProvider?: string;
  validationMessage?: string;
  suggestedAddress?: AddressBookPostalAddress | null;
  validatedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const postalAddressSchema = new mongoose.Schema<AddressBookPostalAddress>(
  {
    countryCode: { type: String, uppercase: true, trim: true, minlength: 2, maxlength: 2, required: true },
    countryName: { type: String, trim: true, maxlength: 80, required: true },
    addressLine1: { type: String, uppercase: true, trim: true, maxlength: 120, required: true },
    addressLine2: { type: String, uppercase: true, trim: true, maxlength: 120, default: "" },
    townOrCity: { type: String, uppercase: true, trim: true, maxlength: 80, required: true },
    county: { type: String, uppercase: true, trim: true, maxlength: 80, default: "" },
    postcode: { type: String, uppercase: true, trim: true, maxlength: 20, required: true }
  },
  { _id: false }
);

const addressBookEntrySchema = new mongoose.Schema<IAddressBookEntry>(
  {
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, immutable: true, index: true },
    type: { type: String, enum: addressBookEntryTypeValues, required: true, index: true },
    label: { type: String, trim: true, maxlength: 80, required: true },
    isFavourite: { type: Boolean, default: false, index: true },
    companyName: { type: String, uppercase: true, trim: true, maxlength: 120, default: "" },
    contactName: { type: String, uppercase: true, trim: true, maxlength: 120, required: true },
    email: { type: String, lowercase: true, trim: true, maxlength: 160, required: true },
    mobileCountryCode: { type: String, trim: true, maxlength: 8, required: true },
    mobileNumber: { type: String, trim: true, maxlength: 30, required: true },
    aadhaarNumberEncrypted: { type: String, default: "", select: false },
    aadhaarNumberMasked: { type: String, trim: true, maxlength: 14, default: "" },
    countryCode: postalAddressSchema.path("countryCode"),
    countryName: postalAddressSchema.path("countryName"),
    addressLine1: postalAddressSchema.path("addressLine1"),
    addressLine2: postalAddressSchema.path("addressLine2"),
    townOrCity: postalAddressSchema.path("townOrCity"),
    county: postalAddressSchema.path("county"),
    postcode: postalAddressSchema.path("postcode"),
    instructions: { type: String, uppercase: true, trim: true, maxlength: 500, default: "" },
    providerPlaceId: { type: String, trim: true, maxlength: 255, default: "" },
    validationStatus: { type: String, enum: addressBookValidationStatusValues, default: "NOT_VALIDATED", index: true },
    validationProvider: { type: String, trim: true, maxlength: 40, default: "" },
    validationMessage: { type: String, trim: true, maxlength: 500, default: "" },
    suggestedAddress: { type: postalAddressSchema, default: null },
    validatedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

addressBookEntrySchema.index({ businessAccountId: 1, deletedAt: 1, isFavourite: -1, updatedAt: -1 });
addressBookEntrySchema.index({ businessAccountId: 1, deletedAt: 1, type: 1, updatedAt: -1 });
addressBookEntrySchema.index({ businessAccountId: 1, label: 1 });

export const AddressBookEntry = mongoose.model<IAddressBookEntry>("AddressBookEntry", addressBookEntrySchema);
