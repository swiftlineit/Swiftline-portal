import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmentDirectPaymentFailureTransition } from "../services/prepaid/shipmentDirectPayments.service.js";

describe("direct shipment payment retry transition", () => {
  it("reopens the same order while clearing only its failed payment attempt", () => {
    const transition = buildShipmentDirectPaymentFailureTransition({
      orderId: "order_123",
      paymentId: "pay_failed_456",
      code: "PAYMENT_FAILED",
      description: "The issuer declined this attempt."
    });

    assert.deepEqual(transition, {
      filter: {
        razorpayOrderId: "order_123",
        status: { $in: ["ORDER_CREATED", "PROCESSING"] },
        $or: [{ razorpayPaymentId: "" }, { razorpayPaymentId: "pay_failed_456" }]
      },
      update: {
        $set: {
          status: "ORDER_CREATED",
          razorpayPaymentId: "",
          razorpaySignature: "",
          failureCode: "PAYMENT_FAILED",
          failureDescription: "The issuer declined this attempt."
        }
      }
    });
  });

  it("ignores a failure event without payment and order identifiers", () => {
    assert.equal(buildShipmentDirectPaymentFailureTransition({ orderId: "order_123", paymentId: "" }), null);
    assert.equal(buildShipmentDirectPaymentFailureTransition({ orderId: "", paymentId: "pay_123" }), null);
  });
});
