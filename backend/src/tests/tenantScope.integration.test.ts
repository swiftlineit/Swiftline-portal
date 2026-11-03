import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { PassThrough } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CancellationDocumentCounter } from "../models/cancellationDocumentCounter.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { IdempotencyKey } from "../models/idempotencyKey.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceCounter } from "../models/shipmentInvoiceCounter.model.js";
import { ShipmentManifestCounter } from "../models/shipmentManifestCounter.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { tenantOwnedSchemaPlugin, TenantScopeError } from "../models/plugins/tenantOwnedSchema.plugin.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { downloadDpdLabelWithToken } from "../controllers/dpdShipment.controller.js";
import { listOperatorCreditAccounts } from "../controllers/operatorCredit.controller.js";
import { downloadShipmentInvoicePdf, getShipmentInvoice } from "../controllers/shipmentInvoice.controller.js";
import { requireOperatorBusinessAccountAccess } from "../middleware/operatorBusinessAccountAccess.middleware.js";
import { requireOperatorContext } from "../middleware/operatorContext.middleware.js";
import { handleSesWebhook } from "../controllers/sesWebhook.controller.js";
import { downloadShipmentKycDocument } from "../controllers/shipmentKyc.controller.js";
import { requireOperatorShipmentDraftAccess } from "../controllers/operatorShipment.controller.js";
import {
  downloadAdminShipmentManifest,
  downloadAdminShipmentManifestExcel,
  downloadAdminShipmentManifestPdf
} from "../controllers/shipmentManifest.controller.js";
import { createLabelAccessToken } from "../services/shipmentLabelAccessToken.service.js";
import { runOperationalTenantJob } from "../services/tenantJobRunner.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";
import { listClientDocumentCentre } from "../services/clientDocumentCentre.service.js";
import { localStorageDriver } from "../services/storage/localDriver.js";
import { shipmentKycKey } from "../services/storage/storage.service.js";
import { listPortalNotifications, markPortalNotificationRead } from "../services/portalNotification.service.js";

const databaseName = `swiftline_tenant_scope_${Date.now()}`;

const fixtureSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", immutable: true },
  reference: { type: String, required: true },
  value: { type: String, default: "" }
}, { timestamps: true });
fixtureSchema.plugin(tenantOwnedSchemaPlugin);
const TenantScopeFixture = mongoose.model("TenantScopeFixture", fixtureSchema);

let rootTenantId: mongoose.Types.ObjectId;
let operatorTenantId: mongoose.Types.ObjectId;
let secondOperatorTenantId: mongoose.Types.ObjectId;
let operatorAccountId: mongoose.Types.ObjectId;
let secondOperatorAccountId: mongoose.Types.ObjectId;
let rootAccountId: mongoose.Types.ObjectId;
let operatorBranchId: mongoose.Types.ObjectId;
let secondOperatorBranchId: mongoose.Types.ObjectId;
let operatorUserId: mongoose.Types.ObjectId;
let secondOperatorUserId: mongoose.Types.ObjectId;
let rootBookingId: mongoose.Types.ObjectId;
let operatorBookingId: mongoose.Types.ObjectId;
let secondOperatorBookingId: mongoose.Types.ObjectId;
let operatorDraftId: mongoose.Types.ObjectId;
let secondOperatorDraftId: mongoose.Types.ObjectId;
let secondOperatorKycStorageKey: string;
let rootEventId: mongoose.Types.ObjectId;
let operatorEventId: mongoose.Types.ObjectId;
let secondOperatorEventId: mongoose.Types.ObjectId;
let rootInvoiceId: mongoose.Types.ObjectId;
let operatorInvoiceId: mongoose.Types.ObjectId;
let secondOperatorInvoiceId: mongoose.Types.ObjectId;
let secondOperatorManifestId: mongoose.Types.ObjectId;

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

function streamingResponseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, string | number | readonly string[]>();
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
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
    headers.set(name, value);
    return response;
  };
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    response,
    status: () => statusCode,
    body: () => body,
    header: (name: string) => headers.get(name),
    bytes: () => Buffer.concat(chunks)
  };
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    family: 4,
    retryWrites: false,
    autoIndex: false,
    autoCreate: false
  });
  assert.equal(mongoose.connection.name, databaseName, "Tenant scope tests must use their isolated database.");
  await Promise.all([
    Tenant.createCollection(),
    TenantSlug.createCollection(),
    TenantMembership.createCollection(),
    TenantScopeFixture.createCollection(),
    BusinessAccount.createCollection(),
    BusinessAccountMember.createCollection(),
    BusinessCreditAccount.createCollection(),
    CreditLedgerEntry.createCollection(),
    Branch.createCollection(),
    DpdShipment.createCollection(),
    ShipmentEvent.createCollection(),
    ShipmentInvoice.createCollection(),
    CountryRateCard.createCollection(),
    CountryRouteCharge.createCollection(),
    ShipmentInvoiceCounter.createCollection(),
    CancellationDocumentCounter.createCollection(),
    ShipmentManifestCounter.createCollection(),
    ShipmentManifest.createCollection(),
    EmailOutbox.createCollection(),
    ShipmentDraft.createCollection(),
    PortalNotification.createCollection(),
    AuditLog.createCollection(),
    IdempotencyKey.createCollection()
  ]);
  await Promise.all([
    BusinessAccountMember.createIndexes(),
    BusinessCreditAccount.createIndexes(),
    CreditLedgerEntry.createIndexes(),
    ShipmentInvoice.createIndexes(),
    CountryRouteCharge.createIndexes(),
    ShipmentInvoiceCounter.createIndexes(),
    CancellationDocumentCounter.createIndexes(),
    ShipmentManifest.createIndexes(),
    EmailOutbox.createIndexes(),
    PortalNotification.createIndexes(),
    AuditLog.createIndexes(),
    IdempotencyKey.createIndexes()
  ]);

  const [rootTenant, operatorTenant, secondOperatorTenant] = await Tenant.create([
    { kind: "SWIFTLINE", status: "ACTIVE", companyName: "Swiftline Test", slug: "swiftline" },
    { kind: "OPERATOR", status: "ACTIVE", companyName: "Operator Test", slug: "operator-test" },
    { kind: "OPERATOR", status: "ACTIVE", companyName: "Second Operator Test", slug: "second-operator-test" }
  ]);
  rootTenantId = rootTenant!._id as mongoose.Types.ObjectId;
  operatorTenantId = operatorTenant!._id as mongoose.Types.ObjectId;
  secondOperatorTenantId = secondOperatorTenant!._id as mongoose.Types.ObjectId;
  operatorAccountId = new mongoose.Types.ObjectId();
  secondOperatorAccountId = new mongoose.Types.ObjectId();
  rootAccountId = new mongoose.Types.ObjectId();
  operatorBranchId = new mongoose.Types.ObjectId();
  secondOperatorBranchId = new mongoose.Types.ObjectId();
  operatorUserId = new mongoose.Types.ObjectId();
  secondOperatorUserId = new mongoose.Types.ObjectId();
  rootBookingId = new mongoose.Types.ObjectId();
  operatorBookingId = new mongoose.Types.ObjectId();
  secondOperatorBookingId = new mongoose.Types.ObjectId();
  operatorDraftId = new mongoose.Types.ObjectId();
  secondOperatorDraftId = new mongoose.Types.ObjectId();
  secondOperatorKycStorageKey = shipmentKycKey(String(secondOperatorDraftId), "tenant-scope-pan.pdf");
  rootEventId = new mongoose.Types.ObjectId();
  operatorEventId = new mongoose.Types.ObjectId();
  secondOperatorEventId = new mongoose.Types.ObjectId();
  rootInvoiceId = new mongoose.Types.ObjectId();
  operatorInvoiceId = new mongoose.Types.ObjectId();
  secondOperatorInvoiceId = new mongoose.Types.ObjectId();
  secondOperatorManifestId = new mongoose.Types.ObjectId();

  await Promise.all([
    TenantSlug.create({ slug: "operator-test", tenantId: operatorTenantId, isCurrent: true }),
    TenantSlug.create({ slug: "second-operator-test", tenantId: secondOperatorTenantId, isCurrent: true }),
    TenantMembership.create({
      tenantId: operatorTenantId,
      userId: operatorUserId,
      role: "OPERATIONS",
      status: "ACTIVE",
      assignedBranches: []
    }),
    TenantMembership.create({
      tenantId: secondOperatorTenantId,
      userId: secondOperatorUserId,
      role: "OPERATOR_ADMIN",
      status: "ACTIVE",
      assignedBranches: []
    }),
    BusinessAccount.collection.insertMany([
      { _id: rootAccountId, tenantId: rootTenantId, accountId: "SCOPE-ROOT", status: "active", accountKind: "BUSINESS" },
      { _id: operatorAccountId, tenantId: operatorTenantId, accountId: "SCOPE-OPERATOR", status: "active", accountKind: "BUSINESS" },
      { _id: secondOperatorAccountId, tenantId: secondOperatorTenantId, accountId: "SCOPE-SECOND-OPERATOR", status: "active", accountKind: "BUSINESS" }
    ]),
    Branch.collection.insertMany([
      { _id: new mongoose.Types.ObjectId(), tenantId: rootTenantId, name: "Root Branch", code: "ROOT" },
      { _id: operatorBranchId, tenantId: operatorTenantId, name: "Operator Branch", code: "OPERATOR" },
      { _id: secondOperatorBranchId, tenantId: secondOperatorTenantId, name: "Second Operator Branch", code: "SECOND-OPERATOR" }
    ]),
    DpdShipment.collection.insertMany([
      {
        _id: rootBookingId,
        tenantId: rootTenantId,
        shipmentDraftId: new mongoose.Types.ObjectId(),
        idempotencyKey: "root-booking",
        serviceCode: "INTERNAL",
        status: "LABEL_RECEIVED"
      },
      {
        _id: operatorBookingId,
        tenantId: operatorTenantId,
        shipmentDraftId: operatorDraftId,
        idempotencyKey: "operator-booking",
        serviceCode: "INTERNAL",
        status: "LABEL_RECEIVED",
        swiftlineTrackingNumber: "OP-TRACK-1",
        createdAt: new Date()
      },
      {
        _id: secondOperatorBookingId,
        tenantId: secondOperatorTenantId,
        shipmentDraftId: secondOperatorDraftId,
        idempotencyKey: "second-operator-booking",
        serviceCode: "INTERNAL",
        status: "LABEL_RECEIVED",
        swiftlineTrackingNumber: "OP2-TRACK-1",
        createdAt: new Date()
      }
    ]),
    ShipmentDraft.collection.insertMany([
      {
        _id: operatorDraftId,
        tenantId: operatorTenantId,
        businessAccountId: operatorAccountId,
        branchId: operatorBranchId,
        bookingState: "BOOKED",
        deletedAt: null,
        allocatedTrackingNumber: "OP-TRACK-1",
        consigneeEnteredAddress: { townOrCity: "London", countryName: "UNITED KINGDOM" }
      },
      {
        _id: secondOperatorDraftId,
        tenantId: secondOperatorTenantId,
        businessAccountId: secondOperatorAccountId,
        branchId: secondOperatorBranchId,
        bookingState: "BOOKED",
        deletedAt: null,
        allocatedTrackingNumber: "OP2-TRACK-1",
        consigneeEnteredAddress: { townOrCity: "Paris", countryName: "FRANCE" },
        kycDocuments: {
          pan: {
            type: "pan",
            documentLabel: "PAN Card",
            originalName: "tenant-scope-pan.pdf",
            storageKey: secondOperatorKycStorageKey,
            mimeType: "application/pdf",
            size: 16,
            uploadedAt: new Date()
          }
        }
      }
    ]),
    ShipmentEvent.collection.insertMany([
      {
        _id: rootEventId,
        tenantId: rootTenantId,
        shipmentDraftId: new mongoose.Types.ObjectId(),
        status: "BOOKING_CONFIRMED",
        source: "SYSTEM",
        eventAt: new Date(),
        isCustomerVisible: true
      },
      {
        _id: operatorEventId,
        tenantId: operatorTenantId,
        shipmentDraftId: new mongoose.Types.ObjectId(),
        status: "BOOKING_CONFIRMED",
        source: "SYSTEM",
        eventAt: new Date(),
        isCustomerVisible: true
      },
      {
        _id: secondOperatorEventId,
        tenantId: secondOperatorTenantId,
        shipmentDraftId: new mongoose.Types.ObjectId(),
        status: "BOOKING_CONFIRMED",
        source: "SYSTEM",
        eventAt: new Date(),
        isCustomerVisible: true
      }
    ]),
    ShipmentInvoice.collection.insertMany([
      { _id: rootInvoiceId, tenantId: rootTenantId, invoiceNumber: "ROOT-INV-1" },
      {
        _id: operatorInvoiceId,
        tenantId: operatorTenantId,
        invoiceNumber: "OP-INV-1",
        shipmentDraftId: operatorDraftId,
        dpdShipmentId: operatorBookingId,
        businessAccountId: operatorAccountId,
        branchId: operatorBranchId,
        status: "ISSUED",
        issuedAt: new Date()
      },
      {
        _id: secondOperatorInvoiceId,
        tenantId: secondOperatorTenantId,
        invoiceNumber: "OP2-INV-1",
        shipmentDraftId: secondOperatorDraftId,
        dpdShipmentId: secondOperatorBookingId,
        businessAccountId: secondOperatorAccountId,
        branchId: secondOperatorBranchId,
        status: "ISSUED",
        issuedAt: new Date()
      }
    ]),
    ShipmentManifest.collection.insertOne({
      _id: secondOperatorManifestId,
      tenantId: secondOperatorTenantId,
      manifestNumber: "OP2-MANIFEST-1",
      manifestType: "ACCOUNT",
      businessAccountId: secondOperatorAccountId,
      branchId: secondOperatorBranchId,
      shipmentDraftIds: [secondOperatorDraftId],
      headerSnapshot: {},
      lineSnapshots: [],
      totalPieces: 1,
      totalWeightKg: 1,
      totalBags: 1,
      createdBy: secondOperatorUserId,
      actorRole: "admin",
      generatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }),
    TenantScopeFixture.collection.insertMany([
      { tenantId: rootTenantId, reference: "root-row", value: "root" },
      { tenantId: operatorTenantId, reference: "operator-row", value: "operator" }
    ])
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("swiftline_tenant_scope_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("tenant-owned model scope", () => {
  test("unscoped production work defaults to the active Swiftline tenant", async () => {
    const previousEnvironment = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      assert.equal((await BusinessAccount.findById(operatorAccountId).lean().exec()), null);
      assert.equal((await Branch.findById(operatorBranchId).lean().exec()), null);
      assert.equal((await DpdShipment.findById(operatorBookingId).lean().exec()), null);
      assert.equal((await ShipmentEvent.findById(operatorEventId).lean().exec()), null);
      assert.equal((await ShipmentInvoice.findById(operatorInvoiceId).lean().exec()), null);
      const rows = await TenantScopeFixture.find().select("reference").lean().exec();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.reference, "root-row");

      const created = await TenantScopeFixture.create({ reference: "production-root-write", value: "root" });
      assert.equal(String(created.tenantId), String(rootTenantId));
    } finally {
      env.NODE_ENV = previousEnvironment;
    }
  });

  test("operator middleware establishes the database scope after membership verification", async () => {
    const request = {
      params: { operatorSlug: "operator-test" },
      headers: {},
      user: { _id: operatorUserId, role: "client" }
    } as unknown as Request;
    let statusCode = 200;
    const response = {
      status(code: number) { statusCode = code; return this; },
      json(_body: unknown) { return this; }
    } as unknown as Response;
    let accountQuery: Promise<string | undefined> | undefined;

    await requireOperatorContext(request, response, (() => {
      accountQuery = BusinessAccount.findById(operatorAccountId)
        .select("accountId")
        .lean()
        .exec()
        .then((account) => account?.accountId);
    }) as NextFunction);

    assert.equal(statusCode, 200);
    assert.equal(await accountQuery, "SCOPE-OPERATOR");
  });

  test("an operator login cannot use another operator's URL slug", async () => {
    const request = {
      params: { operatorSlug: "second-operator-test" },
      headers: {},
      user: { _id: operatorUserId, role: "client" }
    } as unknown as Request;
    const recorded = responseRecorder();
    let reachedNext = false;

    await requireOperatorContext(request, recorded.response, (() => {
      reachedNext = true;
    }) as NextFunction);

    assert.equal(recorded.status(), 404);
    assert.equal(reachedNext, false);
  });

  test("operator account detail access hides Swiftline and other-operator accounts", async () => {
    const context = {
      tenantId: operatorTenantId,
      kind: "OPERATOR" as const,
      role: "OPERATOR_ADMIN" as const,
      assignedBranches: []
    };

    async function check(accountId: string) {
      const request = {
        params: { accountId: String(accountId) },
        operatorContext: context
      } as unknown as Request;
      const recorded = responseRecorder();
      let reachedNext = false;

      await runWithTenantContext(context, () => requireOperatorBusinessAccountAccess(
        request,
        recorded.response,
        (() => { reachedNext = true; }) as NextFunction
      ));
      return { ...recorded, reachedNext };
    }

    const ownAccount = await check("SCOPE-OPERATOR");
    assert.equal(ownAccount.reachedNext, true);
    assert.equal(ownAccount.status(), 200);

    const swiftlineAccount = await check("SCOPE-ROOT");
    assert.equal(swiftlineAccount.reachedNext, false);
    assert.equal(swiftlineAccount.status(), 404);

    const otherOperatorAccount = await check("SCOPE-SECOND-OPERATOR");
    assert.equal(otherOperatorAccount.reachedNext, false);
    assert.equal(otherOperatorAccount.status(), 404);
  });

  test("operator credit account listing returns only the authenticated tenant's accounts", async () => {
    const context = {
      tenantId: operatorTenantId,
      kind: "OPERATOR" as const,
      role: "OPERATOR_ADMIN" as const,
      slug: "operator-test",
      assignedBranches: [],
      accessMode: "MEMBER" as const
    };
    const request = { query: {}, operatorContext: context } as unknown as Request;
    const recorded = responseRecorder();

    await runWithTenantContext(context, () => listOperatorCreditAccounts(request, recorded.response));

    assert.equal(recorded.status(), 200);
    const body = recorded.body() as { creditAccounts: Array<{ businessAccount: { accountId: string } }> };
    assert.deepEqual(body.creditAccounts.map((item) => item.businessAccount.accountId), ["SCOPE-OPERATOR"]);
  });

  test("invoice APIs and signed label downloads hide another operator's booked shipment", async () => {
    const context = { tenantId: operatorTenantId, kind: "OPERATOR" as const };
    const userId = new mongoose.Types.ObjectId();
    const signedLabelToken = createLabelAccessToken({
      dpdShipmentId: String(secondOperatorBookingId),
      labelId: String(new mongoose.Types.ObjectId()),
      userId: String(userId),
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: operatorTenantId,
      tenantKind: "OPERATOR"
    });

    const invoiceRequest = {
      params: { draftId: String(secondOperatorDraftId) },
      query: {},
      user: { _id: userId }
    } as unknown as Request;
    const invoiceRead = responseRecorder();
    await runWithTenantContext(context, () => getShipmentInvoice(invoiceRequest, invoiceRead.response));
    assert.equal(invoiceRead.status(), 409, "the invoice API must behave as if the other tenant's booking is absent");

    const invoiceDownload = responseRecorder();
    await runWithTenantContext(context, () => downloadShipmentInvoicePdf(invoiceRequest, invoiceDownload.response));
    assert.equal(invoiceDownload.status(), 409, "the PDF endpoint must not issue or return another tenant's invoice");

    const labelDownload = responseRecorder();
    await downloadDpdLabelWithToken({
      params: { id: String(secondOperatorBookingId) },
      query: { token: signedLabelToken }
    } as unknown as Request, labelDownload.response);
    assert.equal(labelDownload.status(), 404, "a signed URL bound to one tenant cannot read another tenant's booking");
  });

  test("document-centre invoice aggregation returns only the active tenant's client documents", async () => {
    const filters = { documentType: "BILLING_INVOICE" as const, page: 1, limit: 20 };
    const operatorScope = {
      ok: true as const,
      businessAccountId: operatorAccountId,
      branchIds: [operatorBranchId],
      canViewFinancials: true
    };
    const secondOperatorScope = {
      ok: true as const,
      businessAccountId: secondOperatorAccountId,
      branchIds: [secondOperatorBranchId],
      canViewFinancials: true
    };

    const operatorDocuments = await runWithTenantContext(
      { tenantId: operatorTenantId, kind: "OPERATOR" },
      () => listClientDocumentCentre(operatorScope, filters)
    );
    assert.equal(operatorDocuments.pagination.total, 1);
    assert.deepEqual(operatorDocuments.items.map((item) => item.reference), ["OP-INV-1"]);

    const crossTenantAccountDocuments = await runWithTenantContext(
      { tenantId: operatorTenantId, kind: "OPERATOR" },
      () => listClientDocumentCentre(secondOperatorScope, filters)
    );
    assert.equal(crossTenantAccountDocuments.pagination.total, 0);
    assert.deepEqual(crossTenantAccountDocuments.items, []);

    const secondOperatorDocuments = await runWithTenantContext(
      { tenantId: secondOperatorTenantId, kind: "OPERATOR" },
      () => listClientDocumentCentre(secondOperatorScope, filters)
    );
    assert.equal(secondOperatorDocuments.pagination.total, 1);
    assert.deepEqual(secondOperatorDocuments.items.map((item) => item.reference), ["OP2-INV-1"]);
  });

  test("operator draft guards and streamed KYC downloads hide another tenant's stored document", async () => {
    const operatorContext = {
      tenantId: operatorTenantId,
      kind: "OPERATOR" as const,
      role: "OPERATOR_ADMIN" as const,
      assignedBranches: []
    };
    const guardResponse = responseRecorder();
    let reachedNext = false;
    await runWithTenantContext(operatorContext, () => requireOperatorShipmentDraftAccess(
      {
        params: { id: String(secondOperatorDraftId) },
        operatorContext
      } as unknown as Request,
      guardResponse.response,
      (() => { reachedNext = true; }) as NextFunction
    ));
    assert.equal(guardResponse.status(), 404);
    assert.equal(reachedNext, false);

    const previousStorageDriver = env.STORAGE_DRIVER;
    const documentBytes = Buffer.from("tenant-scope private KYC document");
    env.STORAGE_DRIVER = "local";
    try {
      await localStorageDriver.putObject({
        key: secondOperatorKycStorageKey,
        body: documentBytes,
        contentType: "application/pdf"
      });
      assert.equal(await localStorageDriver.objectExists(secondOperatorKycStorageKey), true);

      const foreignRead = streamingResponseRecorder();
      await runWithTenantContext(operatorContext, () => downloadShipmentKycDocument({
        params: { id: String(secondOperatorDraftId), type: "pan" },
        user: { _id: operatorUserId }
      } as unknown as Request, foreignRead.response));
      assert.equal(foreignRead.status(), 404);
      assert.equal(foreignRead.bytes().length, 0);

      const ownerRead = streamingResponseRecorder();
      await runWithTenantContext(
        { tenantId: secondOperatorTenantId, kind: "OPERATOR" },
        () => downloadShipmentKycDocument({
          params: { id: String(secondOperatorDraftId), type: "pan" },
          user: { _id: secondOperatorUserId }
        } as unknown as Request, ownerRead.response)
      );
      assert.equal(ownerRead.status(), 200);
      assert.deepEqual(ownerRead.bytes(), documentBytes);
      assert.equal(ownerRead.header("Cache-Control"), "private, no-store");
    } finally {
      env.STORAGE_DRIVER = previousStorageDriver;
      await localStorageDriver.deleteObject(secondOperatorKycStorageKey);
    }
  });

  test("manifest document downloads hide another operator's manifest", async () => {
    const context = { tenantId: operatorTenantId, kind: "OPERATOR" as const };
    const request = {
      params: { manifestId: String(secondOperatorManifestId) },
      query: {},
      user: { _id: operatorUserId }
    } as unknown as Request;

    for (const download of [
      downloadAdminShipmentManifest,
      downloadAdminShipmentManifestPdf,
      downloadAdminShipmentManifestExcel
    ]) {
      const recorded = responseRecorder();
      await runWithTenantContext(context, () => download(request, recorded.response));
      assert.equal(recorded.status(), 404, "a manifest PDF or workbook must be hidden outside its owner tenant");
    }
  });

  test("SES delivery callback updates only the database row owned by its operator tenant", async () => {
    const previousSecret = env.SES_WEBHOOK_SECRET;
    const messageId = `tenant-scope-ses-${Date.now()}`;
    const rootOutboxId = new mongoose.Types.ObjectId();
    const operatorOutboxId = new mongoose.Types.ObjectId();
    const secondOperatorOutboxId = new mongoose.Types.ObjectId();
    env.SES_WEBHOOK_SECRET = "tenant-scope-test-secret";

    try {
      await EmailOutbox.collection.insertMany([
        {
          _id: rootOutboxId, tenantId: rootTenantId, idempotencyKey: `${messageId}:root`,
          toEmail: "root@example.test", notificationType: "TEST", templateKey: "TEST",
          category: "TRANSACTIONAL", priority: 0, subject: "Test", payload: {},
          attachmentRefs: [], status: "PENDING", attempts: 0, nextAttemptAt: new Date(),
          lastError: "", sesMessageId: `${messageId}-root`, createdAt: new Date(), updatedAt: new Date()
        },
        {
          _id: operatorOutboxId, tenantId: operatorTenantId, idempotencyKey: `${messageId}:operator`,
          toEmail: "operator@example.test", notificationType: "TEST", templateKey: "TEST",
          category: "TRANSACTIONAL", priority: 0, subject: "Test", payload: {},
          attachmentRefs: [], status: "PENDING", attempts: 0, nextAttemptAt: new Date(),
          lastError: "", sesMessageId: `${messageId}-operator`, createdAt: new Date(), updatedAt: new Date()
        },
        {
          _id: secondOperatorOutboxId, tenantId: secondOperatorTenantId, idempotencyKey: `${messageId}:second-operator`,
          toEmail: "second-operator@example.test", notificationType: "TEST", templateKey: "TEST",
          category: "TRANSACTIONAL", priority: 0, subject: "Test", payload: {},
          attachmentRefs: [], status: "PENDING", attempts: 0, nextAttemptAt: new Date(),
          lastError: "", sesMessageId: messageId, createdAt: new Date(), updatedAt: new Date()
        }
      ]);

      const recorded = responseRecorder();
      await handleSesWebhook({
        query: { token: env.SES_WEBHOOK_SECRET },
        body: {
          Type: "Notification",
          Message: JSON.stringify({ eventType: "Delivery", mail: { messageId } })
        }
      } as unknown as Request, recorded.response);

      assert.equal(recorded.status(), 200);
      const [rootStatus, operatorStatus, secondOperatorStatus] = await Promise.all([
        runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () =>
          (await EmailOutbox.findById(rootOutboxId).lean().exec())?.status),
        runWithTenantContext({ tenantId: operatorTenantId, kind: "OPERATOR" }, async () =>
          (await EmailOutbox.findById(operatorOutboxId).lean().exec())?.status),
        runWithTenantContext({ tenantId: secondOperatorTenantId, kind: "OPERATOR" }, async () =>
          (await EmailOutbox.findById(secondOperatorOutboxId).lean().exec())?.status)
      ]);
      assert.deepEqual([rootStatus, operatorStatus, secondOperatorStatus], ["PENDING", "PENDING", "DELIVERED"]);
    } finally {
      env.SES_WEBHOOK_SECRET = previousSecret;
    }
  });

  test("account and branch reads stay within the active tenant", async () => {
    await runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () => {
      assert.equal(await BusinessAccount.findById(operatorAccountId).lean().exec(), null);
      assert.equal(await BusinessAccount.findById(secondOperatorAccountId).lean().exec(), null);
      assert.equal(await Branch.findById(operatorBranchId).lean().exec(), null);
      assert.equal(await Branch.findById(secondOperatorBranchId).lean().exec(), null);
      assert.equal(await BusinessAccount.countDocuments({}).exec(), 1);
      assert.equal(await Branch.countDocuments({}).exec(), 1);
      assert.deepEqual(await BusinessAccount.distinct("accountId").exec(), ["SCOPE-ROOT"]);
      assert.deepEqual(await Branch.distinct("code").exec(), ["ROOT"]);
      assert.equal(await DpdShipment.findById(secondOperatorBookingId).lean().exec(), null);
      assert.equal(await ShipmentEvent.findById(secondOperatorEventId).lean().exec(), null);
      assert.equal(await ShipmentInvoice.findById(secondOperatorInvoiceId).lean().exec(), null);
    });

    await runWithTenantContext({ tenantId: operatorTenantId, kind: "OPERATOR" }, async () => {
      assert.equal((await BusinessAccount.findById(operatorAccountId).lean().exec())?.accountId, "SCOPE-OPERATOR");
      assert.equal(await BusinessAccount.findById(secondOperatorAccountId).lean().exec(), null);
      assert.equal((await Branch.findById(operatorBranchId).lean().exec())?.code, "OPERATOR");
      assert.equal(await Branch.findById(secondOperatorBranchId).lean().exec(), null);
      assert.equal((await DpdShipment.findById(operatorBookingId).lean().exec())?.idempotencyKey, "operator-booking");
      assert.equal(await DpdShipment.findById(secondOperatorBookingId).lean().exec(), null);
      assert.equal((await ShipmentEvent.findById(operatorEventId).lean().exec())?.status, "BOOKING_CONFIRMED");
      assert.equal(await ShipmentEvent.findById(secondOperatorEventId).lean().exec(), null);
      assert.equal((await ShipmentInvoice.findById(operatorInvoiceId).lean().exec())?.invoiceNumber, "OP-INV-1");
      assert.equal(await ShipmentInvoice.findById(secondOperatorInvoiceId).lean().exec(), null);
    });

    await runWithTenantContext({ tenantId: secondOperatorTenantId, kind: "OPERATOR" }, async () => {
      assert.equal((await BusinessAccount.findById(secondOperatorAccountId).lean().exec())?.accountId, "SCOPE-SECOND-OPERATOR");
      assert.equal((await Branch.findById(secondOperatorBranchId).lean().exec())?.code, "SECOND-OPERATOR");
      assert.equal((await DpdShipment.findById(secondOperatorBookingId).lean().exec())?.idempotencyKey, "second-operator-booking");
      assert.equal((await ShipmentEvent.findById(secondOperatorEventId).lean().exec())?.status, "BOOKING_CONFIRMED");
      assert.equal((await ShipmentInvoice.findById(secondOperatorInvoiceId).lean().exec())?.invoiceNumber, "OP2-INV-1");
      assert.equal(await BusinessAccount.findById(operatorAccountId).lean().exec(), null);
    });
  });

  test("scheduled database work reads each tenant only inside its own context", async () => {
    const accountCounts = new Map<string, number>();
    const summary = await runOperationalTenantJob("tenant data isolation check", async (target) => {
      accountCounts.set(target.slug, await BusinessAccount.countDocuments({}).exec());
    });

    assert.equal(summary.total, 3);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(new Set(summary.succeeded), new Set(["swiftline", "operator-test", "second-operator-test"]));
    assert.deepEqual(Object.fromEntries(accountCounts), {
      "operator-test": 1,
      "second-operator-test": 1,
      swiftline: 1
    });
  });

  test("the same login can have isolated account and credit records in separate tenants", async () => {
    const sharedIdempotencyKey = "tenant-local-credit-ledger-key";
    let rootCreditAccountId: mongoose.Types.ObjectId | undefined;
    let operatorCreditAccountId: mongoose.Types.ObjectId | undefined;

    await runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () => {
      await BusinessAccountMember.create({
        businessAccount: rootAccountId,
        user: operatorUserId,
        role: "account_owner",
        status: "active",
        invitedBy: operatorUserId
      });
      const account = await BusinessCreditAccount.create({ businessAccountId: rootAccountId });
      rootCreditAccountId = account._id as mongoose.Types.ObjectId;
      await CreditLedgerEntry.create({
        businessAccountId: rootAccountId,
        creditAccountId: rootCreditAccountId,
        type: "CREDIT_REQUESTED",
        reference: "ROOT-CREDIT-REQUEST",
        description: "Root tenant test entry",
        amountMinor: 0,
        availableCreditAfterMinor: 0,
        availableAdvanceAfterMinor: 0,
        idempotencyKey: sharedIdempotencyKey
      });
    });

    await runWithTenantContext({ tenantId: operatorTenantId, kind: "OPERATOR" }, async () => {
      await BusinessAccountMember.create({
        businessAccount: operatorAccountId,
        user: operatorUserId,
        role: "account_owner",
        status: "active",
        invitedBy: operatorUserId
      });
      const account = await BusinessCreditAccount.create({ businessAccountId: operatorAccountId });
      operatorCreditAccountId = account._id as mongoose.Types.ObjectId;
      await CreditLedgerEntry.create({
        businessAccountId: operatorAccountId,
        creditAccountId: operatorCreditAccountId,
        type: "CREDIT_REQUESTED",
        reference: "OPERATOR-CREDIT-REQUEST",
        description: "Operator tenant test entry",
        amountMinor: 0,
        availableCreditAfterMinor: 0,
        availableAdvanceAfterMinor: 0,
        idempotencyKey: sharedIdempotencyKey
      });
    });

    await runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () => {
      assert.equal(await BusinessAccountMember.countDocuments({ user: operatorUserId }), 1);
      assert.equal(await BusinessCreditAccount.countDocuments({}), 1);
      assert.equal(await BusinessCreditAccount.findById(operatorCreditAccountId).lean().exec(), null);
      assert.equal(await CreditLedgerEntry.countDocuments({ idempotencyKey: sharedIdempotencyKey }), 1);
      await assert.rejects(CreditLedgerEntry.create({
        businessAccountId: rootAccountId,
        creditAccountId: rootCreditAccountId,
        type: "CREDIT_REQUESTED",
        reference: "ROOT-CREDIT-REQUEST-DUPLICATE",
        description: "Duplicate root tenant test entry",
        amountMinor: 0,
        availableCreditAfterMinor: 0,
        availableAdvanceAfterMinor: 0,
        idempotencyKey: sharedIdempotencyKey
      }), (error: unknown) => (error as { code?: number }).code === 11000);
    });

    await runWithTenantContext({ tenantId: operatorTenantId, kind: "OPERATOR" }, async () => {
      assert.equal(await BusinessAccountMember.countDocuments({ user: operatorUserId }), 1);
      assert.equal(await BusinessCreditAccount.countDocuments({}), 1);
      assert.equal(await BusinessCreditAccount.findById(rootCreditAccountId).lean().exec(), null);
      assert.equal(await CreditLedgerEntry.countDocuments({ idempotencyKey: sharedIdempotencyKey }), 1);
    });
  });

  test("rate cards, counters, notifications, audit and idempotency stay tenant-local", async () => {
    const sameIdempotencyKey = "same-request-key";
    const sameNotificationKey = "same-notification-key";
    const rootManifestCounterId = "shipment-manifest:TEST";
    const operatorManifestCounterId = `${operatorTenantId}:shipment-manifest:TEST`;

    async function createTenantRecords(tenantId: mongoose.Types.ObjectId, kind: "SWIFTLINE" | "OPERATOR", accountId: mongoose.Types.ObjectId) {
      await runWithTenantContext({ tenantId, kind }, async () => {
        await CountryRateCard.create({
          band: "BAND_A",
          businessAccountId: null,
          countryCode: "GB",
          countryName: "United Kingdom",
          service: "COURIER",
          fromKg: 0,
          toKg: 1,
          chargesPerKg: 10,
          maxBoxKg: 10,
          gstTreatment: "EXCLUDED",
          gstRatePercent: 0,
          gstApplyToAllRates: false,
          createdBy: operatorUserId
        });
        await CountryRouteCharge.create({
          band: "BAND_A",
          businessAccountId: null,
          countryCode: "GB",
          service: "COURIER",
          createdBy: operatorUserId
        });
        await ShipmentInvoiceCounter.create({ financialYear: "26-27", sequence: 1 });
        await CancellationDocumentCounter.create({ financialYear: "26-27", documentType: "CREDIT_NOTE", sequence: 1 });
        await ShipmentManifestCounter.create({
          _id: kind === "SWIFTLINE" ? rootManifestCounterId : operatorManifestCounterId,
          sequence: 1
        });
        await PortalNotification.create({
          recipientUserId: operatorUserId,
          businessAccountId: accountId,
          type: "SHIPMENT_BOOKED",
          title: kind === "SWIFTLINE" ? "Swiftline tenant notice" : "Operator tenant notice",
          message: "A shipment was booked.",
          href: "/shipment/example",
          idempotencyKey: sameNotificationKey,
          metadata: {}
        });
        await AuditLog.create({
          action: "SHIPMENT_DRAFT_CREATED",
          entityType: "SHIPMENT_DRAFT",
          entityId: new mongoose.Types.ObjectId(),
          performedBy: operatorUserId,
          performedAt: new Date(),
          metadata: {}
        });
        await IdempotencyKey.create({
          key: sameIdempotencyKey,
          scope: "shipment-create",
          userId: operatorUserId,
          entityId: new mongoose.Types.ObjectId()
        });
      });
    }

    await createTenantRecords(rootTenantId, "SWIFTLINE", rootAccountId);
    await createTenantRecords(operatorTenantId, "OPERATOR", operatorAccountId);

    let rootNotificationId: mongoose.Types.ObjectId | null = null;
    await runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () => {
      assert.equal(await CountryRateCard.countDocuments({ band: "BAND_A" }), 1);
      assert.equal(await CountryRouteCharge.countDocuments({ band: "BAND_A" }), 1);
      assert.equal(await ShipmentInvoiceCounter.countDocuments({ financialYear: "26-27" }), 1);
      assert.equal(await CancellationDocumentCounter.countDocuments({ financialYear: "26-27" }), 1);
      assert.equal(await ShipmentManifestCounter.countDocuments({}), 1);
      assert.equal(await PortalNotification.countDocuments({ recipientUserId: operatorUserId }), 1);
      const inbox = await listPortalNotifications(operatorUserId);
      assert.ok(inbox.notifications.some((notification) => notification.title === "Swiftline tenant notice"));
      assert.equal(inbox.notifications.some((notification) => notification.title === "Operator tenant notice"), false);
      const rootNotification = await PortalNotification.findOne({ recipientUserId: operatorUserId }).select("_id").lean().exec();
      assert.ok(rootNotification);
      rootNotificationId = rootNotification._id as mongoose.Types.ObjectId;
      assert.equal(await AuditLog.countDocuments({ action: "SHIPMENT_DRAFT_CREATED" }), 1);
      assert.equal(await IdempotencyKey.countDocuments({ key: sameIdempotencyKey, scope: "shipment-create" }), 1);
      assert.equal(await ShipmentManifestCounter.findById(operatorManifestCounterId).lean().exec(), null);
    });

    await runWithTenantContext({ tenantId: operatorTenantId, kind: "OPERATOR" }, async () => {
      assert.equal(await CountryRateCard.countDocuments({ band: "BAND_A" }), 1);
      assert.equal(await CountryRouteCharge.countDocuments({ band: "BAND_A" }), 1);
      assert.equal(await ShipmentInvoiceCounter.countDocuments({ financialYear: "26-27" }), 1);
      assert.equal(await CancellationDocumentCounter.countDocuments({ financialYear: "26-27" }), 1);
      assert.equal(await ShipmentManifestCounter.countDocuments({}), 1);
      assert.equal(await PortalNotification.countDocuments({ recipientUserId: operatorUserId }), 1);
      const inbox = await listPortalNotifications(operatorUserId);
      assert.ok(inbox.notifications.some((notification) => notification.title === "Operator tenant notice"));
      assert.equal(inbox.notifications.some((notification) => notification.title === "Swiftline tenant notice"), false);
      assert.ok(rootNotificationId);
      assert.equal(await markPortalNotificationRead(operatorUserId, rootNotificationId), null);
      assert.equal(await AuditLog.countDocuments({ action: "SHIPMENT_DRAFT_CREATED" }), 1);
      assert.equal(await IdempotencyKey.countDocuments({ key: sameIdempotencyKey, scope: "shipment-create" }), 1);
      assert.equal(await ShipmentManifestCounter.findById(rootManifestCounterId).lean().exec(), null);
    });
  });

  test("shipment booking schemas carry the guarded tenant field and index", () => {
    assert.equal(DpdShipment.schema.path("tenantId")?.instance, "ObjectId");
    const indexes = DpdShipment.schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown>]>;
    assert.ok(indexes.some(([keys]) => keys.tenantId === 1));
    assert.equal(ShipmentEvent.schema.path("tenantId")?.instance, "ObjectId");
    assert.equal(ShipmentInvoice.schema.path("tenantId")?.instance, "ObjectId");
  });

  test("aggregation and writes preserve tenant scope", async () => {
    await runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, async () => {
      const grouped = await TenantScopeFixture.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$value", count: { $sum: 1 } } }
      ]).exec();
      assert.deepEqual(grouped, [{ _id: "root", count: 2 }]);

      const blockedUpdate = await TenantScopeFixture.updateOne(
        { reference: "operator-row" },
        { $set: { value: "changed by root" } }
      ).exec();
      assert.equal(blockedUpdate.matchedCount, 0);

      await TenantScopeFixture.updateOne(
        { reference: "root-upsert" },
        { $set: { value: "created" } },
        { upsert: true }
      ).exec();
      const upserted = await TenantScopeFixture.findOne({ reference: "root-upsert" }).lean().exec();
      assert.equal(String(upserted?.tenantId), String(rootTenantId));

      const bulkResult = await TenantScopeFixture.bulkWrite([
        { insertOne: { document: { reference: "bulk-root", value: "created" } } },
        { updateOne: { filter: { reference: "operator-row" }, update: { $set: { value: "blocked" } } } }
      ]);
      assert.equal(bulkResult.insertedCount, 1);
      assert.equal(bulkResult.matchedCount, 0);
      const bulkInserted = await TenantScopeFixture.findOne({ reference: "bulk-root" }).lean().exec();
      assert.equal(String(bulkInserted?.tenantId), String(rootTenantId));

      const [inserted] = await TenantScopeFixture.insertMany([{ reference: "insert-many-root" }]);
      assert.equal(String(inserted?.tenantId), String(rootTenantId));
    });

    await assert.rejects(
      runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, () => TenantScopeFixture.updateOne(
        { reference: "root-row" },
        { $set: { tenantId: operatorTenantId } }
      ).exec()),
      TenantScopeError
    );
    await assert.rejects(
      runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, () => TenantScopeFixture.updateOne(
        { reference: "root-row" },
        { $rename: { reference: "tenantId" } }
      ).exec()),
      TenantScopeError
    );
    await assert.rejects(
      runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, () => TenantScopeFixture.updateOne(
        { reference: "root-row" },
        { $set: { "tenantId.path": operatorTenantId } }
      ).exec()),
      TenantScopeError
    );
    await assert.rejects(
      runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, () => TenantScopeFixture.aggregate([
        { $unionWith: "other_collection" }
      ]).exec()),
      TenantScopeError
    );
    await assert.rejects(
      runWithTenantContext({ tenantId: rootTenantId, kind: "SWIFTLINE" }, () => TenantScopeFixture.aggregate([
        { $lookup: { from: "businessaccounts", localField: "reference", foreignField: "accountId", as: "accounts" } }
      ]).exec()),
      TenantScopeError
    );
  });
});
