import type { Request, Response, NextFunction } from "express";
import { isAadhaarOcrFeatureEnabled } from "../services/aadhaarOcrFeature.service.js";

export async function requireAadhaarOcrFeatureEnabled(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!await isAadhaarOcrFeatureEnabled()) {
      response.status(403).json({ success: false, message: "Aadhaar OCR is currently disabled." });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
