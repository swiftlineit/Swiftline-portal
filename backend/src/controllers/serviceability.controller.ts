import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { checkServiceability } from "../services/serviceability.service.js";
import { accountRateCardScope } from "../services/rateCardScope.service.js";

const querySchema = z.object({
  destinationCountryCode: z.string().trim().length(2),
  destinationPostcode: z.string().trim().max(20).optional().default(""),
  weightKg: z.coerce.number().min(0).max(100_000).optional()
});

/**
 * Serviceability for the caller's own commercial band.
 *
 * The band comes from their account rather than the request: weight bands and
 * remote-area lists are per band, so answering against any other one would
 * describe a service this customer is not on.
 */
export async function checkClientServiceability(request: Request, response: Response): Promise<Response> {
  const userId = (request as Request & { user?: { _id?: unknown } }).user?._id;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Choose a destination country to check." });
  }

  const membership = await BusinessAccountMember.findOne({ user: userId, status: "active" })
    .select("businessAccount")
    .lean()
    .exec();
  if (!membership) {
    return response.status(403).json({ success: false, message: "No active business account is available for your login." });
  }

  const account = await BusinessAccount.findById(membership.businessAccount).select("rateCardBand privateRateCardVersion privateRateCardReady").lean().exec();
  if (!account || (account.privateRateCardVersion != null ? !account.privateRateCardReady : !account.rateCardBand)) {
    return response.status(409).json({
      success: false,
      message: "A rate card must be assigned to your account before serviceability can be checked."
    });
  }

  return response.status(200).json({
    success: true,
    result: await checkServiceability({ ...parsed.data, scope: accountRateCardScope(account) })
  });
}
