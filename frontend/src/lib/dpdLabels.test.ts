import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findRecordedLaterStatusMilestones,
  firstAllowedOperationalStatus
} from "./dpdLabels";

describe("shipment status choices", () => {
  it("offers the same next normal milestone as the backend sequence", () => {
    assert.equal(
      firstAllowedOperationalStatus(["SHIPMENT_BOOKED", "PARCEL_COLLECTED"]),
      "WAREHOUSE_SCAN_IN"
    );
  });

  it("blocks an earlier choice after canonical or legacy later milestones", () => {
    assert.deepEqual(
      findRecordedLaterStatusMilestones("ORIGIN_HUB_PROCESSED", [
        "WAREHOUSE_SCAN_IN",
        "EXPORT_CUSTOMS_CLEARED",
        "FLIGHT_DEPARTED"
      ]),
      ["READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED", "IN_TRANSIT"]
    );
  });
});
