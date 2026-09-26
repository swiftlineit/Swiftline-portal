import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTrackingJourney,
  formatTrackingEventLabel,
  normalizeVisibleTrackingHistory,
  resolveCurrentTrackingEvent,
  resolveTrackingProfile
} from "../services/shipmentJourney.service.js";

const completedEvents = [
  "SHIPMENT_BOOKED",
  "PARCEL_COLLECTED",
  "WAREHOUSE_SCAN_IN",
  "ORIGIN_HUB_PROCESSED",
  "READY_FOR_EXPORT",
  "ORIGIN_HUB_DISPATCHED",
  "IN_TRANSIT",
  "DESTINATION_ARRIVED",
  "IMPORT_CUSTOMS_CLEARANCE",
  "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED",
  "DELIVERY_HUB_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DELIVERED"
].map((status, index) => ({
  status,
  eventAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString()
}));

describe("destination-aware shipment journey", () => {
  it("selects the four configured regional flows automatically", () => {
    assert.equal(resolveTrackingProfile("GB"), "UK");
    assert.equal(resolveTrackingProfile("US"), "USA");
    assert.equal(resolveTrackingProfile("CA"), "CANADA");
    assert.equal(resolveTrackingProfile("DE"), "EUROPE");
    assert.equal(resolveTrackingProfile("AE"), "OTHER");
  });

  it("treats Turkey as a Middle East lane, not a European one", () => {
    // Swiftline sells Turkey as Middle East and the rate card groups it that
    // way, so presenting it as a European shipment told the customer two
    // different stories about the same parcel.
    assert.equal(resolveTrackingProfile("TR"), "OTHER");

    // Its European neighbours are unaffected.
    for (const code of ["GR", "BG", "CY", "RO", "HR", "RS"]) {
      assert.equal(resolveTrackingProfile(code), "EUROPE", `${code} should still be EUROPE`);
    }
  });

  it("lets a route override the automatic choice", () => {
    // AUTO is only the default. A lane pinned to a profile keeps it, which is
    // the escape hatch if Turkey should ever read as European after all.
    assert.equal(resolveTrackingProfile("TR", "EUROPE"), "EUROPE");
    assert.equal(resolveTrackingProfile("DE", "OTHER"), "OTHER");
  });

  it("uses the approved international-transit wording on every lane", () => {
    const journey = buildTrackingJourney({
      destinationCountryCode: "TR",
      destinationCountryName: "Turkey",
      originHubName: "Delhi Hub",
      events: []
    });

    assert.equal(journey.context.profile, "OTHER");
    assert.equal(journey.context.destinationCountryName, "Turkey");
    assert.ok(
      journey.milestones.some((milestone) => milestone.label === "In International Transit"),
      "the transit milestone should use the approved customer wording"
    );
  });

  it("always presents UK shipments through LHR and the DPD Network", () => {
    const journey = buildTrackingJourney({
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      originHubName: "Delhi Hub",
      deliveryPartnerName: "Another Partner",
      events: completedEvents
    });

    assert.deepEqual(journey.context.routeSegments, ["Delhi Hub", "LHR Gateway", "DPD Network", "Delivery"]);
    assert.equal(journey.context.deliveryPartnerCode, "DPD");
    assert.equal(formatTrackingEventLabel("DESTINATION_ARRIVED", journey), "Arrived in Destination Country");
    assert.equal(formatTrackingEventLabel("DELIVERY_PARTNER_TRANSFERRED", journey), "Transferred to DPD Network");
    assert.equal(formatTrackingEventLabel("DELIVERY_HUB_ARRIVED", journey), "Arrived at DPD Delivery Hub");
  });

  it("uses the actual USA and Canada gateways", () => {
    const usa = buildTrackingJourney({
      destinationCountryCode: "US",
      destinationCountryName: "United States",
      deliveryPartnerName: "US Partner",
      events: completedEvents.map((event) => event.status === "DESTINATION_ARRIVED"
        ? { ...event, gatewayCode: "JFK" }
        : event)
    });
    const canada = buildTrackingJourney({
      destinationCountryCode: "CA",
      destinationCountryName: "Canada",
      events: completedEvents.map((event) => event.status === "DESTINATION_ARRIVED"
        ? { ...event, gatewayCode: "YVR" }
        : event)
    });

    assert.equal(formatTrackingEventLabel("DESTINATION_ARRIVED", usa), "Arrived in Destination Country");
    assert.equal(formatTrackingEventLabel("DESTINATION_ARRIVED", canada), "Arrived in Destination Country");
  });

  it("keeps the Europe wording and includes the destination-country leg", () => {
    const journey = buildTrackingJourney({
      destinationCountryCode: "DE",
      destinationCountryName: "Germany",
      originHubName: "Delhi Hub",
      events: completedEvents.map((event) => event.status === "DESTINATION_ARRIVED"
        ? { ...event, gatewayCode: "FRA" }
        : event)
    });

    assert.equal(formatTrackingEventLabel("ORIGIN_HUB_DISPATCHED", journey), "Departed from Origin Facility Delhi");
    assert.equal(journey.milestones.find((item) => item.key === "INTERNATIONAL_TRANSIT")?.label, "In International Transit");
    assert.deepEqual(journey.context.routeSegments, [
      "Delhi Hub",
      "FRA Gateway",
      "Destination Country",
      "Delivery Partner",
      "Delivery"
    ]);
  });

  it("ignores gateway data attached to dispatch instead of destination arrival", () => {
    const journey = buildTrackingJourney({
      destinationCountryCode: "CA",
      destinationCountryName: "Canada",
      events: [
        { status: "ORIGIN_HUB_DISPATCHED", eventAt: "2026-08-01T08:00:00.000Z", gatewayCode: "LHR" },
        { status: "DESTINATION_ARRIVED", eventAt: "2026-08-02T08:00:00.000Z" }
      ]
    });

    assert.equal(journey.context.gatewayCode, "");
    assert.equal(formatTrackingEventLabel("DESTINATION_ARRIVED", journey), "Arrived in Destination Country");
  });

  it("does not show international transit until an actual flight-departure event exists", () => {
    const dispatched = buildTrackingJourney({
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      originHubName: "Delhi Hub",
      events: [
        { status: "ORIGIN_HUB_DISPATCHED", eventAt: "2026-08-01T08:00:00.000Z" }
      ]
    });
    assert.equal(dispatched.milestones.find((item) => item.key === "ORIGIN_DISPATCHED")?.reachedAt !== null, true);
    assert.equal(dispatched.milestones.find((item) => item.key === "INTERNATIONAL_TRANSIT")?.reachedAt, null);

    const departed = buildTrackingJourney({
      destinationCountryCode: "GB",
      destinationCountryName: "United Kingdom",
      originHubName: "Delhi Hub",
      events: [
        { status: "ORIGIN_HUB_DISPATCHED", eventAt: "2026-08-01T08:00:00.000Z" },
        { status: "IN_TRANSIT", eventAt: "2026-08-01T12:00:00.000Z" }
      ]
    });
    assert.equal(departed.milestones.find((item) => item.key === "INTERNATIONAL_TRANSIT")?.reachedAt !== null, true);
  });

  it("keeps collection out of the nine-stage customer journey", () => {
    const journey = buildTrackingJourney({
      destinationCountryCode: "US",
      destinationCountryName: "United States",
      events: completedEvents.filter((event) => event.status !== "PARCEL_COLLECTED")
    });
    assert.equal(journey.milestones.some((item) => item.key === "COLLECTED"), false);
    assert.equal(journey.milestones.length, 9);
  });
});

