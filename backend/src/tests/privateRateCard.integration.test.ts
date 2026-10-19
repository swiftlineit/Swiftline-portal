import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { RateCardMutationLock } from "../models/rateCardMutationLock.model.js";
import { createCountryRateCard, updateCountryRateCard, deleteCountryRateCard, listCountryRateCards, saveCountryRouteCharge, commitRateCardImport } from "../controllers/countryRateCard.controller.js";
import { auditPrivateRateCardAccount, migratePrivateRateCardAccount } from "../services/privateRateCardMigration.service.js";
import { calculateShipmentPricingEstimate, RateCardRequiredError } from "../services/shipmentPricing.service.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import { buildRateCardSnapshot } from "../services/rateCardShare.service.js";

const dbName = "sl_private_rate_cards_" + Date.now();
const userId = new mongoose.Types.ObjectId();
const branchA = new mongoose.Types.ObjectId();
const branchB = new mongoose.Types.ObjectId();
const ids = { a: new mongoose.Types.ObjectId(), b: new mongoose.Types.ObjectId(), noGst: new mongoose.Types.ObjectId(), empty: new mongoose.Types.ObjectId() };

function req(body: unknown = {}, query: Record<string, unknown> = {}, params: Record<string, string> = {}, role = "admin"): Request {
  return { body, query, params, user: { _id: userId, role, assignedBranches: [branchA] } } as unknown as Request;
}
function recorder() {
  let status = 200;
  let body: Record<string, any> = {};
  const response = { status(value: number) { status = value; return response; }, json(value: Record<string, any>) { body = value; return response; } } as unknown as Response;
  return { response, status: () => status, body: () => body };
}
async function version(id: mongoose.Types.ObjectId) { return (await BusinessAccount.findById(id).lean().exec())!.privateRateCardVersion ?? 0; }
function pricing(id: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
  return calculateShipmentPricingEstimate({ businessAccountId: id, countryCode: "GB", serviceType: "COURIER", parcels: [{ weightKg: 5 }], ...extra });
}
async function copy(id: mongoose.Types.ObjectId) {
  const audit = await auditPrivateRateCardAccount(id);
  if (audit.state !== "ALREADY_PRIVATE") await migratePrivateRateCardAccount(id, audit.checksum!, userId);
}
const chargeInput = { countryCode: "GB", service: "COURIER" as const, fuelSurchargePercent: 10, remoteAreaCharge: 75, remoteAreaPostcodes: "AB", handlingCharge: 25, insurancePercent: 1.5, insuranceMinimum: 125, discountPercent: 5 };

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, dbName);
  await Promise.all([BusinessAccount.init(), CountryRateCard.init(), CountryRouteCharge.init(), AuditLog.init(), RateCardMutationLock.init()]);
  await BusinessAccount.collection.insertMany([
    { _id: ids.a, accountId: "BA-PRIVATE-A", accountKind: "BUSINESS", status: "active", company: { companyName: "Alpha Ltd" }, assignedBranch: branchA, rateCardBand: "BAND_C" },
    { _id: ids.b, accountId: "BA-PRIVATE-B", accountKind: "BUSINESS", status: "active", company: { companyName: "Beta Ltd" }, assignedBranch: branchB, rateCardBand: "BAND_C" },
    { _id: ids.noGst, accountId: "BA-PRIVATE-NO-GST", accountKind: "BUSINESS", status: "active", company: { companyName: "No GST Ltd" }, assignedBranch: branchA, rateCardBand: "BAND_C",
      gstBilling: { requestedTreatment: "NO_GST", status: "APPROVED", effectiveFrom: new Date(), version: 2 } },
    { _id: ids.empty, accountId: "BA-PRIVATE-EMPTY", accountKind: "BUSINESS", status: "active", company: { companyName: "New Ltd" }, assignedBranch: branchA, privateRateCardVersion: 0, privateRateCardReady: false }
  ].map((account, index) => ({ ...account, contact: {
    email: `${account.accountId.toLowerCase()}@example.test`, countryCode: "+91", mobileNumber: `900000000${index}`
  } })));
  await CountryRateCard.create([
    { band: "BAND_C", countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 0, toKg: 10, chargesPerKg: 420, maxBoxKg: 30, gstTreatment: "INCLUDED", gstRatePercent: 18, gstApplyToAllRates: true, createdBy: userId },
    { band: "BAND_C", countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 10.01, toKg: 30, chargesPerKg: 400, maxBoxKg: 30, gstTreatment: "INCLUDED", gstRatePercent: 18, gstApplyToAllRates: true, createdBy: userId },
    { band: "BAND_D", countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 0, toKg: 30, chargesPerKg: 500, maxBoxKg: 30, createdBy: userId }
  ]);
  await CountryRouteCharge.create({ band: "BAND_C", ...chargeInput, remoteAreaPostcodes: ["AB"], createdBy: userId });
});
after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, dbName);
    assert.ok(dbName.startsWith("sl_private_rate_cards_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("copying a shared card preserves money, charges, GST and independent ownership", async () => {
  const before = await pricing(ids.a);
  await copy(ids.a); await copy(ids.b); await copy(ids.noGst);
  const after = await pricing(ids.a);
  assert.equal(after.totalAmount, before.totalAmount);
  assert.equal(after.gstAmount, before.gstAmount);
  assert.deepEqual(after.lines, before.lines);
  assert.equal(after.pricingBasis.businessAccountId, String(ids.a));
  assert.notEqual(buildPricingHash(after), buildPricingHash(before));
  const a = await CountryRateCard.find({ businessAccountId: ids.a }).lean().exec();
  const b = await CountryRateCard.find({ businessAccountId: ids.b }).lean().exec();
  assert.equal(a.length, 2); assert.equal(b.length, 2);
  assert.notEqual(String(a[0]!._id), String(b[0]!._id));
  assert.equal(await CountryRouteCharge.countDocuments({ businessAccountId: ids.a }), 1);
  assert.equal(await CountryRouteCharge.countDocuments({ businessAccountId: ids.b }), 1);
  assert.equal(await CountryRateCard.countDocuments({ band: "BAND_C", businessAccountId: null }), 2);
});

