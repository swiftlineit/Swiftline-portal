import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import type { Request, Response as ExpressResponse } from "express";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Tenant } from "../models/tenant.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { User } from "../models/user.model.js";
import { Branch } from "../models/branch.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";
import {
  createShipmentDirectPayment,
  recordCapturedShipmentDirectPayment,
  reconcileShipmentDirectPayment,
  refundCapturedShipmentDirectPayment,
  refundUnallocatedShipmentDirectPayment
} from "../services/prepaid/shipmentDirectPayments.service.js";
import {
  applyAmendmentPaymentMovement,
  prepareAmendmentRefund,
  recordManualAmendmentRefund
} from "../services/prepaid/amendmentFunding.service.js";
import type { AmendmentBillingAdjustment } from "../services/amendmentBilling.service.js";
import { ensureCancellationGatewayRefund } from "../services/prepaid/cancellationRefunds.service.js";
import { cancelShipmentDirectly, getShipmentCancellationPreview } from "../services/shipmentCancellation.service.js";
import { reserveShipmentBookingCharge } from "../services/shipmentBookingBilling.service.js";
import { createLabelForShipmentDraft } from "../services/dpdShipment.service.js";
import { saveCashReceiptDraft, finalizeCashReceiptForBooking } from "../services/prepaid/cashReceipts.service.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import { buildPricingInputFromDraft, calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import type { ShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import { listAccountLedger } from "../services/prepaid/accountLedger.service.js";
import { deleteObject } from "../services/storage/storage.service.js";

const databaseName = `sl_payments_offline_${Date.now()}`;
let rootId = new mongoose.Types.ObjectId();
const connected = process.env.PREPAID_CONNECTED_TEST === "1";
const staffId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const root = <T>(work: () => T) => runWithTenantContext({ tenantId: rootId, kind: "SWIFTLINE" }, work);
const fetchBefore = globalThis.fetch;
const providerRefunds = new Map<string, Record<string, unknown>>();
const providerPayments = new Map<string, {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}>();
let nextRefundPending = false;
let providerCaptureCount = 0;

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
  }
  if (!connected) {
    for (const model of Object.values(mongoose.models)) await model.createCollection();
    for (const model of [ShipmentFunding, ShipmentDirectPayment, ShipmentAmendment, ShipmentCancellation, CashReceipt, ShipmentCharge]) {
      await model.createIndexes();
    }
    await Tenant.create({ _id: rootId, kind: "SWIFTLINE", status: "ACTIVE", companyName: "Offline Swiftline", slug: "swiftline" });
  }
  await User.collection.insertOne({ _id: staffId, name: "Offline Operations User", role: "operations", userStatus: "active", email: "payments-staff@example.test" } as never);
  globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    assert.ok(url.startsWith("https://api.razorpay.com/v1/"), `Forbidden provider request: ${url}`);
    const json = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/orders")) {
      return new Response(JSON.stringify({ id: `order_offline_${crypto.randomUUID()}`, amount: json.amount, currency: json.currency, status: "created" }));
    }
    const capture = url.match(/\/payments\/([^/]+)\/capture$/);
    if (capture) {
      const entity = providerPayments.get(capture[1]!);
      if (!entity) throw new Error(`Unknown offline payment: ${capture[1]}`);
      entity.status = "captured";
      providerCaptureCount += 1;
      return new Response(JSON.stringify(entity));
    }
    const paymentLookup = url.match(/\/payments\/([^/]+)$/);
    if (paymentLookup) {
      const entity = providerPayments.get(paymentLookup[1]!);
      if (!entity) throw new Error(`Unknown offline payment: ${paymentLookup[1]}`);
      return new Response(JSON.stringify(entity));
    }
    const refundLookup = url.match(/\/refunds\/([^/]+)$/);
    if (refundLookup && providerRefunds.has(refundLookup[1]!)) {
      return new Response(JSON.stringify(providerRefunds.get(refundLookup[1]!)!));
    }
    const refund = url.match(/\/payments\/([^/]+)\/refund$/);
    if (refund) {
      const key = new Headers(init?.headers).get("X-Refund-Idempotency") ?? "";
      const entity = {
        id: `rfnd_${key}`,
        payment_id: refund[1],
        amount: json.amount,
        currency: "INR",
        status: nextRefundPending ? "pending" : "processed"
      };
      nextRefundPending = false;
      providerRefunds.set(entity.id!, entity);
      return new Response(JSON.stringify(entity));
    }
    throw new Error(`Unexpected offline Razorpay request: ${url}`);
  };
});

