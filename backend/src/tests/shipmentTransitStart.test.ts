import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveShipmentTransitStart } from "../services/shipmentTracking.service.js";

const oldDraftDate = new Date("2026-08-01T10:00:00.000Z");
const bookingDate = new Date("2026-10-09T10:00:00.000Z");

describe("shipment transit start", () => {
  test("uses the booking date for an old reusable draft that is not collected", () => {
    assert.equal(
      resolveShipmentTransitStart({ createdAt: oldDraftDate }, [], bookingDate).toISOString(),
      bookingDate.toISOString()
    );
  });

  test("uses the actual collection event once the parcel is collected", () => {
    const collectedAt = new Date("2026-10-10T09:00:00.000Z");
    assert.equal(
      resolveShipmentTransitStart(
        { createdAt: oldDraftDate },
        [{ status: "PARCEL_COLLECTED", eventAt: collectedAt }],
        bookingDate
      ).toISOString(),
      collectedAt.toISOString()
    );
  });

  test("uses the booking milestone before falling back to draft creation", () => {
    const eventBookingDate = new Date("2026-10-09T11:00:00.000Z");
    assert.equal(
      resolveShipmentTransitStart(
        { createdAt: oldDraftDate },
        [{ status: "SHIPMENT_BOOKED", eventAt: eventBookingDate }]
      ).toISOString(),
      eventBookingDate.toISOString()
    );
    assert.equal(
      resolveShipmentTransitStart({ createdAt: oldDraftDate }, [], null).toISOString(),
      oldDraftDate.toISOString()
    );
  });
});
