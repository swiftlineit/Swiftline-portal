import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import type { Request, Response as ExpressResponse } from "express";
import { PDFDocument } from "pdf-lib";
import { env } from "../config/env.js";
import { Tenant } from "../models/tenant.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { updateBusinessAccountVolumetricDiscount } from "../controllers/businessAccount.controller.js";
import { requireRole } from "../middleware/auth.middleware.js";
import { requireAssignedBusinessAccountBranch } from "../middleware/businessAccountBranchAccess.middleware.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import { PrepaidTransaction } from "../models/prepaidTransaction.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { PaymentTopUp } from "../models/paymentTopUp.model.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { User } from "../models/user.model.js";
import { Branch } from "../models/branch.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";
import { ensurePrepaidAccount, createPaymentTopUp, creditCapturedTopUp } from "../services/prepaid/topups.service.js";
import { getClientPrepaidAccount } from "../controllers/prepaid.controller.js";
import { handleRazorpayWebhook } from "../controllers/razorpayWebhook.controller.js";
import { secureWalletShipmentFunding, securePaidShipmentFunding, markShipmentFundingConsuming, completeShipmentFunding, releaseShipmentFunding, assertShipmentFundingCompleted, notifyLowWalletIfNeeded } from "../services/prepaid/shipmentFunding.service.js";
import { createShipmentDirectPayment, recordCapturedShipmentDirectPayment, reconcileShipmentDirectPayment } from "../services/prepaid/shipmentDirectPayments.service.js";
import { secureAmendmentWalletPayment, secureAmendmentDirectPayment, applyPrepaidAmendmentMovement } from "../services/prepaid/amendmentFunding.service.js";
import { applyApprovedAmendmentBilling, calculateAmendmentBillingAdjustment } from "../services/amendmentBilling.service.js";
import { ensureCancellationGatewayRefund } from "../services/prepaid/cancellationRefunds.service.js";
import { renderCashReceiptPdf } from "../services/cashReceiptPdf.service.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import type { ShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import { buildPricingInputFromDraft, calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import { createLabelForShipmentDraft } from "../services/dpdShipment.service.js";
import { saveCashReceiptDraft, finalizeCashReceiptForBooking } from "../services/prepaid/cashReceipts.service.js";
import { createStandaloneCashReceipt } from "../services/prepaid/standaloneCashReceipts.service.js";
import { downloadClientCashReceiptPdf, getClientCashReceiptUnreadCount, getStaffCashReceipt } from "../controllers/cashReceipt.controller.js";
import { listClientDocumentCentre } from "../services/clientDocumentCentre.service.js";
import { rejectShipmentCancellation } from "../services/shipmentCancellation.service.js";
import { rejectShipmentAmendment, createShipmentAmendment, approveShipmentAmendment } from "../controllers/shipmentAmendment.controller.js";
import { listAccountLedger } from "../services/prepaid/accountLedger.service.js";
import { deleteObject } from "../services/storage/storage.service.js";

const databaseName = `sl_prepaid_offline_${Date.now()}`;
let rootId = new mongoose.Types.ObjectId();
const connected = process.env.PREPAID_CONNECTED_TEST === "1";
const operatorId = new mongoose.Types.ObjectId();
const staffId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const root = <T>(work: () => T) => runWithTenantContext({ tenantId: rootId, kind: "SWIFTLINE" }, work);
const operator = <T>(work: () => T) => runWithTenantContext({ tenantId: operatorId, kind: "OPERATOR" }, work);
const fetchBefore = globalThis.fetch;
const providerPayments = new Map<string, Record<string, unknown>>();
const refundRequests: Array<{ paymentId: string; amount: number; key: string }> = [];
const providerRefunds = new Map<string, Record<string, unknown>>();
let nextRefundPending = false;

function responseRecorder() {
  let status = 200;
  let body: any;
  const response = {
    status(value: number) { status = value; return response; },
    json(value: unknown) { body = value; return response; },
    setHeader() { return response; },
    send(value: unknown) { body = value; return response; }
  } as unknown as ExpressResponse;
  return { response, status: () => status, body: () => body };
}

before(async () => {
  assert.equal(env.NODE_ENV, "test");
  if (!connected) assert.equal(new URL(env.MONGODB_URI).hostname, "127.0.0.1", "Use the offline environment preload.");
  assert.equal(env.RAZORPAY_KEY_ID, "rzp_test_offline");
  await mongoose.connect(env.MONGODB_URI, { ...(!connected ? { dbName: databaseName } : {}), serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false });
  if (connected) {
    const existing = await Tenant.collection.findOne({ kind: "SWIFTLINE" });
    assert.ok(existing, "Connected database must already contain the Swiftline tenant.");
    rootId = existing._id;
    console.log("Connected prepaid verification database: " + mongoose.connection.name);
  }
  if (!connected) assert.equal(mongoose.connection.name, databaseName);
  if (!connected) {
  // Models used inside transactions must exist before the first transaction.
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
  }
  for (const model of [Tenant, PrepaidAccount, PrepaidTransaction, ShipmentFunding, ShipmentDirectPayment, ShipmentCharge, PaymentTopUp, CashReceipt]) {
    await model.createIndexes();
  }
  await Tenant.create({ _id: rootId, kind: "SWIFTLINE", status: "ACTIVE", companyName: "Offline Swiftline", slug: "swiftline" });
  }
  await Tenant.create({ _id: operatorId, kind: "OPERATOR", status: "ACTIVE", companyName: "Prepaid QA Operator", slug: `prepaid-qa-${String(operatorId)}` });
  globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    assert.ok(url.startsWith("https://api.razorpay.com/v1/"), `Forbidden provider request: ${url}`);
    const json = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/orders")) return new Response(JSON.stringify({ id: `order_offline_${crypto.randomUUID()}`, amount: json.amount, currency: json.currency, status: "created" }));
    const refundLookup = url.match(/\/refunds\/([^/]+)$/);
    if (refundLookup && providerRefunds.has(refundLookup[1]!)) return new Response(JSON.stringify(providerRefunds.get(refundLookup[1]!)!));
    const refund = url.match(/\/payments\/([^/]+)\/refund$/);
    if (refund) {
      const key = new Headers(init?.headers).get("X-Refund-Idempotency") ?? "";
      refundRequests.push({ paymentId: refund[1]!, amount: json.amount, key });
      const entity = { id: `rfnd_${key}`, payment_id: refund[1], amount: json.amount, currency: "INR", status: nextRefundPending ? "pending" : "processed" };
      nextRefundPending = false;
      providerRefunds.set(entity.id, entity);
      return new Response(JSON.stringify(entity));
    }
    const payment = url.match(/\/payments\/([^/]+)$/);
    if (payment && providerPayments.has(payment[1]!)) return new Response(JSON.stringify(providerPayments.get(payment[1]!)!));
    throw new Error(`Unexpected offline Razorpay request: ${url}`);
  };
});