after(async () => {
  globalThis.fetch = fetchBefore;
  if (mongoose.connection.readyState) {
    if (connected) {
      const labels = await LabelDocument.collection.find({}).toArray();
      for (const label of labels) if (label.storageKey) await deleteObject(label.storageKey);
      await mongoose.disconnect();
      return;
    }
    const labels = await LabelDocument.collection.find({}).toArray();
    for (const label of labels) if (label.storageKey) await deleteObject(label.storageKey);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function bookingFixture(customerType: "BUSINESS" | "INDIVIDUAL" = "BUSINESS") {
  await Branch.collection.updateOne({ _id: branchId }, { $setOnInsert: {
    tenantId: rootId,
    name: "Payments QA Delhi",
    code: "DEL",
    labelCode: "DEL",
    status: "ACTIVE",
    address: { address: "1 Offline Road", city: "Delhi", stateOrProvince: "Delhi", postalCode: "110001", countryName: "India" },
    contact: { email: "payments-branch@example.test", phone: "9876543210", countryCode: "+91" },
    gstin: "07AAACS1234A1Z1"
  } }, { upsert: true });

  const businessAccountId = new mongoose.Types.ObjectId();
  await BusinessAccount.collection.insertOne({
    _id: businessAccountId,
    tenantId: rootId,
    accountId: `PAY-${businessAccountId}`,
    status: "active",
    accountKind: customerType === "INDIVIDUAL" ? "INDIVIDUAL_SENTINEL" : "BUSINESS",
    company: {
      companyName: "Payments QA Business",
      registrationIdKey: String(businessAccountId),
      stateOrProvince: "Delhi",
      registeredAddress: "1 Offline Road",
      city: "Delhi",
      postalCode: "110001",
      addressCountry: "India"
    },
    contact: {
      firstName: "Payments QA",
      lastName: "Sender",
      email: `qa-${businessAccountId}@example.test`,
      countryCode: "+91",
      mobileNumber: String(BigInt("0x" + String(businessAccountId).slice(-10))).slice(-10).padStart(10, "9")
    },
    assignedBranch: branchId,
    privateRateCardVersion: 1,
    privateRateCardReady: true
  } as never);

  await CountryRateCard.create({
    ...(customerType === "INDIVIDUAL" ? { band: "BAND_D" } : { businessAccountId }),
    countryCode: "US",
    countryName: "United States",
    service: "COURIER",
    fromKg: 0,
    toKg: 10,
    chargesPerKg: 100,
    maxBoxKg: 30,
    createdBy: staffId
  });

  const draft = new ShipmentDraft({ businessAccountId, branchId, customerType, createdBy: staffId });
  await ShipmentDraft.collection.insertOne({
    ...draft.toObject(),
    tenantId: rootId,
    creationSource: "MANUAL",
    bookingState: "EDITABLE",
    status: "READY_FOR_DPD",
    serviceType: "COURIER",
    serviceCode: "EXP",
    csbType: "CSB_IV",
    parcelCount: 1,
    shipperDeclarationAcceptedAt: new Date(),
    shipperDeclarationVersion: "v1",
    addressValidationStatus: "VALIDATED",
    consigneeEnteredAddress: {
      companyName: "Offline Receiver",
      contactName: "Alex Smith",
      email: "offline-receiver@example.test",
      mobileCountryCode: "+1",
      mobileNumber: "2025550123",
      countryCode: "US",
      countryName: "United States",
      postcode: "10001",
      addressLine1: "1 Offline Street",
      townOrCity: "New York",
      county: "New York",
      stateCode: "NY"
    },
    consignorAddress: {
      companyName: "Offline Sender",
      contactName: "Ravi Kumar",
      email: "offline-sender@example.test",
      mobileCountryCode: "+91",
      mobileNumber: "9876543210",
      countryCode: "IN",
      countryName: "India",
      postcode: "110001",
      addressLine1: "10 Offline Road",
      townOrCity: "Delhi",
      county: "Delhi",
      aadhaarNumber: "234567890124"
    },
    parcelList: [{
      sequence: 1,
      weightKg: 1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      shipmentContentType: "PARCEL",
      shipmentReference1: "PAYMENTS-TEST",
      contentsDescription: "Cotton shirts",
      items: [{ description: "Cotton shirts", hsnCode: "", unitType: "Pcs", quantity: 1, unitRate: 500 }]
    }]
  } as never);

  const loadedDraft = await ShipmentDraft.findById(draft._id).orFail();
  const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(loadedDraft));
  return {
    draft: loadedDraft,
    businessAccountId,
    pricing,
    pricingHash: buildPricingHash(pricing),
    amountMinor: Math.round(pricing.totalAmount * 100),
    createdBy: staffId,
    bookingAttemptId: crypto.randomUUID()
  };
}

async function capturedDirectPayment(fixture: Awaited<ReturnType<typeof bookingFixture>>, amountMinor = fixture.amountMinor) {
  const created = await createShipmentDirectPayment({
    businessAccountId: fixture.businessAccountId,
    branchId,
    shipmentDraftId: fixture.draft._id as mongoose.Types.ObjectId,
    amountMinor,
    pricingHash: fixture.pricingHash,
    pricingRevision: 0,
    idempotencyKey: crypto.randomUUID()
  });
  await recordCapturedShipmentDirectPayment({
    paymentIntentId: created.payment._id as mongoose.Types.ObjectId,
    razorpayPaymentId: `pay_${created.payment._id}`,
    expectedOrderId: created.payment.razorpayOrderId,
    expectedAmountMinor: created.payment.amountMinor,
    expectedCurrency: "INR"
  });
  return created.payment;
}

async function createDirectPaymentIntentWithoutBooking(amountMinor = 12_500) {
  const shipmentDraftId = new mongoose.Types.ObjectId();
  const payment = await createShipmentDirectPayment({
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    shipmentDraftId,
    amountMinor,
    pricingHash: crypto.randomBytes(16).toString("hex"),
    pricingRevision: 0,
    idempotencyKey: crypto.randomUUID()
  });
  return { payment: payment.payment, shipmentDraftId };
}

async function bookDirect(fixture: Awaited<ReturnType<typeof bookingFixture>>, payment: Awaited<ReturnType<typeof capturedDirectPayment>>) {
  return createLabelForShipmentDraft(String(fixture.draft._id), staffId, {
    actor: "admin",
    paymentSource: "DIRECT_RAZORPAY",
    fundingReferenceId: String(payment._id),
    acceptedPricingHash: fixture.pricingHash,
    skipDpdLabel: true
  });
}

function zeroAdjustment(deltaAmountMinor: number, previousAmountMinor: number): AmendmentBillingAdjustment {
  const amendedAmountMinor = previousAmountMinor + deltaAmountMinor;
  return {
    previousAmountMinor,
    amendedAmountMinor,
    deltaAmountMinor,
    advanceUsedMinor: 0,
    creditUsedMinor: 0,
    creditReducedMinor: 0,
    advanceRefundedMinor: deltaAmountMinor < 0 ? -deltaAmountMinor : 0,
    advanceCreditedMinor: 0,
    advanceAppliedMinor: 0,
    creditOutstandingMinor: 0,
    settledAmountMinor: Math.max(amendedAmountMinor, 0)
  };
}

test("direct payment order is verified and captured without booking a shipment", () => root(async () => {
  const { payment, shipmentDraftId } = await createDirectPaymentIntentWithoutBooking();
  const gatewayPaymentId = `pay_offline_${crypto.randomUUID()}`;
  providerPayments.set(gatewayPaymentId, {
    id: gatewayPaymentId,
    order_id: payment.razorpayOrderId,
    amount: payment.amountMinor,
    currency: "INR",
    status: "authorized"
  });
  const capturesBefore = providerCaptureCount;

  const result = await reconcileShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    razorpayPaymentId: gatewayPaymentId,
    razorpaySignature: "offline-signature"
  });

  assert.equal(result.captured, true);
  if (!result.captured) return;
  assert.equal(result.payment.status, "CAPTURED");
  assert.equal(providerCaptureCount, capturesBefore + 1);
  assert.equal(await ShipmentFunding.findOne({ source: "DIRECT_RAZORPAY", sourceReferenceId: payment._id }).exec(), null);
  assert.equal(await DpdShipment.findOne({ shipmentDraftId }).exec(), null);
}));

