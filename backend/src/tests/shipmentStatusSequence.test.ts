import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedOperationalStatuses,
  canonicalShipmentStatus,
  describeAlreadyRecorded,
  describeEventDateProblem,
  describeMissingPrerequisites,
  describeRecordedLaterMilestones,
  equivalentCurrentStatusValues,
  findMissingPrerequisites,
  findRecordedLaterMilestones,
  formatShipmentEventLabel,
  isOperationalStatus
} from "../services/shipmentStatusSequence.service.js";
import { ShipmentEvent, shipmentOperationalStatusValues } from "../models/shipmentEvent.model.js";

/** A shipment that has been booked but never scanned. */
const justBooked = ["SHIPMENT_BOOKED"];

describe("shipment status sequence", () => {
  it("defines a database uniqueness boundary for customer milestones", () => {
    const indexes = ShipmentEvent.schema.indexes() as Array<[
      Record<string, number>,
      { name?: string; unique?: boolean }
    ]>;
    const milestoneIndex = indexes.find(([, options]) =>
      options.name === "uniq_shipment_customer_milestone"
    );
    assert.ok(milestoneIndex);
    assert.equal(milestoneIndex[1].unique, true);
    assert.deepEqual(milestoneIndex[0], { shipmentDraftId: 1, milestoneKey: 1 });
  });

  it("lets a booked shipment record collection or enter directly at the hub", () => {
    assert.deepEqual(findMissingPrerequisites("PARCEL_COLLECTED", justBooked), []);
    assert.deepEqual(allowedOperationalStatuses(justBooked), ["PARCEL_COLLECTED", "WAREHOUSE_SCAN_IN"]);
  });

  it("blocks a jump past unrecorded steps and names every one of them", () => {
    assert.deepEqual(
      findMissingPrerequisites("READY_FOR_EXPORT", justBooked),
      ["WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED"]
    );
  });

  /**
   * A historical gap is now deliberately held for a controlled correction: a
   * normal update must not insert an earlier milestone after a later one.
   */
  it("does not offer an earlier gap after a later milestone exists", () => {
    const withGap = ["SHIPMENT_BOOKED", "PARCEL_COLLECTED", "READY_FOR_EXPORT"];

    // The earlier gap is not a normal operator update once a later milestone
    // exists; this prevents the timeline from being rewritten out of order.
    assert.deepEqual(findMissingPrerequisites("WAREHOUSE_SCAN_IN", withGap), []);
    assert.deepEqual(allowedOperationalStatuses(withGap), []);
    assert.deepEqual(
      findMissingPrerequisites("ORIGIN_HUB_PROCESSED", withGap),
      ["WAREHOUSE_SCAN_IN"]
    );
    assert.deepEqual(
      findMissingPrerequisites("ORIGIN_HUB_DISPATCHED", withGap),
      ["WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED"]
    );
  });

  it("removes an already recorded milestone from the staff choices", () => {
    const collected = ["SHIPMENT_BOOKED", "PARCEL_COLLECTED"];
    assert.deepEqual(findMissingPrerequisites("PARCEL_COLLECTED", collected), []);
    assert.deepEqual(allowedOperationalStatuses(collected), ["WAREHOUSE_SCAN_IN"]);
    assert.match(describeAlreadyRecorded("PARCEL_COLLECTED"), /already recorded/);
  });

  it("clears every rung once the whole ladder is walked in order", () => {
    const recorded: string[] = ["SHIPMENT_BOOKED"];

    for (const status of shipmentOperationalStatusValues) {
      assert.deepEqual(
        findMissingPrerequisites(status, recorded),
        [],
        `${status} should be reachable once everything before it is recorded`
      );
      recorded.push(status);
    }

    assert.deepEqual(allowedOperationalStatuses(recorded), []);
  });

  it("says nothing about statuses that are not on the ladder", () => {
    for (const offLadder of [
      "ON_HOLD",
      "RELEASED_FROM_HOLD",
      "SHIPMENT_CANCELLED",
      "IMPORT_CUSTOMS_CLEARANCE",
      "IMPORT_CUSTOMS_CLEARED",
      "DELIVERY_PARTNER_TRANSFERRED",
      "DELIVERY_HUB_ARRIVED",
      "LOST"
    ]) {
      assert.equal(isOperationalStatus(offLadder), false);
      assert.deepEqual(findMissingPrerequisites(offLadder, []), []);
    }
    assert.equal(isOperationalStatus("IN_TRANSIT"), true);
  });

  it("reads as a sentence for one missing step and for several", () => {
    assert.equal(
      describeMissingPrerequisites("ORIGIN_HUB_PROCESSED", ["WAREHOUSE_SCAN_IN"]),
      "Processing for Export cannot be recorded yet. Received at Origin Facility is still outstanding- "
        + "shipment progress must be recorded in order."
    );
    assert.equal(
      describeMissingPrerequisites("READY_FOR_EXPORT", [
        "WAREHOUSE_SCAN_IN",
        "ORIGIN_HUB_PROCESSED"
      ]),
      "Ready for Dispatch cannot be recorded yet. Received at Origin Facility and Processing for Export "
        + "are still outstanding- shipment progress must be recorded in order."
    );
  });

  it("titles a status the way the timeline shows it", () => {
    assert.equal(formatShipmentEventLabel("IMPORT_CUSTOMS_CLEARANCE"), "Customs Processing");
    assert.equal(formatShipmentEventLabel(""), "Shipment Created");
    assert.equal(formatShipmentEventLabel(null), "Shipment Created");
  });

  it("accepts historical export and flight events as aliases for the new flow", () => {
    const historical = [
      "SHIPMENT_BOOKED",
      "PARCEL_COLLECTED",
      "WAREHOUSE_SCAN_IN",
      "ORIGIN_HUB_PROCESSED",
      "EXPORT_CUSTOMS_CLEARED",
      "FLIGHT_DEPARTED"
    ];
    assert.deepEqual(findMissingPrerequisites("DESTINATION_ARRIVED", historical), []);
  });

  it("uses one canonical stage for historical aliases without rewriting stored events", () => {
    assert.equal(canonicalShipmentStatus("EXPORT_CUSTOMS_CLEARED"), "READY_FOR_EXPORT");
    assert.equal(canonicalShipmentStatus("FLIGHT_ASSIGNED"), "READY_FOR_EXPORT");
    assert.equal(canonicalShipmentStatus("FLIGHT_DEPARTED"), "IN_TRANSIT");
    assert.equal(canonicalShipmentStatus("DESTINATION_ARRIVED"), "DESTINATION_ARRIVED");
    assert.equal(formatShipmentEventLabel("FLIGHT_DEPARTED"), "In International Transit");
  });

  it("keeps one visible filter while matching every historical alias internally", () => {
    assert.deepEqual(equivalentCurrentStatusValues("READY_FOR_EXPORT"), [
      "READY_FOR_EXPORT",
      "EXPORT_CUSTOMS_CLEARED",
      "FLIGHT_ASSIGNED"
    ]);
    assert.deepEqual(equivalentCurrentStatusValues("EXPORT_CUSTOMS_CLEARED"), [
      "READY_FOR_EXPORT",
      "EXPORT_CUSTOMS_CLEARED",
      "FLIGHT_ASSIGNED"
    ]);
    assert.deepEqual(equivalentCurrentStatusValues("ORIGIN_HUB_DISPATCHED"), [
      "ORIGIN_HUB_DISPATCHED"
    ]);
    assert.deepEqual(equivalentCurrentStatusValues("IN_TRANSIT"), [
      "IN_TRANSIT",
      "FLIGHT_DEPARTED"
    ]);
  });

  it("keeps customs and partner activity outside the required customer ladder", () => {
    const throughDestination = [
      "WAREHOUSE_SCAN_IN",
      "ORIGIN_HUB_PROCESSED",
      "READY_FOR_EXPORT",
      "ORIGIN_HUB_DISPATCHED",
      "IN_TRANSIT",
      "DESTINATION_ARRIVED"
    ];
    assert.deepEqual(findMissingPrerequisites("OUT_FOR_DELIVERY", throughDestination), []);
    assert.deepEqual(findMissingPrerequisites("DELIVERED", throughDestination), ["OUT_FOR_DELIVERY"]);
  });

  it("blocks adding an earlier milestone after a later one exists", () => {
    const recorded = [
      "WAREHOUSE_SCAN_IN",
      "ORIGIN_HUB_PROCESSED",
      "READY_FOR_EXPORT",
      "ORIGIN_HUB_DISPATCHED"
    ];
    assert.deepEqual(findRecordedLaterMilestones("ORIGIN_HUB_PROCESSED", recorded), ["READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED"]);
    assert.match(
      describeRecordedLaterMilestones("ORIGIN_HUB_PROCESSED", ["ORIGIN_HUB_DISPATCHED"]),
      /cannot be recorded because Departed from Origin Facility is already recorded/
    );
  });
});

