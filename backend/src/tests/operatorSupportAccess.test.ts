import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { startOperatorSupportSession } from "../controllers/operatorSupport.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import {
  auditOperatorSupportAccess,
  requireOperatorSupportReadOnly,
  type OperatorContext
} from "../middleware/operatorContext.middleware.js";
import { activeOperatorSupportSessionFilter, hashOperatorSupportToken } from "../services/operatorSupportSession.service.js";

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

function operatorContext(accessMode: OperatorContext["accessMode"]): OperatorContext {
  return {
    tenantId: new mongoose.Types.ObjectId(),
    slug: "northstar-cargo",
    role: "OPERATOR_ADMIN",
    assignedBranches: [],
    accessMode,
    ...(accessMode === "PLATFORM_SUPPORT" ? { supportSessionId: new mongoose.Types.ObjectId() } : {})
  };
}

describe("audited platform operator support access", () => {
  test("stores only a one-way token digest and binds active lookup to actor, tenant, and expiry", () => {
    const token = "a".repeat(64);
    const tenantId = new mongoose.Types.ObjectId();
    const actorUserId = new mongoose.Types.ObjectId();
    const now = new Date("2026-10-24T12:00:00.000Z");

    assert.equal(hashOperatorSupportToken(token), createHash("sha256").update(token).digest("hex"));
    assert.notEqual(hashOperatorSupportToken(token), token);
    assert.deepEqual(activeOperatorSupportSessionFilter({ token, tenantId, actorUserId, now }), {
      tokenHash: hashOperatorSupportToken(token),
      operatorTenantId: tenantId,
      actorUserId,
      endedAt: null,
      expiresAt: { $gt: now }
    });
  });

  test("rejects short reasons and unexpected support-session fields before database access", async () => {
    for (const body of [
      { reason: "help" },
      { reason: "Review a client shipment issue", tenantId: new mongoose.Types.ObjectId().toString() }
    ]) {
      const request = { body, params: {}, user: { _id: new mongoose.Types.ObjectId() } } as unknown as Request;
      const recorded = responseRecorder();
      await startOperatorSupportSession(request, recorded.response);
      assert.equal(recorded.status(), 400);
      assert.deepEqual(recorded.body(), {
        success: false,
        message: "Enter a support reason between 10 and 500 characters."
      });
    }
  });

  test("allows read methods and rejects all support-mode mutations", () => {
    for (const method of ["GET", "HEAD"]) {
      const request = { method, operatorContext: operatorContext("PLATFORM_SUPPORT") } as unknown as Request;
      const recorded = responseRecorder();
      let reachedNext = false;
      requireOperatorSupportReadOnly(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);
      assert.equal(reachedNext, true, `${method} should remain available`);
      assert.equal(recorded.status(), 200);
    }

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const request = { method, operatorContext: operatorContext("PLATFORM_SUPPORT") } as unknown as Request;
      const recorded = responseRecorder();
      let reachedNext = false;
      requireOperatorSupportReadOnly(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);
      assert.equal(reachedNext, false, `${method} must not reach a route handler`);
      assert.equal(recorded.status(), 403);
      assert.deepEqual(recorded.body(), { success: false, message: "Operator support access is read-only." });
    }
  });

  test("does not change ordinary operator member permissions", () => {
    const request = { method: "PATCH", operatorContext: operatorContext("MEMBER") } as unknown as Request;
    const recorded = responseRecorder();
    let reachedNext = false;
    requireOperatorSupportReadOnly(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);
    assert.equal(reachedNext, true);
    assert.equal(recorded.status(), 200);
  });

  test("audits the resource without storing a record identifier and fails closed when audit storage fails", async () => {
    const context = operatorContext("PLATFORM_SUPPORT");
    const request = {
      method: "GET",
      path: "/shipments/private-shipment-id/invoices",
      user: { _id: new mongoose.Types.ObjectId() },
      operatorContext: context
    } as unknown as Request;
    const model = AuditLog as unknown as { create: (documents: unknown) => Promise<unknown> };
    const originalCreate = model.create;
    let written: unknown;
    try {
      model.create = async (documents) => { written = documents; return []; };
      let reachedNext = false;
      await auditOperatorSupportAccess(request, {} as Response, (() => { reachedNext = true; }) as NextFunction);
      assert.equal(reachedNext, true);
      const entry = written as { action: string; entityId: mongoose.Types.ObjectId; metadata: Record<string, unknown> };
      assert.equal(entry.action, "PLATFORM_OPERATOR_SUPPORT_DATA_VIEWED");
      assert.equal(String(entry.entityId), String(context.tenantId));
      assert.deepEqual(entry.metadata, {
        supportSessionId: String(context.supportSessionId),
        resource: "shipments",
        method: "GET"
      });
      assert.equal(JSON.stringify(entry).includes("private-shipment-id"), false);

      const auditError = new Error("audit store unavailable");
      model.create = async () => { throw auditError; };
      let forwardedError: unknown;
      await auditOperatorSupportAccess(request, {} as Response, ((error?: unknown) => { forwardedError = error; }) as NextFunction);
      assert.equal(forwardedError, auditError);
    } finally {
      model.create = originalCreate;
    }
  });
});
