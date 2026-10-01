import assert from "node:assert/strict";
import test from "node:test";
import { isValidMawbNumber, normalizeMawbNumber } from "../utils/mawbNumber.js";

test("accepts carrier-defined MAWB text without a Swiftline format assumption", () => {
  assert.equal(normalizeMawbNumber(" 789-1234-5678 "), "789-1234-5678");
  assert.equal(isValidMawbNumber("789-1234-5678"), true);
  assert.equal(isValidMawbNumber("  789 ABC / 123  "), true);
});

test("requires a non-empty MAWB with at most 40 characters", () => {
  assert.equal(isValidMawbNumber("  "), false);
  assert.equal(isValidMawbNumber("A".repeat(41)), false);
});
