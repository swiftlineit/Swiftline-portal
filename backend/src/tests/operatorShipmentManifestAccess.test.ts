import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import {
  buildOperatorManifestDraftFilter,
  buildOperatorManifestFilter,
  operatorManifestActionAllowed,
  operatorManifestBranchAllowed
} from "../middleware/operatorShipmentManifestAccess.middleware.js";

describe("operator shipment manifest access", () => {
  test("manifest and shipment lookups carry the authenticated tenant", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const manifestId = new mongoose.Types.ObjectId();
    const draftId = new mongoose.Types.ObjectId();
    const context = { tenantId };

    assert.deepEqual(buildOperatorManifestFilter(context, manifestId), {
      _id: manifestId,
      tenantId
    });
    assert.deepEqual(buildOperatorManifestDraftFilter(context, [draftId]), {
      _id: { $in: [draftId] },
      tenantId
    });
  });

  test("operations and finance users can access only assigned manifest branches", () => {
    const assignedBranch = new mongoose.Types.ObjectId();
    const otherBranch = new mongoose.Types.ObjectId();

    for (const role of ["OPERATIONS", "FINANCE"] as const) {
      const context = { role, assignedBranches: [assignedBranch] };
      assert.equal(operatorManifestBranchAllowed(context, assignedBranch), true);
      assert.equal(operatorManifestBranchAllowed(context, otherBranch), false);
    }
  });

  test("operator administrators can access every branch in their tenant", () => {
    const context = { role: "OPERATOR_ADMIN" as const, assignedBranches: [] };
    assert.equal(operatorManifestBranchAllowed(context, new mongoose.Types.ObjectId()), true);
  });

  test("clients can create account manifests but not combined manifests or delete them", () => {
    assert.equal(operatorManifestActionAllowed("CLIENT", "read"), true);
    assert.equal(operatorManifestActionAllowed("CLIENT", "createAccount"), true);
    assert.equal(operatorManifestActionAllowed("CLIENT", "createCombined"), false);
    assert.equal(operatorManifestActionAllowed("CLIENT", "delete"), false);
    assert.equal(operatorManifestActionAllowed("FINANCE", "createAccount"), false);
    assert.equal(operatorManifestActionAllowed("OPERATIONS", "createCombined"), true);
  });
});
