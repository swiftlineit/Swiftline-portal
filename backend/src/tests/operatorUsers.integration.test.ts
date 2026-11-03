import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getOperatorUserProfile, listOperatorUsers } from "../controllers/operatorUsers.controller.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databaseName = `sl_operator_users_${Date.now()}`;

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    family: 4,
    retryWrites: false,
    autoIndex: false,
    autoCreate: false
  });
  assert.equal(mongoose.connection.name, databaseName, "Operator user tests must use an isolated database.");
  await Promise.all([
    Tenant.createCollection(),
    TenantMembership.createCollection(),
    User.createCollection(),
    BusinessAccount.createCollection(),
    BusinessAccountMember.createCollection()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, databaseName, "Only the isolated operator-user test database may be dropped.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("operator user directory tenant isolation", () => {
  test("returns separate, paginated operator-team and client-user lists only for the active operator", async () => {
    const [swiftline, operator, otherOperator] = await Tenant.create([
      { kind: "SWIFTLINE", status: "ACTIVE", companyName: "Swiftline Test", slug: "swiftline" },
      { kind: "OPERATOR", status: "ACTIVE", companyName: "Operator Test", slug: "operator-test" },
      { kind: "OPERATOR", status: "ACTIVE", companyName: "Other Operator Test", slug: "other-operator-test" }
    ]);
    assert.ok(swiftline && operator && otherOperator);

    const ids = {
      operatorAdmin: new mongoose.Types.ObjectId(),
      operatorFinance: new mongoose.Types.ObjectId(),
      operatorClient: new mongoose.Types.ObjectId(),
      operatorClient2: new mongoose.Types.ObjectId(),
      crossLinkedClient: new mongoose.Types.ObjectId(),
      otherAdmin: new mongoose.Types.ObjectId(),
      otherClient: new mongoose.Types.ObjectId(),
      swiftlineClient: new mongoose.Types.ObjectId(),
      operatorAccount: new mongoose.Types.ObjectId(),
      otherAccount: new mongoose.Types.ObjectId(),
      swiftlineAccount: new mongoose.Types.ObjectId()
    };
    const now = new Date();

    await User.collection.insertMany([
      { _id: ids.operatorAdmin, email: "admin@operator.example", firstName: "Olivia", lastName: "Admin", role: "client", userStatus: "active" },
      { _id: ids.operatorFinance, email: "finance@operator.example", firstName: "Fiona", lastName: "Finance", role: "client", userStatus: "active" },
      { _id: ids.operatorClient, email: "client@operator.example", firstName: "Chris", lastName: "Client", role: "client", userStatus: "active" },
      { _id: ids.operatorClient2, email: "second-client@operator.example", firstName: "Sandy", lastName: "Client", role: "client", userStatus: "invited" },
      { _id: ids.crossLinkedClient, email: "cross-linked@operator.example", firstName: "Cross", lastName: "Linked", role: "client", userStatus: "active" },
      { _id: ids.otherAdmin, email: "admin@other.example", firstName: "Other", lastName: "Admin", role: "client", userStatus: "active" },
      { _id: ids.otherClient, email: "client@other.example", firstName: "Other", lastName: "Client", role: "client", userStatus: "active" },
      { _id: ids.swiftlineClient, email: "client@swiftline.example", firstName: "Swiftline", lastName: "Client", role: "client", userStatus: "active" }
    ]);
    await BusinessAccount.collection.insertMany([
      { _id: ids.operatorAccount, tenantId: operator._id, accountId: "OP-BA-1", accountKind: "BUSINESS", company: { companyName: "" }, contact: { firstName: "Operator", lastName: "Client", jobTitle: "Operations Lead" }, status: "active" },
      { _id: ids.otherAccount, tenantId: otherOperator._id, accountId: "OTHER-BA-1", accountKind: "BUSINESS", company: { companyName: "Other Operator Client" }, status: "active" },
      { _id: ids.swiftlineAccount, tenantId: swiftline._id, accountId: "SL-BA-1", accountKind: "BUSINESS", company: { companyName: "Swiftline Client" }, status: "active" }
    ]);
    await TenantMembership.collection.insertMany([
      { tenantId: operator._id, userId: ids.operatorAdmin, role: "OPERATOR_ADMIN", status: "ACTIVE", assignedBranches: [], createdAt: now, updatedAt: now },
      { tenantId: operator._id, userId: ids.operatorFinance, role: "FINANCE", status: "ACTIVE", assignedBranches: [], createdAt: new Date(now.getTime() - 1), updatedAt: now },
      { tenantId: operator._id, userId: ids.operatorClient, role: "CLIENT", status: "ACTIVE", assignedBranches: [], createdAt: now, updatedAt: now },
      { tenantId: otherOperator._id, userId: ids.otherAdmin, role: "OPERATOR_ADMIN", status: "ACTIVE", assignedBranches: [], createdAt: now, updatedAt: now },
      { tenantId: swiftline._id, userId: ids.swiftlineClient, role: "CLIENT", status: "ACTIVE", assignedBranches: [], createdAt: now, updatedAt: now }
    ]);
    await BusinessAccountMember.collection.insertMany([
      { tenantId: operator._id, businessAccount: ids.operatorAccount, user: ids.operatorClient, role: "account_owner", status: "active", invitedBy: ids.operatorAdmin, createdAt: now, updatedAt: now },
      { tenantId: operator._id, businessAccount: ids.operatorAccount, user: ids.operatorClient2, role: "finance", status: "invited", invitedBy: ids.operatorAdmin, createdAt: new Date(now.getTime() - 1), updatedAt: now },
      { tenantId: otherOperator._id, businessAccount: ids.otherAccount, user: ids.otherClient, role: "account_owner", status: "active", invitedBy: ids.otherAdmin, createdAt: now, updatedAt: now },
      { tenantId: swiftline._id, businessAccount: ids.swiftlineAccount, user: ids.swiftlineClient, role: "account_owner", status: "active", invitedBy: ids.swiftlineClient, createdAt: now, updatedAt: now }
    ]);

    const context = {
      tenantId: operator._id,
      slug: operator.slug,
      kind: "OPERATOR" as const,
      role: "OPERATOR_ADMIN" as const,
      assignedBranches: [],
      accessMode: "MEMBER" as const
    };
    const recorded = responseRecorder();
    await runWithTenantContext(context, () => listOperatorUsers({
      query: { teamPage: "1", clientPage: "1", pageSize: "1" },
      operatorContext: context
    } as unknown as Request, recorded.response));

    assert.equal(recorded.status(), 200);
    const body = recorded.body() as {
      teamUsers: Array<{ user: { email: string } }>;
      teamPagination: { page: number; pageSize: number; total: number; totalPages: number };
      clientUsers: Array<{ user: { email: string; designation: string }; account: { accountId: string; companyName: string } }>;
      clientPagination: { page: number; pageSize: number; total: number; totalPages: number };
    };
    assert.deepEqual(body.teamUsers.map((user) => user.user.email), ["admin@operator.example"]);
    assert.deepEqual(body.clientUsers.map((user) => user.user.email), ["client@operator.example"]);
    assert.equal(body.clientUsers[0]?.account.accountId, "OP-BA-1");
    assert.equal(body.clientUsers[0]?.account.companyName, "Operator Client");
    assert.equal(body.clientUsers[0]?.user.designation, "Operations Lead");
    assert.deepEqual(body.teamPagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
    assert.deepEqual(body.clientPagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });

    const searched = responseRecorder();
    await runWithTenantContext(context, () => listOperatorUsers({
      query: { search: "second-client@operator.example" },
      operatorContext: context
    } as unknown as Request, searched.response));
    const searchedBody = searched.body() as { teamUsers: unknown[]; clientUsers: Array<{ user: { email: string } }> };
    assert.deepEqual(searchedBody.teamUsers, []);
    assert.deepEqual(searchedBody.clientUsers.map((user) => user.user.email), ["second-client@operator.example"]);

    await BusinessAccountMember.collection.insertOne({
      tenantId: operator._id,
      businessAccount: ids.otherAccount,
      user: ids.crossLinkedClient,
      role: "account_owner",
      status: "active",
      invitedBy: ids.operatorAdmin,
      createdAt: now,
      updatedAt: now
    });
    const crossLinked = responseRecorder();
    await runWithTenantContext(context, () => listOperatorUsers({
      query: { search: "cross-linked@operator.example" },
      operatorContext: context
    } as unknown as Request, crossLinked.response));
    const crossLinkedBody = crossLinked.body() as { clientUsers: unknown[]; clientPagination: { total: number } };
    assert.deepEqual(crossLinkedBody.clientUsers, []);
    assert.equal(crossLinkedBody.clientPagination.total, 0);

    const teamMembership = await TenantMembership.findOne({ tenantId: operator._id, userId: ids.operatorAdmin }).select("_id").lean().exec();
    assert.ok(teamMembership);
    const teamProfile = responseRecorder();
    await runWithTenantContext(context, () => getOperatorUserProfile({
      params: { audience: "team", membershipId: String(teamMembership._id) },
      operatorContext: context
    } as unknown as Request, teamProfile.response));
    assert.equal(teamProfile.status(), 200);
    const teamProfileBody = teamProfile.body() as { profile: { user: { email: string }; allBranchesAccess: boolean } };
    assert.equal(teamProfileBody.profile.user.email, "admin@operator.example");
    assert.equal(teamProfileBody.profile.allBranchesAccess, true);

    const clientMembership = await BusinessAccountMember.findOne({ tenantId: operator._id, user: ids.operatorClient }).select("_id").lean().exec();
    assert.ok(clientMembership);
    const clientProfile = responseRecorder();
    await runWithTenantContext(context, () => getOperatorUserProfile({
      params: { audience: "clients", membershipId: String(clientMembership._id) },
      operatorContext: context
    } as unknown as Request, clientProfile.response));
    assert.equal(clientProfile.status(), 200);
    const clientProfileBody = clientProfile.body() as {
      profile: { user: { designation: string }; account: { accountId: string; companyName: string } };
    };
    assert.equal(clientProfileBody.profile.user.designation, "Operations Lead");
    assert.deepEqual(clientProfileBody.profile.account, { accountId: "OP-BA-1", companyName: "Operator Client" });

    const otherMembership = await TenantMembership.findOne({ tenantId: otherOperator._id, userId: ids.otherAdmin }).select("_id").lean().exec();
    assert.ok(otherMembership);
    const crossTenantProfile = responseRecorder();
    await runWithTenantContext(context, () => getOperatorUserProfile({
      params: { audience: "team", membershipId: String(otherMembership._id) },
      operatorContext: context
    } as unknown as Request, crossTenantProfile.response));
    assert.equal(crossTenantProfile.status(), 404);
  });
});
