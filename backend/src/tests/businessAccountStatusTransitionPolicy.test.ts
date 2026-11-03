import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransitionBusinessAccountStatus } from "../controllers/businessAccount.controller.js";

test("only operator accounts may be suspended directly after approval", () => {
  assert.equal(canTransitionBusinessAccountStatus("approved", "suspended", "OPERATOR"), true);
  assert.equal(canTransitionBusinessAccountStatus("approved", "suspended", "SWIFTLINE"), false);
  assert.equal(canTransitionBusinessAccountStatus("approved", "suspended", undefined), false);
});

test("a suspended account reactivates through the existing active state", () => {
  assert.equal(canTransitionBusinessAccountStatus("suspended", "active", "OPERATOR"), true);
  assert.equal(canTransitionBusinessAccountStatus("active", "suspended", "OPERATOR"), true);
});