test("normal, approved no-GST and forced-GST pricing keep the commercial total", async () => {
  const normal = await pricing(ids.b);
  const noGst = await pricing(ids.noGst);
  const forced = await pricing(ids.noGst, { forceGst: true });
  assert.equal(normal.totalAmount, noGst.totalAmount);
  assert.equal(noGst.gstAmount, 0);
  assert.equal(forced.totalAmount, normal.totalAmount);
  assert.equal(forced.gstAmount, normal.gstAmount);
  await BusinessAccount.updateOne({ _id: ids.noGst }, { $set: { "gstBilling.status": "PENDING" } });
  assert.equal((await pricing(ids.noGst)).gstAmount, normal.gstAmount);
});

test("route charge edits are atomic, private and invalidate the accepted price lock", async () => {
  const beforeA = await pricing(ids.a);
  const beforeB = await pricing(ids.b);
  const publicInput = { countryCode: "GB", serviceType: "COURIER" as const, rateCardBand: "BAND_D" as const, parcels: [{ weightKg: 5 }] };
  const publicBefore = buildPricingHash(await calculateShipmentPricingEstimate(publicInput));
  const rec = recorder();
  await saveCountryRouteCharge(req({ ...chargeInput, services: ["COURIER", "CARGO"], handlingCharge: 150, businessAccountId: String(ids.a), expectedVersion: await version(ids.a) }), rec.response);
  assert.equal(rec.status(), 200);
  assert.equal(await CountryRouteCharge.countDocuments({ businessAccountId: ids.a, handlingCharge: 150 }), 2);
  assert.notEqual(buildPricingHash(await pricing(ids.a)), buildPricingHash(beforeA));
  assert.equal((await pricing(ids.b)).totalAmount, beforeB.totalAmount);
  assert.equal(buildPricingHash(await calculateShipmentPricingEstimate(publicInput)), publicBefore);
});

