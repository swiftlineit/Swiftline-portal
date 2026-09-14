import assert from "node:assert/strict";
import { test } from "node:test";
import { LatestShipmentDraftSaver } from "./shipmentDraftAutosave";

test("an edit made during a save is persisted by a second serialized request", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const persisted: string[] = [];
  const applied: Array<{ result: string; isLatest: boolean }> = [];

  const saver = new LatestShipmentDraftSaver(
    async (patch: string) => {
      persisted.push(patch);
      if (patch === "first") {
        return new Promise<string>((resolve) => { releaseFirst = resolve; });
      }
      return patch;
    },
    (result, isLatest) => applied.push({ result, isLatest }),
    () => undefined
  );

  saver.setSnapshot("1", "first");
  const flushing = saver.flush();
  await Promise.resolve();
  saver.setSnapshot("2", "second");
  releaseFirst?.("first");

  assert.equal(await flushing, "second");
  assert.deepEqual(persisted, ["first", "second"]);
  assert.deepEqual(applied, [
    { result: "first", isLatest: false },
    { result: "second", isLatest: true }
  ]);
});

test("parallel flushes share one request for the same snapshot", async () => {
  let calls = 0;
  const saver = new LatestShipmentDraftSaver(
    async (patch: string) => {
      calls += 1;
      return patch;
    },
    () => undefined,
    () => undefined
  );

  saver.setSnapshot("same", "draft");
  assert.deepEqual(await Promise.all([saver.flush(), saver.flush()]), ["draft", "draft"]);
  assert.equal(calls, 1);
});

test("a failed write is reported and can be retried", async () => {
  let shouldFail = true;
  const statuses: string[] = [];
  const saver = new LatestShipmentDraftSaver(
    async (patch: string) => {
      if (shouldFail) throw new Error("offline");
      return patch;
    },
    () => undefined,
    (status) => statuses.push(status)
  );

  saver.setSnapshot("retry", "draft");
  await assert.rejects(saver.flush(), /offline/);
  shouldFail = false;
  assert.equal(await saver.flush(), "draft");
  assert.deepEqual(statuses, ["saving", "failed", "saving", "saved"]);
});

