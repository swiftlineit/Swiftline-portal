import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { getIndividualSentinelIdentity } from "../services/individualCustomer.service.js";

test("Swiftline retains its reserved individual sentinel identity", () => {
  const identity = getIndividualSentinelIdentity(new mongoose.Types.ObjectId("6a0000000000000000000001"), "SWIFTLINE");
  assert.equal(identity.accountId, "BA-SYSTEM-INDIVIDUAL");
  assert.equal(identity.email, "individual.customers@system.swiftline.internal");
  assert.equal(identity.mobileNumber, "0000000000");
});

test("operator sentinel unique-key fields are stable and tenant-specific", () => {
  const firstTenantId = new mongoose.Types.ObjectId("6a0000000000000000000002");
  const secondTenantId = new mongoose.Types.ObjectId("6a0000000000000000000003");
  const first = getIndividualSentinelIdentity(firstTenantId, "OPERATOR");
  const firstAgain = getIndividualSentinelIdentity(firstTenantId, "OPERATOR");
  const second = getIndividualSentinelIdentity(secondTenantId, "OPERATOR");
  const swiftline = getIndividualSentinelIdentity(firstTenantId, "SWIFTLINE");

  assert.deepEqual(first, firstAgain);
  assert.notEqual(first.accountId, swiftline.accountId);
  assert.notEqual(first.email, swiftline.email);
  assert.notEqual(first.mobileNumber, swiftline.mobileNumber);
  assert.notEqual(first.accountId, second.accountId);
  assert.notEqual(first.email, second.email);
  assert.notEqual(first.mobileNumber, second.mobileNumber);
});
