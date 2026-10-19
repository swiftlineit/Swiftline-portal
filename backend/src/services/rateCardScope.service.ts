import mongoose from "mongoose";
import type { Request } from "express";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard, type RateCardBand } from "../models/countryRateCard.model.js";
import { allowedBranchIds } from "../middleware/branchAccess.middleware.js";

/** The owning account is the permanent card identity. Legacy bands are read-only. */
export type RateCardScope = { businessAccountId?: string | mongoose.Types.ObjectId | null; band?: RateCardBand | null };

export class RateCardScopeError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = "RATE_CARD_SCOPE_INVALID",
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RateCardScopeError";
  }
}

export function rateCardFilter(scope: RateCardScope): Record<string, unknown> {
  if (scope.businessAccountId) return { businessAccountId: new mongoose.Types.ObjectId(String(scope.businessAccountId)) };
  if (scope.band) return { band: scope.band, businessAccountId: null };
  throw new RateCardScopeError("Select a business account or Individual Clients.");
}

export function accountRateCardScope(account: {
  _id?: unknown; accountKind?: string; rateCardBand?: RateCardBand | null; privateRateCardVersion?: number | null;
}): RateCardScope {
  if (account.accountKind === "INDIVIDUAL_SENTINEL") return { band: "BAND_D" };
  if (account.privateRateCardVersion == null && account.rateCardBand) return { band: account.rateCardBand };
  if (!account._id || !mongoose.Types.ObjectId.isValid(String(account._id))) {
    throw new RateCardScopeError("Business account was not found.", 404);
  }
  return { businessAccountId: String(account._id) };
}

/** Use for every staff read/write, including imports, downloads and direct row IDs. */
export async function managedRateCardScope(request: Request, scope: RateCardScope, write = false): Promise<RateCardScope> {
  if (!scope.businessAccountId) {
    if (scope.band && scope.band !== "BAND_D") {
      throw new RateCardScopeError("Shared business bands are archived. Select a business account's private rate card.", 409, "LEGACY_RATE_CARD_READ_ONLY");
    }
    return { band: "BAND_D" };
  }
  if (!mongoose.Types.ObjectId.isValid(String(scope.businessAccountId)) || scope.band) {
    throw new RateCardScopeError("Select a valid business account rate card.");
  }
  const branches = allowedBranchIds(request);
  const account = await BusinessAccount.findOne({
    _id: scope.businessAccountId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" },
    ...(branches === null ? {} : { assignedBranch: { $in: branches } })
  }).select("rateCardBand privateRateCardVersion").lean().exec();
  if (!account) throw new RateCardScopeError("Business account was not found.", 404, "RATE_CARD_ACCOUNT_NOT_FOUND");
  if (account.privateRateCardVersion == null && account.rateCardBand) {
    if (write) throw new RateCardScopeError("This account's rates must be copied by the private rate-card migration before editing.", 409, "PRIVATE_RATE_CARD_MIGRATION_REQUIRED");
    return { band: account.rateCardBand };
  }
  return { businessAccountId: String(account._id) };
}

/** Called in the same transaction as the rates, so readiness/version cannot drift. */
export async function touchPrivateRateCard(scope: RateCardScope, session: mongoose.ClientSession) {
  if (!scope.businessAccountId) return;
  const ready = Boolean(await CountryRateCard.exists(rateCardFilter(scope)).session(session).exec());
  await BusinessAccount.updateOne({ _id: scope.businessAccountId, accountKind: { $ne: "INDIVIDUAL_SENTINEL" } }, {
    $inc: { privateRateCardVersion: 1 }, $set: { privateRateCardReady: ready }
  }, { session }).exec();
}
