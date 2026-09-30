import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { CarrierApiRateBucket } from "../models/carrierApiRateBucket.model.js";
import {
  AlsTrackingServiceError,
  reserveRateBucket
} from "../services/als/alsTracking.service.js";

const testMongoUri = process.env.ALS_RATE_LIMIT_TEST_MONGODB_URI?.trim();
const databaseName = `sl_als_rate_limit_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;

function futureExpiry() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

async function readCount(key: string) {
  const bucket = await CarrierApiRateBucket.findOne({ key }).lean().exec();
  assert.ok(bucket, `Expected rate bucket ${key} to exist.`);
  return bucket.count;
}

describe("ALS rate-bucket concurrency", { skip: !testMongoUri }, () => {
  before(async () => {
    assert.ok(testMongoUri, "ALS_RATE_LIMIT_TEST_MONGODB_URI is required for this integration suite.");
    await mongoose.connect(testMongoUri, {
      dbName: databaseName,
      family: 4,
      retryWrites: false
    });
    assert.equal(mongoose.connection.name, databaseName);
    await CarrierApiRateBucket.createIndexes();
  });

  beforeEach(async () => {
    await CarrierApiRateBucket.deleteMany({}).exec();
  });

  after(async () => {
    if (mongoose.connection.readyState === 0) return;
    assert.ok(
      mongoose.connection.name.startsWith("sl_als_rate_limit_"),
      "Refusing to clean a non-test database."
    );
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("reserves every concurrent request against a fresh bucket", async () => {
    const key = "ALS:TEST:FRESH";
    await Promise.all(
      Array.from({ length: 3 }, () => reserveRateBucket(key, 30, futureExpiry()))
    );

    assert.equal(await readCount(key), 3);
  });

  it("increments an existing bucket atomically under concurrency", async () => {
    const key = "ALS:TEST:EXISTING";
    await CarrierApiRateBucket.create({ key, count: 5, expiresAt: futureExpiry() });

    await Promise.all(
      Array.from({ length: 3 }, () => reserveRateBucket(key, 30, futureExpiry()))
    );

    assert.equal(await readCount(key), 8);
  });

  it("rejects only requests beyond the real bucket limit", async () => {
    const key = "ALS:TEST:LIMIT";
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => reserveRateBucket(key, 2, futureExpiry()))
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 1);
    const reason = rejected[0]?.reason;
    assert.ok(reason instanceof AlsTrackingServiceError);
    assert.equal(reason.statusCode, 429);
    assert.equal(await readCount(key), 2);
  });

  it("does not leak duplicate-key errors during a larger creation race", async () => {
    const key = "ALS:TEST:CREATION_RACE";
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveRateBucket(key, 30, futureExpiry()))
    );

    assert.equal(results.filter((result) => result.status === "rejected").length, 0);
    assert.equal(await readCount(key), 10);
  });
});
