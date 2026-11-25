import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { CreditPayment } from "../models/creditPayment.model.js";
import { calculateCreditRestriction } from "../services/creditOverdue.service.js";
import { creditPaymentMatchesRequest } from "../services/creditPayment.service.js";

describe("credit collection policy", () => {
  const dueAt = new Date("2026-07-01T00:00:00.000Z");

  test("moves through grace, credit-only restriction and full booking restriction", () => {
    assert.equal(calculateCreditRestriction({
      oldestDueAt: dueAt,
      gracePeriodDays: 2,
      maxOverdueDays: 10,
      now: new Date("2026-07-03T00:00:00.000Z")
    }).level, "GRACE_WARNING");

    assert.equal(calculateCreditRestriction({
      oldestDueAt: dueAt,
      gracePeriodDays: 2,
      maxOverdueDays: 10,
      now: new Date("2026-07-05T00:00:00.000Z")
    }).level, "CREDIT_BLOCKED");

    assert.equal(calculateCreditRestriction({
      oldestDueAt: dueAt,
      gracePeriodDays: 2,
      maxOverdueDays: 10,
      now: new Date("2026-07-13T00:00:00.000Z")
    }).level, "ALL_BOOKINGS_BLOCKED");
  });

  test("accepts an adjustment-only statement without changing an older statement total", async () => {
    const statement = new CreditBillingStatement({
      statementNumber: "CBS/26-27/00999",
      businessAccountId: new mongoose.Types.ObjectId(),
      creditAccountId: new mongoose.Types.ObjectId(),
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-06-30T18:30:00.000Z"),
      periodEnd: new Date("2026-07-31T18:30:00.000Z"),
      issuedAt: new Date("2026-08-01T04:30:00.000Z"),
      dueAt: new Date("2026-08-31T04:30:00.000Z"),
      currency: "INR",
      lines: [],
      adjustments: [{
        adjustmentId: new mongoose.Types.ObjectId(),
        shipmentInvoiceId: new mongoose.Types.ObjectId(),
        originalStatementId: new mongoose.Types.ObjectId(),
        description: "Additional credit charge from an approved shipment update.",
        amountMinor: 500,
        affectsAmountDue: true
      }],
      totalAmountMinor: 500,
      paidAmountMinor: 0,
      creditAdjustmentMinor: 0,
      outstandingAmountMinor: 500,
      status: "ISSUED",
      createdBy: new mongoose.Types.ObjectId()
    });
    await statement.validate();
    assert.equal(statement.totalAmountMinor, 500);
  });

  test("accepts only idempotent retries for the same payment identity", () => {
    const businessAccountId = new mongoose.Types.ObjectId();
    const requestedStatementId = new mongoose.Types.ObjectId();
    const payment = {
      businessAccountId,
      requestedStatementId,
      amountMinor: 5000,
      method: "RAZORPAY" as const
    };

    assert.equal(creditPaymentMatchesRequest(payment, {
      ...payment,
      idempotencyKey: "payment-request-1"
    }), true);
    assert.equal(creditPaymentMatchesRequest(payment, {
      ...payment,
      businessAccountId: new mongoose.Types.ObjectId(),
      idempotencyKey: "payment-request-1"
    }), false);
    assert.equal(creditPaymentMatchesRequest(payment, {
      ...payment,
      amountMinor: 5001,
      idempotencyKey: "payment-request-1"
    }), false);
  });

  test("enforces one offline payment reference per business and method", () => {
    const indexes = CreditPayment.schema.indexes();
    const offlineReferenceIndex = indexes.find((index) => {
      const fields = index[0] as Record<string, unknown>;
      return fields.businessAccountId === 1 && fields.method === 1 && fields.externalReference === 1;
    });

    assert.ok(offlineReferenceIndex);
    assert.equal(offlineReferenceIndex[1].unique, true);
  });
});
