import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getOperatorContactQuery, listOperatorContactQueries, submitOperatorContactQuery } from "../controllers/operatorContact.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { OperatorContactQuery } from "../models/operatorContactQuery.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databasePrefix = "sl_operator_contact_";
const databaseName = `${databasePrefix}${Date.now()}`;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false, autoIndex: false, autoCreate: false });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([OperatorContactQuery.createCollection(), AuditLog.createCollection()]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith(databasePrefix));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function recorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

test("client queries and alerts stay with the operator and only reach its admin and operations users", async () => {
  const suffix = Date.now();
  const [client, admin, operations, finance, otherStaff, swiftlineAdmin] = await Promise.all([
    User.create({ email: `query-client-${suffix}@example.test`, role: "client", userStatus: "active" }),
    User.create({ email: `query-admin-${suffix}@example.test`, role: "client", userStatus: "active" }),
    User.create({ email: `query-ops-${suffix}@example.test`, role: "client", userStatus: "active" }),
    User.create({ email: `query-finance-${suffix}@example.test`, role: "client", userStatus: "active" }),
    User.create({ email: `query-other-${suffix}@example.test`, role: "client", userStatus: "active" }),
    User.create({ email: `query-swiftline-${suffix}@example.test`, role: "admin", userStatus: "active" })
  ]);
  const [operator, other, swiftline] = await Promise.all([
    Tenant.create({ kind: "OPERATOR", status: "ACTIVE", companyName: "Query Operator", slug: "query-operator" }),
    Tenant.create({ kind: "OPERATOR", status: "ACTIVE", companyName: "Other Operator", slug: "other-query-operator" }),
    Tenant.create({ kind: "SWIFTLINE", status: "ACTIVE", companyName: "Swiftline", slug: "swiftline" })
  ]);
  await TenantMembership.create([
    { tenantId: operator._id, userId: client._id, role: "CLIENT", status: "ACTIVE" },
    { tenantId: operator._id, userId: admin._id, role: "OPERATOR_ADMIN", status: "ACTIVE" },
    { tenantId: operator._id, userId: operations._id, role: "OPERATIONS", status: "ACTIVE" },
    { tenantId: operator._id, userId: finance._id, role: "FINANCE", status: "ACTIVE" },
    { tenantId: other._id, userId: otherStaff._id, role: "OPERATOR_ADMIN", status: "ACTIVE" },
    { tenantId: swiftline._id, userId: swiftlineAdmin._id, role: "OPERATOR_ADMIN", status: "ACTIVE" }
  ]);
  const accountId = new mongoose.Types.ObjectId();
  await runWithTenantContext({ tenantId: operator._id, kind: "OPERATOR" }, async () => {
    await BusinessAccount.collection.insertOne({
      _id: accountId, tenantId: operator._id, accountId: `QUERY-${suffix}`,
      company: { companyName: "Client Export House" }, status: "active", createdAt: new Date(), updatedAt: new Date()
    });
    await BusinessAccountMember.create({
      businessAccount: accountId, user: client._id, role: "account_owner", status: "active", invitedBy: admin._id
    });
  });

  const request = {
    body: { kind: "ISSUE", subject: "Missing parcel update", message: "Please check the latest parcel scan.",
      contactName: "Client Contact", contactEmail: "client@example.test", contactPhone: "+91 9999999999",
      awbNumbers: ["QOP12345", "QOP12345"] },
    user: { _id: client._id, role: "client" },
    operatorContext: { tenantId: operator._id, slug: operator.slug, role: "CLIENT", assignedBranches: [], accessMode: "MEMBER" }
  } as unknown as Request;
  const submitted = recorder();
  await runWithTenantContext({ tenantId: operator._id, kind: "OPERATOR" }, () => submitOperatorContactQuery(request, submitted.response));
  assert.equal(submitted.status(), 201);
  const result = submitted.body() as { query: { id: string; businessAccountName: string; awbNumbers: string[] } };
  assert.equal(result.query.businessAccountName, "Client Export House");
  assert.deepEqual(result.query.awbNumbers, ["QOP12345"]);

  await runWithTenantContext({ tenantId: operator._id, kind: "OPERATOR" }, async () => {
    assert.equal(await OperatorContactQuery.countDocuments(), 1);
    assert.equal(await AuditLog.countDocuments({ action: "OPERATOR_CONTACT_QUERY_SUBMITTED" }), 1);
    const notices = await PortalNotification.find({ type: "OPERATOR_CONTACT_QUERY_SUBMITTED" }).lean().exec();
    assert.deepEqual(notices.map((notice) => String(notice.recipientUserId)).sort(), [admin, operations].map((user) => String(user._id)).sort());
    const emails = await EmailOutbox.find({ notificationType: "OPERATOR_CONTACT_QUERY_SUBMITTED" }).lean().exec();
    assert.deepEqual(emails.map((email) => email.toEmail).sort(), [admin.email, operations.email].sort());
    assert.ok(emails.every((email) => email.payload.businessAccountName === "Client Export House"));
    const listed = recorder();
    await listOperatorContactQueries({ query: { page: "1", search: "QOP12345" } } as unknown as Request, listed.response);
    assert.equal((listed.body() as { queries: unknown[] }).queries.length, 1);
  });
  await runWithTenantContext({ tenantId: other._id, kind: "OPERATOR" }, async () => {
    const hidden = recorder();
    await getOperatorContactQuery({ params: { queryId: result.query.id } } as unknown as Request, hidden.response);
    assert.equal(hidden.status(), 404);
    assert.equal(await OperatorContactQuery.countDocuments(), 0);
    assert.equal(await PortalNotification.countDocuments({ type: "OPERATOR_CONTACT_QUERY_SUBMITTED" }), 0);
    assert.equal(await EmailOutbox.countDocuments({ notificationType: "OPERATOR_CONTACT_QUERY_SUBMITTED" }), 0);
  });
  await runWithTenantContext({ tenantId: swiftline._id, kind: "SWIFTLINE" }, async () => {
    assert.equal(await PortalNotification.countDocuments({ type: "OPERATOR_CONTACT_QUERY_SUBMITTED" }), 0);
    assert.equal(await EmailOutbox.countDocuments({ notificationType: "OPERATOR_CONTACT_QUERY_SUBMITTED" }), 0);
  });
});
