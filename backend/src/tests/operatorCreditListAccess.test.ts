import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { buildOperatorCreditListFilter } from "../controllers/operatorCredit.controller.js";

describe("operator credit account list scope", () => {
  test("includes tenant and excludes individual-customer sentinel accounts", () => {
    const tenantId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildOperatorCreditListFilter({
      tenantId,
      role: "OPERATOR_ADMIN",
      assignedBranches: []
    }), {
      $and: [
        { tenantId },
        { accountKind: { $ne: "INDIVIDUAL_SENTINEL" } },
        { status: { $in: ["approved", "active"] } }
      ]
    });
  });

  test("limits finance and operations to assigned branches, including empty assignments", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    for (const role of ["FINANCE", "OPERATIONS"] as const) {
      assert.deepEqual(buildOperatorCreditListFilter({
        tenantId, role, assignedBranches: [branchId]
      }).$and[3], { assignedBranch: { $in: [branchId] } });
      assert.deepEqual(buildOperatorCreditListFilter({
        tenantId, role, assignedBranches: []
      }).$and[3], { assignedBranch: { $in: [] } });
    }
  });

  test("escapes search text before it becomes a regular expression", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const filter = buildOperatorCreditListFilter({
      tenantId,
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      search: "A.*(B)"
    });
    const searchClause = filter.$and[3] as { $or: Array<Record<string, RegExp>> };
    const pattern = searchClause.$or[0]?.accountId;
    assert.ok(pattern instanceof RegExp);
    assert.equal(pattern.source, "A\\.\\*\\(B\\)");
    assert.equal(pattern.test("AxxB"), false);
  });
});
