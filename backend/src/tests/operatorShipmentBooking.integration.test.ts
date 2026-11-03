import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PassThrough } from "node:stream";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { createOperatorShipment } from "../controllers/operatorShipment.controller.js";
import { approveOperatorShipmentAmendment, createOperatorShipmentAmendment } from "../controllers/operatorShipmentAmendment.controller.js";
import {
  approveOperatorShipmentCancellation,
  requestOperatorShipmentCancellation
} from "../controllers/operatorShipmentCancellation.controller.js";
import { createAdminShipmentManifest } from "../controllers/shipmentManifest.controller.js";
import { getAdminShipmentDetails } from "../controllers/dpdShipment.controller.js";
import { downloadShipmentInvoicePdf, getShipmentInvoice } from "../controllers/shipmentInvoice.controller.js";
import {
  downloadCustomsInvoicePdf,
  downloadCustomsInvoiceWorkbook,
  getCustomsInvoice
} from "../controllers/customsInvoice.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BalanceReservation } from "../models/balanceReservation.model.js";
import { BookingPause } from "../models/bookingPause.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { OperatorShipmentTrackingCounter } from "../models/operatorShipmentTrackingCounter.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceCounter } from "../models/shipmentInvoiceCounter.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentProfitability } from "../models/shipmentProfitability.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { localStorageDriver } from "../services/storage/localDriver.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import { buildPricingInputFromDraft, calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";

const databasePrefix = "sl_operator_booking_";
const databaseName = `${databasePrefix}${Date.now()}`;
const generatedKeys = new Set<string>();
const realFetch = globalThis.fetch.bind(globalThis);
const carrierCalls: string[] = [];
const previousStorageDriver = env.STORAGE_DRIVER;
let tenant: InstanceType<typeof Tenant> | null = null;

const consignor = {
  companyName: "Delhi Exports Pvt Ltd",
  contactName: "Ravi Sharma",
  email: "ravi@delhiexports.example",
  mobileCountryCode: "+91",
  mobileNumber: "9876543210",
  aadhaarNumber: "234567890124",
  countryCode: "IN",
  countryName: "India",
  postcode: "110001",
  addressLine1: "12 Connaught Place",
  townOrCity: "New Delhi",
  county: "Delhi"
};

function kycDocument(type: "aadhaar" | "pan") {
  return {
    type,
    documentLabel: type === "aadhaar" ? "Aadhaar Card" : "PAN Card",
    originalName: `${type}.pdf`,
    storageKey: `shipments/operator-booking-test/kyc/${type}.pdf`,
    mimeType: "application/pdf",
    size: 1024,
    uploadedAt: new Date()
  };
}

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const headers: Record<string, string> = {};
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    send(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return {
    response,
    status: () => statusCode,
    body: () => body,
    header: (name: string) => headers[name.toLowerCase()]
  };
}

function streamingResponseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, string | number | readonly string[]>();
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  const response = stream as unknown as Response;
  response.status = (code: number) => {
    statusCode = code;
    return response;
  };
  response.json = (value: unknown) => {
    body = value;
    stream.end();
    return response;
  };
  response.setHeader = (name, value) => {
    headers.set(name.toLowerCase(), value);
    return response;
  };
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    response,
    status: () => statusCode,
    body: () => body,
    header: (name: string) => headers.get(name.toLowerCase()),
    bytes: () => Buffer.concat(chunks),
    complete
  };
}

before(async () => {
  env.STORAGE_DRIVER = "local";
  globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const normalizedUrl = url.toLowerCase();
    const configuredAlsBase = (env.ALS_API_BASE_URL ?? "").trim().replace(/\/+$/, "").toLowerCase();
    if (
      normalizedUrl.includes("airportlinkservices")
      || (configuredAlsBase !== "" && normalizedUrl.startsWith(configuredAlsBase))
      || /:\/\/[^/]*dpd/i.test(normalizedUrl)
    ) {
      carrierCalls.push(url);
      throw new Error("Operator internal-label booking must not call a carrier.");
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;

  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    family: 4,
    retryWrites: false,
    autoIndex: false,
    autoCreate: false
  });
  assert.equal(mongoose.connection.name, databaseName);
});

