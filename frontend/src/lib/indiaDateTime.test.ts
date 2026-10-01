import assert from "node:assert/strict";
import { it } from "node:test";
import { indiaDateTimeLocalToIso, isoToIndiaDateTimeLocal } from "./indiaDateTime.js";

it("converts India wall time to the matching UTC instant independent of browser timezone", () => {
  assert.equal(indiaDateTimeLocalToIso("2026-09-29T12:00"), "2026-09-29T06:30:00.000Z");
});

it("accepts an explicitly supplied seconds value", () => {
  assert.equal(indiaDateTimeLocalToIso("2026-09-29T12:00:30"), "2026-09-29T06:30:30.000Z");
});

it("returns an empty value for invalid or unsupported input", () => {
  assert.equal(indiaDateTimeLocalToIso(""), "");
  assert.equal(indiaDateTimeLocalToIso("2026-09-29"), "");
});

it("renders UTC instants as India-local datetime-local values", () => {
  assert.equal(isoToIndiaDateTimeLocal("2026-09-29T06:30:00.000Z"), "2026-09-29T12:00");
  assert.equal(isoToIndiaDateTimeLocal("invalid"), "");
});
