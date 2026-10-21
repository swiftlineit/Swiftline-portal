import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCancellationAmounts,
  calculateCancellationSettlement,
  getCancellationEligibility
} from "../services/shipmentCancellation.service.js";

describe("shipment cancellation policy", () => {
  it("adds 18% GST to the standard INR 700 fee", () => {
    assert.deepEqual(calculateCancellationAmounts(200_000), {
      feeBaseMinor: 70_000,
      feeGstMinor: 12_600,
      feeTotalMinor: 82_600,
      refundableAmountMinor: 117_400,
      feeWasCapped: false
    });
  });

  it("allows a cancellation fee below INR 700 and calculates the refund", () => {
    assert.deepEqual(calculateCancellationAmounts(200_000, 10_000), {
      feeBaseMinor: 10_000,
      feeGstMinor: 1_800,
      feeTotalMinor: 11_800,
      refundableAmountMinor: 188_200,
      feeWasCapped: false
    });
  });

  it("allows a zero cancellation fee and refunds the full shipment charge", () => {
    assert.deepEqual(calculateCancellationAmounts(200_000, 0), {
      feeBaseMinor: 0,
      feeGstMinor: 0,
      feeTotalMinor: 0,
      refundableAmountMinor: 200_000,
      feeWasCapped: false
    });
  });

  it("caps the fee at a low-value shipment without creating a new charge", () => {
    assert.deepEqual(calculateCancellationAmounts(50_000), {
      feeBaseMinor: 42_373,
      feeGstMinor: 7_627,
      feeTotalMinor: 50_000,
      refundableAmountMinor: 0,
      feeWasCapped: true
    });
  });

  it("keeps the cancellation charge but applies no GST to a no-GST shipment", () => {
    assert.deepEqual(calculateCancellationAmounts(200_000, 70_000, "NO_GST"), {
      feeBaseMinor: 70_000,
      feeGstMinor: 0,
      feeTotalMinor: 70_000,
      refundableAmountMinor: 130_000,
      feeWasCapped: false
    });
    assert.deepEqual(calculateCancellationAmounts(50_000, 70_000, "NO_GST"), {
      feeBaseMinor: 50_000,
      feeGstMinor: 0,
      feeTotalMinor: 50_000,
      refundableAmountMinor: 0,
      feeWasCapped: true
    });
  });

  it("splits a partly settled shipment into refund and remaining fee credit", () => {
    assert.deepEqual(calculateCancellationSettlement({
      originalAmountMinor: 200_000,
      feeTotalMinor: 82_600,
      refundableAmountMinor: 117_400,
      currentCreditOutstandingMinor: 150_000
    }), {
      originalCreditReversedMinor: 150_000,
      cancellationFeeCreditMinor: 32_600,
      cancellationFeeSettledMinor: 50_000,
      netCreditReleasedMinor: 117_400,
      customerAdvanceCreditedMinor: 0
    });
  });

  it("returns a fully settled refund to Customer Advance", () => {
    assert.deepEqual(calculateCancellationSettlement({
      originalAmountMinor: 200_000,
      feeTotalMinor: 82_600,
      refundableAmountMinor: 117_400,
      currentCreditOutstandingMinor: 0
    }), {
      originalCreditReversedMinor: 0,
      cancellationFeeCreditMinor: 0,
      cancellationFeeSettledMinor: 82_600,
      netCreditReleasedMinor: 0,
      customerAdvanceCreditedMinor: 117_400
    });
  });

  it("uses a prior advance allocation before leaving a cancellation fee on credit", () => {
    assert.deepEqual(calculateCancellationSettlement({
      originalAmountMinor: 200_000,
      feeTotalMinor: 82_600,
      refundableAmountMinor: 117_400,
      currentCreditOutstandingMinor: 100_000
    }), {
      originalCreditReversedMinor: 100_000,
      cancellationFeeCreditMinor: 0,
      cancellationFeeSettledMinor: 82_600,
      netCreditReleasedMinor: 100_000,
      customerAdvanceCreditedMinor: 17_400
    });
  });

  it("enforces the client and admin cancellation cutoffs", () => {
    assert.equal(getCancellationEligibility({
      requesterType: "CLIENT",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasWarehouseScanOrLater: false,
      alreadyCancelled: false
    }).allowed, false);
    assert.equal(getCancellationEligibility({
      requesterType: "ADMIN",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasWarehouseScanOrLater: false,
      alreadyCancelled: false
    }).allowed, true);
    assert.equal(getCancellationEligibility({
      requesterType: "ADMIN",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasWarehouseScanOrLater: true,
      alreadyCancelled: false
    }).allowed, false);
  });
});
