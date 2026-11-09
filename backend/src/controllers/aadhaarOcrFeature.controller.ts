import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import {
  getAadhaarOcrFeatureStatus,
  setAadhaarOcrFeatureEnabled,
} from "../services/aadhaarOcrFeature.service.js";

const updateSchema = z.object({ enabled: z.boolean() }).strict();

function authenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (request as any).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

export async function getAadhaarOcrFeature(request: Request, response: Response): Promise<Response> {
  const status = await getAadhaarOcrFeatureStatus();
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ success: true, ...status });
}

export async function updateAadhaarOcrFeature(request: Request, response: Response): Promise<Response> {
  const userId = authenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = updateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Choose whether Aadhaar OCR is enabled." });
  }

  const status = await getAadhaarOcrFeatureStatus();
  if (parsed.data.enabled && !status.providerConfigured) {
    return response.status(409).json({
      success: false,
      message: "Configure the backend Surepass token and the selected environment endpoint before enabling Aadhaar OCR.",
    });
  }

  const setting = await setAadhaarOcrFeatureEnabled(parsed.data.enabled, userId);
  if (!setting) return response.status(500).json({ success: false, message: "Aadhaar OCR setting could not be saved." });

  await AuditLog.create({
    action: "AADHAAR_OCR_FEATURE_TOGGLED",
    entityType: "AADHAAR_OCR_FEATURE_SETTING",
    entityId: setting._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { enabled: setting.enabled, providerEnvironment: status.providerEnvironment },
  });

  const refreshedStatus = await getAadhaarOcrFeatureStatus();
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ success: true, ...refreshedStatus });
}
