import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { OperatorClientInvitation } from "../models/operatorClientInvitation.model.js";
import { Tenant } from "../models/tenant.model.js";
import { User } from "../models/user.model.js";
import {
  hashOperatorClientInvitationToken,
  lookupOperatorClientInvitation
} from "../services/operatorClientInvitation.service.js";
import { getTenantContext, runWithTenantContext } from "../services/tenantScope.service.js";

function queryResult<T>(value: T) {
  return {
    select() { return this; },
    lean() { return this; },
    exec: async () => value
  };
}

describe("operator client invitation lookup", () => {
  test("loads the linked account in the invitation tenant from the Swiftline auth route", async (context) => {
    const token = "operator-client-invitation-test-token";
    const tenantId = new mongoose.Types.ObjectId();
    const swiftlineTenantId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId();
    const invitation = {
      tenantId,
      userId,
      businessAccountId,
      status: "PENDING",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    };
    const tenant = { _id: tenantId, slug: "testop", companyName: "Test Operator" };
    const user = {
      _id: userId,
      email: "client@example.test",
      firstName: "Test",
      lastName: "Client",
      name: "Test Client",
      userStatus: "invited"
    };
    const account = {
      _id: businessAccountId,
      accountId: "BA-2026-123456",
      company: { companyName: "Client Business" }
    };

    context.mock.method(OperatorClientInvitation, "findOne", (filter: unknown) => {
      assert.deepEqual(filter, { tokenHash: hashOperatorClientInvitationToken(token) });
      return queryResult(invitation) as never;
    });
    context.mock.method(Tenant, "findOne", (filter: unknown) => {
      assert.deepEqual(filter, { _id: tenantId, kind: "OPERATOR", status: "ACTIVE" });
      return queryResult(tenant) as never;
    });
    context.mock.method(User, "findById", (id: unknown) => {
      assert.equal(String(id), String(userId));
      return queryResult(user) as never;
    });
    context.mock.method(BusinessAccount, "findOne", (filter: unknown) => {
      assert.deepEqual(filter, { _id: businessAccountId, tenantId });
      assert.equal(getTenantContext()?.kind, "OPERATOR");
      assert.equal(String(getTenantContext()?.tenantId), String(tenantId));
      return queryResult(account) as never;
    });

    const result = await runWithTenantContext(
      { tenantId: swiftlineTenantId, kind: "SWIFTLINE" },
      () => lookupOperatorClientInvitation(token)
    );

    assert.equal(result.matched, true);
    if (!result.matched || !result.invitation) throw new Error("Expected a valid operator client invitation.");
    assert.equal(result.invitation.tenantSlug, "testop");
    assert.equal(result.invitation.email, user.email);
    assert.equal(result.invitation.businessAccountId, account.accountId);
    assert.equal(result.invitation.companyName, account.company.companyName);
    assert.equal(result.invitation.requiresSignIn, false);
  });
});
