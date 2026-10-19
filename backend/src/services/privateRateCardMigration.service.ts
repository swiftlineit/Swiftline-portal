import crypto from "node:crypto";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard, type RateCardBand } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { rateCardFilter } from "./rateCardScope.service.js";

const rateFields = ["countryCode", "countryName", "service", "fromKg", "toKg", "chargesPerKg", "maxBoxKg", "gstTreatment", "gstRatePercent", "gstApplyToAllRates"] as const;
const chargeFields = ["countryCode", "service", "fuelSurchargePercent", "remoteAreaCharge", "remoteAreaPostcodes", "handlingCharge", "insurancePercent", "insuranceMinimum", "discountPercent"] as const;
type Row = Partial<Record<(typeof rateFields)[number] | (typeof chargeFields)[number] | "createdBy" | "updatedBy" | "createdAt" | "updatedAt", unknown>>;

export function commercialRateData(row: Row) {
  return Object.fromEntries(rateFields.map((key) => [key, row[key] ?? (key === "gstTreatment" ? "EXCLUDED" : key === "gstApplyToAllRates" ? false : key === "gstRatePercent" ? 0 : undefined)]));
}
export function commercialChargeData(row: Row) {
  return Object.fromEntries(chargeFields.map((key) => [key, row[key] ?? (key === "remoteAreaPostcodes" ? [] : 0)]));
}
export function rateCardChecksum(rates: Row[], charges: Row[]) {
  const stable = (rows: Row[], project: (row: Row) => Row) => rows.map((row) => JSON.stringify(project(row))).sort();
  return crypto.createHash("sha256").update(JSON.stringify({ rates: stable(rates, commercialRateData), charges: stable(charges, commercialChargeData) })).digest("hex");
}

/** Reject ambiguous source data before any account is switched. */
export function assertRateCardSource(rates: Row[], charges: Row[]) {
  const routes = new Map<string, Row[]>();
  for (const rate of rates) {
    if (typeof rate.countryCode !== "string" || !/^[A-Z]{2}$/.test(rate.countryCode) || !["COURIER", "CARGO"].includes(String(rate.service))) throw new Error("Invalid source route.");
    for (const key of ["fromKg", "toKg", "chargesPerKg", "maxBoxKg"] as const) {
      if (typeof rate[key] !== "number" || !Number.isFinite(rate[key]) || Number(rate[key]) < 0) throw new Error("Invalid source rate: " + key);
    }
    if (Number(rate.toKg) < Number(rate.fromKg) || Number(rate.toKg) <= 0 || Number(rate.maxBoxKg) <= 0) throw new Error("Invalid source weight range.");
    if (!["INCLUDED", "EXCLUDED"].includes(String(rate.gstTreatment ?? "EXCLUDED"))
      || typeof (rate.gstRatePercent ?? 0) !== "number"
      || !Number.isFinite(rate.gstRatePercent ?? 0)
      || Number(rate.gstRatePercent ?? 0) < 0 || Number(rate.gstRatePercent ?? 0) > 100) {
      throw new Error("Invalid source GST settings.");
    }
    const key = String(rate.countryCode) + ":" + String(rate.service);
    routes.set(key, [...(routes.get(key) ?? []), rate]);
  }
  for (const [key, rows] of routes) {
    rows.sort((a, b) => Number(a.fromKg) - Number(b.fromKg));
    for (let index = 1; index < rows.length; index++) {
      if (Number(rows[index]!.fromKg) <= Number(rows[index - 1]!.toKg)) throw new Error("Overlapping source slabs: " + key);
    }
  }
  const chargeKeys = new Set<string>();
  for (const charge of charges) {
    if (typeof charge.countryCode !== "string" || !/^[A-Z]{2}$/.test(charge.countryCode) || !["COURIER", "CARGO"].includes(String(charge.service))) throw new Error("Invalid source charge route.");
    for (const key of ["fuelSurchargePercent", "remoteAreaCharge", "handlingCharge", "insurancePercent", "insuranceMinimum", "discountPercent"] as const) {
      const amount = charge[key] ?? 0;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new Error("Invalid source route charge: " + key);
    }
    const key = String(charge.countryCode) + ":" + String(charge.service);
    for (const percent of ["fuelSurchargePercent", "insurancePercent", "discountPercent"] as const) {
      if (Number(charge[percent] ?? 0) > 100) throw new Error("Invalid source route percentage: " + percent);
    }
    const prefixes = charge.remoteAreaPostcodes ?? [];
    if (!Array.isArray(prefixes) || prefixes.length > 500
      || prefixes.some((prefix) => typeof prefix !== "string" || prefix.length > 20)) {
      throw new Error("Invalid source remote area postcodes.");
    }
    if (chargeKeys.has(key)) throw new Error("Duplicate source route charges: " + key);
    chargeKeys.add(key);
  }
}

