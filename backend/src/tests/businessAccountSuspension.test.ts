import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsableClientAccountWorkspace, suspensionMode, suspensionRestorationStatus } from "../services/businessAccountSuspension.service.js";

test("legacy suspended business accounts behave as an operational hold", () => {
  assert.equal(suspensionMode({ status: "suspended" }), "OPERATIONAL_HOLD");
  assert.equal(suspensionMode({ status: "suspended", suspension: null }), "OPERATIONAL_HOLD");
});

test("the suspension mode is account-scoped and only applies while suspended", () => {
  assert.equal(suspensionMode({ status: "suspended", suspension: { mode: "SECURITY_LOCK" } }), "SECURITY_LOCK");
  assert.equal(suspensionMode({ status: "active", suspension: { mode: "SECURITY_LOCK" } }), null);
});

test("another usable account preserves the shared user's login", () => {
  assert.equal(isUsableClientAccountWorkspace({ status: "active" }), true);
  assert.equal(isUsableClientAccountWorkspace({ status: "approved" }), true);
  assert.equal(isUsableClientAccountWorkspace({ status: "suspended" }), true); // Legacy operational hold.
  assert.equal(isUsableClientAccountWorkspace({ status: "suspended", suspension: { mode: "OPERATIONAL_HOLD" } }), true);
  assert.equal(isUsableClientAccountWorkspace({ status: "suspended", suspension: { mode: "SECURITY_LOCK" } }), false);
  assert.equal(isUsableClientAccountWorkspace({ status: "rejected" }), false);
});

test("reactivation restores the status held before suspension", () => {
  assert.equal(suspensionRestorationStatus({ status: "approved" }), "approved");
  assert.equal(suspensionRestorationStatus({ status: "active" }), "active");
  assert.equal(suspensionRestorationStatus({ status: "suspended", suspension: { previousStatus: "approved" } }), "approved");
  assert.equal(suspensionRestorationStatus({ status: "suspended" }), "active");
});
