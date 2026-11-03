import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import {
  buildOperatorAccountAccessFilter,
  buildOperatorBranchAccessFilter,
  buildOperatorBranchRecordAccessFilter
} from "../services/operatorDirectory.service.js";

describe("operator directory access filters", () => {
  test("operator administrators can list tenant records without a branch predicate", () => {
    assert.deepEqual(buildOperatorAccountAccessFilter({
      role: "OPERATOR_ADMIN", assignedBranches: []
    }), {});
    assert.deepEqual(buildOperatorBranchAccessFilter({
      role: "OPERATOR_ADMIN", assignedBranches: []
    }), {});
  });

  test("operations and finance roles are limited to assigned branches", () => {
    const first = new mongoose.Types.ObjectId();
    const second = new mongoose.Types.ObjectId();
    for (const role of ["OPERATIONS", "FINANCE"] as const) {
      assert.deepEqual(buildOperatorAccountAccessFilter({
        role, assignedBranches: [first, second]
      }), { assignedBranch: { $in: [first, second] } });
      assert.deepEqual(buildOperatorBranchAccessFilter({
        role, assignedBranches: [first, second]
      }), { _id: { $in: [first, second] } });
    }
  });

  test("empty staff assignments and unassigned client memberships grant no records", () => {
    for (const role of ["OPERATIONS", "FINANCE"] as const) {
      assert.deepEqual(buildOperatorAccountAccessFilter({ role, assignedBranches: [] }), {
        assignedBranch: { $in: [] }
      });
      assert.deepEqual(buildOperatorBranchAccessFilter({ role, assignedBranches: [] }), {
        _id: { $in: [] }
      });
    }
    assert.deepEqual(buildOperatorAccountAccessFilter({
      role: "CLIENT", assignedBranches: [], clientAccountIds: []
    }), { _id: { $in: [] } });
    assert.deepEqual(buildOperatorBranchAccessFilter({
      role: "CLIENT", assignedBranches: [], clientBranchIds: []
    }), { _id: { $in: [] } });
  });

  test("client access is derived only from its linked business account and branches", () => {
    const accountId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildOperatorAccountAccessFilter({
      role: "CLIENT", assignedBranches: [new mongoose.Types.ObjectId()], clientAccountIds: [accountId]
    }), { _id: { $in: [accountId] } });
    assert.deepEqual(buildOperatorBranchAccessFilter({
      role: "CLIENT", assignedBranches: [new mongoose.Types.ObjectId()], clientBranchIds: [branchId]
    }), { _id: { $in: [branchId] } });
  });

  test("invalid ids are discarded rather than turned into query predicates", () => {
    assert.deepEqual(buildOperatorBranchAccessFilter({
      role: "OPERATIONS", assignedBranches: ["not-an-object-id"]
    }), { _id: { $in: [] } });
  });

  test("branch detail reads require the active tenant and an allowed branch assignment", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const otherBranchId = new mongoose.Types.ObjectId();

    assert.deepEqual(buildOperatorBranchRecordAccessFilter({
      tenantId,
      branchId,
      role: "OPERATOR_ADMIN",
      assignedBranches: []
    }), { $and: [{ tenantId, _id: branchId }, {}] });

    assert.deepEqual(buildOperatorBranchRecordAccessFilter({
      tenantId,
      branchId,
      role: "OPERATIONS",
      assignedBranches: [otherBranchId]
    }), {
      $and: [
        { tenantId, _id: branchId },
        { _id: { $in: [otherBranchId] } }
      ]
    });
  });
});
