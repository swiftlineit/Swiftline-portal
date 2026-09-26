import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findShipmentStateCode, findStateCode, type GeographyState } from "@/lib/geography";

const usStates: GeographyState[] = [
  { name: "Ohio", code: "OH" },
  { name: "Texas", code: "TX" }
];

describe("shipment state codes", () => {
  test("uses numeric U.S. customs codes without changing shared geography codes", () => {
    assert.equal(findShipmentStateCode("United States", usStates, "Ohio"), "39");
    assert.equal(findStateCode(usStates, "Ohio"), "OH");
  });

  test("falls back to the reference code outside the numeric U.S. mapping", () => {
    const states = [{ name: "Greater London", code: "LND" }];
    assert.equal(findShipmentStateCode("United Kingdom", states, "Greater London"), "LND");
  });
});
