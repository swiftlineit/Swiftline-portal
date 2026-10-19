import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { commitRateCardImport, createCountryRateCard } from "../controllers/countryRateCard.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { RateCardMutationLock } from "../models/rateCardMutationLock.model.js";
import { calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";

const databaseName = `sl_rate_import_${Date.now()}`;

function responseRecorder() {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    }
  } as unknown as Response;
  return { response, statusCode: () => statusCode, payload: () => payload as Record<string, unknown> };
}

function request(input: { userId: mongoose.Types.ObjectId; body: unknown }) {
  return {
    user: { _id: input.userId, role: "admin" },
    body: input.body,
    params: {},
    query: {}
  } as unknown as Request;
}

/** Thirty contiguous slabs, the shape a rate list produces. */
function slabs(rate: number, count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    fromKg: index === 0 ? 0 : Number((index + 0.01).toFixed(2)),
    toKg: index + 1,
    chargesPerKg: rate,
    maxBoxKg: 30
  }));
}

const userId = new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([AuditLog.init(), CountryRateCard.init(), RateCardMutationLock.init()]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_rate_import_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("rate list import", () => {
  test("writes every destination and slab in one request", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: false,
          fileName: "SWIFTLINE ERUOPE RATELIST.xlsx",
          routes: [
            { countryCode: "BE", countryName: "Belgium", slabs: slabs(795) },
            { countryCode: "FR", countryName: "France", slabs: slabs(795) },
            { countryCode: "RS", countryName: "Serbia", slabs: slabs(1150) },
            { countryCode: "ME", countryName: "Montenegro", slabs: slabs(1150) }
          ]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 200);
    assert.equal(recorder.payload().slabsWritten, 120);
    assert.equal(await CountryRateCard.countDocuments({ band: "BAND_D" }), 120);
    // Serbia and Montenegro came from one cell but are two priceable lanes.
    assert.equal(await CountryRateCard.countDocuments({ countryCode: "ME" }), 30);
  });

  test("refuses to replace existing rates without confirmation", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: false,
          routes: [{ countryCode: "BE", countryName: "Belgium", slabs: slabs(600) }]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 409);
    assert.equal(recorder.payload().code, "RATE_CARD_IMPORT_REPLACE_UNCONFIRMED");

    // Nothing was written: the original price still stands.
    const untouched = await CountryRateCard.findOne({ countryCode: "BE", fromKg: 0 }).lean().exec();
    assert.equal(untouched?.chargesPerKg, 795);
  });

  test("is idempotent - importing twice leaves thirty slabs, not sixty", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: true,
          routes: [{ countryCode: "BE", countryName: "Belgium", slabs: slabs(795) }]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 200);
    assert.equal(await CountryRateCard.countDocuments({ countryCode: "BE", service: "COURIER" }), 30);
    assert.equal(recorder.payload().slabsRemoved, 30);
  });

  test("touches only the destinations named in the file", async () => {
    const before = await CountryRateCard.countDocuments({ countryCode: "FR" });

    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: true,
          routes: [{ countryCode: "BE", countryName: "Belgium", slabs: slabs(700) }]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 200);
    assert.equal(await CountryRateCard.countDocuments({ countryCode: "FR" }), before);
    const france = await CountryRateCard.findOne({ countryCode: "FR", fromKg: 0 }).lean().exec();
    assert.equal(france?.chargesPerKg, 795);
  });

  test("leaves another band alone", async () => {
    await CountryRateCard.create({
      band: "BAND_B", countryCode: "BE", countryName: "Belgium", service: "COURIER",
      fromKg: 0, toKg: 1, chargesPerKg: 900, maxBoxKg: 30, createdBy: userId
    });

    const bandA = await CountryRateCard.findOne({ band: "BAND_D", countryCode: "BE", fromKg: 0 }).lean().exec();
    const bandB = await CountryRateCard.findOne({ band: "BAND_B", countryCode: "BE", fromKg: 0 }).lean().exec();
    assert.equal(bandA?.chargesPerKg, 700);
    assert.equal(bandB?.chargesPerKg, 900);
  });

  test("writes both services when both are chosen", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER", "CARGO"],
          confirmReplace: false,
          routes: [{ countryCode: "HR", countryName: "Croatia", slabs: slabs(1480) }]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 200);
    assert.equal(await CountryRateCard.countDocuments({ band: "BAND_D", countryCode: "HR", service: "COURIER" }), 30);
    assert.equal(await CountryRateCard.countDocuments({ band: "BAND_D", countryCode: "HR", service: "CARGO" }), 30);
  });

  test("rejects overlapping slabs rather than storing two prices for one weight", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: true,
          routes: [{
            countryCode: "IE",
            countryName: "Ireland",
            slabs: [
              { fromKg: 0, toKg: 10, chargesPerKg: 500, maxBoxKg: 30 },
              { fromKg: 5, toKg: 15, chargesPerKg: 400, maxBoxKg: 30 }
            ]
          }]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 400);
    assert.equal(await CountryRateCard.countDocuments({ countryCode: "IE" }), 0);
  });

  test("rejects the same destination listed twice", async () => {
    const recorder = responseRecorder();
    await commitRateCardImport(
      request({
        userId,
        body: {
          band: "BAND_D",
          services: ["COURIER"],
          confirmReplace: true,
          routes: [
            { countryCode: "PT", countryName: "Portugal", slabs: slabs(900) },
            { countryCode: "PT", countryName: "Portugal", slabs: slabs(800) }
          ]
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 400);
    assert.equal(await CountryRateCard.countDocuments({ countryCode: "PT" }), 0);
  });

  test("records what it replaced in the audit log", async () => {
    const entry = await AuditLog.findOne({ action: "COUNTRY_RATE_CARD_IMPORTED" })
      .sort({ performedAt: -1 })
      .lean()
      .exec();

    assert.ok(entry);
    assert.equal(entry.entityType, "COUNTRY_RATE_CARD");
  });

  test("imported slabs price a real shipment", async () => {
    const estimate = await calculateShipmentPricingEstimate({
      countryCode: "FR",
      serviceType: "COURIER",
      rateCardBand: "BAND_D",
      parcels: [{ sequence: 1, weightKg: 5 }]
    } as Parameters<typeof calculateShipmentPricingEstimate>[0]);

    const parcel = estimate.parcels[0];
    assert.equal(parcel?.chargeableWeightKg, 5);
    assert.equal(parcel?.chargesPerKg, 795);
    assert.equal(parcel?.inclusiveBaseAmount, 3975);
    assert.equal(parcel?.baseAmount, 3368.64);
    assert.equal(estimate.totalAmount, 3975);
  });

  test("a fractional weight rounds up into the next slab, with no gap", async () => {
    const estimate = await calculateShipmentPricingEstimate({
      countryCode: "FR",
      serviceType: "COURIER",
      rateCardBand: "BAND_D",
      parcels: [{ sequence: 1, weightKg: 4.2 }]
    } as Parameters<typeof calculateShipmentPricingEstimate>[0]);

    const parcel = estimate.parcels[0];
    assert.equal(parcel?.chargeableWeightKg, 5);
    assert.equal(parcel?.chargesPerKg, 795);
  });
});
