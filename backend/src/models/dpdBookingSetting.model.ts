import mongoose from "mongoose";

export interface IDpdBookingSetting extends mongoose.Document {
  key: "GLOBAL";
  enabled: boolean;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const dpdBookingSettingSchema = new mongoose.Schema<IDpdBookingSetting>(
  {
    key: { type: String, enum: ["GLOBAL"], default: "GLOBAL", unique: true, required: true },
    enabled: { type: Boolean, default: true, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

export const DpdBookingSetting = mongoose.model<IDpdBookingSetting>(
  "DpdBookingSetting",
  dpdBookingSettingSchema
);