test("captured unallocated direct payment can be refunded without creating a shipment", () => root(async () => {
  const { payment, shipmentDraftId } = await createDirectPaymentIntentWithoutBooking();
  const gatewayPaymentId = `pay_offline_${crypto.randomUUID()}`;
  await recordCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    razorpayPaymentId: gatewayPaymentId,
    expectedOrderId: payment.razorpayOrderId,
    expectedAmountMinor: payment.amountMinor,
    expectedCurrency: "INR"
  });

  const refunded = await refundUnallocatedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    shipmentDraftId,
    reason: "DPD became unavailable before booking."
  });

  assert.equal(refunded?.status, "REFUNDED");
  assert.equal(refunded?.razorpayRefundAmountMinor, payment.amountMinor);
  assert.equal(await DpdShipment.findOne({ shipmentDraftId }).exec(), null);
}));

test("wallet reservations are closed and direct payments fund a complete booking", () => root(async () => {
  const f = await bookingFixture();
  await assert.rejects(
    reserveShipmentBookingCharge({ draft: f.draft, createdBy: staffId, bookingAttemptId: f.bookingAttemptId }),
    /Wallet funding is no longer available/i
  );

  const payment = await capturedDirectPayment(f);
  const booked = await bookDirect(f, payment);
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);
  assert.equal(booked.dpdShipment.dpdShipmentId, "");
  assert.ok(await LabelDocument.countDocuments({ dpdShipmentId: booked.dpdShipment._id, labelType: "SWIFTLINE" }));
  assert.equal(await DpdShipment.countDocuments({ shipmentDraftId: f.draft._id, labelType: "DPD" }), 0);

  const completed = await ShipmentFunding.findOne({ shipmentDraftId: f.draft._id }).orFail();
  assert.equal(completed.status, "COMPLETED");
  assert.equal((await ShipmentDirectPayment.findById(payment._id))?.status, "ALLOCATED");

  const ledger = await listAccountLedger({ tenantId: rootId, businessAccountId: f.businessAccountId });
  const directRows = ledger.transactions.filter((row) => row.transactionType === "RAZORPAY_BOOKING_PAYMENT");
  assert.equal(directRows.length, 1);
  assert.equal(directRows[0]?.amountMinor, f.amountMinor);
  assert.equal(directRows[0]?.shipmentDraftId, String(f.draft._id));
  assert.equal(directRows[0]?.cashBalanceAfterMinor, undefined);
  assert.equal(ledger.transactions.some((row) => row.paymentSource === "WALLET"), false);
}));

