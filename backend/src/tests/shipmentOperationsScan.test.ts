import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  operationsScanStatus,
  resolveOperationsScanParcelNumbers
} from "../services/shipmentOperationsScan.service.js";

describe("origin tracking scan actions", () => {
  it("maps receiving and processing scans to stable backend milestone keys", () => {
    assert.equal(operationsScanStatus("RECEIVE"), "WAREHOUSE_SCAN_IN");
    assert.equal(operationsScanStatus("PROCESS"), "ORIGIN_HUB_PROCESSED");
  });

  it("uses frozen Swiftline parcel labels when the carrier parcel field is empty", () => {
    assert.deepEqual(resolveOperationsScanParcelNumbers({
      parcelNumbers: [],
      currentShipmentSnapshot: {
        version: 1,
        source: {},
        tracking: {},
        payment: {},
        pricing: {},
        parcels: [
          { swiftlineParcelNumber: "SLCAMD210926001-01" },
          { swiftlineParcelNumber: "SLCAMD210926001-02" }
        ]
      }
    }), ["SLCAMD210926001-01", "SLCAMD210926001-02"]);
  });

  it("falls back to stored Swiftline labels for legacy bookings without a snapshot", () => {
    assert.deepEqual(resolveOperationsScanParcelNumbers({
      parcelNumbers: [],
      swiftlineLabelParcelNumbers: ["slcamd210926001-01"]
    }), ["SLCAMD210926001-01"]);
  });
});