describe("visible tracking history", () => {
  const journey = buildTrackingJourney({
    destinationCountryCode: "GB",
    destinationCountryName: "United Kingdom",
    originHubName: "Delhi Hub",
    events: []
  });

  it("collapses the two legacy export statuses into one Ready for Dispatch milestone", () => {
    const history = normalizeVisibleTrackingHistory([
      {
        status: "FLIGHT_ASSIGNED",
        eventAt: "2026-08-22T01:38:00.000Z",
        note: "Allocated to an outbound flight.",
        location: ""
      },
      {
        status: "EXPORT_CUSTOMS_CLEARED",
        eventAt: "2026-08-22T01:37:00.000Z",
        note: "Export customs clearance completed.",
        location: ""
      }
    ], journey);

    assert.equal(history.length, 1);
    assert.equal(history[0]?.statusLabel, "Ready for Dispatch");
    assert.equal(history[0]?.eventAt, "2026-08-22T01:37:00.000Z");
    assert.equal(history[0]?.note, "Shipment is ready for dispatch.");
  });

  it("collapses genuine repeated milestones but keeps repeatable holds", () => {
    const history = normalizeVisibleTrackingHistory([
      { status: "ON_HOLD", eventAt: "2026-08-23T09:00:00.000Z", note: "", location: "" },
      { status: "PARCEL_COLLECTED", eventAt: "2026-08-22T08:01:00.000Z", note: "", location: "" },
      { status: "PARCEL_COLLECTED", eventAt: "2026-08-22T08:00:00.000Z", note: "", location: "" },
      { status: "ON_HOLD", eventAt: "2026-08-21T09:00:00.000Z", note: "", location: "" }
    ], journey);

    assert.equal(history.filter((event) => event.status === "PARCEL_COLLECTED").length, 1);
    assert.equal(history.filter((event) => event.status === "ON_HOLD").length, 2);
  });

  it("hides an impossible duplicate release until another hold occurs", () => {
    const history = normalizeVisibleTrackingHistory([
      { status: "ON_HOLD", eventAt: "2026-08-23T09:00:00.000Z", note: "Customs query", location: "LHR" },
      { status: "RELEASED_FROM_HOLD", eventAt: "2026-08-23T10:00:00.000Z", note: "Released", location: "LHR" },
      { status: "RELEASED_FROM_HOLD", eventAt: "2026-08-23T10:00:01.000Z", note: "Released", location: "LHR" },
      { status: "ON_HOLD", eventAt: "2026-08-24T09:00:00.000Z", note: "A new query", location: "LHR" },
      { status: "RELEASED_FROM_HOLD", eventAt: "2026-08-24T10:00:00.000Z", note: "Released again", location: "LHR" }
    ], journey);

    assert.equal(history.filter((event) => event.status === "RELEASED_FROM_HOLD").length, 2);
    assert.equal(history.filter((event) => event.status === "ON_HOLD").length, 2);
  });

  it("preserves an operator note and recorded location from a collapsed legacy group", () => {
    const history = normalizeVisibleTrackingHistory([
      {
        status: "EXPORT_CUSTOMS_CLEARED",
        eventAt: "2026-08-22T01:37:00.000Z",
        note: "",
        location: ""
      },
      {
        status: "FLIGHT_ASSIGNED",
        eventAt: "2026-08-22T01:38:00.000Z",
        note: "Confirmed on flight SL101.",
        location: "Delhi Airport"
      }
    ], journey);

    assert.equal(history.length, 1);
    assert.equal(history[0]?.note, "Confirmed on flight SL101.");
    assert.equal(history[0]?.location, "Delhi Airport");
  });

  it("normalizes history when a lightweight staff list does not load a journey", () => {
    const history = normalizeVisibleTrackingHistory([
      {
        status: "FLIGHT_ASSIGNED",
        eventAt: "2026-08-22T01:38:00.000Z",
        note: "Allocated to an outbound flight."
      },
      {
        status: "EXPORT_CUSTOMS_CLEARED",
        eventAt: "2026-08-22T01:37:00.000Z",
        note: "Export customs clearance completed."
      }
    ]);

    assert.equal(history.length, 1);
    assert.equal(history[0]?.statusLabel, "Ready for Dispatch");
    assert.equal(history[0]?.note, "Shipment is ready for dispatch.");
  });
});