test("a staff cash receipt funds a business booking and appears in the payments ledger", () => root(async () => {
  const f = await bookingFixture();
  const clientId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: clientId, name: "Offline Payments Client", role: "client", userStatus: "active", email: `client-${clientId}@example.test` } as never);
  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", assignedBranches: [branchId], tenantId: rootId } as never);

  const draft = await saveCashReceiptDraft({
    shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
    staffUserId: staffId,
    acceptedPricingHash: f.pricingHash,
    totalReceivedMinor: f.amountMinor,
    customerName: "Payments QA Business",
    receiptDate: new Date(),
    cashCustodyReference: "PAYMENTS-CASH-001"
  });
  const finalized = await finalizeCashReceiptForBooking({
    cashReceiptId: draft._id as mongoose.Types.ObjectId,
    shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
    staffUserId: staffId,
    acceptedPricingHash: f.pricingHash
  });
  assert.equal(finalized.status, "FINALIZED");
  assert.ok(await EmailOutbox.countDocuments({ recipientUserId: clientId, "attachmentRefs.refId": draft._id }));

  const booked = await createLabelForShipmentDraft(String(f.draft._id), staffId, {
    actor: "admin",
    paymentSource: "CASH_RECEIPT",
    fundingReferenceId: String(draft._id),
    acceptedPricingHash: f.pricingHash,
    skipDpdLabel: true
  });
  assert.equal(booked.shipmentInvoice.paymentStatus, "PAID");
  assert.equal(booked.shipmentInvoice.creditOutstandingMinor, 0);

  // Historical standalone receipts must not leak into a business account ledger.
  await CashReceipt.collection.insertOne({
    tenantId: rootId,
    businessAccountId: f.businessAccountId,
    branchId,
    receiptNumber: "STANDALONE-LEGACY",
    receiptType: "STANDALONE",
    status: "FINALIZED",
    issuedAt: new Date(),
    totalReceivedMinor: 99_900
  } as never);

  const ledger = await listAccountLedger({ tenantId: rootId, businessAccountId: f.businessAccountId });
  const cashRows = ledger.transactions.filter((row) => row.transactionType === "SHIPMENT_CASH_RECEIPT");
  assert.equal(cashRows.length, 1);
  assert.equal(cashRows[0]?.amountMinor, f.amountMinor);
  assert.equal(ledger.transactions.some((row) => row.reference === "STANDALONE-LEGACY"), false);
  assert.equal(ledger.transactions.some((row) => row.transactionType === "STANDALONE_CASH_RECEIPT"), false);
}));