test("branch access and row ownership apply to direct IDs and listing", async () => {
  const denied = recorder();
  await listCountryRateCards(req({}, { businessAccountId: String(ids.b) }, {}, "finance"), denied.response);
  assert.equal(denied.status(), 404);
  const own = recorder();
  await listCountryRateCards(req({}, { businessAccountId: String(ids.a) }, {}, "finance"), own.response);
  assert.equal(own.status(), 200);
  assert.ok(own.body().rates.every((row: { businessAccountId: unknown }) => String(row.businessAccountId) === String(ids.a)));
  const bRate = await CountryRateCard.findOne({ businessAccountId: ids.b }).lean().orFail().exec();
  const changed = recorder();
  await updateCountryRateCard(req({ businessAccountId: String(ids.a), expectedVersion: await version(ids.a), countryCode: "GB", countryName: "United Kingdom", service: "COURIER",
    fromKg: 0, toKg: 10, chargesPerKg: 1, maxBoxKg: 30 }, {}, { id: String(bRate._id) }), changed.response);
  assert.equal(changed.status(), 404);
  const deleted = recorder();
  await deleteCountryRateCard(req({}, { expectedVersion: 1 }, { id: String(bRate._id) }, "operations"), deleted.response);
  assert.equal(deleted.status(), 404);
  assert.equal((await CountryRateCard.findById(bRate._id).orFail().exec()).chargesPerKg, 420);
});

test("an empty private card blocks bookings and never falls back to Individual Clients", async () => {
  await assert.rejects(pricing(ids.empty), RateCardRequiredError);
  const rec = recorder();
  await createCountryRateCard(req({ businessAccountId: String(ids.empty), expectedVersion: 0, countryCode: "US", countryName: "United States", service: "COURIER",
    fromKg: 0, toKg: 30, chargesPerKg: 420, maxBoxKg: 30 }), rec.response);
  assert.equal(rec.status(), 201);
  assert.equal((await BusinessAccount.findById(ids.empty).orFail().lean().exec()).privateRateCardReady, true);
  assert.equal((await pricing(ids.empty)).missingRate, true);
  assert.equal((await pricing(ids.empty, { countryCode: "US", parcels: [{ weightKg: 1 }] })).totalAmount, 420);
});

test("stale and concurrent writes are rejected, including imports", async () => {
  const stale = recorder();
  await saveCountryRouteCharge(req({ ...chargeInput, businessAccountId: String(ids.a), expectedVersion: 0 }), stale.response);
  assert.equal(stale.status(), 409);
  const v = await version(ids.a);
  const common = { businessAccountId: String(ids.a), expectedVersion: v, countryCode: "FR", countryName: "France", service: "COURIER", fromKg: 0, toKg: 30, chargesPerKg: 200, maxBoxKg: 30 };
  const first = recorder(), second = recorder();
  await Promise.all([createCountryRateCard(req(common), first.response), createCountryRateCard(req(common), second.response)]);
  assert.deepEqual([first.status(), second.status()].sort(), [201, 409]);
  const conflict = recorder();
  await commitRateCardImport(req({ businessAccountId: String(ids.a), expectedVersion: v, services: ["COURIER"], confirmReplace: true,
    routes: [{ countryCode: "GB", countryName: "United Kingdom", slabs: [{ fromKg: 0, toKg: 30, chargesPerKg: 1, maxBoxKg: 30 }] }] }), conflict.response);
  assert.equal(conflict.status(), 409);
});

test("imports and country-wide GST policy stay inside the owning card", async () => {
  const beforeB = (await pricing(ids.b)).totalAmount;
  const rec = recorder();
  await commitRateCardImport(req({ businessAccountId: String(ids.a), expectedVersion: await version(ids.a), services: ["COURIER"], confirmReplace: true,
    routes: [{ countryCode: "GB", countryName: "United Kingdom", slabs: [{ fromKg: 0, toKg: 30, chargesPerKg: 300, maxBoxKg: 30 }] }] }), rec.response);
  assert.equal(rec.status(), 200);
  const a = await CountryRateCard.findOne({ businessAccountId: ids.a, countryCode: "GB" }).orFail().lean().exec();
  assert.equal(a.gstTreatment, "INCLUDED"); assert.equal(a.gstRatePercent, 18);
  assert.equal((await pricing(ids.b)).totalAmount, beforeB);
  const bRate = await CountryRateCard.findOne({ businessAccountId: ids.b }).orFail().lean().exec();
  await assert.rejects(buildRateCardSnapshot({ businessAccountId: ids.a }, { rateIds: [String(bRate._id)], countryCodes: [], services: [] }, "NONE", 0));
});

test("migration retries do not overwrite private edits or duplicate copied rows", async () => {
  const v = await version(ids.a);
  const rows = await CountryRateCard.countDocuments({ businessAccountId: ids.a });
  await migratePrivateRateCardAccount(ids.a, "already-migrated", userId);
  assert.equal(await version(ids.a), v);
  assert.equal(await CountryRateCard.countDocuments({ businessAccountId: ids.a }), rows);
});