after(async () => {
  globalThis.fetch = fetchBefore;
  if (mongoose.connection.readyState) {
    if (connected) {
      const { inserted }: { inserted: Map<string, Map<string, mongoose.Types.ObjectId>> } = await import(new URL("./helpers/prepaidConnectedEnvironment.mjs", import.meta.url).href);
      const labelIds = [...(inserted.get(LabelDocument.collection.name)?.values() ?? [])];
      const labels = await LabelDocument.collection.find({ _id: { $in: labelIds } }).toArray();
      for (const label of labels) if (label.storageKey) await deleteObject(label.storageKey);
      for (const [name, ids] of inserted) if (ids.size) await mongoose.connection.db!.collection(name).deleteMany({ _id: { $in: [...ids.values()] } });
      console.log("Connected QA records removed by their exact generated ids; existing records preserved.");
      await mongoose.disconnect();
      return;
    }
    assert.equal(mongoose.connection.host, "127.0.0.1");
    assert.equal(mongoose.connection.name, databaseName);
    const labels = await LabelDocument.collection.find({}).toArray();
    for (const label of labels) if (label.storageKey) await deleteObject(label.storageKey);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function bookingFixture(customerType: "BUSINESS" | "INDIVIDUAL" = "BUSINESS", balance = 100_000) {
  const f = await fixture(balance, customerType);
  await Branch.collection.updateOne({ _id: branchId }, { $setOnInsert: {
    tenantId: rootId, name: "Prepaid QA Delhi", code: connected ? `QA-${String(branchId).slice(-6)}` : "DEL", labelCode: connected ? "QAT" : "DEL", status: "ACTIVE",
    address: { address: "1 Offline Road", city: "Delhi", stateOrProvince: "Delhi", postalCode: "110001", countryName: "India" },
    contact: { email: "offline-branch@example.test", phone: "9876543210", countryCode: "+91" }, gstin: "07AAACS1234A1Z1"
  } }, { upsert: true });
  await BusinessAccount.collection.updateOne({ _id: f.businessAccountId }, { $set: {
    accountKind: customerType === "INDIVIDUAL" ? "INDIVIDUAL_SENTINEL" : "BUSINESS",
    privateRateCardVersion: 1, privateRateCardReady: true,
    contact: { firstName: "Prepaid QA", lastName: "Sender", email: `qa-${f.businessAccountId}@example.test`, countryCode: "+91", mobileNumber: String(BigInt("0x" + String(f.businessAccountId).slice(-10))).slice(-10).padStart(10, "9") },
    "company.stateOrProvince": "Delhi", "company.registeredAddress": "1 Offline Road", "company.city": "Delhi", "company.postalCode": "110001", "company.addressCountry": "India"
  } });
  await CountryRateCard.create({ ...(customerType === "INDIVIDUAL" ? { band: "BAND_D" } : { businessAccountId: f.businessAccountId }), countryCode: "US", countryName: "United States", service: "COURIER", fromKg: 0, toKg: 10, chargesPerKg: 100, maxBoxKg: 30, createdBy: staffId });
  await ShipmentDraft.collection.updateOne({ _id: f.draft._id }, { $set: {
    creationSource: "MANUAL", bookingState: "EDITABLE", status: "READY_FOR_DPD", serviceCode: "EXP", csbType: "CSB_IV", parcelCount: 1,
    shipperDeclarationAcceptedAt: new Date(), shipperDeclarationVersion: "v1", addressValidationStatus: "VALIDATED",
    consignorAddress: { companyName: "Offline Sender", contactName: "Ravi Kumar", email: "offline-sender@example.test", mobileCountryCode: "+91", mobileNumber: "9876543210", countryCode: "IN", countryName: "India", postcode: "110001", addressLine1: "10 Offline Road", townOrCity: "Delhi", county: "Delhi", aadhaarNumber: "234567890124" },
    consigneeEnteredAddress: { companyName: "Offline Receiver", contactName: "Alex Smith", email: "offline-receiver@example.test", mobileCountryCode: "+1", mobileNumber: "2025550123", countryCode: "US", countryName: "United States", postcode: "10001", addressLine1: "1 Offline Street", townOrCity: "New York", county: "New York", stateCode: "NY" },
    parcelList: [{ sequence: 1, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, shipmentContentType: "PARCEL", shipmentReference1: "OFFLINE-TEST", contentsDescription: "Cotton shirts", items: [{ description: "Cotton shirts", hsnCode: "", unitType: "Pcs", quantity: 1, unitRate: 500 }] }]
  } });
  const draft = await ShipmentDraft.findById(f.draft._id).orFail();
  const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(draft));
  return { ...f, draft, pricing, pricingHash: buildPricingHash(pricing) };
}

test("a full business test booking produces only Swiftline labels and a paid invoice", () => root(async () => {
  const f = await bookingFixture();
  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, { actor: "admin", paymentSource: "BUSINESS_WALLET", skipDpdLabel: true, acceptedPricingHash: f.pricingHash });
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);
  assert.equal(booked.dpdShipment.dpdShipmentId, "");
  assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: booked.dpdShipment._id, labelType: "DPD" }), 0);
  assert.ok(await LabelDocument.countDocuments({ dpdShipmentId: booked.dpdShipment._id, labelType: "SWIFTLINE" }));
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000 - booked.shipmentInvoice.totalAmountMinor);
}));

test("the internal test funding source cannot create a production shipment", () => root(async () => {
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    await assert.rejects(createLabelForShipmentDraft(String(new mongoose.Types.ObjectId()), staffId, { actor: "admin", paymentSource: "TEST", skipDpdLabel: true }), /test funding.*production/i);
  } finally { env.NODE_ENV = previous; }
}));

test("business volumetric discounts are permissioned, validated, audited and used by paid booking prices", () => root(async () => {
  const f = await bookingFixture("BUSINESS", 1_000_000);
  const opsRequest = {
    params: { accountId: `OFF-${f.businessAccountId}` },
    body: { volumetricDiscountPercent: 50, expectedVersion: 0 },
    user: { _id: staffId, role: "operations", assignedBranches: [branchId] }
  } as unknown as Request;

  let roleAllowed = false;
  requireRole("admin", "operations")(opsRequest, responseRecorder().response, () => { roleAllowed = true; });
  assert.equal(roleAllowed, true);
  let staffRoleAllowed = false;
  const staffRoleResult = responseRecorder();
  requireRole("admin", "operations")({ ...opsRequest, user: { _id: staffId, role: "staff" } } as unknown as Request, staffRoleResult.response, () => { staffRoleAllowed = true; });
  assert.equal(staffRoleAllowed, false);
  assert.equal(staffRoleResult.status(), 403);

  let branchAllowed = false;
  await requireAssignedBusinessAccountBranch(opsRequest, responseRecorder().response, () => { branchAllowed = true; });
  assert.equal(branchAllowed, true);
  const otherBranchRequest = { ...opsRequest, user: { _id: staffId, role: "operations", assignedBranches: [new mongoose.Types.ObjectId()] } } as unknown as Request;
  let otherBranchAllowed = false;
  const branchDenied = responseRecorder();
  await requireAssignedBusinessAccountBranch(otherBranchRequest, branchDenied.response, () => { otherBranchAllowed = true; });
  assert.equal(otherBranchAllowed, false);
  assert.equal(branchDenied.status(), 404);

  const saved = responseRecorder();
  await updateBusinessAccountVolumetricDiscount(opsRequest, saved.response);
  assert.equal(saved.status(), 200, saved.body()?.message);
  assert.equal(saved.body()?.account.volumetricDiscountPercent, 50);
  assert.equal(saved.body()?.account.volumetricDiscountVersion, 1);

  const stale = responseRecorder();
  await updateBusinessAccountVolumetricDiscount({ ...opsRequest, body: { volumetricDiscountPercent: 25, expectedVersion: 0 } } as unknown as Request, stale.response);
  assert.equal(stale.status(), 409);
  const invalid = responseRecorder();
  await updateBusinessAccountVolumetricDiscount({ ...opsRequest, body: { volumetricDiscountPercent: 101, expectedVersion: 1 } } as unknown as Request, invalid.response);
  assert.equal(invalid.status(), 400);

  const updatedDraft = await ShipmentDraft.findById(f.draft._id).orFail();
  updatedDraft.parcelList = updatedDraft.parcelList.map((parcel) => ({
    ...parcel, weightKg: 20, lengthCm: 50, widthCm: 50, heightCm: 50
  }));
  await updatedDraft.save();
  const pricedDraft = await ShipmentDraft.findById(f.draft._id).orFail();
  const discountedPricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(pricedDraft));
  assert.equal(discountedPricing.parcels[0]?.actualWeightKg, 20);
  assert.equal(discountedPricing.parcels[0]?.volumetricWeightKg, 25);
  assert.equal(discountedPricing.parcels[0]?.volumetricDiscountKg, 2.5);
  assert.equal(discountedPricing.parcels[0]?.chargeableWeightKg, 22.5);
  assert.equal(discountedPricing.volumetricDiscountPercent, 50);
  assert.notEqual(buildPricingHash(discountedPricing), f.pricingHash);

  const booked = await createLabelForShipmentDraft(String(pricedDraft._id), staffId, {
    actor: "admin", paymentSource: "BUSINESS_WALLET", skipDpdLabel: true,
    acceptedPricingHash: buildPricingHash(discountedPricing)
  });
  assert.equal(booked.shipmentInvoice.totalAmountMinor, Math.round(discountedPricing.totalAmount * 100));
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");

  const audit = await AuditLog.findOne({ entityId: f.businessAccountId, action: "BUSINESS_ACCOUNT_VOLUMETRIC_DISCOUNT_UPDATED" }).lean().exec();
  assert.equal(audit?.metadata.changes ? true : false, true);

  const individual = await bookingFixture("INDIVIDUAL", 1_000_000);
  await BusinessAccount.updateOne({ _id: individual.businessAccountId }, { $set: { volumetricDiscountPercent: 50 } });
  const individualDraft = await ShipmentDraft.findById(individual.draft._id).orFail();
  individualDraft.parcelList = individualDraft.parcelList.map((parcel) => ({ ...parcel, weightKg: 20, lengthCm: 50, widthCm: 50, heightCm: 50 }));
  await individualDraft.save();
  const individualPricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(await ShipmentDraft.findById(individual.draft._id).orFail()));
  assert.equal(individualPricing.parcels[0]?.chargeableWeightKg, 25);
  assert.equal(individualPricing.volumetricDiscountPercent, undefined);

  const publicPricing = await calculateShipmentPricingEstimate({
    rateCardBand: "BAND_D", countryCode: "US", serviceType: "COURIER",
    parcels: [{ weightKg: 20, lengthCm: 50, widthCm: 50, heightCm: 50 }]
  });
  assert.equal(publicPricing.parcels[0]?.chargeableWeightKg, 25);
  assert.equal(publicPricing.volumetricDiscountPercent, undefined);
}));

