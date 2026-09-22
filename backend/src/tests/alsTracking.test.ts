import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { CarrierTrackingEvent } from "../models/carrierTrackingEvent.model.js";
import { CarrierTrackingSync } from "../models/carrierTrackingSync.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import {
  assessAlsTrackingMilestone,
  ingestAlsEvents,
  runAlsTrackingSweep,
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

describe("ALS sweep rollout boundary", () => {
  it("does not enrol the eligible population when the new-sync limit is zero", async () => {
    const previous = {
      enabled: env.ALS_TRACKING_ENABLED,
      maxNew: env.ALS_TRACKING_SWEEP_MAX_NEW_SYNCS,
      allowlist: env.ALS_TRACKING_SWEEP_AWB_ALLOWLIST
    };
    try {
      env.ALS_TRACKING_ENABLED = true;
      env.ALS_TRACKING_SWEEP_MAX_NEW_SYNCS = 0;
      env.ALS_TRACKING_SWEEP_AWB_ALLOWLIST = "";
      mock.method(ShipmentEvent, "distinct", () => { throw new Error("Must not enumerate shipments"); });
      mock.method(CarrierTrackingSync, "find", () => ({
        sort: () => ({ limit: () => ({ exec: async () => [] }) })
      }) as never);
      const result = await runAlsTrackingSweep();
      assert.equal(result.created, 0);
      assert.equal(result.attempted, 0);
    } finally {
      Object.assign(env, {
        ALS_TRACKING_ENABLED: previous.enabled,
        ALS_TRACKING_SWEEP_MAX_NEW_SYNCS: previous.maxNew,
        ALS_TRACKING_SWEEP_AWB_ALLOWLIST: previous.allowlist
      });
      mock.restoreAll();
    }
  });

  it("enrols only an allowlisted AWB and stops at the per-run cap", async () => {
    const previous = {
      enabled: env.ALS_TRACKING_ENABLED,
      maxNew: env.ALS_TRACKING_SWEEP_MAX_NEW_SYNCS,
      allowlist: env.ALS_TRACKING_SWEEP_AWB_ALLOWLIST
    };
    const drafts = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    let created = 0;
    try {
      env.ALS_TRACKING_ENABLED = true;
      env.ALS_TRACKING_SWEEP_MAX_NEW_SYNCS = 1;
      env.ALS_TRACKING_SWEEP_AWB_ALLOWLIST = "1017000002";
      mock.method(ShipmentEvent, "distinct", () => ({ exec: async () => drafts }) as never);
      mock.method(ShipmentEvent, "exists", async () => ({ _id: new mongoose.Types.ObjectId() }));
      mock.method(DpdShipment, "findOne", (filter: unknown) => ({
        exec: async () => ({ _id: new mongoose.Types.ObjectId(),
          dpdShipmentId: String((filter as { shipmentDraftId: mongoose.Types.ObjectId }).shipmentDraftId
            .equals(drafts[0]) ? "1017000001" : "1017000002") })
      }) as never);
      mock.method(CarrierTrackingSync, "exists", async () => null);
      mock.method(CarrierTrackingSync, "findOneAndUpdate", () => ({
        exec: async () => { created += 1; return { _id: new mongoose.Types.ObjectId() }; }
      }) as never);
      mock.method(CarrierTrackingSync, "find", () => ({
        sort: () => ({ limit: () => ({ exec: async () => [] }) })
      }) as never);
      const result = await runAlsTrackingSweep();
      assert.equal(result.created, 1);
      assert.equal(created, 1);
      assert.equal(result.attempted, 0);
    } finally {
      Object.assign(env, {
        ALS_TRACKING_ENABLED: previous.enabled,
        ALS_TRACKING_SWEEP_MAX_NEW_SYNCS: previous.maxNew,
        ALS_TRACKING_SWEEP_AWB_ALLOWLIST: previous.allowlist
      });
      mock.restoreAll();
    }
  });
});

describe("ALS-specific milestone safety", () => {
  const historicalArrival = [
    "SHIPMENT_BOOKED", "WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED",
    "READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED", "DESTINATION_ARRIVED"
  ];

  it("accepts verified last-mile progress despite an older missing transit scan", () => {
    assert.deepEqual(assessAlsTrackingMilestone("OUT_FOR_DELIVERY", historicalArrival), {
      missing: [], later: []
    });
    // ALS may provide delivery without a separately mappable OFD scan.
    assert.deepEqual(assessAlsTrackingMilestone("DELIVERED", historicalArrival), {
      missing: [], later: []
    });
  });

  it("does not let an ALS event bypass the sequence for a merely booked shipment", () => {
    assert.deepEqual(
      assessAlsTrackingMilestone("DELIVERED", ["SHIPMENT_BOOKED"]).missing,
      ["WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED", "READY_FOR_EXPORT",
        "ORIGIN_HUB_DISPATCHED", "IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"]
    );
  });

  it("does not create a regressive milestone after delivery", () => {
    assert.deepEqual(
      assessAlsTrackingMilestone("OUT_FOR_DELIVERY", [...historicalArrival, "DELIVERED"]).later,
      ["DELIVERED"]
    );
    assert.deepEqual(
      assessAlsTrackingMilestone("DESTINATION_ARRIVED", ["IN_TRANSIT", "OUT_FOR_DELIVERY"]).later,
      ["OUT_FOR_DELIVERY"]
    );
  });

  it("trusts a real transit event without fabricating missing origin rows", () => {
    assert.deepEqual(assessAlsTrackingMilestone("DESTINATION_ARRIVED", ["IN_TRANSIT"]), {
      missing: [], later: []
    });
    assert.deepEqual(assessAlsTrackingMilestone("DELIVERED", ["IN_TRANSIT"]), {
      missing: [], later: []
    });
  });
});

