import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { createDpdLabelAccessUrl, downloadDpdLabelWithToken } from "../controllers/dpdShipment.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { Tenant } from "../models/tenant.model.js";
import { isHistoricalLabelBeforePaymentPolicy, canAccessShipmentLabel } from "../services/prepaid/shipmentLabelAccessPolicy.service.js";
import { createLabelAccessToken } from "../services/shipmentLabelAccessToken.service.js";
import { localStorageDriver } from "../services/storage/localDriver.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

function queryResult<T>(value: T) {
  return {
    select() { return this; },
    lean() { return this; },
    exec: async () => value
  };
}

function jsonResponse() {
  const state: { status: number; body: unknown } = { status: 200, body: null };
  const response = {
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; }
  } as unknown as Response;
  return { response, state };
}

function streamResponse() {
  const stream = new PassThrough() as PassThrough & {
    statusCode: number;
    body: unknown;
    headersSent: boolean;
    status(code: number): PassThrough;
    json(body: unknown): PassThrough;
    setHeader(name: string, value: string): PassThrough;
  };
  stream.statusCode = 200;
  stream.body = null;
  stream.headersSent = false;
  stream.status = (code) => { stream.statusCode = code; return stream; };
  stream.json = (body) => { stream.body = body; return stream; };
  stream.setHeader = () => stream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { response: stream as unknown as Response, stream, chunks };
}