after(async () => {
  globalThis.fetch = realFetch;
  env.STORAGE_DRIVER = previousStorageDriver;

  try {
    if (mongoose.connection.readyState !== 0) {
      assert.equal(mongoose.connection.name, databaseName, "cleanup may only drop this test's isolated database");
      try {
        if (tenant) {
          await runWithTenantContext({ tenantId: tenant._id, kind: "OPERATOR" }, async () => {
            const labels = await LabelDocument.find({}).select("storageKey").lean().exec();
            labels.forEach((label) => generatedKeys.add(label.storageKey));
          });
        }
      } finally {
        for (const key of generatedKeys) {
          await localStorageDriver.deleteObject(key).catch(() => undefined);
        }
        assert.ok(mongoose.connection.name.startsWith(databasePrefix));
        await mongoose.connection.dropDatabase();
      }
    }
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }

  assert.deepEqual(carrierCalls, [], "no operator booking request may call a carrier");
});

test("operator booking, amendment, reviewed cancellation and manifest remain tenant-local", async () => {
  const userId = new mongoose.Types.ObjectId();

  const operatorTenant = await Tenant.create({
    kind: "OPERATOR",
    status: "ACTIVE",
    companyName: "Operator Booking Test",
    slug: "operator-booking-test",
    createdBy: userId
  });
  tenant = operatorTenant;

  const context = {
    tenantId: operatorTenant._id as mongoose.Types.ObjectId,
    kind: "OPERATOR" as const
  };

  const { draft, account, ownerId, unusedBookerId, swiftlineAdminId } = await runWithTenantContext(context, async () => {
    const branch = await Branch.create({
      name: "Operator Booking Test Branch",
      code: `OBK-${Date.now()}`,
      labelCode: "OBK",
      status: "ACTIVE",
      gstin: "09BIQPK8904E1ZW",
      invoiceSacCode: "996812",
      baseCurrency: "INR",
      address: {
        countryCode: "IN",
        countryName: "India",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110001",
        address: "Operator Test Branch"
      },
      contact: { email: "branch@example.test", phone: "+91 9999999999" },
      operations: { supportedServices: [], shipmentCoverage: ["INTERNATIONAL"], operatingCountries: ["GB"], workingDays: [] },
      createdBy: userId
    });

    const suffix = String(Date.now());
    const account = await BusinessAccount.create({
      accountId: `OP-BOOK-${suffix}`,
      status: "active",
      rateCardBand: null,
      privateRateCardVersion: 1,
      privateRateCardReady: true,
      contact: {
        title: "mr.", firstName: "Operator", lastName: "Client",
        email: `operator-client-${suffix}@example.test`, mobileType: "mobile",
        countryCode: "+91", mobileNumber: `9${suffix.slice(-9)}`, jobTitle: "Owner",
        department: "Operations", shipmentTypes: ["international_courier"]
      },
      company: {
        registrationCountry: "India", registrationId: `OPBOOK${suffix}`, companyType: "pvt_ltd",
        companyName: "Operator Booking Client", registeredAddress: "Client Address",
        city: "Delhi", stateOrProvince: "Delhi", postalCode: "110002",
        addressCountry: "India", gstin: "09BIQPK8904E1ZD", operatingCountries: ["United Kingdom"],
        industry: "Testing", monthlyShipmentVolume: "1-10",
        requestedCreditLimit: { currency: "INR", amount: 0 }
      },
      kycReview: { overallStatus: "verified", checks: {} },
      assignedBranch: branch._id,
      createdBy: userId
    });

    const suffixForUsers = String(Date.now());
    const owner = await User.create({ email: `operator-booking-owner-${suffixForUsers}@example.test`, role: "client", userStatus: "active" });
    const unusedBooker = await User.create({ email: `operator-booking-user-${suffixForUsers}@example.test`, role: "client", userStatus: "active" });
    const swiftlineAdmin = await User.create({ email: `swiftline-booking-admin-${suffixForUsers}@example.test`, role: "admin", userStatus: "active" });
    await User.create({ _id: userId, email: `operator-booking-staff-${suffixForUsers}@example.test`, role: "admin", userStatus: "active" });
    await TenantMembership.create([
      { tenantId: operatorTenant._id, userId, role: "OPERATOR_ADMIN", status: "ACTIVE" },
      { tenantId: operatorTenant._id, userId: owner._id, role: "CLIENT", status: "ACTIVE" },
      { tenantId: operatorTenant._id, userId: unusedBooker._id, role: "CLIENT", status: "ACTIVE" }
    ]);
    await BusinessAccountMember.create([
      { businessAccount: account._id, user: owner._id, role: "account_owner", status: "active", invitedBy: userId },
      { businessAccount: account._id, user: unusedBooker._id, role: "booking_user", status: "active", invitedBy: userId }
    ]);

    await CountryRateCard.create({
      businessAccountId: account._id,
      countryCode: "GB",
      countryName: "United Kingdom",
      service: "COURIER",
      fromKg: 0.01,
      toKg: 25,
      chargesPerKg: 420,
      maxBoxKg: 25,
      gstTreatment: "INCLUDED",
      gstRatePercent: 18,
      gstApplyToAllRates: true,
      createdBy: userId
    });

    await BusinessCreditAccount.create({
      businessAccountId: account._id,
      status: "ACTIVE",
      approvedCreditLimitMinor: 2_000_000,
      paymentTermsDays: 30,
      billingCycle: "MONTHLY"
    });

    const draft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: account._id,
      branchId: branch._id,
      sender: { name: branch.name, code: branch.code },
      consignorAddress: consignor,
      kycDocuments: { aadhaar: kycDocument("aadhaar"), pan: kycDocument("pan") },
      consigneeEnteredAddress: {
        companyName: "Operator Client Receiver",
        contactName: "Asha Patel",
        email: "asha@example.test",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London",
        county: "Greater London"
      },
      consigneeValidatedAddress: {
        companyName: "Operator Client Receiver",
        contactName: "Asha Patel",
        email: "asha@example.test",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London",
        county: "Greater London"
      },
      addressValidationStatus: "VALIDATED",
      addressValidationResult: { outcome: "VALID" },
      parcelList: [{
        sequence: 1,
        weightKg: 5,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
        shipmentContentType: "PARCEL",
        items: [{ description: "Books", hsnCode: "49019900", unitType: "Pkt", quantity: 1, unitRate: 500 }],
        contentsDescription: "Books",
        shipmentReference1: "OP-BOOK-BOX-1"
      }],
      serviceType: "COURIER",
      status: "READY_FOR_DPD",
      bookingState: "EDITABLE",
      createdBy: userId
    });

    return { draft, account, ownerId: owner._id, unusedBookerId: unusedBooker._id, swiftlineAdminId: swiftlineAdmin._id };
  });

  const firstAttempt = await runWithTenantContext(context, async () => {
    const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(draft));
    const request = {
      params: { id: String(draft._id) },
      body: { acceptedPricingHash: buildPricingHash(pricing) },
      user: { _id: userId },
      operatorContext: {
        tenantId: context.tenantId,
        slug: "operator-booking-test",
        role: "OPERATOR_ADMIN",
        assignedBranches: [],
        accessMode: "MEMBER"
      }
    } as unknown as Request;
    const recorded = responseRecorder();
    await createOperatorShipment(request, recorded.response);
    return recorded;
  });

  assert.equal(firstAttempt.status(), 201, JSON.stringify(firstAttempt.body()));
  const firstBody = firstAttempt.body() as {
    success: boolean;
    reused: boolean;
    shipment: { id: string; shipmentDraftId: string; trackingNumber: string; status: string };
    labels: Array<{ id: string; labelType: string }>;
    taxInvoice: { id: string; invoiceNumber: string; paymentStatus: string; totalAmountMinor: number };
  };
  assert.equal(firstBody.success, true);
  assert.equal(firstBody.reused, false);
  assert.equal(firstBody.labels.length, 1);
  const [responseLabel] = firstBody.labels;
  assert.ok(responseLabel);
  assert.equal(responseLabel.labelType, "INTERNAL");
  assert.match(firstBody.shipment.trackingNumber, /^OBT[A-Z]{3}\d{6}\d{3}$/);

  const booking = await runWithTenantContext(context, () => DpdShipment.findById(firstBody.shipment.id).orFail().exec());
  const labels = await runWithTenantContext(context, () => LabelDocument.find({ dpdShipmentId: booking._id }).lean().exec());
  const invoice = await runWithTenantContext(context, () => ShipmentInvoice.findById(firstBody.taxInvoice.id).orFail().exec());
  const charge = await runWithTenantContext(context, () => ShipmentCharge.findOne({ shipmentDraftId: draft._id }).orFail().exec());
  const reservation = await runWithTenantContext(context, () => BalanceReservation.findOne({ shipmentDraftId: draft._id }).orFail().exec());
  const creditAccount = await runWithTenantContext(context, () => BusinessCreditAccount.findOne({ businessAccountId: account._id }).orFail().exec());
  const ledgerEntries = await runWithTenantContext(context, () => CreditLedgerEntry.find({ businessAccountId: account._id }).lean().exec());
  const events = await runWithTenantContext(context, () => ShipmentEvent.find({ shipmentDraftId: draft._id, status: "SHIPMENT_BOOKED" }).lean().exec());

  labels.forEach((label) => generatedKeys.add(label.storageKey));
  const [storedLabel] = labels;
  const [ledgerEntry] = ledgerEntries;
  const [bookingEvent] = events;
  assert.ok(storedLabel);
  assert.ok(ledgerEntry);
  assert.ok(bookingEvent);
  assert.equal(booking.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(booking.serviceCode, "INTERNAL SHIPMENT");
  assert.equal(booking.status, "LABEL_RECEIVED");
  assert.equal(booking.dpdShipmentId, "");
  assert.equal(labels.length, 1);
  assert.equal(storedLabel.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(storedLabel.labelType, "INTERNAL");
  assert.equal(invoice.tenantId?.toString(), String(operatorTenant._id));
  assert.ok(invoice.invoiceNumber.startsWith("OP/"));
  assert.equal(invoice.paymentStatus, "UNPAID");
  assert.ok(invoice.creditOutstandingMinor > 0);
  assert.equal(invoice.chargeFinalizedAt?.getTime(), booking.createdAt.getTime());
  assert.equal(charge.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(charge.paymentSource, "BUSINESS_ACCOUNT");
  assert.equal(charge.customerChargeStatus, "COMPLETED");
  assert.equal(reservation.status, "CONVERTED");
  assert.equal(creditAccount.reservedCreditMinor, 0);
  assert.equal(creditAccount.unbilledCreditMinor, invoice.creditOutstandingMinor);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntry.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(ledgerEntry.type, "BOOKING_CONVERTED");
  assert.equal(events.length, 1);
  assert.equal(bookingEvent.tenantId?.toString(), String(operatorTenant._id));
  const bookingNotices = await runWithTenantContext(context, () => PortalNotification.find({
    type: "SHIPMENT_BOOKED", "metadata.shipmentDraftId": draft._id
  }).lean().exec());
  assert.deepEqual(new Set(bookingNotices.map((notice) => String(notice.recipientUserId))), new Set([String(userId), String(ownerId)]));
  assert.ok(bookingNotices.every((notice) => notice.href === `/portal/operator-booking-test/shipments/${String(draft._id)}`));
  assert.ok(bookingNotices.every((notice) => String(notice.tenantId) === String(operatorTenant._id)));
  const bookingEmails = await runWithTenantContext(context, () => EmailOutbox.find({
    notificationType: "SHIPMENT_BOOKED", "payload.shipmentDraftId": draft._id
  }).lean().exec());
  assert.deepEqual(new Set(bookingEmails.map((email) => String(email.recipientUserId))), new Set([String(userId), String(ownerId)]));
  assert.ok(bookingEmails.every((email) => String(email.recipientUserId) !== String(swiftlineAdminId)));
  assert.ok(bookingEmails.every((email) => String(email.recipientUserId) !== String(unusedBookerId)));
  assert.equal(bookingEmails.find((email) => email.templateKey === "OPERATOR_SHIPMENT_BOOKED_CLIENT")?.attachmentRefs.length, 2);
  assert.equal(bookingEmails.find((email) => email.templateKey === "OPERATOR_SHIPMENT_BOOKED_STAFF")?.attachmentRefs.length, 0);

  const operatorRequestContext = {
    tenantId: context.tenantId,
    kind: "OPERATOR" as const,
    slug: "operator-booking-test",
    role: "OPERATOR_ADMIN" as const,
    assignedBranches: [],
    accessMode: "MEMBER" as const
  };
  const detailRequest = {
    params: { draftId: String(draft._id) },
    user: { _id: userId, role: "admin", assignedBranches: [] },
    operatorContext: operatorRequestContext
  } as unknown as Request;
  const operatorDetails = await runWithTenantContext(context, async () => {
    const recorded = responseRecorder();
    await getAdminShipmentDetails(detailRequest, recorded.response);
    return recorded;
  });
  assert.equal(operatorDetails.status(), 200, JSON.stringify(operatorDetails.body()));
  const operatorDetailDraft = (operatorDetails.body() as {
    shipment: { shipmentDraft: Record<string, any> }
  }).shipment.shipmentDraft;
  assert.equal(operatorDetailDraft.consignee.contactName, "ASHA PATEL");
  assert.equal(operatorDetailDraft.consignor.contactName, String(consignor.contactName).toUpperCase());
  assert.equal(operatorDetailDraft.consignor.aadhaarNumber, "XXXX XXXX 0124");
  assert.equal(operatorDetailDraft.parcelList[0].items[0].description, "BOOKS");
  assert.equal(operatorDetailDraft.parcelList[0].weightKg, 5);
  assert.equal(operatorDetailDraft.kycDocuments.aadhaar.storageKey, undefined);
  assert.equal(operatorDetailDraft.parcelList[0].kycDocuments?.aadhaar?.storageKey, undefined);

  const invoiceRequest = {
    params: { draftId: String(draft._id) },
    query: {},
    user: { _id: userId },
    operatorContext: operatorRequestContext
  } as unknown as Request;
  const taxInvoiceView = await runWithTenantContext(context, async () => {
    const recorded = responseRecorder();
    await getShipmentInvoice(invoiceRequest, recorded.response);
    return recorded;
  });
  assert.equal(taxInvoiceView.status(), 200, JSON.stringify(taxInvoiceView.body()));

  const taxInvoicePdf = streamingResponseRecorder();
  await runWithTenantContext(context, () => downloadShipmentInvoicePdf(invoiceRequest, taxInvoicePdf.response));
  await taxInvoicePdf.complete;
  assert.equal(taxInvoicePdf.status(), 200);
  assert.equal(taxInvoicePdf.header("content-type"), "application/pdf");
  assert.ok(taxInvoicePdf.bytes().subarray(0, 4).equals(Buffer.from("%PDF")));

  const shipmentInvoiceView = await runWithTenantContext(context, async () => {
    const recorded = responseRecorder();
    await getCustomsInvoice(invoiceRequest, recorded.response);
    return recorded;
  });
  assert.equal(shipmentInvoiceView.status(), 200, JSON.stringify(shipmentInvoiceView.body()));
  const customsInvoice = (shipmentInvoiceView.body() as { invoice: { boxes: Array<{ items: Array<{ description: string }> }> } }).invoice;
  assert.equal(customsInvoice.boxes[0]?.items[0]?.description, "BOOKS");

  const shipmentInvoicePdf = await runWithTenantContext(context, async () => {
    const recorded = responseRecorder();
    await downloadCustomsInvoicePdf(invoiceRequest, recorded.response);
    return recorded;
  });
  assert.equal(shipmentInvoicePdf.status(), 200);
  assert.equal(shipmentInvoicePdf.header("content-type"), "application/pdf");
  assert.ok(Buffer.isBuffer(shipmentInvoicePdf.body()));

  const shipmentInvoiceWorkbook = await runWithTenantContext(context, async () => {
    const recorded = responseRecorder();
    await downloadCustomsInvoiceWorkbook(invoiceRequest, recorded.response);
    return recorded;
  });
  assert.equal(shipmentInvoiceWorkbook.status(), 200);
  assert.equal(shipmentInvoiceWorkbook.header("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(Buffer.isBuffer(shipmentInvoiceWorkbook.body()));

  const retry = await runWithTenantContext(context, async () => {
    const request = {
      params: { id: String(draft._id) },
      body: { acceptedPricingHash: "retry-is-reused-before-repricing" },
      user: { _id: userId },
      operatorContext: {
        tenantId: context.tenantId,
        slug: "operator-booking-test",
        role: "OPERATOR_ADMIN",
        assignedBranches: [],
        accessMode: "MEMBER"
      }
    } as unknown as Request;
    const recorded = responseRecorder();
    await createOperatorShipment(request, recorded.response);
    return recorded;
  });

  assert.equal(retry.status(), 200, JSON.stringify(retry.body()));
  assert.equal((retry.body() as { reused: boolean }).reused, true);
  const [bookingCount, invoiceCount, eventCount, chargeCount, ledgerCount] = await Promise.all([
    runWithTenantContext(context, () => DpdShipment.countDocuments({ shipmentDraftId: draft._id })),
    runWithTenantContext(context, () => ShipmentInvoice.countDocuments({ shipmentDraftId: draft._id })),
    runWithTenantContext(context, () => ShipmentEvent.countDocuments({ shipmentDraftId: draft._id, status: "SHIPMENT_BOOKED" })),
    runWithTenantContext(context, () => ShipmentCharge.countDocuments({ shipmentDraftId: draft._id })),
    runWithTenantContext(context, () => CreditLedgerEntry.countDocuments({ businessAccountId: account._id }))
  ]);
  assert.deepEqual([bookingCount, invoiceCount, eventCount, chargeCount, ledgerCount], [1, 1, 1, 1, 1]);
  assert.equal(await runWithTenantContext(context, () => PortalNotification.countDocuments({
    type: "SHIPMENT_BOOKED", "metadata.shipmentDraftId": draft._id
  })), 2, "reused booking must not create duplicate notices");

  const amendmentRequest = await runWithTenantContext(context, async () => {
    const request = {
      params: { id: String(draft._id) },
      body: {
        reason: "Correct the delivery address",
        changes: { consigneeEnteredAddress: { addressLine1: "20 Downing Street" } }
      },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await createOperatorShipmentAmendment(request, recorded.response);
    return recorded;
  });
  assert.equal(amendmentRequest.status(), 200, JSON.stringify(amendmentRequest.body()));
  const amendmentId = (amendmentRequest.body() as { amendment: { _id: mongoose.Types.ObjectId } }).amendment._id;

  const amendmentApproval = await runWithTenantContext(context, async () => {
    const request = {
      params: { id: String(amendmentId) },
      body: { note: "Address correction reviewed" },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await approveOperatorShipmentAmendment(request, recorded.response);
    return recorded;
  });
  assert.equal(amendmentApproval.status(), 200, JSON.stringify(amendmentApproval.body()));
  const appliedAmendment = await runWithTenantContext(context, () => ShipmentAmendment.findById(amendmentId).orFail().exec());
  const amendedDraft = await runWithTenantContext(context, () => ShipmentDraft.findById(draft._id).orFail().exec());
  assert.equal(appliedAmendment.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(appliedAmendment.status, "APPROVED");
  assert.equal(amendedDraft.consigneeEnteredAddress?.addressLine1, "20 DOWNING STREET");

  const cancellationRequest = await runWithTenantContext(context, async () => {
    const request = {
      params: { draftId: String(draft._id) },
      body: { reason: "Customer no longer requires this shipment" },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await requestOperatorShipmentCancellation(request, recorded.response);
    return recorded;
  });
  assert.equal(cancellationRequest.status(), 201, JSON.stringify(cancellationRequest.body()));
  const cancellationId = (cancellationRequest.body() as { cancellation: { id: string } }).cancellation.id;

  const cancellationApproval = await runWithTenantContext(context, async () => {
    const request = {
      params: { id: cancellationId },
      body: { feeBaseMinor: 0, feeReason: "", settlementConfirmed: true, reviewNote: "Approved with no fee" },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await approveOperatorShipmentCancellation(request, recorded.response);
    return recorded;
  });
  assert.equal(cancellationApproval.status(), 200, JSON.stringify(cancellationApproval.body()));
  const cancellation = await runWithTenantContext(context, () => ShipmentCancellation.findById(cancellationId).orFail().exec());
  const creditNote = await runWithTenantContext(context, () => ShipmentCreditNote.findOne({ cancellationId }).orFail().exec());
  const cancelledInvoice = await runWithTenantContext(context, () => ShipmentInvoice.findOne({ shipmentDraftId: draft._id, paymentStatus: "VOID" }).orFail().exec());
  const reversedCharge = await runWithTenantContext(context, () => ShipmentCharge.findOne({ shipmentDraftId: draft._id }).orFail().exec());
  const cancellationEvent = await runWithTenantContext(context, () => ShipmentEvent.findOne({ shipmentDraftId: draft._id, status: "SHIPMENT_CANCELLED" }).orFail().exec());
  const cancelledCreditAccount = await runWithTenantContext(context, () => BusinessCreditAccount.findOne({ businessAccountId: account._id }).orFail().exec());
  assert.equal(cancellation.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(cancellation.status, "COMPLETED");
  assert.equal(cancellation.approvedFeeBaseMinor, 0);
  assert.equal(cancellation.carrierConfirmationRequired, false);
  assert.equal(creditNote.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(cancelledInvoice.paymentStatus, "VOID");
  assert.equal(reversedCharge.customerChargeStatus, "REVERSED");
  assert.equal(cancellationEvent.tenantId?.toString(), String(operatorTenant._id));
  assert.equal(cancelledCreditAccount.unbilledCreditMinor, 0);
  assert.equal(await runWithTenantContext(context, () => CancellationFeeInvoice.countDocuments({ cancellationId })), 0);

  const secondDraftData = draft.toObject();
  secondDraftData._id = new mongoose.Types.ObjectId();
  secondDraftData.parcelList = secondDraftData.parcelList.map((parcel, index) => ({
    ...parcel,
    shipmentReference1: `OP-BOOK-SECOND-BOX-${index + 1}`
  }));
  const secondDraft = await runWithTenantContext(context, () => ShipmentDraft.create(secondDraftData));
  const secondBookingAttempt = await runWithTenantContext(context, async () => {
    const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(secondDraft));
    const request = {
      params: { id: String(secondDraft._id) },
      body: { acceptedPricingHash: buildPricingHash(pricing) },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await createOperatorShipment(request, recorded.response);
    return recorded;
  });
  assert.equal(secondBookingAttempt.status(), 201, JSON.stringify(secondBookingAttempt.body()));

  const manifestCreation = await runWithTenantContext(context, async () => {
    const request = {
      params: {},
      body: {
        currentShipmentDraftId: String(secondDraft._id),
        lines: [{ shipmentDraftId: String(secondDraft._id), bagNumber: "OP-BAG-1" }]
      },
      user: { _id: userId },
      operatorContext: operatorRequestContext
    } as unknown as Request;
    const recorded = responseRecorder();
    await createAdminShipmentManifest(request, recorded.response);
    return recorded;
  });
  assert.equal(manifestCreation.status(), 201, JSON.stringify(manifestCreation.body()));
  const manifestId = (manifestCreation.body() as { manifest: { id: string } }).manifest.id;
  const manifest = await runWithTenantContext(context, () => ShipmentManifest.findById(manifestId).orFail().exec());
  assert.equal(manifest.tenantId?.toString(), String(operatorTenant._id));
  assert.deepEqual(manifest.shipmentDraftIds.map(String), [String(secondDraft._id)]);
  assert.equal(manifest.actorRole, "admin");
  assert.equal(manifest.manifestType, "ACCOUNT");

  assert.deepEqual(carrierCalls, []);
});
