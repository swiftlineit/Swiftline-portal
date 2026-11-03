import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { getTenantContext } from "../services/tenantScope.service.js";
import { runTenantJob, type TenantJobTarget } from "../services/tenantJobRunner.service.js";

describe("tenant scheduled job runner", () => {
  test("runs each tenant in its own explicit context and continues after a tenant failure", async (context) => {
    const swiftline: TenantJobTarget = {
      tenantId: new mongoose.Types.ObjectId(),
      kind: "SWIFTLINE",
      slug: "swiftline"
    };
    const operator: TenantJobTarget = {
      tenantId: new mongoose.Types.ObjectId(),
      kind: "OPERATOR",
      slug: "harbor-cargo"
    };
    const visited: string[] = [];
    context.mock.method(console, "error", () => undefined);

    const summary = await runTenantJob("test credit sweep", [swiftline, operator], async (target) => {
      const activeContext = getTenantContext();
      assert.ok(activeContext);
      assert.equal(String(activeContext.tenantId), String(target.tenantId));
      assert.equal(activeContext.kind, target.kind);
      visited.push(target.slug);
      if (target.slug === "swiftline") throw new Error("simulated tenant failure");
    });

    assert.deepEqual(visited, ["swiftline", "harbor-cargo"]);
    assert.deepEqual(summary, {
      total: 2,
      succeeded: ["harbor-cargo"],
      failed: ["swiftline"]
    });
    assert.equal(getTenantContext(), undefined, "tenant context must not leak after the worker finishes");
  });

  test("returns an empty summary without invoking work when no tenant targets are supplied", async () => {
    let invoked = false;
    const summary = await runTenantJob("test credit sweep", [], async () => {
      invoked = true;
    });

    assert.equal(invoked, false);
    assert.deepEqual(summary, { total: 0, succeeded: [], failed: [] });
  });
});