test("staff can approve the saved amendment without treating it as a second pending request", () => root(async () => {
  const f = await bookingFixture();
  await createLabelForShipmentDraft(String(f.draft._id), staffId, { actor: "admin", paymentSource: "BUSINESS_WALLET", skipDpdLabel: true, acceptedPricingHash: f.pricingHash });
  for (const increase of [false, true]) {
    const current = await ShipmentDraft.findById(f.draft._id).orFail();
    const changes = increase
      ? { parcelList: current.parcelList.map((parcel) => ({ sequence: parcel.sequence, weightKg: 2, lengthCm: parcel.lengthCm, widthCm: parcel.widthCm, heightCm: parcel.heightCm, shipmentContentType: parcel.shipmentContentType, contentsDescription: parcel.contentsDescription })) }
      : { consigneeEnteredAddress: { deliveryInstructions: "Call recipient before delivery" } };
    const created = responseRecorder();
    await createShipmentAmendment({ user: { _id: staffId, role: "admin" }, params: { id: String(f.draft._id) }, body: { reason: "Approval regression", changes } } as unknown as Request, created.response);
    assert.equal(created.status(), 200, created.body()?.message);
    const change = await ShipmentAmendment.findOne({ shipmentDraftId: f.draft._id, status: { $in: ["REQUESTED", "AWAITING_PAYMENT"] } }).orFail();
    const duplicate = responseRecorder();
    await createShipmentAmendment({ user: { _id: staffId, role: "admin" }, params: { id: String(f.draft._id) }, body: { changes } } as unknown as Request, duplicate.response);
    assert.equal(duplicate.status(), 409);
    if (increase) await secureAmendmentWalletPayment({ amendmentId: change._id as mongoose.Types.ObjectId, userId: staffId });
    const approved = responseRecorder();
    await approveShipmentAmendment({ user: { _id: staffId, role: "admin" }, params: { id: String(change._id) }, body: { note: "Approved offline test" } } as unknown as Request, approved.response);
    assert.equal(approved.status(), 200, JSON.stringify(approved.body()));
    assert.equal((await ShipmentAmendment.findById(change._id))?.status, "APPROVED");
  }
}));

test("account ledger includes gateway booking payments without changing the wallet or leaking accounts", () => root(async () => {
  const f = await bookingFixture();
  const payment = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, amountMinor: Math.round(f.pricing.totalAmount * 100), pricingHash: f.pricingHash, pricingRevision: 0, idempotencyKey: crypto.randomUUID() });
  await recordCapturedShipmentDirectPayment({ paymentIntentId: payment.payment._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${payment.payment._id}`, expectedOrderId: payment.payment.razorpayOrderId, expectedAmountMinor: payment.payment.amountMinor, expectedCurrency: "INR" });
  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, { actor: "admin", paymentSource: "DIRECT_RAZORPAY", fundingReferenceId: String(payment.payment._id), skipDpdLabel: true, acceptedPricingHash: f.pricingHash });
  const ledger = await listAccountLedger({ tenantId: rootId, businessAccountId: f.businessAccountId });
  const direct = ledger.transactions.filter((row) => row.transactionType === "RAZORPAY_BOOKING_PAYMENT");
  const walletLedger = await listAccountLedger({ tenantId: rootId, businessAccountId: f.businessAccountId, walletOnly: true });
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.amountMinor, booked.shipmentInvoice.totalAmountMinor);
  assert.equal(direct[0]?.shipmentDraftId, String(f.draft._id));
  assert.equal(direct[0]?.cashBalanceAfterMinor, undefined);
  assert.ok(walletLedger.transactions.every((row) => row.paymentSource === "WALLET"));
  assert.equal(walletLedger.transactions.some((row) => row.transactionType === "RAZORPAY_BOOKING_PAYMENT"), false);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000);
  assert.equal((await listAccountLedger({ tenantId: rootId, businessAccountId: new mongoose.Types.ObjectId() })).transactions.length, 0);
  await operator(async () => assert.equal((await listAccountLedger({ tenantId: operatorId, businessAccountId: f.businessAccountId })).transactions.length, 0));
}));

test("direct shipment payment retries reuse the same intent across payment actors and draft-version changes", () => root(async () => {
  const f = await bookingFixture("INDIVIDUAL", 0);
  const idempotencyKey = `retry-${crypto.randomUUID()}`;
  const firstActor = new mongoose.Types.ObjectId();
  const secondActor = new mongoose.Types.ObjectId();
  const paymentInput = {
    businessAccountId: f.businessAccountId,
    branchId,
    shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
    amountMinor: Math.round(f.pricing.totalAmount * 100),
    pricingHash: f.pricingHash,
    idempotencyKey
  };
  const first = await createShipmentDirectPayment({ ...paymentInput, clientUserId: firstActor, pricingRevision: 0 });
  const retry = await createShipmentDirectPayment({ ...paymentInput, clientUserId: secondActor, pricingRevision: 3 });

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(String(retry.payment._id), String(first.payment._id));
  assert.equal(await ShipmentDirectPayment.countDocuments({ idempotencyKey }), 1);
  await assert.rejects(
    createShipmentDirectPayment({ ...paymentInput, amountMinor: paymentInput.amountMinor + 100, clientUserId: secondActor, pricingRevision: 3 }),
    /different shipment payment/i
  );
  await assert.rejects(
    createShipmentDirectPayment({ ...paymentInput, shipmentDraftId: new mongoose.Types.ObjectId(), clientUserId: secondActor, pricingRevision: 3 }),
    /different shipment payment/i
  );
}));

test("a full individual test booking cannot proceed before capture and pays its complete invoice", () => root(async () => {
  const f = await bookingFixture("INDIVIDUAL", 0);
  const result = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, amountMinor: Math.round(f.pricing.totalAmount * 100), pricingHash: f.pricingHash, pricingRevision: 0, idempotencyKey: crypto.randomUUID() });
  const context = { actor: "admin" as const, paymentSource: "DIRECT_RAZORPAY" as const, skipDpdLabel: true, acceptedPricingHash: f.pricingHash, fundingReferenceId: String(result.payment._id) };
  await assert.rejects(createLabelForShipmentDraft(String(f.draft._id), staffId, context), /pending|captured/i);
  assert.equal(await DpdShipment.countDocuments({ shipmentDraftId: f.draft._id }), 0);
  await recordCapturedShipmentDirectPayment({ paymentIntentId: result.payment._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${result.payment._id}`, expectedOrderId: result.payment.razorpayOrderId, expectedAmountMinor: result.payment.amountMinor, expectedCurrency: "INR" });
  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, context);
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);
  assert.equal(booked.dpdShipment.dpdShipmentId, "");
}));

test("business cash receipt finalizes once, queues copies and creates the unread client badge", () => root(async () => {
  const f = await bookingFixture();
  const adminId = new mongoose.Types.ObjectId();
  const operationsId = new mongoose.Types.ObjectId();
  const clientId = new mongoose.Types.ObjectId();
  for (const [id, role, name] of [[adminId, "admin", "Offline Administrator"], [operationsId, "operations", "Offline Operations"], [clientId, "client", "Offline Client"]] as const) {
    await User.collection.insertOne({ _id: id, name, role, userStatus: "active", email: `${id}@example.test` } as never);
  }
  const staffReceiptDefaults = responseRecorder();
  await getStaffCashReceipt({ params: { id: String(f.draft._id) }, user: { _id: operationsId, role: "operations", assignedBranches: [branchId] } } as unknown as Request, staffReceiptDefaults.response);
  assert.equal(staffReceiptDefaults.status(), 200);
  assert.equal(staffReceiptDefaults.body().defaults.recordedByName, "Offline Operations");
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", assignedBranches: [branchId], tenantId: rootId } as never);
  const receipt = await saveCashReceiptDraft({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: operationsId, acceptedPricingHash: f.pricingHash, totalReceivedMinor: Math.round(f.pricing.totalAmount * 100), customerName: "Offline Test Business", receiptDate: new Date(), cashCustodyReference: "OFFLINE-CASH-001" });
  await assert.rejects(securePaidShipmentFunding({ ...f, source: "CASH_RECEIPT", sourceReferenceId: receipt._id as mongoose.Types.ObjectId }), /finalized/i);
  const finalized = await finalizeCashReceiptForBooking({ cashReceiptId: receipt._id as mongoose.Types.ObjectId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: operationsId, acceptedPricingHash: f.pricingHash });
  assert.equal(finalized.status, "FINALIZED");
  assert.equal(finalized.cashRecordedByNameSnapshot, "Offline Operations");
  assert.ok(await EmailOutbox.countDocuments({ recipientUserId: clientId, "attachmentRefs.refId": receipt._id }));
  assert.ok(await EmailOutbox.countDocuments({ recipientUserId: operationsId, "attachmentRefs.refId": receipt._id }));
  assert.ok(await EmailOutbox.countDocuments({ recipientUserId: adminId, "attachmentRefs.refId": receipt._id }));
  const unread = responseRecorder();
  await getClientCashReceiptUnreadCount({ user: { _id: clientId } } as unknown as Request, unread.response);
  assert.equal(unread.body().unreadCount, 1);
  const booked = await createLabelForShipmentDraft(String(f.draft._id), operationsId, { actor: "admin", paymentSource: "CASH_RECEIPT", fundingReferenceId: String(receipt._id), skipDpdLabel: true, acceptedPricingHash: f.pricingHash });
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);
  assert.equal(booked.dpdShipment.dpdShipmentId, "");
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000);
  const clientScope = { ok: true as const, businessAccountId: f.businessAccountId, branchIds: [branchId], canViewFinancials: true };
  const documentsBeforeRead = await listClientDocumentCentre(clientScope, { documentType: "CASH_RECEIPT", page: 1, limit: 20 }, clientId);
  assert.equal(documentsBeforeRead.pagination.total, 1);
  assert.equal(documentsBeforeRead.items[0]?.isNew, true);
  const receiptPdf = responseRecorder();
  await downloadClientCashReceiptPdf({
    user: { _id: clientId },
    query: { businessAccountId: String(f.businessAccountId) },
    params: { receiptId: String(receipt._id) }
  } as unknown as Request, receiptPdf.response);
  assert.equal(receiptPdf.status(), 200);
  const documentsAfterRead = await listClientDocumentCentre(clientScope, { documentType: "CASH_RECEIPT", page: 1, limit: 20 }, clientId);
  assert.equal(documentsAfterRead.items[0]?.isNew, false);
  const unreadAfterRead = responseRecorder();
  await getClientCashReceiptUnreadCount({ user: { _id: clientId } } as unknown as Request, unreadAfterRead.response);
  assert.equal(unreadAfterRead.body().unreadCount, 0);
}));

