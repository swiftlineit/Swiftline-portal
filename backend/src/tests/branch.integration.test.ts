import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { createBranch, updateBranch, updateBranchStatus } from "../controllers/branch.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { User } from "../models/user.model.js";

// Kept short: Atlas caps database names at 38 bytes.
const databaseName = `swiftline_br_test_${Date.now()}`;

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
    query: {}
  } as unknown as Request;
}

// A payload that satisfies every active-branch requirement.
function branchPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Delhi Hub",
    code: "DEL-HUB",
    labelCode: "DEL",
    status: "ACTIVE",
    address: {
      countryCode: "IN",
      countryName: "India",
      city: "New Delhi",
      stateOrProvince: "Delhi",
      postalCode: "110001",
      address: "1 Trade Street"
    },
    contact: { email: "delhi@swiftline.test", phone: "+919876543210" },
    operations: {
      supportedServices: ["AIR_FREIGHT"],
      shipmentCoverage: ["DOMESTIC"],
      operatingCountries: [],
      workingDays: ["MONDAY", "TUESDAY"]
    },
    baseCurrency: "INR",
    gstin: "06ABCDE1234F1Z5",
    invoiceSacCode: "996812",
    ...overrides
  };
}

async function createBusinessAccountForBranch(adminId: mongoose.Types.ObjectId, branchId: mongoose.Types.ObjectId, suffix: string) {
  return BusinessAccount.create({
    accountId: `BA-2026-${suffix}`,
    status: "draft",
    contact: {
      title: "mr.",
      firstName: "John",
      lastName: "Doe",
      email: `branch-dep-${suffix}@acme.com`,
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: `98765${suffix}`,
      jobTitle: "Director",
      department: "Management",
      shipmentTypes: ["international_cargo"]
    },
    company: {
      registrationCountry: "India",
      registrationId: `ABCDE${suffix}F`,
      companyType: "pvt_ltd",
      companyName: "Acme Exports",
      registeredAddress: "1 Trade Street",
      city: "New Delhi",
      stateOrProvince: "Delhi",
      postalCode: "110001",
      operatingCountries: ["India"],
      industry: "Retail",
      monthlyShipmentVolume: "1-50 shipments",
      requestedCreditLimit: { currency: "INR", amount: null }
    },
    assignedBranch: branchId,
    createdBy: adminId,
    updatedBy: adminId
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Integration tests must use the isolated branch test database.");
  await Promise.all([
    Branch.init(),
    BusinessAccount.init(),
    BusinessAccountMember.init(),
    OperationsManifest.init(),
    AuditLog.init(),
    User.init()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("swiftline_br_test_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("branch lifecycle", () => {
  test("rejects duplicate branch and station codes", async () => {
    const adminId = new mongoose.Types.ObjectId();

    const first = createResponseRecorder();
    await createBranch(controllerRequest({ userId: adminId, body: branchPayload() }), first.response);
    assert.equal(first.statusCode(), 201);

    const duplicateCode = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ labelCode: "BOM" }) }),
      duplicateCode.response
    );
    assert.equal(duplicateCode.statusCode(), 409);

    // A different branch code but the same station code must also be refused,
    // because station codes prefix customer-facing tracking numbers.
    const duplicateLabel = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "DEL-ALT" }) }),
      duplicateLabel.response
    );
    assert.equal(duplicateLabel.statusCode(), 409);
  });

  test("blocks activation until requirements are met, then freezes identity fields", async () => {
    const adminId = new mongoose.Types.ObjectId();

    // A draft may be incomplete.
    const draft = createResponseRecorder();
    await createBranch(
      controllerRequest({
        userId: adminId,
        body: branchPayload({ code: "BOM-HUB", labelCode: "BOM", status: "DRAFT", gstin: "" })
      }),
      draft.response
    );
    assert.equal(draft.statusCode(), 201);
    const branchId = String(draft.body<{ branch: { _id: string } }>().branch._id);

    // Activating it fails while the Indian GSTIN is missing.
    const blocked = createResponseRecorder();
    await updateBranchStatus(
      controllerRequest({ userId: adminId, params: { branchId }, body: { status: "ACTIVE" } }),
      blocked.response
    );
    assert.equal(blocked.statusCode(), 400);
    assert.match(blocked.body<{ message: string }>().message, /GSTIN/);

    // Supply the GSTIN, then activation succeeds and stamps activatedAt.
    const fixed = createResponseRecorder();
    await updateBranch(
      controllerRequest({ userId: adminId, params: { branchId }, body: { gstin: "06ABCDE1234F1Z5" } }),
      fixed.response
    );
    assert.equal(fixed.statusCode(), 200);

    const activated = createResponseRecorder();
    await updateBranchStatus(
      controllerRequest({ userId: adminId, params: { branchId }, body: { status: "ACTIVE" } }),
      activated.response
    );
    assert.equal(activated.statusCode(), 200);
    assert.ok((await Branch.findById(branchId).lean().exec())?.activatedAt);

    // Identity fields are frozen once the branch has been activated.
    const renameCode = createResponseRecorder();
    await updateBranch(
      controllerRequest({ userId: adminId, params: { branchId }, body: { code: "BOM-NEW" } }),
      renameCode.response
    );
    assert.equal(renameCode.statusCode(), 409);

    const renameLabel = createResponseRecorder();
    await updateBranch(
      controllerRequest({ userId: adminId, params: { branchId }, body: { labelCode: "BMX" } }),
      renameLabel.response
    );
    assert.equal(renameLabel.statusCode(), 409);
  });

  test("a partial update leaves untouched fields intact", async () => {
    const adminId = new mongoose.Types.ObjectId();

    const created = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "MAA-HUB", labelCode: "MAA" }) }),
      created.response
    );
    assert.equal(created.statusCode(), 201);
    const branchId = String(created.body<{ branch: { _id: string } }>().branch._id);

    // Sending only a name must not wipe the operations arrays.
    const updated = createResponseRecorder();
    await updateBranch(
      controllerRequest({ userId: adminId, params: { branchId }, body: { name: "Chennai Hub" } }),
      updated.response
    );
    assert.equal(updated.statusCode(), 200);

    const stored = await Branch.findById(branchId).lean().exec();
    assert.equal(stored?.name, "Chennai Hub");
    assert.deepEqual(stored?.operations.supportedServices, ["AIR_FREIGHT"]);
    assert.deepEqual(stored?.operations.workingDays, ["MONDAY", "TUESDAY"]);
    assert.equal(stored?.baseCurrency, "INR");
  });

  test("blocks leaving ACTIVE while dependents are still assigned", async () => {
    const adminId = new mongoose.Types.ObjectId();

    const created = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "CCU-HUB", labelCode: "CCU" }) }),
      created.response
    );
    assert.equal(created.statusCode(), 201);
    const branchId = String(created.body<{ branch: { _id: string } }>().branch._id);

    const account = await createBusinessAccountForBranch(adminId, new mongoose.Types.ObjectId(branchId), "31001");

    const blocked = createResponseRecorder();
    await updateBranchStatus(
      controllerRequest({ userId: adminId, params: { branchId }, body: { status: "INACTIVE" } }),
      blocked.response
    );
    assert.equal(blocked.statusCode(), 409);
    assert.match(blocked.body<{ message: string }>().message, /business account/);

    // Once the dependent is reassigned, the branch can leave service.
    await BusinessAccount.updateOne({ _id: account._id }, { $set: { assignedBranch: null } }).exec();

    const allowed = createResponseRecorder();
    await updateBranchStatus(
      controllerRequest({ userId: adminId, params: { branchId }, body: { status: "INACTIVE" } }),
      allowed.response
    );
    assert.equal(allowed.statusCode(), 200);
    assert.equal((await Branch.findById(branchId).lean().exec())?.status, "INACTIVE");
  });

  test("rejects transitions that are not in the state machine", async () => {
    const adminId = new mongoose.Types.ObjectId();

    const created = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "HYD-HUB", labelCode: "HYD", status: "DRAFT" }) }),
      created.response
    );
    const branchId = String(created.body<{ branch: { _id: string } }>().branch._id);

    // DRAFT may only go to ACTIVE.
    const invalid = createResponseRecorder();
    await updateBranchStatus(
      controllerRequest({ userId: adminId, params: { branchId }, body: { status: "CLOSED" } }),
      invalid.response
    );
    assert.equal(invalid.statusCode(), 409);
  });

  test("records a field-level diff on update", async () => {    const adminId = new mongoose.Types.ObjectId();

    const created = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "PNQ-HUB", labelCode: "PNQ", status: "DRAFT" }) }),
      created.response
    );
    const branchId = String(created.body<{ branch: { _id: string } }>().branch._id);

    await updateBranch(
      controllerRequest({ userId: adminId, params: { branchId }, body: { name: "Pune Hub" } }),
      createResponseRecorder().response
    );

    const auditEntry = await AuditLog.findOne({ entityId: branchId, action: "BRANCH_UPDATED" }).lean().exec();
    const changes = (auditEntry?.metadata as { changes?: Record<string, { from: unknown; to: unknown }> })?.changes;
    assert.ok(changes?.name, "the audit entry should record the changed name");
    assert.equal(changes?.name.to, "Pune Hub");
  });

  test("unrelated edits succeed when legacy documents lack a storageKey", async () => {
    const adminId = new mongoose.Types.ObjectId();

    const created = createResponseRecorder();
    await createBranch(
      controllerRequest({ userId: adminId, body: branchPayload({ code: "LKO-HUB", labelCode: "LKO", status: "DRAFT" }) }),
      created.response
    );
    assert.equal(created.statusCode(), 201);
    const branchId = String(created.body<{ branch: { _id: string } }>().branch._id);

    // Legacy entries stored before storageKey became required. Written at the
    // collection level to bypass mongoose validation, mirroring production data.
    await Branch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(branchId) },
      {
        $set: {
          documents: [
            { type: "PAN", title: "PAN", fileName: "pan.pdf", mimeType: "application/pdf", uploadedAt: new Date() },
            { type: "GST", title: "GST", fileName: "gst.pdf", mimeType: "application/pdf", uploadedAt: new Date() }
          ]
        }
      }
    );

    // An unrelated edit (e.g. the invoice phone number) must not be blocked by them.
    const updated = createResponseRecorder();
    await updateBranch(
      controllerRequest({
        userId: adminId,
        params: { branchId },
        body: { contact: { email: "lko@swiftline.test", phone: "+919817717689" } }
      }),
      updated.response
    );
    assert.equal(updated.statusCode(), 200);

    const stored = await Branch.findById(branchId).lean().exec();
    assert.equal(stored?.contact.phone, "+919817717689");
    assert.equal(stored?.documents.length, 2);

    // And the legacy entries remain removable one at a time.
    const { deleteBranchDocument } = await import("../controllers/branch.controller.js");
    const removed = createResponseRecorder();
    await deleteBranchDocument(
      controllerRequest({ userId: adminId, params: { branchId, docIndex: "0" } }),
      removed.response
    );
    assert.equal(removed.statusCode(), 200);
    assert.equal((await Branch.findById(branchId).lean().exec())?.documents.length, 1);
  });
});
