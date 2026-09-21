import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapAlsTrackingEvent,
  parseAlsIndiaTimestamp,
  parseAlsTrackingResponse,
  type AlsTrackingProviderEvent
} from "../services/als/alsTracking.service.js";

function event(overrides: Partial<AlsTrackingProviderEvent>): AlsTrackingProviderEvent {
  return {
    id: "1",
    eventAt: "2026-09-15 14:25:00",
    eventState: "in_transit",
    description: "Confirmed at depot",
    location: "Barking",
    countryCode: "GB",
    rawPayload: {},
    ...overrides
  };
}

describe("ALS tracking response", () => {
  it("parses the text/html JSON payload and keeps the carrier event identifiers", () => {
    const parsed = parseAlsTrackingResponse([{
      errors: false,
      tracking_no: "1017656879",
      docket_events: [{
        id: "519036",
        event_at: "2026-09-15 14:25:00",
        event_state: "redrs",
        event_description: "On vehicle for delivery Out For Delivery notification sent",
        event_location: "Barking",
        add_country_code: "GB"
      }]
    }], "1017656879");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, "519036");
    assert.equal(parsed[0]?.eventState, "redrs");
  });

  it("interprets ALS event_at in India time", () => {
    assert.equal(
      parseAlsIndiaTimestamp("2026-09-15 20:34:00")?.toISOString(),
      "2026-09-15T15:04:00.000Z"
    );
    assert.equal(parseAlsIndiaTimestamp("2026-09-31 20:34:00"), null);
  });

  it("maps only confirmed ALS combinations to public milestones", () => {
    assert.equal(mapAlsTrackingEvent(event({}), "GB"), "DESTINATION_ARRIVED");
    assert.equal(mapAlsTrackingEvent(event({ countryCode: "IN" }), "GB"), null);
    assert.equal(mapAlsTrackingEvent(event({
      eventState: "redrs",
      description: "On vehicle for delivery Out For Delivery notification sent"
    }), "GB"), "OUT_FOR_DELIVERY");
    assert.equal(mapAlsTrackingEvent(event({ eventState: "delivered", description: "Delivered" }), "GB"), "DELIVERED");
    assert.equal(mapAlsTrackingEvent(event({ eventState: "redrs", description: "Unknown redirect" }), "GB"), null);
    assert.equal(mapAlsTrackingEvent(event({ eventState: "entry", description: "SHIPMENT HAS BEEN BOOKED" }), "GB"), null);
  });
});
