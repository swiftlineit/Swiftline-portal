import mongoose from "mongoose";

export interface IPickupCourierAddress extends mongoose.Document {
  branchId: mongoose.Types.ObjectId;
  companyName: string;
  companyKey: string;
  address: {
    addressLine1: string;
    addressLine2: string;
    townOrCity: string;
    county: string;
    postcode: string;
    countryCode: string;
    countryName: string;
    googlePlaceId: string;
  };
  contact: { name: string; phone: string };
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const pickupCourierAddressSchema = new mongoose.Schema<IPickupCourierAddress>({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
  companyName: { type: String, required: true, trim: true, maxlength: 120 },
  companyKey: { type: String, required: true, trim: true, maxlength: 120 },
  address: {
    addressLine1: { type: String, required: true, trim: true, maxlength: 180 },
    addressLine2: { type: String, trim: true, maxlength: 180, default: "" },
    townOrCity: { type: String, required: true, trim: true, maxlength: 100 },
    county: { type: String, trim: true, maxlength: 100, default: "" },
    postcode: { type: String, required: true, trim: true, maxlength: 20 },
    countryCode: { type: String, required: true, trim: true, maxlength: 2 },
    countryName: { type: String, trim: true, maxlength: 100, default: "" },
    googlePlaceId: { type: String, trim: true, maxlength: 300, default: "" }
  },
  contact: {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30, match: /^\d{6,30}$/ }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

pickupCourierAddressSchema.index({ branchId: 1, companyKey: 1 }, { unique: true, name: "pickup_courier_branch_company_unique" });

export const PickupCourierAddress = mongoose.model<IPickupCourierAddress>("PickupCourierAddress", pickupCourierAddressSchema);
