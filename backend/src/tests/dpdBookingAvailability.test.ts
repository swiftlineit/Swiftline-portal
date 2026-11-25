import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDpdLabelBookingAvailable } from "../services/bookingPause.service.js";

describe("DPD label booking availability", () => {
  it("requires the operational switch, ALS switch, and valid ALS configuration", () => {
    assert.equal(isDpdLabelBookingAvailable({
      bookingEnabled: true,
      alsEnabled: false,
      alsConfigurationReady: true
    }), false);
    assert.equal(isDpdLabelBookingAvailable({
      bookingEnabled: true,
      alsEnabled: true,
      alsConfigurationReady: false
    }), false);
  });

  it("keeps the existing enabled-by-default behavior when all prerequisites are ready", () => {
    assert.equal(isDpdLabelBookingAvailable({
      bookingEnabled: undefined,
      alsEnabled: true,
      alsConfigurationReady: true
    }), true);
    assert.equal(isDpdLabelBookingAvailable({
      bookingEnabled: false,
      alsEnabled: true,
      alsConfigurationReady: true
    }), false);
  });
});