/**
 * The optional status date Operations may state instead of "now".
 *
 * Two limits, both about what the timeline reads like afterwards- see
 * describeEventDateProblem.
 */
describe("stated status date", () => {
  const now = new Date("2026-08-21T10:00:00.000Z");

  it("accepts a date between the last update and now", () => {
    assert.equal(
      describeEventDateProblem({
        eventAt: new Date("2026-08-20T09:00:00.000Z"),
        previousEventAt: new Date("2026-08-19T09:00:00.000Z"),
        now
      }),
      null
    );
  });

  it("accepts a shipment's first stated date, with nothing recorded before it", () => {
    assert.equal(
      describeEventDateProblem({ eventAt: new Date("2026-01-01T00:00:00.000Z"), previousEventAt: null, now }),
      null
    );
  });

  it("refuses a scan dated in the future", () => {
    const problem = describeEventDateProblem({ eventAt: new Date("2026-08-22T10:00:00.000Z"), now });
    assert.match(String(problem), /cannot be in the future/);
  });

  // Readers order on eventAt, so a date behind an existing event would show the
  // shipment standing at a stage it has already left.
  it("refuses a date earlier than the last recorded update, and names when that was", () => {
    const problem = describeEventDateProblem({
      eventAt: new Date("2026-08-18T09:00:00.000Z"),
      previousEventAt: new Date("2026-08-19T09:00:00.000Z"),
      now
    });
    assert.match(String(problem), /cannot be earlier than/);
    // Stated in the timezone the portal works in, not UTC.
    assert.match(String(problem), /19 Aug 2026/);
  });

  it("accepts a date exactly on the last recorded update", () => {
    const previousEventAt = new Date("2026-08-19T09:00:00.000Z");
    assert.equal(
      describeEventDateProblem({ eventAt: new Date(previousEventAt), previousEventAt, now }),
      null
    );
  });

  it("refuses a date that is not a date at all", () => {
    assert.equal(
      describeEventDateProblem({ eventAt: new Date("not a date"), now }),
      "Enter a valid status date."
    );
  });
});