describe("current tracking milestone", () => {
  it("keeps a late-written transit event from moving a shipment back from delivery", () => {
    const current = resolveCurrentTrackingEvent([
      { status: "OUT_FOR_DELIVERY", eventAt: "2026-09-19T09:00:00.000Z" },
      { status: "IN_TRANSIT", eventAt: "2026-09-25T09:00:00.000Z" }
    ]);

    assert.equal(current?.status, "OUT_FOR_DELIVERY");
  });

  it("keeps the latest active hold current even when a later milestone exists in history", () => {
    const current = resolveCurrentTrackingEvent([
      { status: "OUT_FOR_DELIVERY", eventAt: "2026-09-19T09:00:00.000Z" },
      { status: "ON_HOLD", eventAt: "2026-09-25T09:00:00.000Z" }
    ]);

    assert.equal(current?.status, "ON_HOLD");
  });

  it("resumes the furthest movement milestone after a hold is released", () => {
    const current = resolveCurrentTrackingEvent([
      { status: "OUT_FOR_DELIVERY", eventAt: "2026-09-19T09:00:00.000Z" },
      { status: "ON_HOLD", eventAt: "2026-09-20T09:00:00.000Z" },
      { status: "RELEASED_FROM_HOLD", eventAt: "2026-09-21T09:00:00.000Z" },
      { status: "IN_TRANSIT", eventAt: "2026-09-25T09:00:00.000Z" }
    ]);

    assert.equal(current?.status, "OUT_FOR_DELIVERY");
  });
});
