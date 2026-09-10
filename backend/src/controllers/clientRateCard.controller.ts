import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { CountryRateCard, type InternalRateCardBand } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

/** Returns only the signed-in client's assigned commercial card. */
export async function listClientCountryRateCards(request: Request, response: Response): Promise<Response> {
  const actor = userId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });

  const requestedAccount = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  if (requestedAccount && !mongoose.Types.ObjectId.isValid(requestedAccount)) {
    return response.status(400).json({ success: false, message: "Select a valid business account." });
  }

  const membership = await BusinessAccountMember.findOne({
    user: actor,
    status: "active",
    ...(requestedAccount ? { businessAccount: requestedAccount } : {})
  }).populate("businessAccount", "rateCardBand").exec();

  const account = membership?.businessAccount as unknown as { rateCardBand?: InternalRateCardBand | null } | undefined;
  if (!membership) {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }
  if (!account?.rateCardBand) {
    return response.status(200).json({
      success: true,
      title: "Your Swiftline Rate Card",
      rateCardAssigned: false,
      rates: [],
      routeCharges: []
    });
  }

  const [rates, routeCharges] = await Promise.all([
    CountryRateCard.find({ band: account.rateCardBand })
      .select("-band -createdBy -updatedBy")
      .sort({ countryName: 1, service: 1, fromKg: 1 })
      .lean().exec(),
    CountryRouteCharge.find({ band: account.rateCardBand })
      .select("-band -createdBy -updatedBy")
      .sort({ countryCode: 1, service: 1 })
      .lean().exec()
  ]);

  return response.status(200).json({
    success: true,
    title: "Your Swiftline Rate Card",
    rateCardAssigned: true,
    rates,
    routeCharges
  });
}
