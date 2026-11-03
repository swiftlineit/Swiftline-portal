import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { OperatorInvitation, operatorInvitationStatusValues } from "../models/operatorInvitation.model.js";
import { hashOperatorInvitationToken } from "../services/operatorInvitation.service.js";

describe("operator administrator invitations", () => {
  test("stores a deterministic digest rather than the bearer token", () => {
    const token = "a-long-random-operator-invitation-token";
    const digest = hashOperatorInvitationToken(token);

    assert.match(digest, /^[a-f\d]{64}$/);
    assert.notEqual(digest, token);
    assert.equal(hashOperatorInvitationToken(token), digest);
    assert.notEqual(hashOperatorInvitationToken(`${token}-changed`), digest);
  });

  test("allows only one pending invitation per user and operator", () => {
    const indexes = OperatorInvitation.schema.indexes() as Array<[
      Record<string, unknown>,
      Record<string, unknown>
    ]>;
    const pendingIndex = indexes.find((entry) =>
      entry[1].name === "uniq_pending_operator_invitation"
    );
    assert.deepEqual(pendingIndex?.[0], { tenantId: 1, userId: 1 });
    assert.deepEqual(pendingIndex?.[1], {
      unique: true,
      partialFilterExpression: { status: "PENDING" },
      name: "uniq_pending_operator_invitation"
    });
    assert.deepEqual(operatorInvitationStatusValues, ["PENDING", "ACCEPTED", "REVOKED"]);
  });

  test("requires tenant, user, role and expiry before an invitation can be saved", async () => {
    const invitation = new OperatorInvitation({
      tenantId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      role: "CLIENT",
      tokenHash: "digest",
      expiresAt: new Date()
    });
    await assert.rejects(invitation.validate(), (error: unknown) => {
      assert.ok(error instanceof mongoose.Error.ValidationError);
      assert.ok(error.errors.role);
      return true;
    });
  });
});