test("direct payment refunds are cumulative, idempotent and reject over-refunds", () => root(async () => {
  const f = await bookingFixture();
  const payment = await capturedDirectPayment(f, 10_000);

  const first = await refundCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    reason: "First partial refund",
    amountMinor: 4_000
  });
  assert.equal(first?.status, "SETTLED");
  assert.equal(first?.razorpayRefundAmountMinor, 4_000);

  const second = await refundCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    reason: "Second partial refund",
    amountMinor: 3_000
  });
  assert.equal(second?.status, "SETTLED");
  assert.equal(second?.razorpayRefundAmountMinor, 7_000);
  assert.equal(await ShipmentDirectPayment.countDocuments({ _id: payment._id, razorpayRefundAmountMinor: 7_000 }), 1);

  const full = await refundCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    reason: "Final refund",
    amountMinor: 3_000
  });
  assert.equal(full?.status, "REFUNDED");
  assert.equal(full?.razorpayRefundAmountMinor, 10_000);
  assert.ok(full?.razorpayRefundedAt);

  const repeatedFull = await refundCapturedShipmentDirectPayment({
    paymentIntentId: payment._id as mongoose.Types.ObjectId,
    reason: "Repeat full refund",
    amountMinor: 1
  });
  assert.equal(String(repeatedFull?._id), String(payment._id));
  assert.equal(repeatedFull?.razorpayRefundAmountMinor, 10_000);
}));

