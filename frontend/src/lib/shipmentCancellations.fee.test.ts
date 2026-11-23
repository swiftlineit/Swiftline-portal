import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calculateCancellationFeeAmounts } from "./shipmentCancellations.js";

describe("cancellation fee preview", () => {
  test("supports zero and custom fees with applicable GST", () => {
    assert.deepEqual(
      calculateCancellationFeeAmounts(200_000, "GST_APPLICABLE", "0"),
      {
        requestedBaseMinor: 0,
        feeBaseMinor: 0,
        feeGstMinor: 0,
        feeTotalMinor: 0,
        refundMinor: 200_000,
        capped: false
      }
    );
    assert.deepEqual(
      calculateCancellationFeeAmounts(200_000, "GST_APPLICABLE", "800"),
      {
        requestedBaseMinor: 80_000,
        feeBaseMinor: 80_000,
        feeGstMinor: 14_400,
        feeTotalMinor: 94_400,
        refundMinor: 105_600,
        capped: false
      }
    );
  });

  test("caps the fee at the shipment total and rejects invalid input", () => {
    assert.deepEqual(
      calculateCancellationFeeAmounts(10_000, "GST_APPLICABLE", "700"),
      {
        requestedBaseMinor: 70_000,
        feeBaseMinor: 8_475,
        feeGstMinor: 1_525,
        feeTotalMinor: 10_000,
        refundMinor: 0,
        capped: true
      }
    );
    assert.equal(calculateCancellationFeeAmounts(200_000, "NO_GST", "-1"), null);
    assert.equal(calculateCancellationFeeAmounts(200_000, "NO_GST", ""), null);
  });
});