test("individual offline cash receipt creation is rejected", () => root(async () => {
  const f = await bookingFixture("INDIVIDUAL");
  await assert.rejects(saveCashReceiptDraft({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: staffId, acceptedPricingHash: f.pricingHash, totalReceivedMinor: 100_000, customerName: "Individual Test", receiptDate: new Date(), cashCustodyReference: "FORBIDDEN" }), /only.*business/i);
}));

test("standalone cash receipts are staff-only, idempotent and never change wallet funds", () => root(async () => {
  const f = await fixture();
  const operationsId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const clientId = new mongoose.Types.ObjectId();
  for (const [id, role] of [[operationsId, "operations"], [adminId, "admin"], [clientId, "client"]] as const) {
    const name = id.equals(operationsId) ? "Offline Operations Staff Member with Long Full Name" : `Offline ${role}`;
    await User.collection.insertOne({ _id: id, name, role, userStatus: "active", email: `${id}@example.test` } as never);
  }
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", assignedBranches: [branchId], tenantId: rootId } as never);
  const input = {
    idempotencyKey: crypto.randomUUID(),
    businessAccountId: f.businessAccountId,
    branchId,
    staffUserId: operationsId,
    customerName: "Offline Test Business",
    receiptDate: new Date("2026-11-21T06:30:00.000Z"),
    amountMinor: 42_500,
    paymentReference: "OFFLINE-STANDALONE-001",
    customerReference: "PO-77",
    destination: "1 Test Road, Delhi",
    service: "COURIER" as const,
    pieces: 2,
    weightKg: 4.25
  };
  const first = await createStandaloneCashReceipt(input);
  const repeated = await createStandaloneCashReceipt(input);
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(String(first.receipt._id), String(repeated.receipt._id));
  assert.equal(first.receipt.receiptType, "STANDALONE");
  assert.equal(first.receipt.shipmentDraftId, null);
  assert.equal(first.receipt.createdByNameSnapshot, "Offline Operations Staff Member with Long Full Name");
  assert.equal(await CashReceipt.countDocuments({ standaloneIdempotencyKey: input.idempotencyKey }), 1);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000);
  assert.equal(await DpdShipment.countDocuments({ shipmentDraftId: first.receipt.shipmentDraftId }), 0);
  const amountOnly = await createStandaloneCashReceipt({
    ...input,
    idempotencyKey: crypto.randomUUID(),
    paymentReference: "OFFLINE-AMOUNT-ONLY-001",
    service: undefined,
    pieces: undefined,
    weightKg: undefined
  });
  assert.equal(amountOnly.receipt.serviceSnapshot, "");
  assert.equal(amountOnly.receipt.piecesSnapshot, null);
  assert.equal(amountOnly.receipt.weightKgSnapshot, null);
  const amountOnlyPdf = await PDFDocument.load(await renderCashReceiptPdf(amountOnly.receipt));
  assert.equal(amountOnlyPdf.getPageCount(), 1);
  assert.equal(amountOnlyPdf.getPage(0).getWidth(), 432);
  assert.ok(amountOnlyPdf.getPage(0).getHeight() < 400, "short receipts should use a compact receipt page");
  const longReference = Array.from({ length: 20 }, (_, index) => `REF${index + 1}`).join(" ");
  const longTextReceipt = await createStandaloneCashReceipt({
    ...input,
    idempotencyKey: crypto.randomUUID(),
    paymentReference: longReference,
    service: undefined,
    pieces: undefined,
    weightKg: undefined
  });
  const longTextPdf = await PDFDocument.load(await renderCashReceiptPdf(longTextReceipt.receipt));
  assert.ok(longTextPdf.getPage(0).getHeight() > amountOnlyPdf.getPage(0).getHeight(), "long receipt details should wrap and expand the page instead of being clipped");
  assert.ok(longTextPdf.getPage(0).getHeight() < 500, "wrapped receipt details should remain compact");
  for (const recipientUserId of [operationsId, adminId]) {
    assert.ok(await EmailOutbox.exists({ recipientUserId, notificationType: "CASH_RECEIPT_AVAILABLE", "attachmentRefs.refId": first.receipt._id }));
  }

  const unread = responseRecorder();
  await getClientCashReceiptUnreadCount({ user: { _id: clientId } } as unknown as Request, unread.response);
  assert.equal(unread.body().unreadCount, 0);
  const clientDownload = responseRecorder();
  await downloadClientCashReceiptPdf({
    user: { _id: clientId },
    query: { businessAccountId: String(f.businessAccountId) },
    params: { receiptId: String(first.receipt._id) }
  } as unknown as Request, clientDownload.response);
  assert.equal(clientDownload.status(), 404);
  const documents = await listClientDocumentCentre(
    { ok: true, businessAccountId: f.businessAccountId, branchIds: [branchId], canViewFinancials: true },
    { documentType: "CASH_RECEIPT", page: 1, limit: 20 },
    clientId
  );
  assert.equal(documents.pagination.total, 0);
  await assert.rejects(createStandaloneCashReceipt({ ...input, amountMinor: input.amountMinor + 1 }), /already used for different details/i);
}));

test("shipment cash receipts cannot be allocated to historical credit dues", () => root(async () => {
  const f = await bookingFixture();
  const recorderId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: recorderId, name: "Offline Cash Recorder", role: "operations", userStatus: "active", email: "cash-recorder@example.test" } as never);
  const account = await BusinessCreditAccount.create({ businessAccountId: f.businessAccountId, status: "CLOSED", invoicedOutstandingMinor: 5000 });
  const invoice = await ShipmentInvoice.create({ invoiceNumber: `OFF${String(new mongoose.Types.ObjectId()).slice(-10)}`, financialYear: "26-27", shipmentDraftId: new mongoose.Types.ObjectId(), dpdShipmentId: new mongoose.Types.ObjectId(), businessAccountId: f.businessAccountId, branchId, currency: "INR", supplier: { legalName: "Offline Swiftline" }, customer: { legalName: "Offline Customer" }, shipment: { description: "Offline previous shipment" }, description: "Historical test invoice", taxableValueMinor: 5000, gstRatePercent: 0, taxType: "IGST", totalTaxAmountMinor: 0, totalAmountMinor: 5000, advanceAppliedMinor: 0, creditOutstandingMinor: 5000, paymentStatus: "UNPAID", pricingSnapshot: { totalAmount: 50 }, status: "ISSUED", createdBy: staffId });
  const statementId = new mongoose.Types.ObjectId();
  await CreditBillingStatement.collection.insertOne({ _id: statementId, tenantId: rootId, businessAccountId: f.businessAccountId, creditAccountId: account._id, statementNumber: "OFF-STMT-001", outstandingAmountMinor: 5000, paidAmountMinor: 0, dueAt: new Date(Date.now() - 1000), status: "OVERDUE", lines: [{ shipmentInvoiceId: invoice._id }], adjustments: [] } as never);
  const receipt = await saveCashReceiptDraft({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: recorderId, acceptedPricingHash: f.pricingHash, totalReceivedMinor: Math.round(f.pricing.totalAmount * 100), customerName: "Offline Test Business", receiptDate: new Date(), cashCustodyReference: "OFFLINE-HISTORICAL-001" });
  await CashReceipt.updateOne({ _id: receipt._id }, { $push: { allocations: { allocationType: "CREDIT_STATEMENT", targetId: statementId, amountMinor: 5000, reference: "Legacy statement" } } });
  await assert.rejects(finalizeCashReceiptForBooking({ cashReceiptId: receipt._id as mongoose.Types.ObjectId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: recorderId, acceptedPricingHash: f.pricingHash }), /only pay for this shipment/i);
  await assert.rejects(saveCashReceiptDraft({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, staffUserId: recorderId, acceptedPricingHash: f.pricingHash, totalReceivedMinor: Math.round(f.pricing.totalAmount * 100), customerName: "Offline Test Business", receiptDate: new Date(), cashCustodyReference: "OFFLINE-HISTORICAL-002", historicalAllocations: [{ statementId, amountMinor: 5000 }] }), /only pay for this shipment/i);
  assert.equal((await CashReceipt.findById(receipt._id))?.status, "DRAFT");
  assert.equal((await ShipmentInvoice.findById(invoice._id))?.creditOutstandingMinor, 5000);
  assert.equal((await CreditBillingStatement.findById(statementId))?.outstandingAmountMinor, 5000);
  assert.equal((await BusinessCreditAccount.findById(account._id))?.invoicedOutstandingMinor, 5000);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000);
}));

