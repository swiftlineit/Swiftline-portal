import assert from "node:assert/strict";
import type { Request, RequestHandler, Response } from "express";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import {
  withOperatorTenantContext,
  withOperatorTenantUpload,
  type OperatorContext
} from "../middleware/operatorContext.middleware.js";
import { getTenantContext } from "../services/tenantScope.service.js";

describe("operator tenant context middleware", () => {
  test("restores the verified tenant when asynchronous middleware calls next", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const operatorContext: OperatorContext = {
      tenantId,
      slug: "testop",
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      accessMode: "MEMBER"
    };
    let insideHandlerTenantId: string | undefined;
    const nextCallbacks: Array<(error?: unknown) => void> = [];
    let downstreamTenantId: string | undefined;
    const handler: RequestHandler = (_request, _response, next) => {
      insideHandlerTenantId = String(getTenantContext()?.tenantId);
      nextCallbacks.push(next);
    };
    const wrapped = withOperatorTenantContext(handler);

    wrapped(
      { operatorContext } as unknown as Request,
      {} as Response,
      () => { downstreamTenantId = String(getTenantContext()?.tenantId); }
    );

    assert.equal(insideHandlerTenantId, String(tenantId));
    assert.equal(getTenantContext(), undefined);
    assert.equal(nextCallbacks.length, 1);
    nextCallbacks[0]!();
    assert.equal(downstreamTenantId, String(tenantId));
  });

  test("restores the verified tenant after an upload callback before running its handler", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const operatorContext: OperatorContext = {
      tenantId,
      slug: "testop",
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      accessMode: "MEMBER"
    };
    const uploadCallbacks: Array<(error?: unknown) => void> = [];
    let uploadTenantId: string | undefined;
    let handlerTenantId: string | undefined;
    let downstreamTenantId: string | undefined;
    const upload: RequestHandler = (_request, _response, next) => {
      uploadTenantId = String(getTenantContext()?.tenantId);
      uploadCallbacks.push(next);
    };
    const handler: RequestHandler = (_request, _response, next) => {
      handlerTenantId = String(getTenantContext()?.tenantId);
      next();
    };

    const wrapped = withOperatorTenantUpload(upload, handler);
    wrapped(
      { operatorContext } as unknown as Request,
      {} as Response,
      () => { downstreamTenantId = String(getTenantContext()?.tenantId); }
    );

    assert.equal(uploadTenantId, String(tenantId));
    assert.equal(getTenantContext(), undefined);
    assert.equal(uploadCallbacks.length, 1);

    // Simulate a multipart library invoking its callback after the request's
    // initial AsyncLocalStorage scope has ended.
    uploadCallbacks[0]!();

    assert.equal(handlerTenantId, String(tenantId));
    assert.equal(downstreamTenantId, String(tenantId));
    assert.equal(getTenantContext(), undefined);
  });
});
