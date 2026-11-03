import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import {
  createBusinessAccount,
  assignBusinessAccountBranch,
  submitBusinessAccount,
  updateBusinessAccountOperationalAction,
  updateBusinessAccountGstBillingReview,
  updateBusinessAccountStatus
} from "../controllers/businessAccount.controller.js";
import { updateBusinessAccountMemberStatus } from "../controllers/businessAccountAccess.controller.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessAccountInvitation } from "../models/businessAccountInvitation.model.js";
import { Branch } from "../models/branch.model.js";
import { User } from "../models/user.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";

// Kept short: Atlas caps database names at 38 bytes.
const databaseName = `swiftline_ba_test_${Date.now()}`;

function createResponseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = payload;
      return response;
    }
  } as unknown as Response;
  return { response, statusCode: () => statusCode, body: <T>() => body as T };
}

function controllerRequest(input: {
  userId: mongoose.Types.ObjectId;
  body?: unknown;
  params?: Record<string, string>;
}) {
  return {
    user: { _id: input.userId, role: "admin" },
    body: input.body ?? {},
    params: input.params ?? {},
    headers: {},
    files: {},
    query: {}
  } as unknown as Request;
}

function testDocument(type: "aadhaarCard" | "panCard") {
  return {
    type,
    originalName: `${type}.pdf`,
    storageKey: `business-accounts/test-account/kyc/${type}.pdf`,
    mimeType: "application/pdf",
    size: 1024,
    uploadedAt: new Date()
  };
}