async function fixture(balance = 100_000, customerType: "BUSINESS" | "INDIVIDUAL" = "BUSINESS") {
  const businessAccountId = new mongoose.Types.ObjectId();
  await BusinessAccount.collection.insertOne({ _id: businessAccountId, tenantId: rootId, accountId: `OFF-${businessAccountId}`, status: "active", company: { companyName: "Prepaid QA Business", registrationIdKey: String(businessAccountId) }, contact: { email: `qa-${businessAccountId}@example.test`, countryCode: "+91", mobileNumber: String(BigInt("0x" + String(businessAccountId).slice(-10))).slice(-10).padStart(10, "9") }, assignedBranch: branchId } as never);
  const draft = new ShipmentDraft({ businessAccountId, branchId, customerType, createdBy: staffId, consigneeEnteredAddress: { countryCode: "US", countryName: "United States" }, parcelList: [{ sequence: 1, weightKg: 1, shipmentContentType: "PARCEL" }], serviceType: "COURIER" });
  await ShipmentDraft.collection.insertOne({ ...draft.toObject(), tenantId: rootId } as never);
  const wallet = await ensurePrepaidAccount({ businessAccountId });
  await PrepaidAccount.updateOne({ _id: wallet._id }, { $set: { cashBalanceMinor: balance, fundingCycleBaselineMinor: balance, fundingCycleSequence: 1 } });
  const pricing = { totalAmount: 100, gstRate: 0, missingRate: false, exceedsMaxBoxKg: false, parcels: [], lines: [], pricingBasis: { rateCardIds: [], routeChargesUpdatedAt: null } } as unknown as ShipmentPricingEstimate;
  return { draft, wallet, pricing, businessAccountId, createdBy: staffId, bookingAttemptId: crypto.randomUUID() };
}

test("legacy wallet ownership is adopted without resetting funds under the old unique index", { skip: connected }, () => root(async () => {
  const businessAccountId = new mongoose.Types.ObjectId();
  await BusinessAccount.collection.insertOne({ _id: businessAccountId, tenantId: rootId } as never);
  await PrepaidAccount.collection.dropIndex("businessAccountId_1");
  await PrepaidAccount.collection.createIndex({ businessAccountId: 1 }, { unique: true, name: "businessAccountId_1" });
  const legacyId = new mongoose.Types.ObjectId();
  await PrepaidAccount.collection.insertOne({ _id: legacyId, businessAccountId, currency: "INR", cashBalanceMinor: 500_000, reservedBalanceMinor: 10_000, status: "ACTIVE", version: 7 } as never);
  const wallet = await ensurePrepaidAccount({ businessAccountId });
  assert.equal(String(wallet._id), String(legacyId));
  assert.equal(String(wallet.tenantId), String(rootId));
  assert.equal(wallet.cashBalanceMinor, 500_000);
  assert.equal(wallet.reservedBalanceMinor, 10_000);
  assert.equal(wallet.version, 7);
  assert.equal(await PrepaidAccount.countDocuments({ businessAccountId }), 1);
}));

test("concurrent first visits return one wallet", () => root(async () => {
  const businessAccountId = new mongoose.Types.ObjectId();
  const wallets = await Promise.all(Array.from({ length: 8 }, () => ensurePrepaidAccount({ businessAccountId })));
  assert.equal(new Set(wallets.map((wallet) => String(wallet._id))).size, 1);
}));

test("operator context cannot adopt a legacy Swiftline wallet", () => root(async () => {
  const businessAccountId = new mongoose.Types.ObjectId();
  await BusinessAccount.collection.insertOne({ _id: businessAccountId, tenantId: rootId } as never);
  await PrepaidAccount.collection.insertOne({ businessAccountId, cashBalanceMinor: 99_999 } as never);
  await assert.rejects(operator(() => ensurePrepaidAccount({ businessAccountId })));
  const wallet = await PrepaidAccount.collection.findOne({ businessAccountId });
  assert.equal(wallet?.cashBalanceMinor, 99_999);
  assert.equal(wallet?.tenantId, undefined);
}));

test("the client prepaid endpoint returns existing legacy funds to an authorized owner", () => root(async () => {
  const f = await fixture();
  const clientId = new mongoose.Types.ObjectId();
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", tenantId: rootId } as never);
  const result = responseRecorder();
  await getClientPrepaidAccount({ user: { _id: clientId }, query: { businessAccountId: String(f.businessAccountId) } } as unknown as Request, result.response);
  assert.equal(result.status(), 200);
  assert.equal(result.body().prepaidAccount.availableBalanceMinor, 100_000);
  const denied = responseRecorder();
  await getClientPrepaidAccount({ user: { _id: new mongoose.Types.ObjectId() }, query: { businessAccountId: String(f.businessAccountId) } } as unknown as Request, denied.response);
  assert.equal(denied.status(), 404);
}));

test("wallet booking reserves, completes exactly once and records a balanced ledger", () => root(async () => {
  const f = await fixture(50_000);
  await secureWalletShipmentFunding(f);
  await secureWalletShipmentFunding(f);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.reservedBalanceMinor, 10_000);
  await markShipmentFundingConsuming({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, bookingAttemptId: f.bookingAttemptId });
  const completion = { shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, dpdShipmentId: new mongoose.Types.ObjectId(), createdBy: staffId };
  await completeShipmentFunding(completion);
  await completeShipmentFunding(completion);
  const wallet = await PrepaidAccount.findById(f.wallet._id);
  assert.equal(wallet?.cashBalanceMinor, 40_000);
  assert.equal(wallet?.reservedBalanceMinor, 0);
  assert.equal(await PrepaidTransaction.countDocuments({ businessAccountId: f.businessAccountId, direction: "DEBIT" }), 1);
  await assertShipmentFundingCompleted(f.draft._id as mongoose.Types.ObjectId);
}));

test("two concurrent shipments cannot overspend the same wallet", () => root(async () => {
  const f = await fixture(10_000);
  const second = new ShipmentDraft({ ...f.draft.toObject(), _id: new mongoose.Types.ObjectId() });
  await ShipmentDraft.collection.insertOne({ ...second.toObject(), tenantId: rootId } as never);
  const results = await Promise.allSettled([secureWalletShipmentFunding(f), secureWalletShipmentFunding({ ...f, draft: second, bookingAttemptId: crypto.randomUUID() })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.reservedBalanceMinor, 10_000);
  assert.equal(await ShipmentFunding.countDocuments({ businessAccountId: f.businessAccountId }), 1);
}));

test("insufficient wallet balance creates no charge and no funding", () => root(async () => {
  const f = await fixture(9_999);
  await assert.rejects(secureWalletShipmentFunding(f), /insufficient/i);
  assert.equal(await ShipmentFunding.countDocuments({ shipmentDraftId: f.draft._id }), 0);
  assert.equal(await ShipmentCharge.countDocuments({ shipmentDraftId: f.draft._id }), 0);
}));

test("individuals cannot fund a booking from a business wallet", () => root(async () => {
  const f = await fixture(100_000, "INDIVIDUAL");
  await assert.rejects(secureWalletShipmentFunding(f), /individual|Razorpay/i);
}));

test("released wallet funding can be reserved again without spending released funds", () => root(async () => {
  const f = await fixture();
  await secureWalletShipmentFunding(f);
  await releaseShipmentFunding({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, createdBy: staffId, reason: "Offline simulated failure before booking" });
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.reservedBalanceMinor, 0);
  const retried = await secureWalletShipmentFunding({ ...f, bookingAttemptId: crypto.randomUUID() });
  assert.equal(retried.funding.status, "SECURED");
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.reservedBalanceMinor, 10_000);
}));

