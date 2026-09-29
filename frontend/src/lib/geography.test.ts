import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { findShipmentStateCode, findStateCode, matchStateName, type GeographyState } from "@/lib/geography";

const referenceStates = JSON.parse(
  readFileSync(new URL("../../../backend/data/reference/states.json", import.meta.url), "utf8"),
) as Record<string, GeographyState[]>;

const usStates: GeographyState[] = [
  { name: "Ohio", code: "OH" },
  { name: "Texas", code: "TX" }
];

describe("shipment state codes", () => {
  test("uses numeric U.S. customs codes without changing shared geography codes", () => {
    assert.equal(findShipmentStateCode("United States", usStates, "Ohio"), "39");
    assert.equal(findShipmentStateCode("USA", usStates, "Ohio"), "39");
    assert.equal(findStateCode(usStates, "Ohio"), "OH");
  });

  test("restores the canonical option name for uppercased saved states", () => {
    assert.equal(matchStateName(usStates, "OHIO"), "Ohio");
    assert.equal(matchStateName(usStates, "OH"), "Ohio");
  });

  test("falls back to the reference code outside the numeric U.S. mapping", () => {
    const states = [{ name: "Greater London", code: "LND" }];
    assert.equal(findShipmentStateCode("United Kingdom", states, "Greater London"), "LND");
  });

  test("maps verified country-specific codes while retaining other letter codes", () => {
    const cases = [
      ["US", "American Samoa", "60"],
      ["US", "Puerto Rico", "72"],
      ["CA", "Ontario", "35"],
      ["CA", "Yukon", "60"],
      ["DE", "Baden-Württemberg", "08"],
      ["ES", "Cantabria", "06"],
      ["ES", "Estremadura", "11"],
      ["IT", "Abruzzo", "13"],
      ["IT", "Sicily", "19"],
      ["FR", "Corse", "94"],
      ["FR", "Mayotte", "06"],
      ["GB", "Wolverhampton", "WLV"],
      ["ES", "A Coruña", "C"],
      ["IT", "Bari", "BA"],
      ["US", "Armed Forces Pacific", "AP"],
    ] as const;

    for (const [country, stateName, expected] of cases) {
      const states = referenceStates[country];
      assert.equal(findShipmentStateCode(country, states, stateName), expected, `${country}: ${stateName}`);
    }

    assert.equal(findStateCode(referenceStates.GB, "Wolverhampton"), "WLV");
    assert.equal(findStateCode(referenceStates.CA, "Ontario"), "ON");
  });

  test("covers every verified numeric entry in the current reference list", () => {
    // Spain has duplicate province/community names for Cantabria and La Rioja.
    const mappedEntryCounts = { US: 57, CA: 13, DE: 16, ES: 21, IT: 20, FR: 18 };

    for (const [country, expectedCount] of Object.entries(mappedEntryCounts)) {
      const states = referenceStates[country];
      const mapped = states.filter((state) =>
        findShipmentStateCode(country, states, state.name) !== state.code,
      );

      assert.equal(mapped.length, expectedCount, country);
      for (const state of mapped) {
        assert.match(findShipmentStateCode(country, states, state.name), /^\d{2}$/, `${country}: ${state.name}`);
      }
    }
  });
});
