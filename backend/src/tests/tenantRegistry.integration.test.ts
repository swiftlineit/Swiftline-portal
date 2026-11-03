import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { getOperatorContext, requireOperatorContext } from "../middleware/operatorContext.middleware.js";
import {
  changeOperatorSlug,
  changeOperatorStatus,
  createDraftOperator,
  normalizeTenantSlug,
  resolveTenantSlug,
  TenantRegistryError
} from "../services/tenantRegistry.service.js";
import { notifyPortalUsers } from "../services/portalNotification.service.js";
import { enqueueEmails } from "../services/email/enqueue.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databaseName = `sl_operator_registry_${Date.now()}`;
const actorId = new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName, family: 4, retryWrites: false, autoIndex: false, autoCreate: false
  });
  assert.equal(mongoose.connection.name, databaseName);
  await Tenant.createCollection();
  await TenantSlug.createCollection();
  await TenantMembership.createCollection();
  await Promise.all([Tenant.createIndexes(), TenantSlug.createIndexes(), TenantMembership.createIndexes()]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_operator_registry_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("operator tenant registry", () => {
  test("company names produce stable URL slugs and reserve Swiftline", () => {
    assert.equal(normalizeTenantSlug("  Atlas Cargo & Express Pvt. Ltd.  "), "atlas-cargo-express-pvt-ltd");
    assert.throws(() => normalizeTenantSlug("Swiftline"), TenantRegistryError);
    assert.throws(() => normalizeTenantSlug("東京"), TenantRegistryError);
  });

  test("draft onboarding, aliases and uniqueness remain atomic", async () => {
    const atlas = await createDraftOperator({ companyName: "Atlas Cargo", actorId });
    assert.equal(atlas.kind, "OPERATOR");
    assert.equal(atlas.status, "DRAFT");
    assert.equal(atlas.slug, "atlas-cargo");
    assert.equal(await resolveTenantSlug("atlas-cargo"), null, "drafts are not publicly routable");
    assert.equal(await AuditLog.countDocuments({ action: "OPERATOR_DRAFT_CREATED", entityId: atlas._id }), 1);

    const second = await createDraftOperator({ companyName: "Meridian Logistics", slug: "meridian", actorId });
    await assert.rejects(
      createDraftOperator({ companyName: "Duplicate Atlas", slug: "atlas-cargo", actorId }),
      (error: unknown) => error instanceof TenantRegistryError && error.statusCode === 409
    );
    await assert.rejects(
      changeOperatorSlug({ tenantId: second._id, slug: "atlas-cargo", actorId }),
      (error: unknown) => error instanceof TenantRegistryError && error.statusCode === 409
    );

    await changeOperatorSlug({ tenantId: atlas._id, slug: "atlas", actorId });
    await Tenant.updateOne({ _id: atlas._id }, { $set: { status: "ACTIVE" } });
    const previous = await resolveTenantSlug("atlas-cargo");
    const current = await resolveTenantSlug("atlas");
    assert.equal(previous?.tenant._id.toString(), atlas._id.toString());
    assert.equal(previous?.canonicalSlug, "atlas");
    assert.equal(previous?.redirect, true);
    assert.equal(current?.redirect, false);
    assert.equal(await TenantSlug.countDocuments({ tenantId: atlas._id, isCurrent: true }), 1);
    assert.equal(await AuditLog.countDocuments({ action: "OPERATOR_SLUG_CHANGED", entityId: atlas._id }), 1);

    // An old URL remains reserved for its original tenant, even after a rename.
    await assert.rejects(
      changeOperatorSlug({ tenantId: second._id, slug: "atlas-cargo", actorId }),
      (error: unknown) => error instanceof TenantRegistryError && error.statusCode === 409
    );
    await changeOperatorSlug({ tenantId: atlas._id, slug: "atlas-cargo", actorId });
    assert.equal((await resolveTenantSlug("atlas-cargo"))?.redirect, false);
    assert.equal((await resolveTenantSlug("atlas"))?.redirect, true);
    assert.equal(await TenantSlug.countDocuments({ tenantId: atlas._id, isCurrent: true }), 1);
  });

  test("operator access requires an active membership in the URL tenant", async () => {
    const atlas = await Tenant.findOne({ slug: "atlas-cargo" }).lean().exec();
    const meridian = await Tenant.findOne({ slug: "meridian" }).lean().exec();
    assert.ok(atlas && meridian);
    await Tenant.updateOne({ _id: meridian._id }, { $set: { status: "ACTIVE" } });
    const memberId = new mongoose.Types.ObjectId();
    await TenantMembership.create({
      tenantId: atlas._id, userId: memberId, role: "OPERATIONS", status: "ACTIVE",
      assignedBranches: []
    });

    async function check(slug: string, role: string, userId = memberId) {
      const request = { params: { operatorSlug: slug }, headers: {}, user: { _id: userId, role } } as unknown as Request;
      let status = 200;
      let payload: unknown;
      let allowed = false;
      const response = {
        status(code: number) { status = code; return this; },
        json(body: unknown) { payload = body; return this; }
      } as unknown as Response;
      await requireOperatorContext(request, response, (() => { allowed = true; }) as NextFunction);
      return { status, payload, allowed, context: getOperatorContext(request) };
    }

    const valid = await check("atlas-cargo", "client");
    assert.equal(valid.allowed, true);
    assert.equal(valid.context?.tenantId.toString(), atlas._id.toString());
    assert.equal(valid.context?.role, "OPERATIONS");
    assert.equal((await check("meridian", "client")).status, 404);
    assert.equal((await check("atlas-cargo", "admin")).status, 403);
    assert.equal((await check("atlas", "client")).status, 409);
    assert.equal((await check("atlas", "client", new mongoose.Types.ObjectId())).status, 404);
    assert.equal((await check("atlas-cargo", "client", new mongoose.Types.ObjectId())).status, 404);
    await TenantMembership.updateOne({ tenantId: atlas._id, userId: memberId }, { $set: { status: "SUSPENDED" } });
    assert.equal((await check("atlas-cargo", "client")).status, 404);
  });

  test("suspension closes operator access and new notices; reactivation restores access", async () => {
    const operator = await Tenant.findOne({ slug: "atlas-cargo" }).orFail().exec();
    const other = await Tenant.findOne({ slug: "meridian" }).orFail().exec();
    const recipient = new mongoose.Types.ObjectId();
    const context = { tenantId: operator._id as mongoose.Types.ObjectId, kind: "OPERATOR" as const };
    const support = await OperatorSupportSession.create({
      tokenHash: "a".repeat(64), operatorTenantId: operator._id, actorUserId: actorId,
      reason: "Checking a support case", expiresAt: new Date(Date.now() + 30 * 60_000)
    });
    await runWithTenantContext(context, () => notifyPortalUsers([recipient], {
      type: "SHIPMENT_BOOKED", title: "Before suspension", message: "Queued before suspension",
      href: "/portal/atlas-cargo/shipments", idempotencyKey: "before-suspension"
    }));
    await runWithTenantContext(context, () => enqueueEmails({
      notificationType: "SHIPMENT_BOOKED", idempotencyKey: "email-before-suspension",
      recipients: [{ email: "operator-suspension-test@example.test", name: "Test" }], subject: "Before suspension"
    }));

    const suspended = await changeOperatorStatus({ tenantId: operator._id as mongoose.Types.ObjectId, actorId, status: "SUSPENDED", reason: "Pilot operations paused" });
    assert.equal(suspended.status, "SUSPENDED");
    assert.equal(await resolveTenantSlug("atlas-cargo"), null);
    assert.ok(await resolveTenantSlug("meridian"), "another operator remains available");
    assert.equal((await OperatorSupportSession.findById(support._id).orFail().exec()).endedBy?.toString(), String(actorId));
    await runWithTenantContext(context, () => notifyPortalUsers([recipient], {
      type: "SHIPMENT_BOOKED", title: "After suspension", message: "Must not be created",
      href: "/portal/atlas-cargo/shipments", idempotencyKey: "after-suspension"
    }));
    const queuedAfterSuspension = await runWithTenantContext(context, () => enqueueEmails({
      notificationType: "SHIPMENT_BOOKED", idempotencyKey: "email-after-suspension",
      recipients: [{ email: "operator-suspension-test@example.test", name: "Test" }], subject: "After suspension"
    }));
    assert.equal(queuedAfterSuspension.enqueued, 0);
    assert.equal(await runWithTenantContext(context, () => PortalNotification.countDocuments({ idempotencyKey: `after-suspension:${recipient}` })), 0);
    assert.equal(await runWithTenantContext(context, () => PortalNotification.countDocuments({ idempotencyKey: `before-suspension:${recipient}` })), 1);
    assert.equal(await runWithTenantContext(context, () => EmailOutbox.countDocuments({ idempotencyKey: "email-before-suspension:operator-suspension-test@example.test:email" })), 1);
    assert.equal(await runWithTenantContext(context, () => EmailOutbox.countDocuments({ idempotencyKey: "email-after-suspension:operator-suspension-test@example.test:email" })), 0);
    assert.equal(await runWithTenantContext(context, () => AuditLog.countDocuments({ action: "OPERATOR_TENANT_SUSPENDED", entityId: operator._id, "metadata.reason": "Pilot operations paused" })), 1);
    await assert.rejects(
      changeOperatorStatus({ tenantId: operator._id as mongoose.Types.ObjectId, actorId, status: "SUSPENDED", reason: "Repeated" }),
      (error: unknown) => error instanceof TenantRegistryError && error.statusCode === 409
    );
    const reactivated = await changeOperatorStatus({ tenantId: operator._id as mongoose.Types.ObjectId, actorId, status: "ACTIVE", reason: "Pilot operations resumed" });
    assert.equal(reactivated.status, "ACTIVE");
    assert.ok(await resolveTenantSlug("atlas-cargo"));
    assert.equal((await OperatorSupportSession.findById(support._id).orFail().exec()).endedBy?.toString(), String(actorId), "old support grant stays closed");
    assert.equal(await runWithTenantContext(context, () => AuditLog.countDocuments({ action: "OPERATOR_TENANT_REACTIVATED", entityId: operator._id })), 1);
    assert.equal(other.status, "ACTIVE");
  });
});
