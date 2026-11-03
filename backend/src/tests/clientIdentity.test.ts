import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { resolveRestoredMemberStatus } from "../controllers/businessAccountAccess.controller.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { User } from "../models/user.model.js";
import { normalizeUserEmail, normalizeUserPhone } from "../services/userIdentity.service.js";

type SchemaIndex = [
  Record<string, number>,
  { name?: string; unique?: boolean; partialFilterExpression?: Record<string, unknown> }
];

describe("global client identity", () => {
  test("email and phone normalize to one canonical identity", () => {
    assert.equal(normalizeUserEmail("  Buyer@Example.COM "), "buyer@example.com");
    assert.equal(normalizeUserPhone("+91 98765 43210"), "+919876543210");
    assert.equal(normalizeUserPhone("not-a-phone"), null);
  });

  test("removed access restores an activated user and reinvites an unactivated user", () => {
    assert.equal(resolveRestoredMemberStatus({ isVerified: true, passwordHash: "stored-hash" }), "active");
    assert.equal(resolveRestoredMemberStatus({ isVerified: false, passwordHash: "" }), "invited");
    assert.equal(resolveRestoredMemberStatus({ isVerified: true, passwordHash: "" }), "invited");
  });

  test("the database reserves phone numbers globally", () => {
    const phoneIndex = (User.schema.indexes() as SchemaIndex[])
      .find((index) => index[1].name === "uniq_user_phone");
    assert.ok(phoneIndex, "the global phone identity index exists");
    assert.deepEqual(phoneIndex[0], { phone: 1 });
    assert.equal(phoneIndex[1].unique, true);
  });

  test("only one invited, active or suspended membership may exist per user in each tenant", () => {
    const memberIndex = (BusinessAccountMember.schema.indexes() as SchemaIndex[])
      .find((index) => index[1].name === "uniq_current_business_membership_per_tenant_user");
    assert.ok(memberIndex, "the single-current-membership index exists");
    assert.deepEqual(memberIndex[0], { tenantId: 1, user: 1 });
    assert.equal(memberIndex[1].unique, true);
    assert.deepEqual(memberIndex[1].partialFilterExpression, {
      status: { $in: ["invited", "active", "suspended"] }
    });
  });
});
