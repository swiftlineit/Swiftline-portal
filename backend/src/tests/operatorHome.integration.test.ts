import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getOperatorHome } from "../controllers/operatorHome.controller.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databasePrefix = "sl_operator_home_";
const databaseName = `${databasePrefix}${Date.now()}`;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false, autoIndex: false, autoCreate: false });
  assert.equal(mongoose.connection.name, databaseName);
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
  return { response, status: () => statusCode, body: () => body as Record<string, any> };
}

function requestFor(tenantId: mongoose.Types.ObjectId, role: string, userId: mongoose.Types.ObjectId, assignedBranches: mongoose.Types.ObjectId[] = []) {
  return {
    user: { _id: userId },
    operatorContext: { tenantId, slug: "operator", role, assignedBranches, accessMode: "MEMBER" }
  } as unknown as Request;
}

test("home metrics and charts follow operator, branch, client and credit permissions", async () => {
  const tenant = new mongoose.Types.ObjectId();
  const otherTenant = new mongoose.Types.ObjectId();
  const branchA = new mongoose.Types.ObjectId();
  const branchB = new mongoose.Types.ObjectId();
  const accountA = new mongoose.Types.ObjectId();
  const accountB = new mongoose.Types.ObjectId();
  const otherAccount = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const bookingUser = new mongoose.Types.ObjectId();
  const staff = new mongoose.Types.ObjectId();
  const now = new Date();
  const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];

  await BusinessAccount.collection.insertMany([
    { _id: accountA, tenantId: tenant, accountId: "HOME-A", accountKind: "BUSINESS", status: "pending_review", assignedBranch: branchA, company: { companyName: "Alpha Traders" }, createdAt: now },
    { _id: accountB, tenantId: tenant, accountId: "HOME-B", accountKind: "BUSINESS", status: "active", assignedBranch: branchB, company: { companyName: "Beta Traders" }, createdAt: now },
    { _id: otherAccount, tenantId: otherTenant, accountId: "HOME-OTHER", accountKind: "BUSINESS", status: "pending_review", assignedBranch: branchA, company: { companyName: "Other Company" }, createdAt: now }
  ]);
  await BusinessAccountMember.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(), tenantId: tenant, businessAccount: accountA, user: owner, role: "account_owner", status: "active" },
    { _id: new mongoose.Types.ObjectId(), tenantId: tenant, businessAccount: accountA, user: bookingUser, role: "booking_user", status: "active" }
  ]);
  await ShipmentDraft.collection.insertMany(ids.map((id, index) => ({
    _id: id, tenantId: index === 2 ? otherTenant : tenant,
    businessAccountId: [accountA, accountB, otherAccount][index],
    branchId: index === 1 ? branchB : branchA,
    bookingState: "BOOKED", deletedAt: null, createdAt: now, updatedAt: now,
    allocatedTrackingNumber: `HOM${index + 1}`, parcelCount: 1,
    consigneeEnteredAddress: { contactName: `Recipient ${index + 1}` }
  })));
  await DpdShipment.collection.insertMany(ids.map((id, index) => ({
    _id: new mongoose.Types.ObjectId(), tenantId: index === 2 ? otherTenant : tenant,
    shipmentDraftId: id, swiftlineTrackingNumber: `HOM${index + 1}`, createdAt: now
  })));
  await ShipmentInvoice.collection.insertMany(ids.map((id, index) => ({
    _id: new mongoose.Types.ObjectId(), tenantId: index === 2 ? otherTenant : tenant,
    shipmentDraftId: id, businessAccountId: [accountA, accountB, otherAccount][index],
    branchId: index === 1 ? branchB : branchA, paymentStatus: "UNPAID",
    totalAmountMinor: [10000, 20000, 90000][index], createdAt: now
  })));
  await BusinessCreditAccount.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), tenantId: tenant, businessAccountId: accountA,
    status: "ACTIVE", approvedCreditLimitMinor: 100000, reservedCreditMinor: 0,
    unbilledCreditMinor: 10000, invoicedOutstandingMinor: 0,
    customerAdvanceBalanceMinor: 0, reservedAdvanceMinor: 0
  });
  await CreditBillingStatement.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), tenantId: tenant, businessAccountId: accountA,
    dueAt: new Date(now.getTime() - 86_400_000), outstandingAmountMinor: 3000, status: "OVERDUE"
  });

  async function home(role: string, userId: mongoose.Types.ObjectId, branches: mongoose.Types.ObjectId[] = []) {
    const record = recorder();
    await runWithTenantContext({ tenantId: tenant, kind: "OPERATOR" }, () => getOperatorHome(requestFor(tenant, role, userId, branches), record.response));
    assert.equal(record.status(), 200);
    return record.body();
  }

  const admin = await home("OPERATOR_ADMIN", staff);
  assert.equal(admin.shipmentCount, 2);
  assert.equal(admin.operations.pendingAccountReviews, 1);
  assert.equal(admin.trend.reduce((sum: number, row: { amountMinor: number }) => sum + row.amountMinor, 0), 30000);
  assert.equal(admin.recentShipments.length, 2);

  const operations = await home("OPERATIONS", staff, [branchA]);
  assert.equal(operations.shipmentCount, 1);
  assert.equal(operations.operations.pendingAccountReviews, 1);
  assert.equal(operations.trend.reduce((sum: number, row: { amountMinor: number }) => sum + row.amountMinor, 0), 10000);

  const finance = await home("FINANCE", staff, [branchA]);
  assert.equal(finance.shipmentCount, 1);
  assert.equal(finance.finance.activeCreditAccounts, 1);
  assert.equal(finance.finance.overdueMinor, 3000);
  assert.equal(finance.finance.outstandingMinor, 10000);

  const client = await home("CLIENT", owner);
  assert.equal(client.shipmentCount, 1);
  assert.equal(client.recentShipments[0].awb, "HOM1");
  assert.equal(client.trend.reduce((sum: number, row: { count: number }) => sum + row.count, 0), 1);
  assert.equal(client.trend.some((row: { amountMinor?: number }) => row.amountMinor !== undefined), false);
  assert.equal(client.credit.availableCapacityMinor, 90000);

  const restrictedClient = await home("CLIENT", bookingUser);
  assert.equal(restrictedClient.shipmentCount, 1);
  assert.equal(restrictedClient.credit, null);
});
