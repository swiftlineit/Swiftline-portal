import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { CountryRateCard, type RateCardBand } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { accountRateCardScope, rateCardFilter } from "../services/rateCardScope.service.js";
import { availableClientAccountIds, suspensionMode } from "../services/businessAccountSuspension.service.js";

function userId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

type ClientRateCardAccount = {
  _id: unknown;
  status?: string;
  suspension?: { mode?: "OPERATIONAL_HOLD" | "SECURITY_LOCK" } | null;
  company?: { companyName?: string };
  rateCardBand?: RateCardBand | null;
  privateRateCardVersion?: number | null;
  privateRateCardReady?: boolean;
};

async function returnClientRateCard(account: ClientRateCardAccount | null | undefined, response: Response, fallbackTitle: string) {
  if (account && suspensionMode(account) === "SECURITY_LOCK") {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }
  const title = account?.company?.companyName ? `${account.company.companyName} Rate Card` : fallbackTitle;
  if (!account || (account.privateRateCardVersion != null ? !account.privateRateCardReady : !account.rateCardBand)) {
    return response.status(200).json({
      success: true,
      title,
      rateCardAssigned: false,
      rates: [],
      routeCharges: []
    });
  }

  const [rates, routeCharges] = await Promise.all([
    CountryRateCard.find(rateCardFilter(accountRateCardScope(account)))
      .select("-band -businessAccountId -createdBy -updatedBy")
      .sort({ countryName: 1, service: 1, fromKg: 1 })
      .lean().exec(),
    CountryRouteCharge.find(rateCardFilter(accountRateCardScope(account)))
      .select("-band -businessAccountId -createdBy -updatedBy")
      .sort({ countryCode: 1, service: 1 })
      .lean().exec()
  ]);

  return response.status(200).json({ success: true, title, rateCardAssigned: true, rates, routeCharges });
}

/** Returns only the signed-in client's privately owned commercial card. */
export async function listClientCountryRateCards(request: Request, response: Response): Promise<Response> {
  const actor = userId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });

  const requestedAccount = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  if (requestedAccount && !mongoose.Types.ObjectId.isValid(requestedAccount)) {
    return response.status(400).json({ success: false, message: "Select a valid business account." });
  }

  const candidateMemberships = await BusinessAccountMember.find({
    user: actor,
    status: "active",
    ...(requestedAccount ? { businessAccount: requestedAccount } : {})
  }).select("businessAccount").lean().exec();
  const availableIds = await availableClientAccountIds(
    candidateMemberships.map((membership) => membership.businessAccount as mongoose.Types.ObjectId)
  );
  const membership = availableIds.length
    ? await BusinessAccountMember.findOne({ user: actor, status: "active", businessAccount: { $in: availableIds } })
      .populate("businessAccount", "status suspension.mode rateCardBand privateRateCardVersion privateRateCardReady company.companyName")
      .exec()
    : null;

  if (!membership) {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }
  const account = membership.businessAccount as unknown as ClientRateCardAccount | null;
  return returnClientRateCard(account, response, "Your Swiftline Rate Card");
}

/** Resolves an operator client's one active account from their verified tenant membership. */
export async function listOperatorClientCountryRateCards(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const actor = userId(request);
  if (!context || context.role !== "CLIENT" || !actor) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const membership = await BusinessAccountMember.findOne({
    tenantId: context.tenantId,
    user: actor,
    status: "active"
  }).select("businessAccount").lean().exec();
  if (!membership) {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }

  const account = await BusinessAccount.findOne({
    _id: membership.businessAccount,
    tenantId: context.tenantId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
  }).select("status suspension.mode company.companyName rateCardBand privateRateCardVersion privateRateCardReady").lean().exec();
  if (!account) {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }

  return returnClientRateCard(account, response, "Your operator rate card");
}
