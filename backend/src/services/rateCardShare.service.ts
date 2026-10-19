import crypto from "crypto";
import { rateCardFilter, type RateCardScope } from "./rateCardScope.service.js";
import mongoose from "mongoose";
import { CountryRateCard, type CountryRateService, type RateCardBand } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import {
  RateCardShare,
  type IRateCardShare,
  type IRateCardShareRow,
  type IRateCardShareRouteCharge,
  type RateCardAdjustmentMode
} from "../models/rateCardShare.model.js";
import { RateCardShareCounter } from "../models/rateCardShareCounter.model.js";

export class RateCardShareError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "RateCardShareError";
  }
}

/** Matches the financial-year numbering used by quotes and invoices. */
function getFinancialYear(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit"
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

async function nextShareNumber(now: Date) {
  const financialYear = getFinancialYear(now);
  const counter = await RateCardShareCounter.findOneAndUpdate(
    { financialYear },
    { $inc: { sequence: 1 }, $setOnInsert: { financialYear } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).exec();
  if (!counter) throw new RateCardShareError("A rate card share number could not be generated. Please try again.", 500);
  return `RC/${financialYear}/${String(counter.sequence).padStart(5, "0")}`;
}

/** Rates are rupees-per-kg, not minor units, so two decimals is the contract. */
function roundRate(value: number) {
  return Math.round(value * 100) / 100;
}

export function rateCardDisplayAmount(input: {
  chargesPerKg: number;
  gstTreatment?: "INCLUDED" | "EXCLUDED";
  gstRatePercent?: number;
}) {
  // `chargesPerKg` is the amount entered on the rate card. GST treatment
  // describes that amount; it must never change it in customer-facing output.
  return roundRate(input.chargesPerKg);
}

export function rateCardGstLabel(input: { gstTreatment?: "INCLUDED" | "EXCLUDED"; gstRatePercent?: number }) {
  const percent = input.gstTreatment === "INCLUDED" ? input.gstRatePercent ?? 0 : 0;
  return input.gstTreatment === "INCLUDED"
    ? `GST included${percent ? ` (${percent}%)` : ""}`
    : "GST excluded";
}

/** The selected validity date is inclusive in the portal's India timezone. */
export function endOfShareValidityDay(date: Date) {
  const end = new Date(date);
  end.setUTCHours(18, 29, 59, 999);
  return end;
}

/**
 * A positive value marks up, a negative one discounts. The result is floored at
 * zero so an over-large discount cannot produce a negative rate on the sheet.
 */
export function applyAdjustment(baseRate: number, mode: RateCardAdjustmentMode, value: number) {
  if (mode === "NONE" || !value) return roundRate(baseRate);
  const adjusted = mode === "PERCENT" ? baseRate * (1 + value / 100) : baseRate + value;
  return roundRate(Math.max(adjusted, 0));
}

export type RateCardSelection = {
  countryCodes: string[];
  services: string[];
  /** Specific rate ids. When present, the country/service filters are ignored. */
  rateIds: string[];
};

/**
 * Reads the live rate card and freezes the selection into share rows. Called
 * once, at share time- nothing here re-reads the rate card afterwards, which is
 * what makes the share immutable.
 */
export async function buildRateCardSnapshot(
  band: RateCardBand | RateCardScope,
  selection: RateCardSelection,
  adjustmentMode: RateCardAdjustmentMode,
  adjustmentValue: number
): Promise<IRateCardShareRow[]> {
  const filters: Record<string, unknown> = rateCardFilter(typeof band === "string" ? { band } : band);
  let requestedRateIds: string[] = [];

  if (selection.rateIds.length) {
    requestedRateIds = [...new Set(selection.rateIds)];
    if (requestedRateIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      throw new RateCardShareError("One or more selected rates are invalid.", 400);
    }
    filters._id = { $in: requestedRateIds };
  } else {
    if (selection.countryCodes.length) filters.countryCode = { $in: selection.countryCodes.map((code) => code.toUpperCase()) };
    if (selection.services.length) filters.service = { $in: selection.services.map((service) => service.toUpperCase()) };
  }

  const rates = await CountryRateCard.find(filters)
    .sort({ countryName: 1, service: 1, fromKg: 1 })
    .lean()
    .exec();

  if (requestedRateIds.length && rates.length !== requestedRateIds.length) {
    throw new RateCardShareError("One or more selected rates do not belong to the selected rate card.", 409);
  }
  if (!rates.length) throw new RateCardShareError("No rates match the selection. Add rates or widen the filter before sharing.", 400);

  return rates.map((rate) => ({
    countryCode: rate.countryCode,
    countryName: rate.countryName,
    service: rate.service,
    fromKg: rate.fromKg,
    toKg: rate.toKg,
    baseChargesPerKg: roundRate(rate.chargesPerKg),
    chargesPerKg: applyAdjustment(rate.chargesPerKg, adjustmentMode, adjustmentValue),
    maxBoxKg: rate.maxBoxKg,
    gstTreatment: rate.gstTreatment ?? "EXCLUDED",
    gstRatePercent: rate.gstRatePercent ?? 0
  }));
}

/** Freezes every selected route's band-specific commercial charges. */
export async function buildRateCardRouteChargeSnapshot(
  band: RateCardBand | RateCardScope,
  rows: IRateCardShareRow[]
): Promise<IRateCardShareRouteCharge[]> {
  const routes = new Map<string, { countryCode: string; service: CountryRateService }>();
  for (const row of rows) routes.set(`${row.countryCode}:${row.service}`, {
    countryCode: row.countryCode,
    service: row.service
  });

  // Include saved route-only entries too, not just routes currently represented
  // by a weight slab. A complete share freezes the entire card configuration.
  const configured = await CountryRouteCharge.find(
    rateCardFilter(typeof band === "string" ? { band } : band)
  ).sort({ countryCode: 1, service: 1 }).lean().exec();
  for (const item of configured) routes.set(`${item.countryCode}:${item.service}`, {
    countryCode: item.countryCode,
    service: item.service
  });

  const byRoute = new Map(configured.map((item) => [`${item.countryCode}:${item.service}`, item]));

  return [...routes.values()].map((route) => {
    const item = byRoute.get(`${route.countryCode}:${route.service}`);
    return {
      ...route,
      fuelSurchargePercent: item?.fuelSurchargePercent ?? 0,
      remoteAreaCharge: item?.remoteAreaCharge ?? 0,
      remoteAreaPostcodes: item?.remoteAreaPostcodes ?? [],
      handlingCharge: item?.handlingCharge ?? 0,
      insurancePercent: item?.insurancePercent ?? 0,
      insuranceMinimum: item?.insuranceMinimum ?? 0,
      discountPercent: item?.discountPercent ?? 0
    };
  });
}

export function hashShareToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createShareToken() {
  // 32 bytes of entropy: the link is the only credential an emailed or
  // WhatsApped recipient holds, so it has to resist offline guessing.
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashShareToken(token) };
}

/**
 * Constant-time comparison so a token cannot be recovered by timing the
 * public endpoint one character at a time.
 */
export function shareTokenMatches(candidate: string, storedHash: string) {
  const candidateHash = Buffer.from(hashShareToken(candidate), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidateHash.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidateHash, stored);
}

export function isShareOpen(share: Pick<IRateCardShare, "status" | "publicTokenExpiresAt">, now = new Date()) {
  return share.status === "ACTIVE" && share.publicTokenExpiresAt.getTime() > now.getTime();
}

export function buildPublicShareUrl(appUrl: string, shareId: string, token: string) {
  return `${appUrl.replace(/\/+$/, "")}/rate-card/${shareId}?token=${encodeURIComponent(token)}`;
}

export async function generateShareNumber(now = new Date()) {
  return nextShareNumber(now);
}

type SerializeOptions = {
  /** Client and public viewers must never see the pre-adjustment rate. */
  includeBaseRates?: boolean;
  currentUserId?: string;
};

export function serializeRateCardShare(share: IRateCardShare, options: SerializeOptions = {}) {
  const now = new Date();

  return {
    id: String(share._id),
    shareNumber: share.shareNumber,
    title: share.title,
    currency: share.currency,
    channels: share.channels,
    status: share.status,
    expired: share.publicTokenExpiresAt.getTime() <= now.getTime(),
    rows: share.rows.map((row) => ({
      countryCode: row.countryCode,
      countryName: row.countryName,
      service: row.service,
      fromKg: row.fromKg,
      toKg: row.toKg,
      chargesPerKg: row.chargesPerKg,
      maxBoxKg: row.maxBoxKg,
      gstTreatment: row.gstTreatment ?? "EXCLUDED",
      gstRatePercent: row.gstRatePercent ?? 0,
      ...(options.includeBaseRates ? { baseChargesPerKg: row.baseChargesPerKg } : {})
    })),
    routeCharges: share.routeCharges ?? [],
    documentType: share.adjustmentMode === "NONE" ? "RATE_CARD" : "EXTERNAL_PROPOSAL",
    ...(options.includeBaseRates
      ? { band: share.band, businessAccountId: share.businessAccountId ? String(share.businessAccountId) : undefined, privateRateCardVersion: share.privateRateCardVersion, adjustmentMode: share.adjustmentMode, adjustmentValue: share.adjustmentValue }
      : {}),
    terms: {
      validFrom: share.terms.validFrom,
      validUntil: share.terms.validUntil,
      fuelSurchargePercent: share.terms.fuelSurchargePercent,
      gstPercent: share.terms.gstPercent,
      minChargeableWeightKg: share.terms.minChargeableWeightKg,
      volumetricDivisor: share.terms.volumetricDivisor,
      remarks: share.terms.remarks,
      customTerms: share.terms.customTerms
    },
    recipientAccounts: share.recipientAccounts.map((account) => ({
      businessAccountId: String(account.businessAccountId),
      companyName: account.companyName
    })),
    recipientEmails: share.recipientEmails,
    recipientPhones: share.recipientPhones,
    publicViewCount: share.publicViewCount,
    lastViewedAt: share.lastViewedAt ?? null,
    expiresAt: share.publicTokenExpiresAt,
    readAt: options.currentUserId
      ? share.readBy.find((entry) => String(entry.userId) === options.currentUserId)?.readAt ?? null
      : null,
    createdAt: share.createdAt
  };
}

export type SerializedRateCardShare = ReturnType<typeof serializeRateCardShare>;

/** Idempotent: re-opening an already-read share leaves the original timestamp. */
export async function markRateCardShareRead(shareId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) {
  await RateCardShare.updateOne(
    { _id: shareId, "readBy.userId": { $ne: userId } },
    { $push: { readBy: { userId, readAt: new Date() } } }
  ).exec();
}

export async function recordPublicShareView(shareId: mongoose.Types.ObjectId) {
  await RateCardShare.updateOne(
    { _id: shareId },
    { $inc: { publicViewCount: 1 }, $set: { lastViewedAt: new Date() } }
  ).exec();
}

/**
 * Groups rows by country then service so the PDF and the workbook lay slabs out
 * the same way, and a reader comparing the two never has to re-sort.
 */
export function groupShareRows(rows: IRateCardShareRow[]) {
  const groups = new Map<string, { countryCode: string; countryName: string; service: string; rows: IRateCardShareRow[] }>();

  for (const row of rows) {
    const key = `${row.countryCode}:${row.service}`;
    const group = groups.get(key)
      ?? { countryCode: row.countryCode, countryName: row.countryName, service: row.service, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((first, second) => first.fromKg - second.fromKg) }))
    .sort((first, second) => first.countryName.localeCompare(second.countryName) || first.service.localeCompare(second.service));
}

export function formatShareService(service: string) {
  return service.charAt(0) + service.slice(1).toLowerCase();
}

export function shareDocumentBasename(
  share: Pick<IRateCardShare, "shareNumber" | "adjustmentMode">
) {
  const documentName = share.adjustmentMode === "NONE" ? "Rate-Card" : "External-Proposal";
  return `Swiftline-${documentName}-${share.shareNumber.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * The "Prepared for" line on the documents. A share aimed at exactly one
 * business account is named; a broadcast to several is not, because printing
 * one customer's name on the sheet the others received would leak the
 * relationship.
 */
export function resolveShareRecipientLabel(share: Pick<IRateCardShare, "recipientAccounts" | "recipientEmails" | "recipientPhones">) {
  const onlyAccount = share.recipientAccounts.length === 1
    && !share.recipientEmails.length
    && !share.recipientPhones.length;
  if (onlyAccount) return share.recipientAccounts[0]?.companyName || "Valued Customer";

  const onlyEmail = !share.recipientAccounts.length
    && share.recipientEmails.length === 1
    && !share.recipientPhones.length;
  if (onlyEmail) return share.recipientEmails[0]?.name || "Valued Customer";

  return "Valued Customer";
}
