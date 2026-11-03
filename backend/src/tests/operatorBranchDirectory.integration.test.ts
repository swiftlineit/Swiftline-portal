import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getOperatorBranchDetails, getOperatorBranchUser, listOperatorBranchUsers, requireOperatorBranchDocumentAccess } from "../controllers/operatorDirectory.controller.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databaseName = `sl_branch_dir_${Date.now()}`;

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
  assert.equal(mongoose.connection.name, databaseName, "Branch directory tests must use an isolated database.");
  await Promise.all([
    Tenant.createCollection(),
    Branch.createCollection(),
    TenantMembership.createCollection(),
    BusinessAccount.createCollection(),
    BusinessAccountMember.createCollection(),
    User.createCollection()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, databaseName, "Only the isolated branch-directory test database may be dropped.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("operator branch detail and assigned-user access", () => {
  test("returns safe branch details and only users assigned within the active tenant and branch", async () => {
    const [operator, otherOperator] = await Tenant.create([
      { kind: "OPERATOR", status: "ACTIVE", companyName: "Branch Operator", slug: "branch-operator" },
      { kind: "OPERATOR", status: "ACTIVE", companyName: "Other Operator", slug: "other-operator" }
    ]);
    assert.ok(operator && otherOperator);

    const ids = {
      branch: new mongoose.Types.ObjectId(),
      secondBranch: new mongoose.Types.ObjectId(),
      otherBranch: new mongoose.Types.ObjectId(),
      staff: new mongoose.Types.ObjectId(),
      otherTenantStaff: new mongoose.Types.ObjectId(),
      client: new mongoose.Types.ObjectId(),
      operatorAdmin: new mongoose.Types.ObjectId(),
      account: new mongoose.Types.ObjectId()
    };
    const now = new Date();

    await User.collection.insertMany([
      { _id: ids.staff, email: "branch.staff@example.test", firstName: "Sana", lastName: "Staff", name: "Sana Staff", userStatus: "active" },
      { _id: ids.otherTenantStaff, email: "other.staff@example.test", firstName: "Omar", lastName: "Other", name: "Omar Other", userStatus: "active" },
      { _id: ids.client, email: "branch.client@example.test", firstName: "Cleo", lastName: "Client", name: "Cleo Client", userStatus: "active", phone: "9876543210" },
      { _id: ids.operatorAdmin, email: "branch.admin@example.test", firstName: "Asha", lastName: "Admin", name: "Asha Admin", userStatus: "active" }
    ]);
    await Branch.collection.insertMany([
      {
        _id: ids.branch,
        tenantId: operator._id,
        name: "Central Hub",
        code: "CENTRAL",
        labelCode: "CEN",
        status: "ACTIVE",
        address: { countryName: "India", city: "Delhi", address: "20 Market Road" },
        contact: { email: "central@example.test" },
        openingDate: now,
        operations: { supportedServices: ["EXPRESS_COURIER"] },
        documents: [{ type: "GST", title: "GST certificate", fileName: "gst.pdf", storageKey: "private/tenant-branch-gst.pdf", mimeType: "application/pdf", uploadedAt: now }],
        createdBy: ids.operatorAdmin,
        createdAt: now,
        updatedAt: now
      },
      { _id: ids.secondBranch, tenantId: operator._id, name: "East Hub", code: "EAST", status: "ACTIVE", createdBy: ids.operatorAdmin, createdAt: now, updatedAt: now },
      { _id: ids.otherBranch, tenantId: otherOperator._id, name: "Other Hub", code: "OTHER", status: "ACTIVE", createdBy: ids.otherTenantStaff, createdAt: now, updatedAt: now }
    ]);
    await TenantMembership.collection.insertMany([
      { tenantId: operator._id, userId: ids.staff, role: "OPERATIONS", status: "ACTIVE", assignedBranches: [ids.branch], createdAt: now, updatedAt: now },
      { tenantId: operator._id, userId: ids.operatorAdmin, role: "OPERATOR_ADMIN", status: "ACTIVE", assignedBranches: [], createdAt: now, updatedAt: now },
      { tenantId: operator._id, userId: ids.client, role: "CLIENT", status: "ACTIVE", assignedBranches: [ids.branch], createdAt: now, updatedAt: now },
      { tenantId: otherOperator._id, userId: ids.otherTenantStaff, role: "OPERATIONS", status: "ACTIVE", assignedBranches: [ids.branch], createdAt: now, updatedAt: now }
    ]);
    await BusinessAccount.collection.insertOne({ _id: ids.account, tenantId: operator._id, accountId: "BA-TEST-001", accountKind: "BUSINESS", assignedBranch: ids.branch, company: { companyName: "Branch Client" }, contact: { jobTitle: "Warehouse owner" }, status: "active", createdAt: now, updatedAt: now });
    const clientMembership = await BusinessAccountMember.collection.insertOne({ tenantId: operator._id, businessAccount: ids.account, user: ids.client, role: "account_owner", assignedBranches: [], status: "active", invitedBy: ids.operatorAdmin, createdAt: now, updatedAt: now });

    const context = {
      tenantId: operator._id,
      slug: operator.slug,
      kind: "OPERATOR" as const,
      role: "OPERATIONS" as const,
      assignedBranches: [ids.branch],
      accessMode: "MEMBER" as const
    };

    const details = responseRecorder();
    await runWithTenantContext(context, () => getOperatorBranchDetails({
      params: { branchId: String(ids.branch) },
      operatorContext: context
    } as unknown as Request, details.response));

    assert.equal(details.status(), 200);
    const branch = (details.body() as { branch: { name: string; openingDate?: Date; documents: Array<Record<string, unknown>> } }).branch;
    assert.equal(branch.name, "Central Hub");
    assert.equal(branch.documents[0]?.fileName, "gst.pdf");
    assert.equal(JSON.stringify(branch).includes("storageKey"), false);
    assert.equal(branch.openingDate?.toISOString(), now.toISOString());

    const documentAccess = responseRecorder();
    let documentAllowed = false;
    await runWithTenantContext(context, () => requireOperatorBranchDocumentAccess({
      params: { branchId: String(ids.branch) }, operatorContext: context
    } as unknown as Request, documentAccess.response, () => { documentAllowed = true; }));
    assert.equal(documentAllowed, true);

    const deniedDocumentAccess = responseRecorder();
    let otherBranchDocumentAllowed = false;
    await runWithTenantContext(context, () => requireOperatorBranchDocumentAccess({
      params: { branchId: String(ids.otherBranch) }, operatorContext: context
    } as unknown as Request, deniedDocumentAccess.response, () => { otherBranchDocumentAllowed = true; }));
    assert.equal(otherBranchDocumentAllowed, false);
    assert.equal(deniedDocumentAccess.status(), 404);

    const users = responseRecorder();
    await runWithTenantContext(context, () => listOperatorBranchUsers({
      params: { branchId: String(ids.branch) },
      query: { page: "1", pageSize: "20" },
      operatorContext: context
    } as unknown as Request, users.response));

    assert.equal(users.status(), 200);
    const userBody = users.body() as { users: Array<{ user: { email: string; phone: string; designation: string } | null; account?: { companyName: string } | null }>; pagination: { total: number } };
    assert.deepEqual(userBody.users.map(({ user }) => user?.email), ["branch.staff@example.test", "branch.admin@example.test", "branch.client@example.test"]);
    assert.equal(userBody.users[2]?.user?.phone, "9876543210");
    assert.equal(userBody.users[2]?.user?.designation, "Warehouse owner");
    assert.equal(userBody.users[2]?.account?.companyName, "Branch Client");
    assert.equal(userBody.pagination.total, 3);

    const clientProfile = responseRecorder();
    await runWithTenantContext(context, () => getOperatorBranchUser({
      params: { branchId: String(ids.branch), membershipId: String(clientMembership.insertedId) },
      operatorContext: context
    } as unknown as Request, clientProfile.response));
    assert.equal(clientProfile.status(), 200);
    const profileBody = clientProfile.body() as {
      branch: { _id: string; name: string };
      user: { role: string; membershipStatus: string; user: { email: string; designation: string }; account: { accountId: string; companyName: string } };
    };
    assert.equal(profileBody.branch.name, "Central Hub");
    assert.equal(profileBody.user.role, "account_owner");
    assert.equal(profileBody.user.membershipStatus, "active");
    assert.equal(profileBody.user.user.email, "branch.client@example.test");
    assert.equal(profileBody.user.user.designation, "Warehouse owner");
    assert.equal(profileBody.user.account.companyName, "Branch Client");
    assert.equal(profileBody.user.account.accountId, "BA-TEST-001");

    const deniedClientProfile = responseRecorder();
    await runWithTenantContext(context, () => getOperatorBranchUser({
      params: { branchId: String(ids.secondBranch), membershipId: String(clientMembership.insertedId) },
      operatorContext: context
    } as unknown as Request, deniedClientProfile.response));
    assert.equal(deniedClientProfile.status(), 404);

    const otherBranch = responseRecorder();
    await runWithTenantContext(context, () => getOperatorBranchDetails({
      params: { branchId: String(ids.secondBranch) },
      operatorContext: context
    } as unknown as Request, otherBranch.response));
    assert.equal(otherBranch.status(), 404);

    const otherTenantBranch = responseRecorder();
    await runWithTenantContext(context, () => getOperatorBranchDetails({
      params: { branchId: String(ids.otherBranch) },
      operatorContext: context
    } as unknown as Request, otherTenantBranch.response));
    assert.equal(otherTenantBranch.status(), 404);
  });
});
