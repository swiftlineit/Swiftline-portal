import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { buildOperatorCreditAccountFilter } from "../routes/operatorCredit.routes.js";

describe("operator credit account access", () => {
  test("always scopes a credit account lookup to the authenticated tenant", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId().toString();

    assert.deepEqual(buildOperatorCreditAccountFilter({
      tenantId,
      role: "OPERATOR_ADMIN",
      assignedBranches: [],
      businessAccountId
    }), {
      _id: new mongoose.Types.ObjectId(businessAccountId),
      tenantId
    });
  });

  test("finance and operations are restricted to their assigned branches", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const assignedBranch = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId().toString();

    for (const role of ["FINANCE", "OPERATIONS"] as const) {
      assert.deepEqual(buildOperatorCreditAccountFilter({
        tenantId,
        role,
        assignedBranches: [assignedBranch],
        businessAccountId
      }), {
        _id: new mongoose.Types.ObjectId(businessAccountId),
        tenantId,
        assignedBranch: { $in: [assignedBranch] }
      });
    }
  });

  test("staff with no branch assignment receive an empty branch predicate", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId().toString();

    assert.deepEqual(buildOperatorCreditAccountFilter({
      tenantId,
      role: "FINANCE",
      assignedBranches: [],
      businessAccountId
    }), {
      _id: new mongoose.Types.ObjectId(businessAccountId),
      tenantId,
      assignedBranch: { $in: [] }
    });
  });
});
