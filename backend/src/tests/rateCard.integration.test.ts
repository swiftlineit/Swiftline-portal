import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { assignBusinessAccountRateCard } from "../controllers/businessAccount.controller.js";
import { createCountryRateCard } from "../controllers/countryRateCard.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { RateCardMutationLock } from "../models/rateCardMutationLock.model.js";

const databaseName = `sl_rate_card_${Date.now()}`;

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
  return { response, statusCode: () => statusCode, payload: () => payload };
}

function request(input: { userId: mongoose.Types.ObjectId; body: unknown; params?: Record<string, string> }) {
  return {
    user: { _id: input.userId, role: "admin" },
    body: input.body,
    params: input.params ?? {},
    query: {}
  } as unknown as Request;
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([
    AuditLog.init(),
    BusinessAccount.init(),
    CountryRateCard.init(),
    RateCardMutationLock.init()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_rate_card_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("rate-card concurrency", () => {
  test("two overlapping slab writes cannot both succeed", async () => {
    const userId = new mongoose.Types.ObjectId();
    const first = responseRecorder();
    const second = responseRecorder();
    const base = {
      band: "BAND_D",
      countryCode: "GB",
      countryName: "United Kingdom",
      service: "COURIER",
      chargesPerKg: 200,
      maxBoxKg: 30
    };

    await Promise.all([
      createCountryRateCard(request({ userId, body: { ...base, fromKg: 0, toKg: 10 } }), first.response),
      createCountryRateCard(request({ userId, body: { ...base, fromKg: 5, toKg: 15 } }), second.response)
    ]);

    assert.deepEqual([first.statusCode(), second.statusCode()].sort(), [201, 409]);
    assert.equal(await CountryRateCard.countDocuments({ band: "BAND_D", countryCode: "GB" }), 1);
  });

  test("retired shared-card assignments cannot change an account", async () => {
    const userId = new mongoose.Types.ObjectId();
    await CountryRateCard.create([
      {
        band: "BAND_B", countryCode: "US", countryName: "United States", service: "COURIER",
        fromKg: 0, toKg: 10, chargesPerKg: 180, maxBoxKg: 30, createdBy: userId, updatedBy: userId
      },
      {
        band: "BAND_C", countryCode: "US", countryName: "United States", service: "COURIER",
        fromKg: 0, toKg: 10, chargesPerKg: 160, maxBoxKg: 30, createdBy: userId, updatedBy: userId
      }
    ]);
    await BusinessAccount.collection.insertOne({
      accountId: "BA-RATE-RACE",
      accountKind: "BUSINESS",
      status: "active",
      rateCardBand: null,
      company: { companyName: "Rate Race Ltd" },
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const first = responseRecorder();
    const second = responseRecorder();
    await Promise.all([
      assignBusinessAccountRateCard(request({
        userId,
        params: { accountId: "BA-RATE-RACE" },
        body: { rateCardBand: "BAND_B", expectedRateCardBand: null, reason: "First commercial choice" }
      }), first.response),
      assignBusinessAccountRateCard(request({
        userId,
        params: { accountId: "BA-RATE-RACE" },
        body: { rateCardBand: "BAND_C", expectedRateCardBand: null, reason: "Concurrent commercial choice" }
      }), second.response)
    ]);

    assert.deepEqual([first.statusCode(), second.statusCode()], [410, 410]);
    const account = await BusinessAccount.findOne({ accountId: "BA-RATE-RACE" }).lean().exec();
    assert.equal(account?.rateCardBand, null);
    assert.equal(await AuditLog.countDocuments({
      action: "BUSINESS_ACCOUNT_RATE_CARD_ASSIGNED",
      entityId: account?._id
    }), 0);
  });
});