describe("prepaid shipment label access policy", () => {
  test("recognizes only complete, unmarked pre-policy booking and label timestamps as historical", () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const beforeActivation = new Date("2026-10-01T00:00:00.000Z");
    const activatedAt = "2026-11-01T00:00:00.000Z";
    const historical = {
      shipment: { shipmentDraftId, createdAt: beforeActivation },
      label: { createdAt: beforeActivation, generatedAt: beforeActivation },
      activatedAt
    };

    assert.equal(isHistoricalLabelBeforePaymentPolicy(historical), true);
    assert.equal(isHistoricalLabelBeforePaymentPolicy({
      ...historical,
      shipment: { ...historical.shipment, labelPaymentPolicy: "PAYMENT_REQUIRED" }
    }), false);
    assert.equal(isHistoricalLabelBeforePaymentPolicy({
      ...historical,
      shipment: { ...historical.shipment, labelPaymentPolicy: "UNKNOWN_POLICY" }
    }), false);
    assert.equal(isHistoricalLabelBeforePaymentPolicy({
      ...historical,
      label: { ...historical.label, generatedAt: new Date(activatedAt) }
    }), false);
    assert.equal(isHistoricalLabelBeforePaymentPolicy({
      ...historical,
      label: { createdAt: beforeActivation }
    }), false);
    assert.equal(isHistoricalLabelBeforePaymentPolicy({ ...historical, activatedAt: undefined }), false);
  });

  test("requires a completed supported funding record for new and ambiguous bookings", async () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const now = new Date();
    const shipment = { shipmentDraftId, createdAt: now, labelPaymentPolicy: "PAYMENT_REQUIRED" };
    const label = { createdAt: now, generatedAt: now };
    const fundingModel = ShipmentFunding as unknown as { findOne: (filter: unknown) => unknown };
    const amendmentModel = ShipmentAmendment as unknown as { findOne: (filter: unknown) => unknown };
    const previousFundingFindOne = fundingModel.findOne;
    const previousAmendmentFindOne = amendmentModel.findOne;
    let funding: { status: string; source: string } | null = null;
    let pendingAmendment: { _id: mongoose.Types.ObjectId } | null = null;
    let fundingFilter: unknown;

    try {
      fundingModel.findOne = (filter) => {
        fundingFilter = filter;
        return queryResult(funding);
      };
      amendmentModel.findOne = () => queryResult(pendingAmendment);

      for (const source of ["BUSINESS_WALLET", "DIRECT_RAZORPAY", "CASH_RECEIPT", "PUBLIC_RAZORPAY"]) {
        funding = { status: "COMPLETED", source };
        assert.equal(await canAccessShipmentLabel({ shipment, label }), true, `${source} completion should grant access`);
      }

      for (const status of ["SECURED", "CONSUMING", "REVIEW_REQUIRED", "RELEASED"]) {
        funding = { status, source: "BUSINESS_WALLET" };
        assert.equal(await canAccessShipmentLabel({ shipment, label }), false, `${status} must not grant access`);
      }
      for (const source of ["DIRECT_RAZORPAY", "PUBLIC_RAZORPAY"]) {
        for (const status of ["SECURED", "RELEASED"]) {
          funding = { status, source };
          assert.equal(await canAccessShipmentLabel({ shipment, label }), false, `${source} ${status} must not grant access`);
        }
      }
      funding = { status: "COMPLETED", source: "TEST" };
      assert.equal(await canAccessShipmentLabel({ shipment, label }), false, "test funding must not grant access");
      funding = { status: "COMPLETED", source: "BUSINESS_WALLET" };
      pendingAmendment = { _id: new mongoose.Types.ObjectId() };
      assert.equal(await canAccessShipmentLabel({ shipment, label }), false, "an unpaid increase must keep the label blocked");
      pendingAmendment = null;

      funding = null;
      assert.equal(await canAccessShipmentLabel({ shipment, label }), false, "missing funding must fail closed");
      assert.deepEqual(fundingFilter, { shipmentDraftId });

      assert.equal(await canAccessShipmentLabel({
        shipment: { shipmentDraftId, createdAt: now },
        label: { createdAt: now }
      }), false, "missing policy metadata must not be classified as historical");
    } finally {
      fundingModel.findOne = previousFundingFindOne;
      amendmentModel.findOne = previousAmendmentFindOne;
    }
  });

  test("historical labels bypass legacy invoice and funding checks only with the configured proof", async () => {
    const beforeActivation = new Date("2026-10-01T00:00:00.000Z");
    const fundingModel = ShipmentFunding as unknown as { findOne: (filter: unknown) => unknown };
    const previousFundingFindOne = fundingModel.findOne;
    const previousActivation = env.LABEL_PAYMENT_POLICY_ACTIVATED_AT;
    let fundingLookups = 0;
    try {
      env.LABEL_PAYMENT_POLICY_ACTIVATED_AT = "2026-11-01T00:00:00.000Z";
      fundingModel.findOne = () => {
        fundingLookups += 1;
        return queryResult(null);
      };
      assert.equal(await canAccessShipmentLabel({
        shipment: { shipmentDraftId: new mongoose.Types.ObjectId(), createdAt: beforeActivation },
        label: { createdAt: beforeActivation, generatedAt: beforeActivation }
      }), true);
      assert.equal(fundingLookups, 0, "historical labels need neither ShipmentFunding nor invoice settlement");
    } finally {
      fundingModel.findOne = previousFundingFindOne;
      env.LABEL_PAYMENT_POLICY_ACTIVATED_AT = previousActivation;
    }
  });

  test("label URL issuance and signed file retrieval apply the same payment policy", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const shipmentId = new mongoose.Types.ObjectId();
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const labelId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId();
    const storageKey = `shipments/${shipmentDraftId}/labels/label.pdf`;
    const oldDate = new Date("2026-10-01T00:00:00.000Z");
    const activation = new Date(Date.now() - 1_000).toISOString();
    const context = { tenantId, kind: "SWIFTLINE" as const };
    let shipment: Record<string, unknown> = {
      _id: shipmentId,
      shipmentDraftId,
      createdAt: new Date(),
      labelPaymentPolicy: "PAYMENT_REQUIRED"
    };
    const label = {
      _id: labelId,
      dpdShipmentId: shipmentId,
      tenantId,
      parcelNumber: "SLC-TEST-01",
      labelType: "SWIFTLINE",
      format: "PDF",
      labelSize: "A6",
      fileChecksum: "sha256:test-label",
      storageKey,
      generatedAt: new Date(),
      createdAt: new Date(),
      downloadCount: 0,
      lastDownloadedAt: null,
      async save() { this.downloadCount += 1; }
    };
    let funding: { status: string; source: string } | null = { status: "SECURED", source: "BUSINESS_WALLET" };
    let shipmentOwnerTenantId = tenantId;
    const queryModels = {
      tenant: Tenant as unknown as { findOne: (filter: unknown) => unknown },
      shipment: DpdShipment as unknown as {
        findById: (id: unknown) => unknown;
        findOne: (filter: unknown) => unknown;
      },
      label: LabelDocument as unknown as { findOne: (filter: unknown) => unknown },
      draft: ShipmentDraft as unknown as { findById: (id: unknown) => unknown },
      account: BusinessAccount as unknown as { findById: (id: unknown) => unknown },
      funding: ShipmentFunding as unknown as { findOne: (filter: unknown) => unknown },
      amendment: ShipmentAmendment as unknown as { findOne: (filter: unknown) => unknown },
      audit: AuditLog as unknown as { create: (document: unknown) => Promise<unknown> }
    };
    const previous = {
      tenantFindOne: queryModels.tenant.findOne,
      shipmentFindById: queryModels.shipment.findById,
      shipmentFindOne: queryModels.shipment.findOne,
      labelFindOne: queryModels.label.findOne,
      draftFindById: queryModels.draft.findById,
      accountFindById: queryModels.account.findById,
      fundingFindOne: queryModels.funding.findOne,
      amendmentFindOne: queryModels.amendment.findOne,
      auditCreate: queryModels.audit.create,
      storageDriver: env.STORAGE_DRIVER,
      labelPolicyActivation: env.LABEL_PAYMENT_POLICY_ACTIVATED_AT,
      objectExists: localStorageDriver.objectExists,
      getObjectStream: localStorageDriver.getObjectStream
    };

    try {
      env.LABEL_PAYMENT_POLICY_ACTIVATED_AT = activation;
      env.STORAGE_DRIVER = "local";
      queryModels.tenant.findOne = () => queryResult({ _id: tenantId });
      queryModels.shipment.findById = () => queryResult(shipment);
      queryModels.shipment.findOne = (filter) => {
        const requestedTenantId = (filter as { tenantId?: mongoose.Types.ObjectId }).tenantId;
        return queryResult(String(requestedTenantId) === String(shipmentOwnerTenantId) ? shipment : null);
      };
      queryModels.label.findOne = () => queryResult(label);
      queryModels.draft.findById = () => queryResult({ businessAccountId });
      queryModels.account.findById = () => queryResult({ status: "active", suspension: { mode: "" } });
      queryModels.funding.findOne = () => queryResult(funding);
      queryModels.amendment.findOne = () => queryResult(null);
      queryModels.audit.create = async () => [];
      localStorageDriver.objectExists = async () => true;
      localStorageDriver.getObjectStream = async () => Readable.from([Buffer.from("label bytes")]);

      const accessRequest = {
        protocol: "https",
        host: "portal.example.test",
        params: { id: String(shipmentId) },
        query: { labelId: String(labelId) },
        user: { _id: actorId }
      } as unknown as Request;
      const blockedAccess = jsonResponse();
      await runWithTenantContext(context, () => createDpdLabelAccessUrl(accessRequest, blockedAccess.response));
      assert.equal(blockedAccess.state.status, 402);

      const fileToken = createLabelAccessToken({
        dpdShipmentId: String(shipmentId),
        labelId: String(labelId),
        userId: String(actorId),
        expiresAt: new Date(Date.now() + 60_000),
        tenantId,
        tenantKind: "SWIFTLINE"
      });
      const blockedFile = streamResponse();
      await downloadDpdLabelWithToken({
        params: { id: String(shipmentId) },
        query: { token: fileToken }
      } as unknown as Request, blockedFile.response);
      assert.equal(blockedFile.stream.statusCode, 402);

      funding = { status: "COMPLETED", source: "BUSINESS_WALLET" };
      const paidAccess = jsonResponse();
      await runWithTenantContext(context, () => createDpdLabelAccessUrl(accessRequest, paidAccess.response));
      assert.equal(paidAccess.state.status, 200);
      const signedUrl = new URL((paidAccess.state.body as { url: string }).url);
      const paidFile = streamResponse();
      await downloadDpdLabelWithToken({
        params: { id: String(shipmentId) },
        query: { token: signedUrl.searchParams.get("token") ?? "" }
      } as unknown as Request, paidFile.response);
      assert.deepEqual(Buffer.concat(paidFile.chunks), Buffer.from("label bytes"));

      shipment = { _id: shipmentId, shipmentDraftId, createdAt: oldDate };
      label.createdAt = oldDate;
      label.generatedAt = oldDate;
      funding = null;
      const historicalAccess = jsonResponse();
      await runWithTenantContext(context, () => createDpdLabelAccessUrl(accessRequest, historicalAccess.response));
      assert.equal(historicalAccess.state.status, 200, "a pre-policy label is available without a funding record");
      const historicalUrl = new URL((historicalAccess.state.body as { url: string }).url);
      const historicalFile = streamResponse();
      await downloadDpdLabelWithToken({
        params: { id: String(shipmentId) },
        query: { token: historicalUrl.searchParams.get("token") ?? "" }
      } as unknown as Request, historicalFile.response);
      assert.deepEqual(Buffer.concat(historicalFile.chunks), Buffer.from("label bytes"));

      const unauthorized = jsonResponse();
      await createDpdLabelAccessUrl({ ...accessRequest, user: undefined } as unknown as Request, unauthorized.response);
      assert.equal(unauthorized.state.status, 401);

      shipmentOwnerTenantId = new mongoose.Types.ObjectId();
      const crossTenantFile = streamResponse();
      await downloadDpdLabelWithToken({
        params: { id: String(shipmentId) },
        query: { token: fileToken }
      } as unknown as Request, crossTenantFile.response);
      assert.equal(crossTenantFile.stream.statusCode, 404, "a shipment outside the token tenant remains hidden");
    } finally {
      queryModels.tenant.findOne = previous.tenantFindOne;
      queryModels.shipment.findById = previous.shipmentFindById;
      queryModels.shipment.findOne = previous.shipmentFindOne;
      queryModels.label.findOne = previous.labelFindOne;
      queryModels.draft.findById = previous.draftFindById;
      queryModels.account.findById = previous.accountFindById;
      queryModels.funding.findOne = previous.fundingFindOne;
      queryModels.amendment.findOne = previous.amendmentFindOne;
      queryModels.audit.create = previous.auditCreate;
      env.STORAGE_DRIVER = previous.storageDriver;
      env.LABEL_PAYMENT_POLICY_ACTIVATED_AT = previous.labelPolicyActivation;
      localStorageDriver.objectExists = previous.objectExists;
      localStorageDriver.getObjectStream = previous.getObjectStream;
    }
  });
});
