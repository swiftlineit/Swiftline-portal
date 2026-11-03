import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { listMyOperatorWorkspaces } from "../controllers/operatorWorkspace.controller.js";
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

test("operator workspace discovery is identity-scoped and returns only safe routing fields", async () => {
  const userId = new mongoose.Types.ObjectId();
  const activeTenantId = new mongoose.Types.ObjectId();
  const draftTenantId = new mongoose.Types.ObjectId();
  let membershipFilter: unknown;
  let tenantFilter: unknown;
  const originalMembershipFind = TenantMembership.find;
  const originalTenantFind = Tenant.find;

  TenantMembership.find = (((filter: unknown) => {
    membershipFilter = filter;
    return { select: () => ({ lean: () => ({ exec: async () => [
      { tenantId: draftTenantId, role: "FINANCE" },
      { tenantId: activeTenantId, role: "OPERATOR_ADMIN" }
    ] }) }) };
  }) as unknown) as typeof TenantMembership.find;
  Tenant.find = (((filter: unknown) => {
    tenantFilter = filter;
    return { select: () => ({ lean: () => ({ exec: async () => [
      { _id: activeTenantId, companyName: "JK LOGISTICS", slug: "testop", status: "ACTIVE" },
      { _id: draftTenantId, companyName: "Awaiting Cargo", slug: "awaiting-cargo", status: "DRAFT" }
    ] }) }) };
  }) as unknown) as typeof Tenant.find;

  try {
    const recorder = responseRecorder();
    await listMyOperatorWorkspaces({ user: { _id: userId, role: "client" } } as unknown as Request, recorder.response);
    assert.equal(recorder.result().statusCode, 200);
    assert.deepEqual(membershipFilter, { userId, status: "ACTIVE" });
    assert.deepEqual(tenantFilter, {
      _id: { $in: [draftTenantId, activeTenantId] },
      kind: "OPERATOR",
      status: { $in: ["DRAFT", "ACTIVE"] }
    });
    assert.deepEqual(recorder.result().payload, {
      success: true,
      workspaces: [
        { slug: "awaiting-cargo", companyName: "Awaiting Cargo", status: "DRAFT", role: "FINANCE" },
        { slug: "testop", companyName: "JK LOGISTICS", status: "ACTIVE", role: "OPERATOR_ADMIN" }
      ]
    });
  } finally {
    TenantMembership.find = originalMembershipFind;
    Tenant.find = originalTenantFind;
  }
});

test("Swiftline staff cannot use client workspace discovery", async () => {
  const recorder = responseRecorder();
  await listMyOperatorWorkspaces({
    user: { _id: new mongoose.Types.ObjectId(), role: "admin" }
  } as unknown as Request, recorder.response);
  assert.equal(recorder.result().statusCode, 403);
  assert.deepEqual(recorder.result().payload, { success: false, message: "Client access is required." });
});