async function directPayment(f: Awaited<ReturnType<typeof fixture>>, captured = true) {
  const result = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, amountMinor: 10_000, pricingHash: buildPricingHash(f.pricing), pricingRevision: 0, idempotencyKey: `offline-${crypto.randomUUID()}` });
  if (!captured) return result.payment;
  return recordCapturedShipmentDirectPayment({ paymentIntentId: result.payment._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${result.payment._id}`, expectedOrderId: result.payment.razorpayOrderId, expectedAmountMinor: 10_000, expectedCurrency: "INR" });
}

test("an unpaid Razorpay order cannot authorize a booking", () => root(async () => {
  const f = await fixture();
  const payment = await directPayment(f, false);
  await assert.rejects(securePaidShipmentFunding({ ...f, source: "DIRECT_RAZORPAY", sourceReferenceId: payment._id as mongoose.Types.ObjectId, pricingHash: buildPricingHash(f.pricing) }), /pending|captured/i);
  assert.equal(await ShipmentFunding.countDocuments({ shipmentDraftId: f.draft._id }), 0);
}));

test("wrong amount, currency, order or price cannot secure a direct payment", () => root(async () => {
  const f = await fixture();
  const payment = await directPayment(f, false);
  const valid = { paymentIntentId: payment._id as mongoose.Types.ObjectId, razorpayPaymentId: "pay_wrong", expectedOrderId: payment.razorpayOrderId, expectedAmountMinor: 10_000, expectedCurrency: "INR" };
  for (const changed of [{ expectedAmountMinor: 1 }, { expectedCurrency: "USD" }, { expectedOrderId: "order_wrong" }]) await assert.rejects(recordCapturedShipmentDirectPayment({ ...valid, ...changed }), /match/i);
  assert.equal((await ShipmentDirectPayment.findById(payment._id))?.status, "ORDER_CREATED");
}));

test("direct payment is allocated only once and cannot be used for another draft", () => root(async () => {
  const f = await fixture(0, "INDIVIDUAL");
  const payment = await directPayment(f);
  const paid = { ...f, source: "DIRECT_RAZORPAY" as const, sourceReferenceId: payment._id as mongoose.Types.ObjectId, pricingHash: buildPricingHash(f.pricing) };
  await securePaidShipmentFunding(paid);
  await securePaidShipmentFunding(paid);
  assert.equal((await ShipmentDirectPayment.findById(payment._id))?.status, "ALLOCATED");
  const second = await fixture(0);
  await assert.rejects(securePaidShipmentFunding({ ...paid, draft: second.draft }), /pending|captured|different/i);
}));

test("server reconciliation does not accept a provider payment with different details", () => root(async () => {
  const f = await fixture();
  const payment = await directPayment(f, false);
  providerPayments.set("pay_mismatch", { id: "pay_mismatch", order_id: payment.razorpayOrderId, amount: 1, currency: "INR", status: "captured" });
  await assert.rejects(reconcileShipmentDirectPayment({ paymentIntentId: payment._id as mongoose.Types.ObjectId, razorpayPaymentId: "pay_mismatch" }), /match/i);
}));

test("historical credit statements do not block fully prepaid bookings", () => root(async () => {
  const f = await fixture();
  await CreditBillingStatement.collection.insertOne({ businessAccountId: f.businessAccountId, tenantId: rootId, outstandingAmountMinor: 100, dueAt: new Date(Date.now() - 1000), status: "OVERDUE" } as never);
  await secureWalletShipmentFunding(f);
  assert.equal((await PrepaidAccount.findOne({ businessAccountId: f.businessAccountId }))?.reservedBalanceMinor, 10_000);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 100_000);
}));

test("wallet low balance alerts fire once at 20 percent", () => root(async () => {
  const f = await fixture(50_000);
  await User.collection.insertOne({ _id: staffId, role: "admin", userStatus: "active", email: "offline-admin@example.test" } as never).catch(() => undefined);
  const clientId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: clientId, role: "client", userStatus: "active", email: `${clientId}@example.test` } as never);
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", tenantId: rootId } as never);
  await PrepaidAccount.updateOne({ _id: f.wallet._id }, { $set: { cashBalanceMinor: 20_000, fundingCycleBaselineMinor: 50_000 } });
  await secureWalletShipmentFunding(f);
  const completion = { shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, dpdShipmentId: new mongoose.Types.ObjectId(), createdBy: staffId };
  await completeShipmentFunding(completion);
  await completeShipmentFunding(completion);
  assert.equal(await PortalNotification.countDocuments({ businessAccountId: f.businessAccountId, recipientUserId: staffId, type: "WALLET_LOW_BALANCE" }), 1);
  assert.equal(await PortalNotification.countDocuments({ businessAccountId: f.businessAccountId, recipientUserId: clientId, type: "WALLET_LOW_BALANCE" }), 1);
  for (const recipientUserId of [staffId, clientId]) {
    assert.equal(await EmailOutbox.countDocuments({ businessAccountId: f.businessAccountId, recipientUserId, notificationType: "WALLET_LOW_BALANCE" }), 1);
  }
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.lowBalanceAlertedCycle, 1);
}));

test("wallet low balance alert recovers an old funding baseline from the prepaid ledger", () => root(async () => {
  const f = await fixture(0);
  const clientId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: clientId, role: "client", userStatus: "active", email: `${clientId}@example.test` } as never);
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", tenantId: rootId } as never);
  const topUp = await createPaymentTopUp({ businessAccountId: f.businessAccountId, clientUserId: clientId, amountMinor: 300_000, internalReference: `offline-${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), razorpayOrderId: `order_${crypto.randomUUID()}` });
  await creditCapturedTopUp({ paymentTopUpId: topUp.topUp._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${crypto.randomUUID()}`, idempotencyKey: `offline-credit-${crypto.randomUUID()}`, expectedAmountMinor: 300_000, expectedCurrency: "INR" });
  await PrepaidAccount.updateOne({ _id: f.wallet._id }, { $set: { cashBalanceMinor: 60_000, fundingCycleSequence: 0, fundingCycleBaselineMinor: 0, lowBalanceAlertedCycle: null } });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await PrepaidAccount.findById(f.wallet._id).session(session).orFail().exec();
      await notifyLowWalletIfNeeded(account, session);
    });
  } finally {
    await session.endSession();
  }
  assert.equal(await PortalNotification.countDocuments({ businessAccountId: f.businessAccountId, recipientUserId: clientId, type: "WALLET_LOW_BALANCE" }), 1);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.fundingCycleBaselineMinor, 300_000);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.lowBalanceAlertedCycle, 1);
}));

test("an existing funded wallet initializes its baseline before bookings cross 20 percent", () => root(async () => {
  const f = await fixture(300_000);
  const clientId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: clientId, role: "client", userStatus: "active", email: `${clientId}@example.test` } as never);
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", tenantId: rootId } as never);

  await PrepaidAccount.updateOne({ _id: f.wallet._id }, { $set: { fundingCycleSequence: 0, fundingCycleBaselineMinor: 0 } });
  const initialized = await ensurePrepaidAccount({ businessAccountId: f.businessAccountId });
  assert.equal(initialized.fundingCycleBaselineMinor, 300_000);
  assert.equal(initialized.fundingCycleSequence, 1);

  await PrepaidAccount.updateOne({ _id: f.wallet._id }, { $set: { cashBalanceMinor: 60_000 } });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await PrepaidAccount.findById(f.wallet._id).session(session).orFail().exec();
      await notifyLowWalletIfNeeded(account, session);
      await notifyLowWalletIfNeeded(account, session);
    });
  } finally {
    await session.endSession();
  }
  assert.equal(await PortalNotification.countDocuments({ businessAccountId: f.businessAccountId, recipientUserId: clientId, type: "WALLET_LOW_BALANCE" }), 1);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.lowBalanceAlertedCycle, 1);
}));

test("captured topup and duplicate webhook credit the wallet only once", () => root(async () => {
  const f = await fixture(0);
  const topUp = await createPaymentTopUp({ businessAccountId: f.businessAccountId, clientUserId: staffId, amountMinor: 50_000, internalReference: `offline-${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), razorpayOrderId: `order_${crypto.randomUUID()}` });
  const input = { paymentTopUpId: topUp.topUp._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${crypto.randomUUID()}`, idempotencyKey: `offline-credit-${crypto.randomUUID()}`, expectedAmountMinor: 50_000, expectedCurrency: "INR" as const };
  await creditCapturedTopUp(input);
  await creditCapturedTopUp(input);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 50_000);
  assert.equal(await PrepaidTransaction.countDocuments({ businessAccountId: f.businessAccountId, transactionType: "TOP_UP_SUCCESS" }), 1);
}));

async function amendment(f: Awaited<ReturnType<typeof fixture>>, amount = 1000) {
  return ShipmentAmendment.create({ shipmentDraftId: f.draft._id, dpdShipmentId: new mongoose.Types.ObjectId(), businessAccountId: f.businessAccountId, branchId, requestedBy: staffId, actorRole: "admin", status: "AWAITING_PAYMENT", paymentStatus: "AWAITING_PAYMENT", paymentAmountMinor: amount, fundingPreview: { deltaAmountMinor: amount }, requestedChanges: { weightKg: 2 }, previousSnapshot: { weightKg: 1 } });
}

test("an unpaid amendment blocks operations on an otherwise fully paid shipment", () => root(async () => {
  const f = await fixture();
  await secureWalletShipmentFunding(f);
  await markShipmentFundingConsuming({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, bookingAttemptId: f.bookingAttemptId });
  await completeShipmentFunding({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, dpdShipmentId: new mongoose.Types.ObjectId(), createdBy: staffId });
  await assertShipmentFundingCompleted(f.draft._id as mongoose.Types.ObjectId);
  const change = await amendment(f);
  await assert.rejects(assertShipmentFundingCompleted(f.draft._id as mongoose.Types.ObjectId), /payment/i);
  await secureAmendmentWalletPayment({ amendmentId: change._id as mongoose.Types.ObjectId, userId: staffId });
  await assert.rejects(assertShipmentFundingCompleted(f.draft._id as mongoose.Types.ObjectId), /payment/i);
  await ShipmentAmendment.updateOne({ _id: change._id }, { $set: { status: "REJECTED" } });
  await assertShipmentFundingCompleted(f.draft._id as mongoose.Types.ObjectId);
}));

test("amendment approval rejects unpaid increases and commits secured wallet funds", () => root(async () => {
  const f = await fixture();
  const change = await amendment(f);
  const adjustment = calculateAmendmentBillingAdjustment({ previousAmountMinor: 10_000, amendedAmountMinor: 11_000, previousAdvanceAppliedMinor: 10_000, previousCreditOutstandingMinor: 0, availableAdvanceMinor: 1000, availableCreditMinor: 0 });
  const session = await mongoose.startSession();
  try {
    await assert.rejects(session.withTransaction(() => applyPrepaidAmendmentMovement({ amendmentId: change._id as mongoose.Types.ObjectId, adjustment, createdBy: staffId, session })), /pay|payment/i);
    await secureAmendmentWalletPayment({ amendmentId: change._id as mongoose.Types.ObjectId, userId: staffId });
    await session.withTransaction(() => applyPrepaidAmendmentMovement({ amendmentId: change._id as mongoose.Types.ObjectId, adjustment, createdBy: staffId, session }));
    assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 99_000);
    assert.equal((await ShipmentAmendment.findById(change._id))?.paymentStatus, "COMPLETED");
  } finally { await session.endSession(); }
}));

test("business amendment reductions credit only the price difference, including legacy charge labels", () => root(async () => {
  const f = await bookingFixture();
  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, {
    actor: "admin",
    paymentSource: "BUSINESS_WALLET",
    skipDpdLabel: true,
    acceptedPricingHash: f.pricingHash
  });
  const invoice = booked.shipmentInvoice;
  const walletAfterBooking = (await PrepaidAccount.findById(f.wallet._id))!.cashBalanceMinor;
  const revisedAmountMinor = Math.round(invoice.totalAmountMinor * 0.2);
  const differenceMinor = invoice.totalAmountMinor - revisedAmountMinor;

  // Older records can retain the former business-account source even though
  // their invoice was paid in full. Customer type and purpose must choose the
  // prepaid workflow, never the removed credit balance.
  await ShipmentCharge.updateOne(
    { shipmentDraftId: f.draft._id },
    { $set: { paymentSource: "BUSINESS_ACCOUNT" } }
  );
  const change = await amendment(f, 0);
  const session = await mongoose.startSession();
  try {
    const adjustment = await session.withTransaction(() => applyApprovedAmendmentBilling({
      amendmentId: change._id as mongoose.Types.ObjectId,
      shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
      businessAccountId: f.businessAccountId,
      pricing: { ...f.pricing, totalAmount: revisedAmountMinor / 100 },
      createdBy: staffId,
      session
    }));

    assert.equal(adjustment?.deltaAmountMinor, -differenceMinor);
    assert.equal(adjustment?.advanceRefundedMinor, differenceMinor);
    assert.equal(adjustment?.creditReducedMinor, 0);
    assert.equal(adjustment?.advanceCreditedMinor, 0);
    assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, walletAfterBooking + differenceMinor);
    assert.equal((await ShipmentCharge.findOne({ shipmentDraftId: f.draft._id }))?.customerChargeMinor, revisedAmountMinor);
    assert.equal(await PrepaidTransaction.countDocuments({
      businessAccountId: f.businessAccountId,
      transactionType: "AMENDMENT_ADJUSTMENT_CREDITED",
      referenceId: change._id
    }), 1);

    await assert.rejects(session.withTransaction(() => applyApprovedAmendmentBilling({
      amendmentId: change._id as mongoose.Types.ObjectId,
      shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
      businessAccountId: f.businessAccountId,
      pricing: { ...f.pricing, totalAmount: revisedAmountMinor / 100 },
      createdBy: staffId,
      session
    })));
    assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, walletAfterBooking + differenceMinor);
  } finally {
    await session.endSession();
  }
}));

test("rejecting secured wallet and direct amendments releases or refunds their payment", () => root(async () => {
  for (const source of ["BUSINESS_WALLET", "DIRECT_RAZORPAY"] as const) {
    const f = await fixture();
    const change = await amendment(f);
    let paymentId: mongoose.Types.ObjectId | undefined;
    if (source === "BUSINESS_WALLET") {
      await secureAmendmentWalletPayment({ amendmentId: change._id as mongoose.Types.ObjectId, userId: staffId });
    } else {
      const { payment } = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, paymentPurpose: "SHIPMENT_AMENDMENT", amendmentId: change._id as mongoose.Types.ObjectId, amountMinor: 1000, pricingHash: "offline-rejection", pricingRevision: 0, idempotencyKey: crypto.randomUUID() });
      paymentId = payment._id as mongoose.Types.ObjectId;
      await recordCapturedShipmentDirectPayment({ paymentIntentId: paymentId, razorpayPaymentId: `pay_${paymentId}`, expectedOrderId: payment.razorpayOrderId, expectedAmountMinor: 1000, expectedCurrency: "INR" });
      await secureAmendmentDirectPayment({ amendmentId: change._id as mongoose.Types.ObjectId, paymentIntentId: paymentId });
    }
    const result = responseRecorder();
    await rejectShipmentAmendment({ user: { _id: staffId }, params: { id: String(change._id) }, body: { note: "Offline regression test" } } as unknown as Request, result.response);
    assert.equal(result.status(), 200);
    assert.equal((await ShipmentAmendment.findById(change._id))?.status, "REJECTED");
    assert.equal((await ShipmentAmendment.findById(change._id))?.paymentStatus, "RELEASED");
    assert.equal((await PrepaidAccount.findById(f.wallet._id))?.reservedBalanceMinor, 0);
    if (paymentId) assert.equal((await ShipmentDirectPayment.findById(paymentId))?.status, "REFUNDED");
  }
}));

test("invalid webhook signatures cannot credit funds", async () => {
  const result = responseRecorder();
  await handleRazorpayWebhook({ body: Buffer.from('{"event":"payment.captured"}'), headers: { "x-razorpay-event-id": "offline-invalid", "x-razorpay-signature": "invalid" } } as unknown as Request, result.response);
  assert.equal(result.status(), 400);
});

async function signedWebhook(event: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = crypto.createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest("hex");
  const result = responseRecorder();
  await handleRazorpayWebhook({ body: rawBody, headers: { "x-razorpay-event-id": eventId, "x-razorpay-signature": signature } } as unknown as Request, result.response);
  assert.equal(result.status(), 200);
  return result.body();
}

test("signed duplicate captured webhooks credit a topup exactly once", () => root(async () => {
  const f = await fixture(0);
  const orderId = `order_${crypto.randomUUID()}`;
  await createPaymentTopUp({ businessAccountId: f.businessAccountId, clientUserId: staffId, amountMinor: 50_000, internalReference: `offline-${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), razorpayOrderId: orderId });
  const eventId = crypto.randomUUID();
  const payload = { event: "payment.captured", payload: { payment: { entity: { id: `pay_${crypto.randomUUID()}`, order_id: orderId, amount: 50_000, currency: "INR", status: "captured" } } } };
  await signedWebhook(payload, eventId);
  await signedWebhook(payload, eventId);
  await signedWebhook(payload);
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 50_000);
  assert.equal(await PrepaidTransaction.countDocuments({ businessAccountId: f.businessAccountId, transactionType: "TOP_UP_SUCCESS" }), 1);
}));

