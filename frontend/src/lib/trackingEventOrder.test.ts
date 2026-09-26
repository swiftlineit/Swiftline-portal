import assert from "node:assert/strict";
import { test } from "node:test";
import { orderTrackingEvents } from "./trackingEventOrder";

test("orders late-written transit before the earlier out-for-delivery milestone", () => {
  const ordered = orderTrackingEvents([
    { status: "OUT_FOR_DELIVERY", eventAt: "2026-09-19T09:00:00.000Z" },
    { status: "IN_TRANSIT", eventAt: "2026-09-25T09:00:00.000Z" }
  ]);

  assert.deepEqual(ordered.map((event) => event.status), ["IN_TRANSIT", "OUT_FOR_DELIVERY"]);
});

test("keeps an active hold after the movement it interrupts", () => {
  const ordered = orderTrackingEvents([
    { status: "OUT_FOR_DELIVERY", eventAt: "2026-09-19T09:00:00.000Z" },
    { status: "ON_HOLD", eventAt: "2026-09-20T09:00:00.000Z" },
    { status: "RELEASED_FROM_HOLD", eventAt: "2026-09-21T09:00:00.000Z" }
  ]);

  assert.deepEqual(ordered.map((event) => event.status), [
    "OUT_FOR_DELIVERY",
    "ON_HOLD",
    "RELEASED_FROM_HOLD"
  ]);
});
