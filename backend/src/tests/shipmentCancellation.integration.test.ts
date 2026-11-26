import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CancellationDocumentCounter } from "../models/cancellationDocumentCounter.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { CreditBillingAdjustment } from "../models/creditBillingAdjustment.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { closeCreditBillingCycle } from "../services/creditBillingCycle.service.js";
import { approveShipmentCancellation, cancelShipmentDirectly } from "../services/shipmentCancellation.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const databaseName = `sl_shipment_cancellation_${Date.now()}`;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([
    AuditLog.init(), BusinessAccount.init(), BusinessCreditAccount.init(), CancellationDocumentCounter.init(),
    CancellationFeeInvoice.init(), CreditBillingAdjustment.init(), CreditBillingStatement.init(),
    CreditLedgerEntry.init(), DpdShipment.init(), PortalNotification.init(), ShipmentCancellation.init(),
    ShipmentCharge.init(), ShipmentCreditNote.init(), ShipmentDraft.init(), ShipmentEvent.init(), ShipmentInvoice.init()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_shipment_cancellation_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function createCancellationFixture(input: {
  originalAmountMinor: number;
  invoiceCreditOutstandingMinor: number;
  accountUnbilledMinor: number;
  accountInvoicedMinor: number;
  billed: boolean;
}) {
  const businessAccountId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const createdBy = new mongoose.Types.ObjectId();
  const taxableValueMinor = Math.round(input.originalAmountMinor / 1.18);
  const totalTaxAmountMinor = input.originalAmountMinor - taxableValueMinor;
  const draft = await ShipmentDraft.create({
    creationSource: "MANUAL",
    businessAccountId,
    branchId,
    consigneeEnteredAddress: {
      companyName: "Cancellation Test Customer",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcelList: [{
      sequence: 1,
      weightKg: 2,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      shipmentContentType: "PARCEL",
      contentsDescription: "Test goods"
    }],
    serviceType: "COURIER",
    serviceCode: "TEST",
    status: "READY_FOR_DPD",
    createdBy
  });
  const dpdShipment = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `CANCEL-${String(draft._id)}`,
    dpdShipmentId: `TEST-${String(draft._id).slice(-8)}`,
    serviceCode: "TEST",
    paymentSource: "BUSINESS_ACCOUNT",
    status: "LABEL_RECEIVED"
  });
  await ShipmentCharge.create({
    businessAccountId,
    branchId,
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    parcelCount: 1,
    paymentSource: "BUSINESS_ACCOUNT",
    customerChargeMinor: input.originalAmountMinor,
    customerCurrency: "INR",
    customerChargeStatus: "COMPLETED",
    pricingSnapshot: { totalAmount: input.originalAmountMinor / 100, gstRate: 0.18, parcels: [] }
  });
  const invoice = await ShipmentInvoice.create({
    invoiceNumber: `SC${String(draft._id).slice(-10)}`,
    financialYear: "26-27",
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    businessAccountId,
    branchId,
    currency: "INR",
    supplier: { legalName: "Swiftline Cargo and Express Logistics Pvt. Ltd.", gstin: "07ABCDE1234F1Z5", address: "Delhi" },
    customer: { companyName: "Cancellation Test Customer", gstin: "29ABCDE1234F1Z5", billingAddress: "London" },
    shipment: { shipmentReference: `REF-${String(draft._id).slice(-6)}` },
    description: "Cancellation integration test shipment",
    taxableValueMinor,
    gstRatePercent: 18,
    taxType: "IGST",
    igstAmountMinor: totalTaxAmountMinor,
    totalTaxAmountMinor,
    totalAmountMinor: input.originalAmountMinor,
    advanceAppliedMinor: Math.max(0, input.originalAmountMinor - input.invoiceCreditOutstandingMinor),
    creditOutstandingMinor: input.invoiceCreditOutstandingMinor,
    paymentStatus: input.invoiceCreditOutstandingMinor === 0 ? "PAID" : "PARTIALLY_PAID",
    pricingSnapshot: { totalAmount: input.originalAmountMinor / 100, gstRate: 0.18, parcels: [] },
    status: "ISSUED",
    createdBy
  });
  const account = await BusinessCreditAccount.create({
    businessAccountId,
    status: "ACTIVE",
    approvedCreditLimitMinor: 1_000_000,
    unbilledCreditMinor: input.accountUnbilledMinor,
    invoicedOutstandingMinor: input.accountInvoicedMinor
  });

  let statement: InstanceType<typeof CreditBillingStatement> | null = null;
  if (input.billed) {
    statement = await CreditBillingStatement.create({
      statementNumber: `CBS/26-27/${String(draft._id).slice(-5)}`,
      businessAccountId,
      creditAccountId: account._id,
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-06-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-01T00:00:00.000Z"),
      issuedAt: new Date("2026-07-01T00:00:00.000Z"),
      dueAt: new Date("2026-07-31T00:00:00.000Z"),
      currency: "INR",
      lines: [{
        sourceType: "SHIPMENT_INVOICE",
        shipmentInvoiceId: invoice._id,
        shipmentDraftId: draft._id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceRevision: 1,
        invoiceIssuedAt: invoice.issuedAt,
        outstandingAmountMinor: input.originalAmountMinor
      }],
      totalAmountMinor: input.originalAmountMinor,
      paidAmountMinor: input.originalAmountMinor - input.invoiceCreditOutstandingMinor,
      outstandingAmountMinor: input.invoiceCreditOutstandingMinor,
      status: input.invoiceCreditOutstandingMinor === 0 ? "PAID" : "PARTIALLY_PAID",
      createdBy
    });
    invoice.billingStatementId = statement._id as mongoose.Types.ObjectId;
    invoice.billedAt = statement.issuedAt;
    await invoice.save();
  }

  await ShipmentEvent.create({
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    status: "SHIPMENT_BOOKED",
    note: "Shipment booked",
    createdBy
  });
  const cancellation = await ShipmentCancellation.create({
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    shipmentInvoiceId: invoice._id,
    businessAccountId,
    branchId,
    requestedBy: createdBy,
    requesterType: "CLIENT",
    requesterRole: "account_owner",
    reason: "Customer no longer requires this shipment.",
    shipmentStatusAtRequest: "SHIPMENT_BOOKED",
    originalAmountMinor: input.originalAmountMinor,
    requestedFeeBaseMinor: 70_000
  });
  return { account, cancellation, draft, invoice, statement, createdBy };
}

