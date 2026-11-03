import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { buildOperatorBusinessAccountFilter } from "../middleware/operatorBusinessAccountAccess.middleware.js";

describe("operator business account detail access", () => {
  test("includes the authenticated tenant in every account lookup", () => {
    const tenantId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildOperatorBusinessAccountFilter({
      tenantId, role: "OPERATOR_ADMIN", assignedBranches: []
    }, "BA-1"), {
      tenantId,
      accountId: "BA-1",
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
    });
  });

  test("limits operations access to assigned branches", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildOperatorBusinessAccountFilter({
      tenantId, role: "OPERATIONS", assignedBranches: [branchId]
    }, "BA-2"), {
      tenantId,
      accountId: "BA-2",
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" },
      assignedBranch: { $in: [branchId] }
    });
  });

  test("fails closed when a branch-scoped operator has no assignment", () => {
    assert.equal(buildOperatorBusinessAccountFilter({
      tenantId: new mongoose.Types.ObjectId(), role: "OPERATIONS", assignedBranches: []
    }, "BA-3"), null);
  });
});
