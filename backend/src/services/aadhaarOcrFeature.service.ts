import mongoose from "mongoose";
import {
  AADHAAR_OCR_FEATURE_SETTING_ID,
  AadhaarOcrFeatureSetting,
} from "../models/aadhaarOcrFeatureSetting.model.js";
import { getSurepassAadhaarOcrConfiguration } from "./surepassAadhaarOcr.service.js";

export type AadhaarOcrFeatureStatus = {
  enabled: boolean;
  providerConfigured: boolean;
  providerEnvironment: "sandbox" | "production";
  updatedAt: string | null;
};

export async function getAadhaarOcrFeatureStatus(): Promise<AadhaarOcrFeatureStatus> {
  const provider = getSurepassAadhaarOcrConfiguration();
  const setting = await AadhaarOcrFeatureSetting.findById(AADHAAR_OCR_FEATURE_SETTING_ID)
    .select("enabled updatedAt")
    .lean()
    .exec();

  return {
    enabled: setting?.enabled === true,
    providerConfigured: provider.configured,
    providerEnvironment: provider.environment,
    updatedAt: setting?.updatedAt instanceof Date ? setting.updatedAt.toISOString() : null,
  };
}

export async function isAadhaarOcrFeatureEnabled(): Promise<boolean> {
  const provider = getSurepassAadhaarOcrConfiguration();
  const setting = await AadhaarOcrFeatureSetting.findById(AADHAAR_OCR_FEATURE_SETTING_ID)
    .select("enabled")
    .lean()
    .exec();
  return setting?.enabled === true && provider.configured;
}

export async function setAadhaarOcrFeatureEnabled(enabled: boolean, userId: mongoose.Types.ObjectId) {
  return AadhaarOcrFeatureSetting.findByIdAndUpdate(
    AADHAAR_OCR_FEATURE_SETTING_ID,
    { $set: { enabled, updatedBy: userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).exec();
}
