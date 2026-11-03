import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { clientPodAssignmentScope } from "../services/pod/podCentre.service.js";

describe("client POD branch scope", () => {
  test("matches only each active account's assigned branches", () => {
    const firstAccountId = new mongoose.Types.ObjectId();
    const secondAccountId = new mongoose.Types.ObjectId();
    const firstBranchId = new mongoose.Types.ObjectId();
    const secondBranchId = new mongoose.Types.ObjectId();

    assert.deepEqual(clientPodAssignmentScope([
      { businessAccountId: firstAccountId, branchIds: [firstBranchId] },
      { businessAccountId: secondAccountId, branchIds: [secondBranchId] }
    ]), {
      $or: [
        { businessAccountId: firstAccountId, branchId: { $in: [firstBranchId] } },
        { businessAccountId: secondAccountId, branchId: { $in: [secondBranchId] } }
      ]
    });
  });

  test("returns no query scope when a client has no active branches", () => {
    assert.equal(clientPodAssignmentScope([
      { businessAccountId: new mongoose.Types.ObjectId(), branchIds: [] }
    ]), null);
  });
});
