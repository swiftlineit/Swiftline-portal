import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_IDLE_COUNTDOWN_MS,
  SESSION_IDLE_WARNING_AFTER_MS
} from "./sessionTimeout";

test("the idle warning starts at 35 minutes and counts down for one minute", () => {
  assert.equal(SESSION_IDLE_WARNING_AFTER_MS, 35 * 60 * 1000);
  assert.equal(SESSION_IDLE_COUNTDOWN_MS, 60 * 1000);
  assert.equal(SESSION_IDLE_WARNING_AFTER_MS + SESSION_IDLE_COUNTDOWN_MS, 36 * 60 * 1000);
});
