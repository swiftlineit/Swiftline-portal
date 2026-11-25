import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock, test } from "node:test";
import mongoose from "mongoose";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DpdBookingSetting } from "../models/dpdBookingSetting.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import {
  createClientShipmentDirectPayment,
  verifyClientShipmentDirectPayment
} from "../controllers/shipmentDirectPayment.controller.js";

function responseRecorder() {
  let statusCode = 200;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return response;
    }
  } as unknown as Response;
  return { response, read: () => ({ statusCode, body }) };
}

function requestFor(input: {
  draftId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  body: Record<string, unknown>;
}) {
  return {
    params: { id: String(input.draftId) },
    body: input.body,
    user: { _id: input.userId },
    header: () => undefined
  } as unknown as Request;
}

function mockDraftAccess(
  context: typeof mock,
  draftId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  payment: InstanceType<typeof ShipmentDirectPayment> | null = null
) {
  const draft = {
    _id: draftId,
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    __v: 0,
    consigneeEnteredAddress: { countryCode: "GB" }
  };
  context.method(ShipmentDraft, "findOne", () => ({
    exec: async () => draft
  }) as never);
  context.method(BusinessAccountMember, "findOne", () => ({
    select: () => ({
      lean: () => ({
        exec: async () => ({ role: "account_owner", assignedBranches: [] })
      })
    })
  }) as never);
  context.method(DpdBookingSetting, "findOne", () => ({
    select: () => ({
      lean: () => ({
        exec: async () => ({ enabled: true })
      })
    })
  }) as never);
  if (payment) {
    context.method(ShipmentDirectPayment, "findOne", () => ({
      exec: async () => payment
    }) as never);
  }
}

function withAlsDisabled<T>(work: () => Promise<T>) {
  const previous = env.ALS_ENABLED;
  env.ALS_ENABLED = false;
  return work().finally(() => {
    env.ALS_ENABLED = previous;
  });
}

test("direct payment creation rejects DPD-required shipments before opening checkout when ALS is disabled", async () => {
  const draftId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  mockDraftAccess(mock, draftId, userId);

  try {
    await withAlsDisabled(async () => {
      const recorder = responseRecorder();
      await createClientShipmentDirectPayment(
        requestFor({
          draftId,
          userId,
          body: { acceptedPricingHash: "accepted-price" }
        }),
        recorder.response
      );

      const result = recorder.read();
      assert.equal(result.statusCode, 423);
      assert.equal(result.body.code, "DPD_BOOKING_DISABLED");
    });
  } finally {
    mock.restoreAll();
  }
});

test("explicit no-DPD choice passes the ALS preflight without creating an order", async () => {
  const draftId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  mockDraftAccess(mock, draftId, userId);

  try {
    await withAlsDisabled(async () => {
      const recorder = responseRecorder();
      await createClientShipmentDirectPayment(
        requestFor({
          draftId,
          userId,
          body: { acceptedPricingHash: "accepted-price", skipDpdLabel: true }
        }),
        recorder.response
      );

      const result = recorder.read();
      assert.equal(result.statusCode, 400);
      assert.match(String(result.body.message), /Idempotency-Key/i);
    });
  } finally {
    mock.restoreAll();
  }
});

test("payment verification does not capture an authorized payment if ALS becomes unavailable", async () => {
  const draftId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();
  const orderId = "order_offline_authorized";
  const gatewayPaymentId = "pay_offline_authorized";
  const paymentSecret = "offline-verification-secret";
  const payment = {
    _id: paymentId,
    shipmentDraftId: draftId,
    razorpayOrderId: orderId,
    amountMinor: 12500,
    currency: "INR"
  } as InstanceType<typeof ShipmentDirectPayment>;
  mockDraftAccess(mock, draftId, userId, payment);

  const previousSecret = env.RAZORPAY_KEY_SECRET;
  const previousFetch = globalThis.fetch;
  let captureRequests = 0;
  env.RAZORPAY_KEY_SECRET = paymentSecret;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/payments/${gatewayPaymentId}`) && !url.endsWith("/capture")) {
      return new Response(JSON.stringify({
        id: gatewayPaymentId,
        order_id: orderId,
        amount: 12500,
        currency: "INR",
        status: "authorized"
      }));
    }
    if (url.endsWith(`/payments/${gatewayPaymentId}/capture`)) captureRequests += 1;
    throw new Error(`Unexpected payment-provider request: ${url} ${init?.method ?? "GET"}`);
  };

  try {
    await withAlsDisabled(async () => {
      const signature = crypto
        .createHmac("sha256", paymentSecret)
        .update(`${orderId}|${gatewayPaymentId}`)
        .digest("hex");
      const recorder = responseRecorder();
      await verifyClientShipmentDirectPayment(
        requestFor({
          draftId,
          userId,
          body: {
            razorpay_order_id: orderId,
            razorpay_payment_id: gatewayPaymentId,
            razorpay_signature: signature
          }
        }),
        recorder.response
      );

      const result = recorder.read();
      assert.equal(result.statusCode, 423);
      assert.equal(result.body.code, "DPD_BOOKING_DISABLED");
      assert.match(String(result.body.message), /before payment capture/i);
      assert.match(String(result.body.message), /temporary authorization/i);
      assert.equal(captureRequests, 0);
    });
  } finally {
    env.RAZORPAY_KEY_SECRET = previousSecret;
    globalThis.fetch = previousFetch;
    mock.restoreAll();
  }
});