async function createBusinessAccountFixture(input: {
  businessAccountId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  companyName: string;
}) {
  return BusinessAccount.create({
    _id: input.businessAccountId,
    accountId: `BA-CANCEL-${String(input.businessAccountId)}`,
    status: "active",
    contact: {
      firstName: "Cancellation",
      lastName: "Test",
      email: `cancellation-${String(input.businessAccountId)}@example.com`,
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: `91${String(input.businessAccountId).slice(-8)}`
    },
    company: {
      registrationCountry: "India",
      companyName: input.companyName,
      operatingCountries: ["India"]
    },
    createdBy: input.createdBy
  });
}

describe("shipment cancellation financial transaction", () => {
  test("rejects an above-standard direct fee without a reason before creating a request", async () => {
    const fixture = await createCancellationFixture({
      originalAmountMinor: 200_000,
      invoiceCreditOutstandingMinor: 200_000,
      accountUnbilledMinor: 200_000,
      accountInvoicedMinor: 0,
      billed: false
    });
    await ShipmentCancellation.deleteOne({ _id: fixture.cancellation._id }).exec();
    await createBusinessAccountFixture({
      businessAccountId: fixture.account.businessAccountId as mongoose.Types.ObjectId,
      createdBy: fixture.createdBy,
      companyName: "Fee Validation Test Ltd"
    });

    await assert.rejects(
      cancelShipmentDirectly({
        shipmentDraftId: fixture.draft._id as mongoose.Types.ObjectId,
        requestedBy: fixture.createdBy,
        requesterRole: "admin",
        reason: "Customer cancelled the shipment before warehouse intake.",
        feeBaseMinor: 80_000,
        feeReason: "",
        carrierReference: ""
      }),
      /Explain the additional carrier or handling fee/
    );
    assert.equal(await ShipmentCancellation.countDocuments({ shipmentDraftId: fixture.draft._id }), 0);
  });

  test("completes an admin direct cancellation once using the existing settlement flow", async () => {
    const fixture = await createCancellationFixture({
      originalAmountMinor: 200_000,
      invoiceCreditOutstandingMinor: 200_000,
      accountUnbilledMinor: 200_000,
      accountInvoicedMinor: 0,
      billed: false
    });
    await ShipmentCancellation.deleteOne({ _id: fixture.cancellation._id }).exec();
    await createBusinessAccountFixture({
      businessAccountId: fixture.account.businessAccountId as mongoose.Types.ObjectId,
      createdBy: fixture.createdBy,
      companyName: "Direct Cancellation Test Ltd"
    });

    await ShipmentEvent.create({
      shipmentDraftId: fixture.draft._id,
      status: "WAREHOUSE_SCAN_IN",
      note: "Received at warehouse",
      createdBy: fixture.createdBy
    });
    const input = {
      shipmentDraftId: fixture.draft._id as mongoose.Types.ObjectId,
      requestedBy: fixture.createdBy,
      requesterRole: "operations" as const,
      reason: "Operations cancelled after warehouse intake.",
      feeBaseMinor: 80_000,
      feeReason: "Carrier cancellation and additional handling charge",
      carrierReference: "CARRIER-CANCEL-DIRECT-1"
    };
    const first = await cancelShipmentDirectly(input);
    const repeated = await cancelShipmentDirectly(input);

    assert.equal(first.completed, true);
    assert.equal(first.cancellation.status, "COMPLETED");
    assert.equal(first.cancellation.requesterRole, "operations");
    assert.equal(first.cancellation.shipmentStatusAtRequest, "WAREHOUSE_SCAN_IN");
    assert.equal(first.cancellation.approvedFeeBaseMinor, 80_000);
    assert.equal(first.cancellation.feeTotalMinor, 94_400);
    assert.equal(first.cancellation.refundableAmountMinor, 105_600);
    assert.equal(repeated.completed, true);
    assert.equal(String(repeated.cancellation._id), String(first.cancellation._id));
    assert.equal(await ShipmentCancellation.countDocuments({ shipmentDraftId: fixture.draft._id }), 1);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: fixture.draft._id, status: "SHIPMENT_CANCELLED" }), 1);
    assert.equal(await ShipmentCreditNote.countDocuments({ cancellationId: first.cancellation._id }), 1);
    assert.equal(await AuditLog.countDocuments({
      action: "SHIPMENT_CANCELLATION_COMPLETED",
      entityId: first.cancellation._id
    }), 1);
  });

  test("cancels legacy Swiftline credit bookings without changing any financial records", async () => {
    const context = { tenantId: new mongoose.Types.ObjectId(), kind: "SWIFTLINE" as const };
    const fixture = await runWithTenantContext(context, () => createCancellationFixture({
      originalAmountMinor: 200_000,
      invoiceCreditOutstandingMinor: 200_000,
      accountUnbilledMinor: 200_000,
      accountInvoicedMinor: 0,
      billed: false
    }));

    await runWithTenantContext(context, async () => {
      await createBusinessAccountFixture({
        businessAccountId: fixture.account.businessAccountId as mongoose.Types.ObjectId,
        createdBy: fixture.createdBy,
        companyName: "Legacy Cancellation Test Ltd"
      });

      const before = {
        account: await BusinessCreditAccount.findById(fixture.account._id).lean().orFail().exec(),
        invoice: await ShipmentInvoice.findById(fixture.invoice._id).lean().orFail().exec(),
        charge: await ShipmentCharge.findOne({ shipmentDraftId: fixture.draft._id }).lean().orFail().exec()
      };
      await ShipmentCancellation.deleteOne({ _id: fixture.cancellation._id }).exec();
      const result = await cancelShipmentDirectly({
        shipmentDraftId: fixture.draft._id as mongoose.Types.ObjectId,
        requestedBy: fixture.createdBy,
        requesterRole: "operations",
        reason: "Operations cancelled this legacy credit shipment.",
        feeBaseMinor: 70_000,
        feeReason: "",
        carrierReference: "LEGACY-CARRIER-REF"
      });

      const [accountAfter, invoiceAfter, chargeAfter, cancellation] = await Promise.all([
        BusinessCreditAccount.findById(fixture.account._id).lean().orFail().exec(),
        ShipmentInvoice.findById(fixture.invoice._id).lean().orFail().exec(),
        ShipmentCharge.findOne({ shipmentDraftId: fixture.draft._id }).lean().orFail().exec(),
        ShipmentCancellation.findById(result.cancellation._id).orFail().exec()
      ]);
      assert.equal(result.completed, true);
      assert.equal(cancellation.financialTreatment, "LEGACY_CREDIT_NO_SETTLEMENT");
      assert.equal(cancellation.refundableAmountMinor, 0);
      assert.equal(cancellation.feeTotalMinor, 0);
      assert.equal(accountAfter.unbilledCreditMinor, before.account.unbilledCreditMinor);
      assert.equal(accountAfter.invoicedOutstandingMinor, before.account.invoicedOutstandingMinor);
      assert.equal(invoiceAfter.paymentStatus, before.invoice.paymentStatus);
      assert.equal(invoiceAfter.status, before.invoice.status);
      assert.equal(chargeAfter.customerChargeStatus, before.charge.customerChargeStatus);
      assert.equal(chargeAfter.customerChargeMinor, before.charge.customerChargeMinor);
      assert.equal(await ShipmentCreditNote.countDocuments({ cancellationId: cancellation._id }), 0);
      assert.equal(await CancellationFeeInvoice.countDocuments({ cancellationId: cancellation._id }), 0);
      assert.equal(await CreditLedgerEntry.countDocuments({ businessAccountId: fixture.account.businessAccountId }), 0);
      assert.equal(await ShipmentEvent.countDocuments({
        shipmentDraftId: fixture.draft._id,
        status: "SHIPMENT_CANCELLED"
      }), 1);
    });
  });

  test("replaces an unbilled shipment charge with the cancellation fee", async () => {
    const fixture = await createCancellationFixture({
      originalAmountMinor: 200_000,
      invoiceCreditOutstandingMinor: 200_000,
      accountUnbilledMinor: 200_000,
      accountInvoicedMinor: 0,
      billed: false
    });

    await approveShipmentCancellation({
      cancellationId: fixture.cancellation._id as mongoose.Types.ObjectId,
      reviewedBy: fixture.createdBy,
      feeBaseMinor: 70_000,
      feeReason: "",
      carrierConfirmed: true,
      settlementConfirmed: true,
      carrierReference: "CARRIER-CANCEL-1",
      reviewNote: "Cancellation confirmed."
    });

    const [account, invoice, feeInvoice, creditNote, cancellation] = await Promise.all([
      BusinessCreditAccount.findById(fixture.account._id).lean().exec(),
      ShipmentInvoice.findById(fixture.invoice._id).lean().exec(),
      CancellationFeeInvoice.findOne({ cancellationId: fixture.cancellation._id }).lean().exec(),
      ShipmentCreditNote.findOne({ cancellationId: fixture.cancellation._id }).lean().exec(),
      ShipmentCancellation.findById(fixture.cancellation._id).lean().exec()
    ]);
    assert.equal(account?.unbilledCreditMinor, 82_600);
    assert.equal(account?.customerAdvanceBalanceMinor, 0);
    assert.equal(invoice?.paymentStatus, "VOID");
    assert.equal(invoice?.creditOutstandingMinor, 0);
    assert.equal(feeInvoice?.creditOutstandingMinor, 82_600);
    assert.equal(feeInvoice?.billingStatementId, null);
    assert.equal(creditNote?.totalAmountMinor, 200_000);
    assert.equal(cancellation?.settlement?.netCreditReleasedMinor, 117_400);
    assert.equal(await ShipmentEvent.countDocuments({ shipmentDraftId: fixture.draft._id, status: "SHIPMENT_CANCELLED" }), 1);
  });

  test("settles the original statement and carries only the unpaid fee into the next cycle", async () => {
    const fixture = await createCancellationFixture({
      originalAmountMinor: 200_000,
      invoiceCreditOutstandingMinor: 150_000,
      accountUnbilledMinor: 0,
      accountInvoicedMinor: 150_000,
      billed: true
    });

    await approveShipmentCancellation({
      cancellationId: fixture.cancellation._id as mongoose.Types.ObjectId,
      reviewedBy: fixture.createdBy,
      feeBaseMinor: 70_000,
      feeReason: "",
      carrierConfirmed: true,
      settlementConfirmed: true,
      carrierReference: "CARRIER-CANCEL-2",
      reviewNote: "Cancellation confirmed."
    });

    const [account, statement, feeInvoice, adjustment] = await Promise.all([
      BusinessCreditAccount.findById(fixture.account._id).lean().exec(),
      CreditBillingStatement.findById(fixture.statement?._id).lean().exec(),
      CancellationFeeInvoice.findOne({ cancellationId: fixture.cancellation._id }).lean().exec(),
      CreditBillingAdjustment.findOne({ sourceId: fixture.cancellation._id }).lean().exec()
    ]);
    assert.equal(account?.invoicedOutstandingMinor, 0);
    assert.equal(account?.unbilledCreditMinor, 32_600);
    assert.equal(statement?.totalAmountMinor, 200_000);
    assert.equal(statement?.lines[0]?.outstandingAmountMinor, 200_000);
    assert.equal(statement?.creditAdjustmentMinor, 150_000);
    assert.equal(statement?.outstandingAmountMinor, 0);
    assert.equal(statement?.status, "PAID");
    assert.equal(feeInvoice?.advanceAppliedMinor, 50_000);
    assert.equal(feeInvoice?.creditOutstandingMinor, 32_600);
    assert.equal(feeInvoice?.billingStatementId, null);
    assert.equal(adjustment?.amountMinor, -150_000);
    assert.equal(adjustment?.affectsAmountDue, false);

    assert.ok(feeInvoice?.issuedAt);
    const nextCycleClosingDate = new Date(feeInvoice.issuedAt);
    nextCycleClosingDate.setUTCMonth(nextCycleClosingDate.getUTCMonth() + 1, 2);
    nextCycleClosingDate.setUTCHours(12, 0, 0, 0);
    const nextCycle = await closeCreditBillingCycle({
      businessAccountId: fixture.account.businessAccountId,
      closingDate: nextCycleClosingDate,
      createdBy: fixture.createdBy
    });
    assert.equal(nextCycle.created, true);
    assert.equal(nextCycle.statement?.totalAmountMinor, 32_600);
    assert.equal(nextCycle.statement?.lines.length, 1);
    assert.equal(nextCycle.statement?.lines[0]?.sourceType, "CANCELLATION_FEE_INVOICE");
    assert.equal(nextCycle.statement?.lines[0]?.invoiceNumber, feeInvoice.invoiceNumber);
  });
});
