import assert from "node:assert/strict";
import test from "node:test";
import { setAccessToken } from "@/lib/auth";
import {
  requestClientShipmentCancellation,
  ShipmentCancellationRequestError
} from "@/lib/shipmentCancellations";

test("client cancellation requests preserve the HTTP status for UI handling", async () => {
  const originalFetch = globalThis.fetch;
  setAccessToken("test-access-token");

  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    message: "Cancellation requests are paused while this account is suspended."
  }), {
    status: 423,
    headers: { "Content-Type": "application/json" }
  });

  try {
    await assert.rejects(
      requestClientShipmentCancellation("draft-123", "Test cancellation reason"),
      (error: unknown) => error instanceof ShipmentCancellationRequestError
        && error.status === 423
        && error.message === "Cancellation requests are paused while this account is suspended."
    );
  } finally {
    globalThis.fetch = originalFetch;
    setAccessToken(null);
  }
});
