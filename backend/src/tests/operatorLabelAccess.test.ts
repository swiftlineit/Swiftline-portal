import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { buildStoredLabelAccess, downloadDpdLabelWithToken } from "../controllers/dpdShipment.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import { Tenant } from "../models/tenant.model.js";
import { createLabelAccessToken, verifyLabelAccessToken } from "../services/shipmentLabelAccessToken.service.js";
import { localStorageDriver } from "../services/storage/localDriver.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

function queryResult<T>(value: T) {
  return {
    select() { return this; },
    lean() { return this; },
    exec: async () => value
  };
}

describe("signed operator label download", () => {
  test("issues support label links bound to the operator and support session", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const shipmentId = new mongoose.Types.ObjectId();
    const labelId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const supportSessionId = new mongoose.Types.ObjectId();
    let labelFilter: unknown;

    const labelModel = LabelDocument as unknown as { findOne: (filter: unknown) => unknown };
    const previousLabelFindOne = labelModel.findOne;
    const generatedAt = new Date("2026-10-24T08:30:00.000Z");

    try {
      labelModel.findOne = (filter) => {
        labelFilter = filter;
        return queryResult({
          _id: labelId,
          dpdShipmentId: shipmentId,
          parcelNumber: "OP-TRACK-01",
          labelType: "INTERNAL",
          format: "PDF",
          labelSize: "A6",
          fileChecksum: "sha256:label",
          generatedAt,
          downloadCount: 4,
          lastDownloadedAt: null
        });
      };

      const access = await runWithTenantContext({
        tenantId,
        kind: "OPERATOR",
        readOnly: true,
        supportSessionId
      }, () => buildStoredLabelAccess({
        request: { protocol: "https", host: "portal.example.test" } as Request,
        dpdShipmentId: String(shipmentId),
        labelId: String(labelId),
        userId: actorId,
        disposition: "inline"
      }));

      assert.ok(access);
      assert.deepEqual(labelFilter, { _id: labelId, dpdShipmentId: shipmentId });
      assert.equal(access.label.labelType, "INTERNAL");
      assert.equal(access.label.downloadCount, 4);

      const token = new URL(access.url).searchParams.get("token");
      assert.ok(token);
      const claims = verifyLabelAccessToken(token);
      assert.ok(claims);
      assert.equal(String(claims.tenantId), String(tenantId));
      assert.equal(claims.tenantKind, "OPERATOR");
      assert.equal(claims.readOnly, true);
      assert.equal(String(claims.supportSessionId), String(supportSessionId));
      assert.equal(String(claims.userId), String(actorId));
      assert.equal(claims.dpdShipmentId, String(shipmentId));
      assert.equal(claims.labelId, String(labelId));
      assert.equal(claims.expiresAt.toISOString(), access.expiresAt.toISOString());
      assert.match(access.url, /^https:\/\/portal\.example\.test\//);
    } finally {
      labelModel.findOne = previousLabelFindOne;
    }
  });

  test("scopes signed downloads and preserves Swiftline counter behavior", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const shipmentId = new mongoose.Types.ObjectId();
    const labelId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const supportSessionId = new mongoose.Types.ObjectId();
    const swiftlineTenantId = new mongoose.Types.ObjectId();
    const storageKey = `shipments/${new mongoose.Types.ObjectId()}/labels/label.pdf`;
    const auditWrites: unknown[] = [];
    let labelSaveCount = 0;
    let tenantFilter: unknown;
    let sessionFilter: unknown;
    let shipmentFilter: unknown;
    let labelFilter: unknown;
    let currentLabel: typeof label;

    const tenantModel = Tenant as unknown as { findOne: (filter: unknown) => unknown };
    const sessionModel = OperatorSupportSession as unknown as { findOne: (filter: unknown) => unknown };
    const shipmentModel = DpdShipment as unknown as { findOne: (filter: unknown) => unknown };
    const labelModel = LabelDocument as unknown as { findOne: (filter: unknown) => unknown };
    const auditModel = AuditLog as unknown as { create: (document: unknown) => Promise<unknown> };
    const previous = {
      tenantFindOne: tenantModel.findOne,
      sessionFindOne: sessionModel.findOne,
      shipmentFindOne: shipmentModel.findOne,
      labelFindOne: labelModel.findOne,
      auditCreate: auditModel.create,
      objectExists: localStorageDriver.objectExists,
      getObjectStream: localStorageDriver.getObjectStream,
      storageDriver: env.STORAGE_DRIVER
    };

    const label = {
      _id: labelId,
      dpdShipmentId: shipmentId,
      tenantId,
      storageKey,
      format: "PDF",
      labelType: "INTERNAL",
      labelSize: "A6",
      parcelNumber: "OP-TRACK-01",
      downloadCount: 4,
      async save() { labelSaveCount += 1; }
    };
    currentLabel = label;

    try {
      tenantModel.findOne = (filter) => {
        tenantFilter = filter;
        return queryResult({ _id: (filter as { _id: mongoose.Types.ObjectId })._id });
      };
      sessionModel.findOne = (filter) => {
        sessionFilter = filter;
        return queryResult({ _id: supportSessionId });
      };
      shipmentModel.findOne = (filter) => {
        shipmentFilter = filter;
        return queryResult({ _id: shipmentId });
      };
      labelModel.findOne = (filter) => {
        labelFilter = filter;
        return queryResult(currentLabel);
      };
      auditModel.create = async (document) => {
        auditWrites.push(document);
        return [];
      };
      env.STORAGE_DRIVER = "local";
      localStorageDriver.objectExists = async () => true;
      localStorageDriver.getObjectStream = async () => Readable.from([Buffer.from("internal-label")]);

      const token = createLabelAccessToken({
        dpdShipmentId: String(shipmentId),
        labelId: String(labelId),
        userId: String(actorId),
        expiresAt: new Date(Date.now() + 60_000),
        tenantId,
        tenantKind: "OPERATOR",
        readOnly: true,
        supportSessionId
      });
      const request = {
        params: { id: String(shipmentId) },
        query: { token, disposition: "attachment" }
      } as unknown as Request;
      const responseStream = new PassThrough() as PassThrough & {
        setHeader: (name: string, value: string) => PassThrough;
        headersSent: boolean;
      };
      responseStream.headersSent = false;
      responseStream.setHeader = () => responseStream;
      const body: Buffer[] = [];
      responseStream.on("data", (chunk: Buffer) => body.push(chunk));

      await downloadDpdLabelWithToken(request, responseStream as unknown as Response);

      assert.deepEqual(tenantFilter, { _id: tenantId, kind: "OPERATOR", status: "ACTIVE" });
      const currentSessionFilter = sessionFilter as {
        _id: mongoose.Types.ObjectId;
        operatorTenantId: mongoose.Types.ObjectId;
        actorUserId: mongoose.Types.ObjectId;
        endedAt: null;
        expiresAt: { $gt: Date };
      };
      assert.equal(String(currentSessionFilter._id), String(supportSessionId));
      assert.equal(String(currentSessionFilter.operatorTenantId), String(tenantId));
      assert.equal(String(currentSessionFilter.actorUserId), String(actorId));
      assert.equal(currentSessionFilter.endedAt, null);
      assert.ok(currentSessionFilter.expiresAt.$gt instanceof Date);
      assert.ok(currentSessionFilter.expiresAt.$gt.getTime() >= Date.now() - 1_000);
      assert.deepEqual(shipmentFilter, { _id: shipmentId, tenantId });
      assert.deepEqual(labelFilter, { _id: labelId, dpdShipmentId: shipmentId, tenantId });
      assert.equal(labelSaveCount, 0);
      assert.equal(label.downloadCount, 4);
      assert.deepEqual(Buffer.concat(body), Buffer.from("internal-label"));
      assert.equal(auditWrites.length, 1);
      const audit = auditWrites[0] as { performedBy: mongoose.Types.ObjectId; metadata: Record<string, unknown> };
      assert.equal(String(audit.performedBy), String(actorId));
      assert.equal(audit.metadata.accessMode, "platform_support");
      assert.equal(audit.metadata.supportSessionId, String(supportSessionId));
      assert.equal("downloadCount" in audit.metadata, false);

      const swiftlineLabel = {
        ...label,
        tenantId: swiftlineTenantId,
        downloadCount: 2,
        async save() { labelSaveCount += 1; }
      };
      currentLabel = swiftlineLabel;
      auditWrites.length = 0;
      const swiftlineToken = createLabelAccessToken({
        dpdShipmentId: String(shipmentId),
        labelId: String(labelId),
        userId: String(actorId),
        expiresAt: new Date(Date.now() + 60_000),
        tenantId: swiftlineTenantId,
        tenantKind: "SWIFTLINE"
      });
      const swiftlineRequest = {
        params: { id: String(shipmentId) },
        query: { token: swiftlineToken }
      } as unknown as Request;
      const swiftlineResponse = new PassThrough() as PassThrough & {
        setHeader: (name: string, value: string) => PassThrough;
        headersSent: boolean;
      };
      swiftlineResponse.headersSent = false;
      swiftlineResponse.setHeader = () => swiftlineResponse;

      await downloadDpdLabelWithToken(swiftlineRequest, swiftlineResponse as unknown as Response);

      assert.deepEqual(tenantFilter, { _id: swiftlineTenantId, kind: "SWIFTLINE", status: "ACTIVE" });
      assert.deepEqual(shipmentFilter, { _id: shipmentId, tenantId: swiftlineTenantId });
      assert.deepEqual(labelFilter, { _id: labelId, dpdShipmentId: shipmentId, tenantId: swiftlineTenantId });
      assert.equal(labelSaveCount, 1);
      assert.equal(swiftlineLabel.downloadCount, 3);
      const swiftlineAudit = auditWrites[0] as { metadata: Record<string, unknown> };
      assert.equal(swiftlineAudit.metadata.accessMode, "signed");
      assert.equal(swiftlineAudit.metadata.downloadCount, 3);
    } finally {
      tenantModel.findOne = previous.tenantFindOne;
      sessionModel.findOne = previous.sessionFindOne;
      shipmentModel.findOne = previous.shipmentFindOne;
      labelModel.findOne = previous.labelFindOne;
      auditModel.create = previous.auditCreate;
      localStorageDriver.objectExists = previous.objectExists;
      localStorageDriver.getObjectStream = previous.getObjectStream;
      env.STORAGE_DRIVER = previous.storageDriver;
    }
  });
});
