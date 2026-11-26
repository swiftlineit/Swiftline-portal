import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateCancellationAmounts,
  calculateCancellationSettlement,
  getCancellationEligibility,
  isLegacyCreditOnlyFunding
} from "../services/shipmentCancellation.service.js";
import { getOperatorCancellationEligibility } from "../services/operatorShipmentCancellationPolicy.service.js";

describe("shipment cancellation financial rules", () => {
  test("classifies only Swiftline BUSINESS_ACCOUNT charges without funding records as legacy credit", () => {
    assert.equal(isLegacyCreditOnlyFunding({
      tenantKind: "SWIFTLINE",
      chargePaymentSource: "BUSINESS_ACCOUNT",
      fundingSource: null
    }), true);
    assert.equal(isLegacyCreditOnlyFunding({
      tenantKind: "SWIFTLINE",
      chargePaymentSource: "BUSINESS_ACCOUNT",
      fundingSource: "PREPAID"
    }), false);
    assert.equal(isLegacyCreditOnlyFunding({
      tenantKind: "OPERATOR",
      chargePaymentSource: "BUSINESS_ACCOUNT",
      fundingSource: null
    }), false);
    assert.equal(isLegacyCreditOnlyFunding({
      tenantKind: "SWIFTLINE",
      chargePaymentSource: "DIRECT_RAZORPAY",
      fundingSource: null
    }), false);
  });

  test("a zero fee preserves the full booked amount as refundable", () => {
    assert.deepEqual(calculateCancellationAmounts(100_000, 0), {
      feeBaseMinor: 0,
      feeGstMinor: 0,
      feeTotalMinor: 0,
      refundableAmountMinor: 100_000,
      feeWasCapped: false
    });
  });

  test("GST is calculated on the editable cancellation fee", () => {
    assert.deepEqual(calculateCancellationAmounts(100_000, 10_000), {
      feeBaseMinor: 10_000,
      feeGstMinor: 1_800,
      feeTotalMinor: 11_800,
      refundableAmountMinor: 88_200,
      feeWasCapped: false
    });
  });

  test("the fee cannot exceed the original invoice total", () => {
    const result = calculateCancellationAmounts(5_000, 7_000);
    assert.equal(result.feeTotalMinor, 5_000);
    assert.equal(result.refundableAmountMinor, 0);
    assert.equal(result.feeBaseMinor + result.feeGstMinor, 5_000);
    assert.equal(result.feeWasCapped, true);
  });

  test("credit settlement reverses the booking and leaves only the approved fee outstanding", () => {
    assert.deepEqual(calculateCancellationSettlement({
      originalAmountMinor: 100_000,
      feeTotalMinor: 11_800,
      refundableAmountMinor: 88_200,
      currentCreditOutstandingMinor: 100_000
    }), {
      originalCreditReversedMinor: 100_000,
      cancellationFeeCreditMinor: 11_800,
      cancellationFeeSettledMinor: 0,
      netCreditReleasedMinor: 88_200,
      customerAdvanceCreditedMinor: 0
    });
  });
});

describe("cancellation eligibility stays separate by tenant workflow", () => {
  test("clients retain their collection restriction while staff can cancel post-warehouse", () => {
    assert.equal(getCancellationEligibility({
      requesterType: "CLIENT",
      hasBooked: true,
      hasParcelCollectedOrLater: false,
      hasTerminalStatus: false,
      alreadyCancelled: false
    }).allowed, true);
    assert.equal(getCancellationEligibility({
      requesterType: "CLIENT",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasTerminalStatus: false,
      alreadyCancelled: false
    }).allowed, false);
    assert.equal(getCancellationEligibility({
      requesterType: "ADMIN",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasTerminalStatus: false,
      alreadyCancelled: false
    }).allowed, true);
    assert.equal(getCancellationEligibility({
      requesterType: "ADMIN",
      hasBooked: true,
      hasParcelCollectedOrLater: true,
      hasTerminalStatus: true,
      alreadyCancelled: false
    }).allowed, false);
  });

  test("operator shipments can be reviewed after dispatch but not after terminal delivery", () => {
    assert.equal(getOperatorCancellationEligibility({
      hasBooked: true,
      latestStatus: "ORIGIN_HUB_DISPATCHED",
      alreadyCancelled: false
    }).allowed, true);
    assert.equal(getOperatorCancellationEligibility({
      hasBooked: true,
      latestStatus: "DELIVERED",
      alreadyCancelled: false
    }).allowed, false);
  });
});
