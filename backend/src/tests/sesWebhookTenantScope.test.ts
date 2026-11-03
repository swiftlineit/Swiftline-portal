import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { handleSesWebhook } from "../controllers/sesWebhook.controller.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { Tenant } from "../models/tenant.model.js";
import { getTenantContext } from "../services/tenantScope.service.js";

function queryResult<T>(value: T) {
  return {
    select() { return this; },
    lean() { return this; },
    exec: async () => value
  };
}

function responseRecorder() {
  let statusCode = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    }
  } as unknown as Response;

  return {
    response,
    get statusCode() { return statusCode; },
    get body() { return responseBody; }
  };
}

test("SES outbox callbacks update each message only inside its stored tenant context", async (context) => {
  const tenantCases = [
    { kind: "SWIFTLINE" as const },
    { kind: "OPERATOR" as const }
  ].map((item) => ({ ...item, tenantId: new mongoose.Types.ObjectId() }));
  const expectedRowIds: mongoose.Types.ObjectId[] = [];
  const updates: Array<{
    tenantId: mongoose.Types.ObjectId | undefined;
    filter: unknown;
    update: unknown;
  }> = [];

  const outboxModel = EmailOutbox as unknown as {
    collection: {
      find: (filter: unknown, options?: unknown) => { toArray: () => Promise<unknown[]> };
    };
    updateOne: (filter: unknown, update: unknown) => { exec: () => Promise<unknown> };
  };
  const tenantModel = Tenant as unknown as {
    findById: (id: mongoose.Types.ObjectId) => ReturnType<typeof queryResult>;
  };
  const original = {
    find: outboxModel.collection.find,
    updateOne: outboxModel.updateOne,
    findById: tenantModel.findById,
    webhookSecret: env.SES_WEBHOOK_SECRET
  };

  try {
    env.SES_WEBHOOK_SECRET = "test-ses-webhook-secret";

    for (const target of tenantCases) {
      const rowId = new mongoose.Types.ObjectId();
      expectedRowIds.push(rowId);
      const messageId = `ses-message-${target.kind.toLowerCase()}`;
      outboxModel.collection.find = (filter, options) => {
        assert.deepEqual(filter, { sesMessageId: messageId });
        assert.deepEqual(options, { projection: { _id: 1, tenantId: 1 } });
        return {
          toArray: async () => [{ _id: rowId, tenantId: target.tenantId }]
        };
      };
      tenantModel.findById = (id) => {
        assert.equal(String(id), String(target.tenantId));
        return queryResult({ _id: id, kind: target.kind });
      };
      outboxModel.updateOne = (filter, update) => {
        const tenantContext = getTenantContext();
        updates.push({
          tenantId: tenantContext?.tenantId,
          filter,
          update
        });
        return { exec: async () => ({ modifiedCount: 1 }) };
      };

      const recorder = responseRecorder();
      await handleSesWebhook({
        query: { token: "test-ses-webhook-secret" },
        body: {
          Type: "Notification",
          Message: JSON.stringify({ eventType: "Delivery", mail: { messageId } })
        }
      } as unknown as Request, recorder.response);

      assert.equal(recorder.statusCode, 200);
      assert.deepEqual(recorder.body, { success: true });
    }

    assert.deepEqual(updates.map((item) => String(item.tenantId)), tenantCases.map((item) => String(item.tenantId)));
    assert.deepEqual(updates.map((item) => item.filter), expectedRowIds.map((_id) => ({ _id })));
    assert.ok(updates.every((item) => {
      const payload = item.update as { $set?: { status?: string; lastError?: string } };
      return payload.$set?.status === "DELIVERED" && payload.$set.lastError === "";
    }));
  } finally {
    outboxModel.collection.find = original.find;
    outboxModel.updateOne = original.updateOne;
    tenantModel.findById = original.findById;
    env.SES_WEBHOOK_SECRET = original.webhookSecret;
  }
});

test("SES callback refuses to mutate an outbox row without a valid tenant owner", async (context) => {
  const originalFind = (EmailOutbox.collection as unknown as {
    find: (filter: unknown, options?: unknown) => { toArray: () => Promise<unknown[]> };
  }).find;
  const originalUpdateOne = (EmailOutbox as unknown as {
    updateOne: (filter: unknown, update: unknown) => { exec: () => Promise<unknown> };
  }).updateOne;
  const originalWebhookSecret = env.SES_WEBHOOK_SECRET;
  let updateCount = 0;

  try {
    env.SES_WEBHOOK_SECRET = "test-ses-webhook-secret";
    context.mock.method(console, "error", () => undefined);
    (EmailOutbox.collection as unknown as {
      find: (filter: unknown, options?: unknown) => { toArray: () => Promise<unknown[]> };
    }).find = () => ({ toArray: async () => [{ _id: new mongoose.Types.ObjectId(), tenantId: "invalid-owner" }] });
    (EmailOutbox as unknown as {
      updateOne: (filter: unknown, update: unknown) => { exec: () => Promise<unknown> };
    }).updateOne = () => {
      updateCount += 1;
      return { exec: async () => ({ modifiedCount: 1 }) };
    };

    const recorder = responseRecorder();
    await handleSesWebhook({
      query: { token: "test-ses-webhook-secret" },
      body: {
        Type: "Notification",
        Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "ses-message-without-owner" } })
      }
    } as unknown as Request, recorder.response);

    assert.equal(recorder.statusCode, 200);
    assert.deepEqual(recorder.body, { success: true });
    assert.equal(updateCount, 0);
  } finally {
    (EmailOutbox.collection as unknown as {
      find: (filter: unknown, options?: unknown) => { toArray: () => Promise<unknown[]> };
    }).find = originalFind;
    (EmailOutbox as unknown as {
      updateOne: (filter: unknown, update: unknown) => { exec: () => Promise<unknown> };
    }).updateOne = originalUpdateOne;
    env.SES_WEBHOOK_SECRET = originalWebhookSecret;
  }
});