test("a pending gateway refund blocks approval and a completed refund unlocks the amendment", () => root(async () => {
  const f = await bookingFixture();
  const payment = await capturedDirectPayment(f);
  await bookDirect(f, payment);

  const amendment = await ShipmentAmendment.create({
    tenantId: rootId,
    shipmentDraftId: f.draft._id,
    dpdShipmentId: new mongoose.Types.ObjectId(),
    businessAccountId: f.businessAccountId,
    branchId,
    requestedBy: staffId,
    actorRole: "admin",
    status: "REQUESTED",
    paymentStatus: "NOT_REQUIRED",
    refundStatus: "NOT_REQUIRED",
    reason: "Reduce shipment value",
    requestedChanges: { parcelList: [] },
    previousSnapshot: { snapshot: "before" },
    fundingPreview: { deltaAmountMinor: -5_000 }
  });

  nextRefundPending = true;
  const prepared = await prepareAmendmentRefund({
    amendmentId: amendment._id as mongoose.Types.ObjectId,
    amountMinor: 5_000,
    reason: "Amendment reduction"
  });
  assert.equal(prepared.refundStatus, "REFUND_PENDING");

  const session = await mongoose.startSession();
  try {
    await assert.rejects(
      applyAmendmentPaymentMovement({
        amendmentId: amendment._id as mongoose.Types.ObjectId,
        adjustment: zeroAdjustment(-5_000, f.amountMinor),
        createdBy: staffId,
        session
      }),
      /still processing/i
    );

    await ShipmentDirectPayment.updateOne(
      { _id: payment._id },
      { $set: { status: "REFUNDED", razorpayRefundedAt: new Date() } }
    );
    const reconciled = await ShipmentAmendment.findById(amendment._id).orFail();
    reconciled.refundStatus = "REFUNDED";
    reconciled.refundCompletedAt = new Date();
    await reconciled.save();

    const movement = await applyAmendmentPaymentMovement({
      amendmentId: amendment._id as mongoose.Types.ObjectId,
      adjustment: zeroAdjustment(-5_000, f.amountMinor),
      createdBy: staffId,
      session
    });
    assert.equal(movement.refundStatus, "REFUNDED");
  } finally {
    await session.endSession();
  }
}));

test("manual refund fallback is required when no gateway payment can cover a reduction", () => root(async () => {
  const f = await bookingFixture();
  const amendment = await ShipmentAmendment.create({
    tenantId: rootId,
    shipmentDraftId: f.draft._id,
    dpdShipmentId: new mongoose.Types.ObjectId(),
    businessAccountId: f.businessAccountId,
    branchId,
    requestedBy: staffId,
    actorRole: "admin",
    status: "REQUESTED",
    paymentStatus: "NOT_REQUIRED",
    refundStatus: "NOT_REQUIRED",
    reason: "Cash reduction",
    requestedChanges: { parcelList: [] },
    previousSnapshot: { snapshot: "before" },
    fundingPreview: { deltaAmountMinor: -2_500 }
  });

  await assert.rejects(
    prepareAmendmentRefund({
      amendmentId: amendment._id as mongoose.Types.ObjectId,
      amountMinor: 2_500,
      reason: "Manual refund fallback"
    }),
    /Record a manual refund before approval/i
  );

  const session = await mongoose.startSession();
  try {
    const recorded = await recordManualAmendmentRefund({
      amendmentId: amendment._id as mongoose.Types.ObjectId,
      reference: "CASH-REFUND-001",
      note: "Paid at counter",
      createdBy: staffId,
      session
    });
    assert.equal(recorded.refundStatus, "CASH_REFUND_RECORDED");
    const movement = await applyAmendmentPaymentMovement({
      amendmentId: amendment._id as mongoose.Types.ObjectId,
      adjustment: zeroAdjustment(-2_500, f.amountMinor),
      createdBy: staffId,
      session
    });
    assert.equal(movement.refundStatus, "CASH_REFUND_RECORDED");
  } finally {
    await session.endSession();
  }
}));

test("a cancellation refunds the original direct payment and never credits a wallet", () => root(async () => {
  const f = await bookingFixture();
  const payment = await capturedDirectPayment(f);
  await bookDirect(f, payment);

  const cancellation = await ShipmentCancellation.create({
    tenantId: rootId,
    shipmentDraftId: f.draft._id,
    dpdShipmentId: new mongoose.Types.ObjectId(),
    shipmentInvoiceId: new mongoose.Types.ObjectId(),
    businessAccountId: f.businessAccountId,
    branchId,
    requestedBy: staffId,
    requesterType: "ADMIN",
    requesterRole: "operations",
    reason: "Customer cancelled the shipment",
    shipmentStatusAtRequest: "BOOKED",
    originalAmountMinor: f.amountMinor,
    requestedFeeBaseMinor: f.amountMinor - 5_000,
    refundableAmountMinor: 5_000,
    taxTreatment: "NO_GST"
  });

  const result = await ensureCancellationGatewayRefund({
    shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
    cancellationId: cancellation._id as mongoose.Types.ObjectId,
    amountMinor: 5_000
  });
  assert.equal(result, "COMPLETED");
  const updated = await ShipmentDirectPayment.findById(payment._id).orFail();
  assert.equal(updated.status, "REFUNDED");
  assert.equal(updated.razorpayRefundAmountMinor, 5_000);
  assert.equal(cancellation.paymentRefundStatus, "NOT_REQUIRED");
}));

