import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { createBusinessAccount } from "../controllers/businessAccount.controller.js";
import type { OperatorContext } from "../middleware/operatorContext.middleware.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

function createResponse() {
  const result: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const response = {
    status(code: number) {
      result.statusCode = code;
      return response;
    },
    json(body: unknown) {
      result.body = body;
      return response;
    }
  };
  return { response: response as unknown as Response, result };
}

function createRequest(operatorSlug: string, operatorContext?: OperatorContext): Request {
  return {
    params: { operatorSlug },
    headers: {},
    ...(operatorContext ? { operatorContext } : {})
  } as unknown as Request;
}

describe("business account creation tenant context", () => {
  test("fails closed instead of defaulting an operator request to Swiftline", async () => {
    const { response, result } = createResponse();

    await createBusinessAccount(createRequest("testop"), response);

    assert.equal(result.statusCode, 403);
    assert.deepEqual(result.body, {
      success: false,
      message: "Operator workspace access could not be verified."
    });
  });

  test("rejects a request context for a different operator tenant", async () => {
    const activeTenantId = new mongoose.Types.ObjectId();
    const otherTenantId = new mongoose.Types.ObjectId();
    const operatorContext: OperatorContext = {
      tenantId: otherTenantId,
      slug: "testop",
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      accessMode: "MEMBER"
    };
    const { response, result } = createResponse();

    await runWithTenantContext({ tenantId: activeTenantId, kind: "OPERATOR" }, () =>
      createBusinessAccount(createRequest("testop", operatorContext), response)
    );

    assert.equal(result.statusCode, 403);
  });

  test("allows a matching operator context to continue through the handler", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const operatorContext: OperatorContext = {
      tenantId,
      slug: "testop",
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      accessMode: "MEMBER"
    };
    const { response, result } = createResponse();

    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () =>
      createBusinessAccount(createRequest("testop", operatorContext), response)
    );

    // The handler proceeds past tenant validation and then rejects the missing login.
    assert.equal(result.statusCode, 401);
  });
});
