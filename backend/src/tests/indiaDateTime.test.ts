import assert from "node:assert/strict";
import test from "node:test";
import { formatIstDate, setIstDatePreservingTime } from "../utils/indiaDateTime.js";

test("formats an instant as its Indian calendar date", () => {
  assert.equal(formatIstDate(new Date("2026-09-29T20:00:00.000Z")), "2026-09-30");
});

test("changes a manifest date without changing the scheduled India-local time", () => {
  const updated = setIstDatePreservingTime("2026-10-02", new Date("2026-09-29T06:30:00.000Z"));
  assert.equal(updated.toISOString(), "2026-10-02T06:30:00.000Z");
  assert.equal(formatIstDate(updated), "2026-10-02");
});

test("rejects impossible calendar dates", () => {
  assert.throws(() => setIstDatePreservingTime("2026-02-30", new Date("2026-09-29T06:30:00.000Z")), RangeError);
});
