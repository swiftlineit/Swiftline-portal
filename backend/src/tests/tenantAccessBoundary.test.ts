import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { requireOperatorContext, requireOperatorRole } from "../middleware/operatorContext.middleware.js";
import { establishSwiftlineTenantContext } from "../middleware/swiftlineTenantContext.middleware.js";
import { getConsignorPlaceAddress, getPlaceAddress } from "../controllers/address.controller.js";
import {
  assertTenantWriteAllowed,
  scopeTenantFilter,
  tenantOwnedSchemaPlugin,
  TenantScopeError,
  validateTenantSafeUpdatePipeline
} from "../models/plugins/tenantOwnedSchema.plugin.js";
import { getTenantContext, getTenantIdForWrite, runWithTenantContext } from "../services/tenantScope.service.js";

const tenantGuardSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", immutable: true },
  value: String
}, { bufferCommands: false });
tenantGuardSchema.plugin(tenantOwnedSchemaPlugin);
const TenantGuardFixture = mongoose.model("TenantGuardFixture", tenantGuardSchema);

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

describe("tenant API access boundary", () => {
  test("rejects anonymous users and Swiftline staff before resolving an operator slug", async () => {
    for (const user of [undefined, { _id: new mongoose.Types.ObjectId(), role: "admin" }]) {
      const request = { headers: {}, params: { operatorSlug: "any-operator" }, user } as unknown as Request;
      const recorded = responseRecorder();
      let reachedNext = false;

      await requireOperatorContext(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);

      assert.equal(reachedNext, false);
      assert.equal(recorded.status(), user ? 403 : 401);
    }
  });

  test("requires an operator membership role for operator handlers", () => {
    const request = {} as Request;
    const recorded = responseRecorder();
    let reachedNext = false;
    requireOperatorRole("OPERATOR_ADMIN")(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);
    assert.equal(recorded.status(), 401);
    assert.equal(reachedNext, false);

    (request as Request & { operatorContext?: { tenantId: mongoose.Types.ObjectId; slug: string; role: "CLIENT"; assignedBranches: mongoose.Types.ObjectId[] } }).operatorContext = {
      tenantId: new mongoose.Types.ObjectId(), slug: "operator", role: "CLIENT", assignedBranches: []
    };
    requireOperatorRole("OPERATIONS")(request, recorded.response, (() => { reachedNext = true; }) as NextFunction);
    assert.equal(recorded.status(), 403);
    assert.equal(reachedNext, false);
  });

  test("limits operator business-account creation to administrator and operations memberships", () => {
    for (const [role, allowed] of [
      ["OPERATOR_ADMIN", true],
      ["OPERATIONS", true],
      ["FINANCE", false],
      ["CLIENT", false]
    ] as const) {
      const request = {
        operatorContext: {
          tenantId: new mongoose.Types.ObjectId(),
          slug: "operator",
          role,
          assignedBranches: []
        }
      } as unknown as Request;
      const recorded = responseRecorder();
      let reachedNext = false;
      requireOperatorRole("OPERATOR_ADMIN", "OPERATIONS")(
        request,
        recorded.response,
        (() => { reachedNext = true; }) as NextFunction
      );
      assert.equal(reachedNext, allowed, `${role} access should be ${allowed ? "allowed" : "denied"}`);
      if (!allowed) assert.equal(recorded.status(), 403);
    }
  });

  test("does not let an operator context fall through into Swiftline routes", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const recorded = responseRecorder();
    let reachedNext = false;

    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () =>
      establishSwiftlineTenantContext({} as Request, recorded.response, (() => { reachedNext = true; }) as NextFunction)
    );

    assert.equal(recorded.status(), 403);
    assert.equal(reachedNext, false);
    assert.equal(getTenantContext(), undefined);
  });

  test("keeps an established Swiftline context for legacy API handlers", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    let reachedNext = false;

    await runWithTenantContext({ tenantId, kind: "SWIFTLINE" }, () =>
      establishSwiftlineTenantContext({} as Request, responseRecorder().response, (() => {
        reachedNext = getTenantContext()?.tenantId.equals(tenantId) === true;
      }) as NextFunction)
    );

    assert.equal(reachedNext, true);
  });

  test("tenant-owned account and branch creation uses the authenticated tenant", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const resolved = await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => getTenantIdForWrite());
    assert.equal(resolved.equals(tenantId), true);

    const swiftlineTenantId = new mongoose.Types.ObjectId();
    const swiftlineResolved = await runWithTenantContext(
      { tenantId: swiftlineTenantId, kind: "SWIFTLINE" },
      () => getTenantIdForWrite()
    );
    assert.equal(swiftlineResolved.equals(swiftlineTenantId), true);
  });

  test("blocks unscoped counts and cross-collection aggregate joins", async () => {
    const tenantId = new mongoose.Types.ObjectId();

    await assert.rejects(
      runWithTenantContext({ tenantId, kind: "OPERATOR" }, () =>
        TenantGuardFixture.estimatedDocumentCount().exec()
      ),
      TenantScopeError
    );
    await assert.rejects(
      runWithTenantContext({ tenantId, kind: "OPERATOR" }, () =>
        TenantGuardFixture.aggregate([{ $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "joined" } }]).exec()
      ),
      TenantScopeError
    );
  });

  test("permits safe tenant-scoped credit pipelines while rejecting owner changes and escape stages", () => {
    const creditReservationPipeline = [{
      $set: {
        reservedCreditMinor: { $add: ["$reservedCreditMinor", 500] },
        version: { $add: ["$version", 1] }
      }
    }];
    assert.deepEqual(
      validateTenantSafeUpdatePipeline(creditReservationPipeline, false),
      creditReservationPipeline
    );

    for (const pipeline of [
      [{ $set: { tenantId: "another-tenant" } }],
      [{ $addFields: { "tenantId.owner": "another-tenant" } }],
      [{ $unset: "tenantId" }],
      [{ $replaceWith: { tenantId: "another-tenant" } }]
    ]) {
      assert.throws(() => validateTenantSafeUpdatePipeline(pipeline, false), TenantScopeError);
    }
    assert.throws(
      () => validateTenantSafeUpdatePipeline(creditReservationPipeline, true),
      TenantScopeError
    );
  });

  test("scopes tenant-owned upserts with one unambiguous owner equality", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const otherTenantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();

    assert.deepEqual(
      scopeTenantFilter({ tenantId, branchId, dateKey: "20261026" }, tenantId, true),
      { tenantId, branchId, dateKey: "20261026" }
    );
    assert.deepEqual(
      scopeTenantFilter({ branchId, dateKey: "20261026" }, tenantId, true),
      { branchId, dateKey: "20261026", tenantId }
    );
    assert.throws(
      () => scopeTenantFilter({ tenantId: otherTenantId, branchId }, tenantId, true),
      TenantScopeError
    );
    assert.throws(
      () => scopeTenantFilter({ $or: [{ tenantId }, { branchId }] }, tenantId, true),
      TenantScopeError
    );
    assert.deepEqual(
      scopeTenantFilter({ tenantId: otherTenantId, branchId }, tenantId),
      { $and: [{ tenantId: otherTenantId, branchId }, { tenantId }] }
    );
  });

  test("blocks tenant-owned writes in read-only support context while allowing append-only audit creation", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const readOnlyContext = { tenantId, kind: "OPERATOR" as const, readOnly: true };
    const blockedWrites: Array<[string, () => Promise<unknown>]> = [
      ["updateOne", () => TenantGuardFixture.updateOne({}, { $set: { value: "changed" } }).exec()],
      ["updateMany", () => TenantGuardFixture.updateMany({}, { $set: { value: "changed" } }).exec()],
      ["findOneAndUpdate", () => TenantGuardFixture.findOneAndUpdate({}, { $set: { value: "changed" } }).exec()],
      ["replaceOne", () => TenantGuardFixture.replaceOne({}, { value: "replaced" }).exec()],
      ["findOneAndReplace", () => TenantGuardFixture.findOneAndReplace({}, { value: "replaced" }).exec()],
      ["deleteOne", () => TenantGuardFixture.deleteOne({}).exec()],
      ["deleteMany", () => TenantGuardFixture.deleteMany({}).exec()],
      ["findOneAndDelete", () => TenantGuardFixture.findOneAndDelete({}).exec()],
      ["insertMany", () => TenantGuardFixture.insertMany([{ value: "created" }])],
      ["bulkWrite", () => TenantGuardFixture.bulkWrite([
        { updateOne: { filter: {}, update: { $set: { value: "changed" } } } }
      ])],
      ["save", () => new TenantGuardFixture({ value: "created" }).save()],
      ["document deleteOne", () => new TenantGuardFixture({ value: "created" }).deleteOne().exec()]
    ];

    for (const [name, write] of blockedWrites) {
      await assert.rejects(runWithTenantContext(readOnlyContext, write), TenantScopeError, name);
    }

    assert.doesNotThrow(() => runWithTenantContext(readOnlyContext, () =>
      assertTenantWriteAllowed("save", { allowReadOnlyAuditAppend: true }, true)
    ));
    assert.throws(() => runWithTenantContext(readOnlyContext, () =>
      assertTenantWriteAllowed("save", { allowReadOnlyAuditAppend: true }, false)
    ), TenantScopeError);
    assert.throws(() => runWithTenantContext(readOnlyContext, () =>
      assertTenantWriteAllowed("updateOne", { allowReadOnlyAuditAppend: true })
    ), TenantScopeError);

    await assert.rejects(
      runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => new TenantGuardFixture({
        tenantId: new mongoose.Types.ObjectId(),
        value: "belongs to another tenant"
      }).deleteOne().exec()),
      TenantScopeError
    );
  });

  test("address lookup endpoints reject support requests that would mutate a draft", async () => {
    const supportContext = {
      tenantId: new mongoose.Types.ObjectId(),
      slug: "operator",
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      accessMode: "PLATFORM_SUPPORT"
    } as const;

    for (const lookup of [getPlaceAddress, getConsignorPlaceAddress]) {
      const request = {
        params: { placeId: "valid-provider-place-id" },
        query: { shipmentDraftId: new mongoose.Types.ObjectId().toString() },
        user: { _id: new mongoose.Types.ObjectId() },
        operatorContext: supportContext
      } as unknown as Request;
      const recorded = responseRecorder();
      await lookup(request, recorded.response);
      assert.equal(recorded.status(), 403);
      assert.deepEqual(recorded.body(), { success: false, message: "Operator support access is read-only." });
    }
  });
});
