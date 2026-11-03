import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getMyClientWorkspaceAccess } from "../controllers/operatorWorkspace.controller.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";

function responseRecorder() {
  let statusCode = 200;
  let payload: unknown;
  return {
    response: {
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { payload = body; return this; }
    } as unknown as Response,
    result: () => ({ statusCode, payload })
  };
}

test("client workspace access reports only workspace entitlements for the authenticated identity", async (context) => {
  const userId = new mongoose.Types.ObjectId();
  const tenantId = new mongoose.Types.ObjectId();
  let swiftlineFilter: unknown;
  let membershipFilter: unknown;

  context.mock.method(BusinessAccountMember, "exists", ((filter: unknown) => {
    swiftlineFilter = filter;
    return { exec: async () => ({ _id: new mongoose.Types.ObjectId() }) };
  }) as never);
  context.mock.method(TenantMembership, "find", ((filter: unknown) => {
    membershipFilter = filter;
    return { select: () => ({ lean: () => ({ exec: async () => [{ tenantId, role: "CLIENT" }] }) }) };
  }) as never);
  context.mock.method(Tenant, "find", (() => ({
    select: () => ({ lean: () => ({ exec: async () => [{
      _id: tenantId,
      companyName: "Harbor Cargo",
      slug: "harbor-cargo",
      status: "ACTIVE"
    }] }) })
  })) as never);

  const recorder = responseRecorder();
  await getMyClientWorkspaceAccess({ user: { _id: userId, role: "client" } } as unknown as Request, recorder.response);

  assert.equal(recorder.result().statusCode, 200);
  assert.deepEqual(swiftlineFilter, { user: userId, status: { $in: ["active", "suspended"] } });
  assert.deepEqual(recorder.result().payload, {
    success: true,
    swiftline: true,
    operators: env.OPERATOR_PORTAL_ENABLED
      ? [{ slug: "harbor-cargo", companyName: "Harbor Cargo", status: "ACTIVE", role: "CLIENT" }]
      : []
  });
  if (env.OPERATOR_PORTAL_ENABLED) {
    assert.deepEqual(membershipFilter, { userId, status: "ACTIVE" });
  } else {
    assert.equal(membershipFilter, undefined);
  }
});

test("workspace access rejects users without the client identity role", async () => {
  const recorder = responseRecorder();
  await getMyClientWorkspaceAccess({ user: { _id: new mongoose.Types.ObjectId(), role: "admin" } } as unknown as Request, recorder.response);
  assert.equal(recorder.result().statusCode, 403);
  assert.deepEqual(recorder.result().payload, { success: false, message: "Client access is required." });
});