describe("ALS review replay", () => {
  it("applies a held carrier event even when ALS no longer returns it", async () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const dpdShipmentId = new mongoose.Types.ObjectId();
    const rawPayload = {
      id: "held-ofd", event_at: "2026-09-19 15:46:00", event_state: "redrs",
      event_description: "Out for delivery", event_location: "Wolverhampton",
      add_country_code: "GB"
    };
    const held = {
      _id: new mongoose.Types.ObjectId(), providerEventKey: "held-ofd",
      providerEventId: "held-ofd", eventState: "redrs",
      description: "Out for delivery", location: "Wolverhampton",
      rawPayload, processingStatus: "REVIEW_REQUIRED", processingNote: "Missing IN_TRANSIT."
    };
    const statuses = [
      "SHIPMENT_BOOKED", "WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED",
      "READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED", "DESTINATION_ARRIVED"
    ];
    const created: Array<{ status: string; eventAt: Date }> = [];
    try {
      mock.method(DpdShipment, "findById", () => ({
        select: () => ({ lean: () => ({ exec: async () => null }) })
      }) as never);
      mock.method(ShipmentEvent, "find", () => ({
        select: () => ({ lean: () => ({ exec: async () => statuses.map((status) => ({ status })) }) })
      }) as never);
      mock.method(ShipmentEvent, "exists", async () => null);
      mock.method(ShipmentEvent, "create", async (value: unknown) => {
        const row = value as { status: string; eventAt: Date };
        created.push(row);
        statuses.push(row.status);
        return row;
      });
      mock.method(CarrierTrackingEvent, "find", () => ({
        lean: () => ({ exec: async () => held.processingStatus === "REVIEW_REQUIRED" ? [held] : [] })
      }) as never);
      mock.method(CarrierTrackingEvent, "findOne", () => ({ exec: async () => held }) as never);
      mock.method(CarrierTrackingEvent, "updateOne", (_filter: unknown, update: unknown) => ({
        exec: async () => {
          const set = (update as { $set: { processingStatus: string; processingNote: string } }).$set;
          held.processingStatus = set.processingStatus;
          held.processingNote = set.processingNote;
          return { modifiedCount: 1 };
        }
      }) as never);

      const input = { shipmentDraftId, dpdShipmentId, carrierAwbNumber: "1017000000", events: [] };
      const first = await ingestAlsEvents(input);
      assert.equal(first.applied, 1);
      assert.equal(first.reviewRequired, 0);
      assert.equal(held.processingStatus, "APPLIED");
      assert.equal(created[0]?.status, "OUT_FOR_DELIVERY");
      assert.equal(created[0]?.eventAt.toISOString(), "2026-09-19T10:16:00.000Z");

      const second = await ingestAlsEvents(input);
      assert.equal(second.applied, 0);
      assert.equal(created.length, 1);
    } finally {
      mock.restoreAll();
    }
  });

  it("records a late or unknown ALS update without changing a delivered shipment", async () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const dpdShipmentId = new mongoose.Types.ObjectId();
    const rawRows: Array<{ processingStatus: string; processingNote: string }> = [];
    try {
      mock.method(DpdShipment, "findById", () => ({
        select: () => ({ lean: () => ({ exec: async () => null }) })
      }) as never);
      mock.method(ShipmentEvent, "find", () => ({
        select: () => ({ lean: () => ({ exec: async () => [
          { status: "DESTINATION_ARRIVED" }, { status: "DELIVERED" }
        ] }) })
      }) as never);
      mock.method(ShipmentEvent, "create", async () => { throw new Error("Must not add a shipment milestone"); });
      mock.method(CarrierTrackingEvent, "find", () => ({
        lean: () => ({ exec: async () => [] })
      }) as never);
      mock.method(CarrierTrackingEvent, "findOne", () => ({ exec: async () => null }) as never);
      mock.method(CarrierTrackingEvent, "create", async (value: unknown) => {
        rawRows.push(value as { processingStatus: string; processingNote: string });
        return value;
      });

      const result = await ingestAlsEvents({
        shipmentDraftId, dpdShipmentId, carrierAwbNumber: "1017000001",
        events: [
          event({ id: "late-ofd", eventState: "redrs", description: "Out for delivery" }),
          event({ id: "unknown", eventState: "redrs", description: "Unknown redirect" })
        ]
      });
      assert.equal(result.applied, 0);
      assert.equal(result.reviewRequired, 1);
      assert.equal(rawRows[0]?.processingStatus, "IGNORED");
      assert.match(rawRows[0]?.processingNote ?? "", /Later milestone/);
      assert.equal(rawRows[1]?.processingStatus, "REVIEW_REQUIRED");
    } finally {
      mock.restoreAll();
    }
  });
});