test("a delayed captured topup after a failed attempt credits once", () => root(async () => {
  const f = await fixture(0);
  const orderId = `order_${crypto.randomUUID()}`;
  const paymentId = `pay_${crypto.randomUUID()}`;
  await createPaymentTopUp({ businessAccountId: f.businessAccountId, clientUserId: staffId, amountMinor: 10_000, internalReference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), razorpayOrderId: orderId });
  await signedWebhook({ event: "payment.failed", payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 10_000, currency: "INR", status: "failed" } } } });
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 0);
  await signedWebhook({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 10_000, currency: "INR", status: "captured" } } } });
  assert.equal((await PrepaidAccount.findById(f.wallet._id))?.cashBalanceMinor, 10_000);
}));

test("cancellation refunds the fixed captures once and cannot be rejected after refund starts", () => root(async () => {
  const f = await fixture(0);
  const payment = await directPayment(f);
  await securePaidShipmentFunding({ ...f, source: "DIRECT_RAZORPAY", sourceReferenceId: payment._id as mongoose.Types.ObjectId, pricingHash: buildPricingHash(f.pricing) });
  await completeShipmentFunding({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, dpdShipmentId: new mongoose.Types.ObjectId(), createdBy: staffId });
  const change = await amendment(f, 1000);
  const amendmentPayment = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, paymentPurpose: "SHIPMENT_AMENDMENT", amendmentId: change._id as mongoose.Types.ObjectId, amountMinor: 1000, pricingHash: "offline-amendment", pricingRevision: 0, idempotencyKey: crypto.randomUUID() });
  await recordCapturedShipmentDirectPayment({ paymentIntentId: amendmentPayment.payment._id as mongoose.Types.ObjectId, razorpayPaymentId: `pay_${amendmentPayment.payment._id}`, expectedOrderId: amendmentPayment.payment.razorpayOrderId, expectedAmountMinor: 1000, expectedCurrency: "INR" });
  await secureAmendmentDirectPayment({ amendmentId: change._id as mongoose.Types.ObjectId, paymentIntentId: amendmentPayment.payment._id as mongoose.Types.ObjectId });
  const session = await mongoose.startSession();
  try {
    const adjustment = calculateAmendmentBillingAdjustment({ previousAmountMinor: 10_000, amendedAmountMinor: 11_000, previousAdvanceAppliedMinor: 10_000, previousCreditOutstandingMinor: 0, availableAdvanceMinor: 1000, availableCreditMinor: 0 });
    await session.withTransaction(async () => {
      await applyPrepaidAmendmentMovement({ amendmentId: change._id as mongoose.Types.ObjectId, adjustment, createdBy: staffId, session });
      await ShipmentAmendment.updateOne({ _id: change._id }, { $set: { status: "APPROVED" } }, { session });
    });
  } finally { await session.endSession(); }
  // Delayed capture events must be harmless after approval.
  await signedWebhook({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${amendmentPayment.payment._id}`, order_id: amendmentPayment.payment.razorpayOrderId, amount: 1000, currency: "INR", status: "captured" } } } });
  const cancellationId = new mongoose.Types.ObjectId();
  await ShipmentCancellation.collection.insertOne({ _id: cancellationId, shipmentDraftId: f.draft._id, tenantId: rootId, status: "REQUESTED" } as never);
  const input = { cancellationId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, amountMinor: 10_500 };
  const beforeRefunds = refundRequests.length;
  assert.equal(await ensureCancellationGatewayRefund(input), "COMPLETED");
  const requests = refundRequests.slice(beforeRefunds);
  assert.equal(requests.length, 2);
  assert.equal(requests.reduce((total, refund) => total + refund.amount, 0), 10_500);
  assert.ok(requests.every((refund) => /^[A-Za-z0-9_-]{10,256}$/.test(refund.key)));
  assert.equal(await ensureCancellationGatewayRefund(input), "COMPLETED");
  assert.equal(refundRequests.length - beforeRefunds, 2);
  await assert.rejects(ensureCancellationGatewayRefund({ ...input, amountMinor: 10_000 }), /already fixed/i);
  await assert.rejects(rejectShipmentCancellation({ cancellationId, reviewedBy: staffId, reviewNote: "Cannot reject money already refunded" }), /started gateway refund/i);
}));

test("a public payment must be captured before its full internal test booking", () => root(async () => {
  const f = await bookingFixture("INDIVIDUAL", 0);
  const amountMinor = Math.round(f.pricing.totalAmount * 100);
  const paymentId = new mongoose.Types.ObjectId();
  await PublicShipmentPayment.collection.insertOne({ _id: paymentId, bookingId: new mongoose.Types.ObjectId(), shipmentDraftId: f.draft._id, amountMinor, currency: "INR", pricingHash: buildPricingHash(f.pricing), status: "ORDER_CREATED" } as never);
  const paid = { ...f, source: "PUBLIC_RAZORPAY" as const, sourceReferenceId: paymentId, pricingHash: buildPricingHash(f.pricing) };
  await assert.rejects(securePaidShipmentFunding(paid), /captured|pending/i);
  await PublicShipmentPayment.updateOne({ _id: paymentId }, { $set: { status: "CAPTURED" } });
  await securePaidShipmentFunding(paid);
  assert.equal((await ShipmentFunding.findOne({ shipmentDraftId: f.draft._id }))?.source, "PUBLIC_RAZORPAY");
  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, { actor: "public", paymentSource: "PUBLIC_RAZORPAY", fundingReferenceId: String(paymentId), skipDpdLabel: true, acceptedPricingHash: f.pricingHash });
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);
  assert.equal(booked.dpdShipment.dpdShipmentId, "");
}));

test("pending cancellation refunds fetch the existing refund until processing completes", () => root(async () => {
  const f = await fixture(0);
  const payment = await directPayment(f);
  await securePaidShipmentFunding({ ...f, source: "DIRECT_RAZORPAY", sourceReferenceId: payment._id as mongoose.Types.ObjectId, pricingHash: buildPricingHash(f.pricing) });
  await completeShipmentFunding({ shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, dpdShipmentId: new mongoose.Types.ObjectId(), createdBy: staffId });
  const cancellationId = new mongoose.Types.ObjectId();
  await ShipmentCancellation.collection.insertOne({ _id: cancellationId, shipmentDraftId: f.draft._id, tenantId: rootId, status: "REQUESTED" } as never);
  const input = { cancellationId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, amountMinor: 9_000 };
  const beforeRefunds = refundRequests.length;
  nextRefundPending = true;
  assert.equal(await ensureCancellationGatewayRefund(input), "PENDING");
  assert.equal(await ensureCancellationGatewayRefund(input), "PENDING");
  assert.equal(refundRequests.length, beforeRefunds + 1);
  const stored = await ShipmentDirectPayment.findById(payment._id).orFail();
  providerRefunds.get(stored.razorpayRefundId)!.status = "processed";
  assert.equal(await ensureCancellationGatewayRefund(input), "COMPLETED");
  assert.equal(await ensureCancellationGatewayRefund(input), "COMPLETED");
  assert.equal(refundRequests.length, beforeRefunds + 1);
}));

test("a late capture for a rejected amendment is refunded without reopening it", () => root(async () => {
  const f = await fixture(0);
  const change = await amendment(f);
  const { payment } = await createShipmentDirectPayment({ businessAccountId: f.businessAccountId, branchId, shipmentDraftId: f.draft._id as mongoose.Types.ObjectId, paymentPurpose: "SHIPMENT_AMENDMENT", amendmentId: change._id as mongoose.Types.ObjectId, amountMinor: 1000, pricingHash: "offline-rejected-amendment", pricingRevision: 0, idempotencyKey: crypto.randomUUID() });
  await ShipmentAmendment.updateOne({ _id: change._id }, { $set: { status: "REJECTED" } });
  const payload = { event: "payment.captured", payload: { payment: { entity: { id: `pay_${payment._id}`, order_id: payment.razorpayOrderId, amount: 1000, currency: "INR", status: "captured" } } } };
  const beforeRefunds = refundRequests.length;
  await signedWebhook(payload);
  await signedWebhook(payload);
  assert.equal(refundRequests.length - beforeRefunds, 1);
  assert.equal((await ShipmentAmendment.findById(change._id))?.status, "REJECTED");
  assert.equal((await ShipmentAmendment.findById(change._id))?.paymentStatus, "RELEASED");
  assert.equal((await ShipmentDirectPayment.findById(payment._id))?.status, "REFUNDED");
  await signedWebhook({ event: "refund.failed", payload: { refund: { entity: { id: "rfnd_late_failed", payment_id: `pay_${payment._id}`, amount: 1000, currency: "INR", status: "failed" } } } });
  assert.equal((await ShipmentDirectPayment.findById(payment._id))?.status, "REFUNDED");
}));

test("cash receipt PDF follows the compact receipt layout on one page", async () => {
  const receipt = new CashReceipt({ receiptNumber: "CR-OFFLINE-001", receiptType: "STANDALONE", status: "FINALIZED", customerNameSnapshot: "Offline Test Business", accountIdSnapshot: "OFF-001", serviceSnapshot: "COURIER", piecesSnapshot: 1, weightKgSnapshot: 1, totalReceivedMinor: 10_000, unappliedAmountMinor: 0, cashCustodyReference: "OFFLINE-CASH-001", customerReference: "TEST", cashRecordedByNameSnapshot: "Offline Operations User", allocations: [{ allocationType: "UNAPPLIED", amountMinor: 10_000 }], issuedAt: new Date() });
  const pdf = await PDFDocument.load(await renderCashReceiptPdf(receipt));
  assert.equal(pdf.getPageCount(), 1);
  const page = pdf.getPage(0);
  assert.equal(page.getWidth(), 432);
  assert.ok(page.getHeight() < 400);
});