test("legacy wallet cancellations require a manual refund before the invoice is voided", () => root(async () => {
  const f = await bookingFixture();
  const payment = await capturedDirectPayment(f);
  await bookDirect(f, payment);
  await ShipmentFunding.updateOne(
    { shipmentDraftId: f.draft._id, status: "COMPLETED" },
    { $set: { source: "BUSINESS_WALLET", sourceReferenceId: null } }
  );
  await ShipmentEvent.create({
    tenantId: rootId,
    shipmentDraftId: f.draft._id,
    status: "SHIPMENT_BOOKED",
    createdBy: staffId,
    eventAt: new Date()
  });

  const preview = await getShipmentCancellationPreview(f.draft._id as mongoose.Types.ObjectId, 0);
  assert.ok(preview.refundableAmountMinor > 0);
  assert.equal(preview.manualRefundSource, true);
  assert.equal(preview.manualRefundRequired, true);

  const directCancellation = {
    shipmentDraftId: f.draft._id as mongoose.Types.ObjectId,
    requestedBy: staffId,
    requesterRole: "admin" as const,
    reason: "Cancel legacy wallet shipment",
    feeBaseMinor: 0,
    feeReason: "",
    carrierReference: ""
  };
  await assert.rejects(
    cancelShipmentDirectly(directCancellation),
    /Record the offline refund payout before completing this cancellation/i
  );
  assert.equal(await ShipmentCancellation.countDocuments({ shipmentDraftId: f.draft._id, status: "REQUESTED" }), 0);

  const result = await cancelShipmentDirectly({
    ...directCancellation,
    refundPayout: { method: "UPI", reference: "UPI-LEGACY-WALLET-001", note: "Paid to customer by UPI" }
  });
  assert.equal(result.completed, true);
  assert.equal(result.cancellation.status, "COMPLETED");
  assert.equal(result.cancellation.paymentRefundStatus, "MANUAL_REFUNDED");
  assert.equal(result.cancellation.paymentRefundAmountMinor, preview.refundableAmountMinor);
  assert.equal(result.cancellation.paymentRefundReference, "UPI-LEGACY-WALLET-001");

  const audit = await AuditLog.collection.findOne({
    action: "SHIPMENT_CANCELLATION_COMPLETED",
    entityId: result.cancellation._id
  });
  assert.equal(audit?.metadata?.manualRefundMethod, "UPI");
  assert.equal(audit?.metadata?.paymentRefundStatus, "MANUAL_REFUNDED");
}));

test("client ledger access is scoped to the account and rejects missing authorization", () => root(async () => {
  const f = await bookingFixture();
  const payment = await capturedDirectPayment(f);
  await bookDirect(f, payment);
  const clientId = new mongoose.Types.ObjectId();

  const denied = responseRecorder();
  const { getClientAccountLedger } = await import("../controllers/prepaid.controller.js");
  await getClientAccountLedger({ user: { _id: clientId }, query: { businessAccountId: String(f.businessAccountId) } } as unknown as Request, denied.response);
  assert.equal(denied.status(), 404);

  await BusinessAccountMember.collection.insertOne({ user: clientId, businessAccount: f.businessAccountId, role: "account_owner", status: "active", tenantId: rootId } as never);
  const allowed = responseRecorder();
  await getClientAccountLedger({ user: { _id: clientId }, query: { businessAccountId: String(f.businessAccountId) } } as unknown as Request, allowed.response);
  assert.equal(allowed.status(), 200);
  assert.equal(allowed.body()?.transactions[0]?.transactionType, "RAZORPAY_BOOKING_PAYMENT");
  assert.equal(allowed.body()?.transactions.some((row: { paymentSource: string }) => row.paymentSource === "WALLET"), false);
}));
