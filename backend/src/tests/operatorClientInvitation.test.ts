import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OperatorClientInvitation } from "../models/operatorClientInvitation.model.js";
import { hashOperatorClientInvitationToken } from "../services/operatorClientInvitation.service.js";

describe("operator client invitations", () => {
  test("stores only a SHA-256 token digest", () => {
    const token = "an-unpredictable-invitation-secret";
    const digest = hashOperatorClientInvitationToken(token);
    assert.equal(digest.length, 64);
    assert.notEqual(digest, token);
    assert.equal(hashOperatorClientInvitationToken(token), digest);
    assert.notEqual(hashOperatorClientInvitationToken(`${token}-changed`), digest);
  });

  test("defines unique token and one pending invitation per operator user indexes", () => {
    const indexes = OperatorClientInvitation.schema.indexes() as Array<[
      Record<string, number>,
      Record<string, unknown>
    ]>;
    const tokenIndex = indexes.find(([fields]) => fields.tokenHash === 1);
    const pendingUserIndex = indexes.find(([fields]) => fields.tenantId === 1 && fields.userId === 1);

    assert.equal(tokenIndex?.[1].unique, true);
    assert.deepEqual(pendingUserIndex?.[1].partialFilterExpression, { status: "PENDING" });
    assert.equal(pendingUserIndex?.[1].unique, true);
  });
});
