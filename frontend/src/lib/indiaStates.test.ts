import assert from "node:assert/strict";
import test from "node:test";
import { indiaStates, normalizeIndiaState } from "./indiaStates";

test("lists every current Indian state and union territory once", () => {
  assert.equal(indiaStates.length, 36);
  assert.equal(new Set(indiaStates).size, indiaStates.length);
  assert.ok(indiaStates.includes("Delhi"));
  assert.ok(indiaStates.includes("Ladakh"));
  assert.ok(indiaStates.includes("Dadra and Nagar Haveli and Daman and Diu"));
});

test("normalizes provider and legacy spellings to selectable options", () => {
  assert.equal(normalizeIndiaState("Gujarat, India"), "Gujarat");
  assert.equal(normalizeIndiaState("State of Karnataka"), "Karnataka");
  assert.equal(normalizeIndiaState("Orissa"), "Odisha");
  assert.equal(normalizeIndiaState("Pondicherry"), "Puducherry");
  assert.equal(normalizeIndiaState("NCT of Delhi"), "Delhi");
  assert.equal(normalizeIndiaState(""), "");
});

