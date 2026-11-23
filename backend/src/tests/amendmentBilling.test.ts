import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AmendmentBillingError,
  calculateAmendmentBillingAdjustment
} from "../services/amendmentBilling.service.js";

describe("amendment billing allocation policy", () => {
  test("funds an increase from Customer Advance before credit", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 75_000,
      previousAdvanceAppliedMinor: 20_000,
      previousCreditOutstandingMinor: 30_000,
      availableAdvanceMinor: 10_000,
      availableCreditMinor: 20_000
    });

    assert.equal(result.advanceUsedMinor, 10_000);
    assert.equal(result.creditUsedMinor, 15_000);
    assert.equal(result.advanceAppliedMinor, 30_000);
    assert.equal(result.creditOutstandingMinor, 45_000);
  });

  test("reduces outstanding credit before refunding Customer Advance", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 5_000,
      previousAdvanceAppliedMinor: 10_000,
      previousCreditOutstandingMinor: 40_000,
      availableAdvanceMinor: 0,
      availableCreditMinor: 0
    });

    assert.equal(result.creditReducedMinor, 40_000);
    assert.equal(result.advanceRefundedMinor, 5_000);
    assert.equal(result.advanceAppliedMinor, 5_000);
    assert.equal(result.creditOutstandingMinor, 0);
  });

  // A settled invoice has nothing left on its statement to unwind, so a
  // reduction has to come back as Customer Advance instead. Only reachable now
  // that a shipment can be re-weighed after its invoice was billed and paid.
  test("returns a reduction on a fully paid invoice to Customer Advance", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 45_000,
      // Paying the statement cleared the outstanding credit without moving it
      // into the applied advance, so both allocations read zero.
      previousAdvanceAppliedMinor: 0,
      previousCreditOutstandingMinor: 0,
      availableAdvanceMinor: 0,
      availableCreditMinor: 0
    });

    assert.equal(result.creditReducedMinor, 0);
    assert.equal(result.advanceRefundedMinor, 0);
    assert.equal(result.advanceCreditedMinor, 5_000);
    assert.equal(result.advanceAppliedMinor, 0);
    assert.equal(result.creditOutstandingMinor, 0);
    assert.equal(result.settledAmountMinor, 45_000);
  });

  test("splits a reduction on a part-paid invoice across credit and Customer Advance", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 40_000,
      previousAdvanceAppliedMinor: 0,
      previousCreditOutstandingMinor: 4_000,
      availableAdvanceMinor: 0,
      availableCreditMinor: 0
    });

    assert.equal(result.creditReducedMinor, 4_000);
    assert.equal(result.advanceRefundedMinor, 0);
    assert.equal(result.advanceCreditedMinor, 6_000);
    assert.equal(result.creditOutstandingMinor, 0);
    assert.equal(result.settledAmountMinor, 40_000);
  });

  test("funds an increase on a fully paid invoice without disturbing what was settled", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 60_000,
      previousAdvanceAppliedMinor: 0,
      previousCreditOutstandingMinor: 0,
      availableAdvanceMinor: 4_000,
      availableCreditMinor: 10_000
    });

    assert.equal(result.advanceUsedMinor, 4_000);
    assert.equal(result.creditUsedMinor, 6_000);
    assert.equal(result.advanceCreditedMinor, 0);
    assert.equal(result.settledAmountMinor, 50_000);
  });

  test("funds a prepaid amendment increase without using credit", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 62_500,
      previousAdvanceAppliedMinor: 50_000,
      previousCreditOutstandingMinor: 0,
      availableAdvanceMinor: 12_500,
      availableCreditMinor: 0,
      insufficientMessage: "Pay the additional amendment amount before approval."
    });

    assert.equal(result.advanceUsedMinor, 12_500);
    assert.equal(result.creditUsedMinor, 0);
    assert.equal(result.advanceAppliedMinor, 62_500);
    assert.equal(result.creditOutstandingMinor, 0);
    assert.equal(result.settledAmountMinor, 0);
  });

  test("leaves an unpaid reduction entirely on credit and applied advance", () => {
    const result = calculateAmendmentBillingAdjustment({
      previousAmountMinor: 50_000,
      amendedAmountMinor: 45_000,
      previousAdvanceAppliedMinor: 10_000,
      previousCreditOutstandingMinor: 40_000,
      availableAdvanceMinor: 0,
      availableCreditMinor: 0
    });

    assert.equal(result.advanceCreditedMinor, 0);
    assert.equal(result.settledAmountMinor, 0);
  });

  test("rejects an increase when combined capacity is insufficient", () => {
    assert.throws(
      () => calculateAmendmentBillingAdjustment({
        previousAmountMinor: 50_000,
        amendedAmountMinor: 75_000,
        previousAdvanceAppliedMinor: 20_000,
        previousCreditOutstandingMinor: 30_000,
        availableAdvanceMinor: 5_000,
        availableCreditMinor: 19_999
      }),
      (error) => error instanceof AmendmentBillingError && error.statusCode === 402
    );
  });
});
