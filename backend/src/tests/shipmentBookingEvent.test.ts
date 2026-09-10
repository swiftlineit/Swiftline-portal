import assert from "node:assert/strict";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import {
  buildShipmentBookedEventUpdate,
} from "../services/shipmentBookingEvent.service.js";

describe("shipment booking timeline event", () => {
  it("builds a customer-visible, canonical booking milestone", () => {
    const shipmentDraftId = new mongoose.Types.ObjectId();
    const dpdShipmentId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const eventAt = new Date("2026-09-09T08:30:00.000Z");

    const update = buildShipmentBookedEventUpdate({
      shipmentDraftId,
      dpdShipmentId,
      userId,
      eventAt,
      source: "SYSTEM",
      sourceReference: "PUBLIC_SHIPMENT_BOOKING:booking-1",
    });

    assert.deepEqual(update.$set, {
      dpdShipmentId,
      customerVisible: true,
    });
    assert.deepEqual(update.$setOnInsert, {
      shipmentDraftId,
      status: "SHIPMENT_BOOKED",
      milestoneKey: "SHIPMENT_BOOKED",
      note: "Shipment booked with carrier.",
      source: "SYSTEM",
      sourceReference: "PUBLIC_SHIPMENT_BOOKING:booking-1",
      customerVisible: true,
      createdBy: userId,
      eventAt,
    });
  });

  it("defaults new public events to the system source without changing the event time", () => {
    const eventAt = new Date("2026-09-09T08:30:00.000Z");
    const update = buildShipmentBookedEventUpdate({
      shipmentDraftId: new mongoose.Types.ObjectId(),
      dpdShipmentId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      eventAt,
    });

    assert.equal(update.$setOnInsert.source, "SYSTEM");
    assert.equal(update.$setOnInsert.sourceReference, "");
    assert.equal(update.$setOnInsert.eventAt, eventAt);
  });
});