async function createDraftAccount(adminId: mongoose.Types.ObjectId, accountId: string) {
  return BusinessAccount.create({
    accountId,
    status: "draft",
    contact: {
      title: "mr.",
      firstName: "John",
      lastName: "Doe",
      email: `${accountId.toLowerCase()}@acme.com`,
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: `98765${accountId.slice(-5)}`,
      jobTitle: "Director",
      department: "Management",
      shipmentTypes: ["international_cargo"]
    },
    company: {
      registrationCountry: "India",
      registrationId: `ABCDE${accountId.slice(-4)}F`,
      gstin: "07ABCDE1234F1Z5",
      companyType: "pvt_ltd",
      companyName: "Acme Exports",
      registeredAddress: "1 Trade Street",
      city: "New Delhi",
      stateOrProvince: "Delhi",
      postalCode: "110001",
      addressCountry: "India",
      operatingCountries: ["India"],
      industry: "Retail",
      monthlyShipmentVolume: "1-50 shipments",
      requestedCreditLimit: { currency: "INR", amount: null }
    },
    documents: { aadhaarCard: testDocument("aadhaarCard"), panCard: testDocument("panCard") },
    createdBy: adminId,
    updatedBy: adminId
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Integration tests must use the isolated business-account test database.");
  await Promise.all([
    BusinessAccount.init(),
    BusinessAccountMember.init(),
    BusinessAccountInvitation.init(),
    Branch.init(),
    User.init(),
    AuditLog.init(),
    Tenant.init(),
    TenantSlug.init()
  ]);
  const swiftlineTenant = await Tenant.create({
    kind: "SWIFTLINE",
    status: "ACTIVE",
    companyName: "Swiftline Test",
    slug: "swiftline",
    createdBy: null
  });
  await TenantSlug.create({ slug: "swiftline", tenantId: swiftlineTenant._id, isCurrent: true });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("swiftline_ba_test_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("business account lifecycle", () => {
  test("new staff accounts are assigned to the Swiftline tenant", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const email = `tenant-account-${Date.now()}@example.com`;
    const mobile = `98${String(Date.now()).slice(-8)}`;
    const recorder = createResponseRecorder();

    await createBusinessAccount(
      controllerRequest({
        userId: adminId,
        body: {
          saveAsDraft: "true",
          contact: {
            firstName: "Tenant",
            lastName: "Account",
            email,
            countryCode: "+91",
            mobileNumber: mobile
          },
          company: { registrationCountry: "India", operatingCountries: ["India"] }
        }
      }),
      recorder.response
    );

    assert.equal(recorder.statusCode(), 201);
    const responseBody = recorder.body<{ account: { accountId: string } }>();
    const stored = await BusinessAccount.findOne({ accountId: responseBody.account.accountId }).lean().exec();
    assert.ok(stored?.tenantId);
    const root = await Tenant.findOne({ kind: "SWIFTLINE" }).lean().exec();
    assert.equal(String(stored?.tenantId), String(root?._id));
  });

  test("persists no-GST approval and rejects a stale review version", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const account = await createDraftAccount(adminId, "BA-2026-200005");
    account.status = "pending_review";
    account.gstBilling = {
      requestedTreatment: "NO_GST",
      status: "PENDING",
      requestReason: "No GST registration",
      requestedAt: new Date(),
      requestedBy: adminId,
      reviewedAt: null,
      reviewedBy: null,
      decisionReason: "",
      effectiveFrom: null,
      effectiveUntil: null,
      version: 1
    };
    await account.save();

    const approve = createResponseRecorder();
    await updateBusinessAccountGstBillingReview(
      controllerRequest({
        userId: adminId,
        params: { accountId: account.accountId },
        body: { decision: "APPROVE", reason: "Approved for no-GST billing", expectedVersion: 1 }
      }),
      approve.response
    );

    assert.equal(approve.statusCode(), 200);
    const approvedBody = approve.body<{ account: { gstBilling: { status: string; version: number } } }>();
    assert.equal(approvedBody.account.gstBilling.status, "APPROVED");
    assert.equal(approvedBody.account.gstBilling.version, 2);

    const stored = await BusinessAccount.findById(account._id).lean().exec();
    assert.equal(stored?.gstBilling.status, "APPROVED");
    assert.equal(stored?.gstBilling.version, 2);
    assert.ok(stored?.gstBilling.effectiveFrom instanceof Date);
    assert.equal(stored?.gstBilling.effectiveUntil, null);

    const stale = createResponseRecorder();
    await updateBusinessAccountGstBillingReview(
      controllerRequest({
        userId: adminId,
        params: { accountId: account.accountId },
        body: { decision: "APPROVE", reason: "Duplicate approval", expectedVersion: 1 }
      }),
      stale.response
    );
    assert.equal(stale.statusCode(), 409);
  });

  test("submits a stored draft that reuses its company address and requests credit", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const account = await createDraftAccount(adminId, "BA-2026-200004");

    account.company.requestedCreditLimit.amount = 50_000;
    await account.save();

    const submit = createResponseRecorder();
    await submitBusinessAccount(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId } }),
      submit.response
    );

    assert.equal(submit.statusCode(), 200);
    const stored = await BusinessAccount.findById(account._id).lean().exec();
    assert.equal(stored?.status, "pending_review");
    assert.equal(stored?.company.useCompanyAddressAsBillingAddress, true);
    assert.equal(stored?.company.billingAddress, null);
    assert.equal(stored?.company.requestedCreditLimit.amount, 50_000);
  });

  test("enforces the status state machine and KYC gate", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const account = await createDraftAccount(adminId, "BA-2026-200001");

    // draft -> active is not a permitted transition.
    const invalid = createResponseRecorder();
    await updateBusinessAccountStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { status: "active" } }),
      invalid.response
    );
    assert.equal(invalid.statusCode(), 409);

    // draft -> pending_review submits the account (documents are present).
    const submit = createResponseRecorder();
    await updateBusinessAccountStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { status: "pending_review" } }),
      submit.response
    );
    assert.equal(submit.statusCode(), 200);

    // pending_review -> approved is blocked until KYC is verified.
    const blocked = createResponseRecorder();
    await updateBusinessAccountStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { status: "approved" } }),
      blocked.response
    );
    assert.equal(blocked.statusCode(), 409);

    // Verify every mandatory KYC check (and the derived overall status) so the
    // account is genuinely verified and stays that way across lifecycle saves.
    await BusinessAccount.updateOne({ _id: account._id }, {
      $set: {
        "kycReview.overallStatus": "verified",
        "kycReview.checks.contactDetails": { status: "verified" },
        "kycReview.checks.companyDetails": { status: "verified" },
        "kycReview.checks.aadhaarCard": { status: "verified" },
        "kycReview.checks.panCard": { status: "verified" }
      }
    }).exec();

    for (const status of ["approved", "active", "suspended", "active"]) {
      const ok = createResponseRecorder();
      await updateBusinessAccountStatus(
        controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { status } }),
        ok.response
      );
      assert.equal(ok.statusCode(), 200, `transition to ${status} should succeed`);
    }

    const finalAccount = await BusinessAccount.findById(account._id).lean().exec();
    assert.equal(finalAccount?.status, "active");
  });

  test("operational actions and branch assignment do not change lifecycle status", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const account = await createDraftAccount(adminId, "BA-2026-200002");
    const branch = await Branch.create({
      name: "Delhi Hub",
      code: "DEL-HUB",
      status: "ACTIVE",
      createdBy: adminId
    });

    const deposit = createResponseRecorder();
    await updateBusinessAccountOperationalAction(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { action: "deposit_required" } }),
      deposit.response
    );
    assert.equal(deposit.statusCode(), 200);

    const assign = createResponseRecorder();
    await assignBusinessAccountBranch(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId }, body: { branchId: String(branch._id) } }),
      assign.response
    );
    assert.equal(assign.statusCode(), 200);

    const stored = await BusinessAccount.findById(account._id).lean().exec();
    assert.equal(stored?.status, "draft", "status must remain draft after operational/branch updates");
    assert.equal(stored?.depositStatus, "required");
    assert.equal(String(stored?.assignedBranch), String(branch._id));
  });

  test("member access can be suspended, removed and restored without a second identity", async () => {
    const adminId = new mongoose.Types.ObjectId();
    const account = await createDraftAccount(adminId, "BA-2026-200003");
    const client = await User.create({
      firstName: "Existing",
      lastName: "Client",
      email: "existing.client@example.com",
      phone: "+919876543219",
      role: "client",
      userStatus: "active",
      isVerified: true,
      passwordHash: "stored-password-hash"
    });
    const member = await BusinessAccountMember.create({
      businessAccount: account._id,
      user: client._id,
      role: "account_owner",
      assignedBranches: [],
      status: "active",
      invitedBy: adminId
    });

    const suspend = createResponseRecorder();
    await updateBusinessAccountMemberStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId, memberId: String(member._id) }, body: { status: "suspended" } }),
      suspend.response
    );
    assert.equal(suspend.statusCode(), 200);

    const remove = createResponseRecorder();
    await updateBusinessAccountMemberStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId, memberId: String(member._id) }, body: { status: "removed" } }),
      remove.response
    );
    assert.equal(remove.statusCode(), 200);

    const stored = await BusinessAccountMember.findById(member._id).lean().exec();
    assert.equal(stored?.status, "removed");

    const restore = createResponseRecorder();
    await updateBusinessAccountMemberStatus(
      controllerRequest({ userId: adminId, params: { accountId: account.accountId, memberId: String(member._id) }, body: { status: "restore" } }),
      restore.response
    );
    assert.equal(restore.statusCode(), 200);
    assert.equal((await BusinessAccountMember.findById(member._id).lean().exec())?.status, "active");
    assert.equal(await User.countDocuments({ email: client.email }).exec(), 1);
  });
});
