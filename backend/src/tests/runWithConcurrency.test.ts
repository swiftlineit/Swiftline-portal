import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runWithConcurrency } from "../utils/runWithConcurrency.js";

describe("runWithConcurrency", () => {
  test("preserves result order while respecting the concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await runWithConcurrency([35, 5, 20, 1, 10], 2, async (delay, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return `result-${index}`;
    });

    assert.equal(maximumActive, 2);
    assert.deepEqual(results, ["result-0", "result-1", "result-2", "result-3", "result-4"]);
  });

  test("waits for all work to settle before rethrowing the first input-order error", async () => {
    const completed: number[] = [];
    const firstError = new Error("first failure");

    await assert.rejects(
      runWithConcurrency([0, 1, 2, 3], 3, async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value === 0 ? 5 : 15));
        completed.push(value);
        if (value === 0) throw firstError;
        if (value === 2) throw new Error("later failure");
        return value;
      }),
      (error: unknown) => error === firstError
    );

    assert.deepEqual(completed.sort((left, right) => left - right), [0, 1, 2, 3]);
  });

  test("rejects an invalid concurrency value before starting work", async () => {
    let called = false;
    await assert.rejects(
      runWithConcurrency([1], 0, async () => {
        called = true;
        return 1;
      }),
      RangeError
    );
    assert.equal(called, false);
  });
});
