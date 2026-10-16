import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { PickupAttempt } from "../models/pickupAttempt.model.js";
import { PickupProof } from "../models/pickupEvidence.model.js";
import { completePickupAttempt, PickupServiceError } from "../services/pickup.service.js";

const databaseName = `sl_pickup_staff_proof_${Date.now()}`;
const testDatabaseUri = process.env.PICKUP_TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017";

before(async () => {
  await mongoose.connect(testDatabaseUri, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, databaseName, "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("staff photo remains visible proof but does not satisfy driver photo requirement", async () => {
  const pickupRequestId = new mongoose.Types.ObjectId();
  const driverUserId = new mongoose.Types.ObjectId();
  const attempt = await PickupAttempt.create({
    pickupRequestId, sequence: 1, status: "COLLECTING", assignedDriverUserId: driverUserId,
    otpVerifiedAt: new Date(),
    scheduledWindow: { startAt: new Date(), endAt: new Date(Date.now() + 60_000), timezone: "Asia/Kolkata" }
  });
  const proof = (type: "PHOTO" | "SIGNATURE", source: "STAFF" | "DRIVER") => ({
    pickupRequestId, pickupAttemptId: attempt._id, type, source,
    originalName: `${source}-${type}.png`, storageKey: `test/${source}-${type}.png`,
    mimeType: "image/png", size: 100, capturedBy: new mongoose.Types.ObjectId()
  });
  await PickupProof.create(proof("SIGNATURE", "DRIVER"), proof("PHOTO", "STAFF"));
  await assert.rejects(
    () => completePickupAttempt({ attemptId: String(attempt._id), driverUserId }),
    (error: unknown) => error instanceof PickupServiceError && /at least one pickup photograph/.test(error.message)
  );
  assert.equal(await PickupProof.countDocuments({ pickupRequestId, type: "PHOTO", source: "STAFF" }), 1);
});
