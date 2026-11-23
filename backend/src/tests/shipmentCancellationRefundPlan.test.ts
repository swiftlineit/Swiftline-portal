import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allocateCancellationRefund } from "../services/prepaid/cancellationRefunds.service.js";

describe("shipment cancellation gateway refund allocations", () => {
  test("allocates a refund across amendment and original payment captures without over-refunding", () => {
    const allocations = allocateCancellationRefund({
      amountMinor: 10_500,
      candidates: [
        { paymentId: "amendment-payment", amountMinor: 3_000 },
        { paymentId: "booking-payment", amountMinor: 10_000 }
      ]
    });

    assert.deepEqual(allocations, [
      { paymentId: "amendment-payment", amountMinor: 3_000 },
      { paymentId: "booking-payment", amountMinor: 7_500 }
    ]);
    assert.equal(allocations.reduce((total, allocation) => total + allocation.amountMinor, 0), 10_500);
  });

  test("rejects an allocation greater than the captured payment total", () => {
    assert.throws(
      () => allocateCancellationRefund({
        amountMinor: 10_501,
        candidates: [
          { paymentId: "amendment-payment", amountMinor: 3_000 },
          { paymentId: "booking-payment", amountMinor: 7_500 }
        ]
      }),
      /do not cover/
    );
  });

  test("rejects malformed captured amounts before building a gateway refund plan", () => {
    assert.throws(
      () => allocateCancellationRefund({
        amountMinor: 100,
        candidates: [{ paymentId: "booking-payment", amountMinor: 1.5 }]
      }),
      /valid captured amounts/
    );
  });
});