export async function auditPrivateRateCardAccount(accountId: mongoose.Types.ObjectId) {
  const account = await BusinessAccount.findOne({ _id: accountId, accountKind: { $ne: "INDIVIDUAL_SENTINEL" } }).lean().exec();
  if (!account) throw new Error("Business account was not found.");
  if (account.privateRateCardVersion != null) {
    const [rates, charges] = await Promise.all([
      CountryRateCard.find(rateCardFilter({ businessAccountId: account._id })).lean().exec(),
      CountryRouteCharge.find(rateCardFilter({ businessAccountId: account._id })).lean().exec()
    ]);
    assertRateCardSource(rates, charges);
    if (!Number.isInteger(account.privateRateCardVersion) || account.privateRateCardVersion < 0
      || account.privateRateCardReady !== (rates.length > 0)) {
      throw new Error(account.accountId + ": private-card version/readiness does not match its stored rates.");
    }
    return { accountId: account.accountId, id: String(account._id), state: "ALREADY_PRIVATE", rates: rates.length,
      charges: charges.length, checksum: rateCardChecksum(rates, charges) };
  }
  if (account.rateCardBand === "BAND_D") throw new Error(account.accountId + ": a business account has the reserved individual band.");
  const scope = account.rateCardBand ? { band: account.rateCardBand } : null;
  const [rates, charges, existingRates, existingCharges] = await Promise.all([
    scope ? CountryRateCard.find(rateCardFilter(scope)).lean().exec() : [],
    scope ? CountryRouteCharge.find(rateCardFilter(scope)).lean().exec() : [],
    CountryRateCard.countDocuments({ businessAccountId: account._id }).exec(),
    CountryRouteCharge.countDocuments({ businessAccountId: account._id }).exec()
  ]);
  if (existingRates || existingCharges) throw new Error(account.accountId + ": unexpected private data exists without a migration marker; review before applying.");
  if (scope && !rates.length) throw new Error(account.accountId + ": assigned legacy card has no rates.");
  assertRateCardSource(rates, charges);
  return { accountId: account.accountId, id: String(account._id), state: scope ? "COPY" : "EMPTY", sourceBand: account.rateCardBand ?? null,
    rates: rates.length, charges: charges.length, checksum: rateCardChecksum(rates, charges) };
}

/** Explicit migration only. It never runs from a page view, pricing or booking. */
export async function migratePrivateRateCardAccount(accountId: mongoose.Types.ObjectId, expectedChecksum: string, actorId: mongoose.Types.ObjectId) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await BusinessAccount.findOne({ _id: accountId, accountKind: { $ne: "INDIVIDUAL_SENTINEL" } }).session(session).lean().exec();
      if (!account) throw new Error("Business account was not found.");
      if (account.privateRateCardVersion != null) return;
      if (account.rateCardBand === "BAND_D") throw new Error("Individual Clients cannot be assigned to a business.");
      const band = account.rateCardBand as RateCardBand | null | undefined;
      const rates = band ? await CountryRateCard.find(rateCardFilter({ band })).session(session).lean().exec() : [];
      const charges = band ? await CountryRouteCharge.find(rateCardFilter({ band })).session(session).lean().exec() : [];
      assertRateCardSource(rates, charges);
      if (rateCardChecksum(rates, charges) !== expectedChecksum) throw new Error("Source rates changed since the audit. Run the audit again.");
      if (await CountryRateCard.exists({ businessAccountId: account._id }).session(session).exec()
        || await CountryRouteCharge.exists({ businessAccountId: account._id }).session(session).exec()) {
        throw new Error("Private records already exist without a migration marker.");
      }
      const metadata = (row: Row) => ({ businessAccountId: account._id, createdBy: row.createdBy ?? actorId, updatedBy: row.updatedBy ?? row.createdBy ?? actorId,
        createdAt: row.createdAt ?? new Date(), updatedAt: row.updatedAt ?? new Date() });
      if (rates.length) await CountryRateCard.insertMany(rates.map((row) => ({ ...commercialRateData(row), ...metadata(row) })), { session, timestamps: false });
      if (charges.length) await CountryRouteCharge.insertMany(charges.map((row) => ({ ...commercialChargeData(row), ...metadata(row) })), { session, timestamps: false });
      const copiedRates = await CountryRateCard.find({ businessAccountId: account._id }).session(session).lean().exec();
      const copiedCharges = await CountryRouteCharge.find({ businessAccountId: account._id }).session(session).lean().exec();
      if (rateCardChecksum(copiedRates, copiedCharges) !== expectedChecksum) throw new Error("Copied rate-card verification failed.");
      await BusinessAccount.updateOne({ _id: account._id, privateRateCardVersion: null }, {
        $set: { privateRateCardVersion: 1, privateRateCardReady: copiedRates.length > 0 }
      }, { session }).exec();
      await AuditLog.create([{ action: "BUSINESS_ACCOUNT_RATE_CARD_MIGRATED", entityType: "BUSINESS_ACCOUNT", entityId: account._id,
        performedBy: actorId, performedAt: new Date(), metadata: { sourceBand: band ?? null, rates: rates.length, routeCharges: charges.length, checksum: expectedChecksum }
      }], { session });
    });
  } finally { await session.endSession(); }
}
