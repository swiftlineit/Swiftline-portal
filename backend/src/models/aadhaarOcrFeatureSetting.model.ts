import mongoose from "mongoose";

export const AADHAAR_OCR_FEATURE_SETTING_ID = new mongoose.Types.ObjectId("00000000000000a0c5a0c501");

export interface IAadhaarOcrFeatureSetting extends mongoose.Document {
  enabled: boolean;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const aadhaarOcrFeatureSettingSchema = new mongoose.Schema<IAadhaarOcrFeatureSetting>(
  {
    enabled: { type: Boolean, default: false, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export const AadhaarOcrFeatureSetting = mongoose.model<IAadhaarOcrFeatureSetting>(
  "AadhaarOcrFeatureSetting",
  aadhaarOcrFeatureSettingSchema,
);
