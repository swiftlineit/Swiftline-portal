import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import {
  operatorCancellationActionAllowed,
  operatorCancellationBranchAllowed
} from "../middleware/operatorShipmentCancellationAccess.middleware.js";
import { getOperatorCancellationEligibility } from "../services/operatorShipmentCancellationPolicy.service.js";

describe("operator shipment cancellation access", () => {
  test("clients can request; finance can review but cannot request", () => {
    assert.equal(operatorCancellationActionAllowed("CLIENT", "request"), true);
    assert.equal(operatorCancellationActionAllowed("FINANCE", "request"), false);
    assert.equal(operatorCancellationActionAllowed("FINANCE", "review"), true);
    assert.equal(operatorCancellationActionAllowed("OPERATIONS", "review"), true);
  });

  test("staff review is branch-scoped except for operator administrators", () => {
    const assignedBranch = new mongoose.Types.ObjectId();
    const otherBranch = new mongoose.Types.ObjectId();

    assert.equal(operatorCancellationBranchAllowed({ role: "OPERATIONS", assignedBranches: [assignedBranch] }, assignedBranch), true);
    assert.equal(operatorCancellationBranchAllowed({ role: "OPERATIONS", assignedBranches: [assignedBranch] }, otherBranch), false);
    assert.equal(operatorCancellationBranchAllowed({ role: "FINANCE", assignedBranches: [] }, assignedBranch), false);
    assert.equal(operatorCancellationBranchAllowed({ role: "OPERATOR_ADMIN", assignedBranches: [] }, otherBranch), true);
  });

  test("dispatched shipments can enter staff review", () => {
    assert.deepEqual(getOperatorCancellationEligibility({
      hasBooked: true,
      latestStatus: "ORIGIN_HUB_DISPATCHED",
      alreadyCancelled: false
    }), { allowed: true, message: "" });
    assert.deepEqual(getOperatorCancellationEligibility({
      hasBooked: true,
      latestStatus: "IN_TRANSIT",
      alreadyCancelled: false
    }), { allowed: true, message: "" });
  });

  test("unbooked, cancelled, and completed shipments cannot be cancelled", () => {
    assert.equal(getOperatorCancellationEligibility({ hasBooked: false, alreadyCancelled: false }).allowed, false);
    assert.equal(getOperatorCancellationEligibility({ hasBooked: true, latestStatus: "DELIVERED", alreadyCancelled: false }).allowed, false);
    assert.equal(getOperatorCancellationEligibility({ hasBooked: true, latestStatus: "SHIPMENT_CANCELLED", alreadyCancelled: false }).allowed, false);
    assert.equal(getOperatorCancellationEligibility({ hasBooked: true, latestStatus: "IN_TRANSIT", hasTerminalStatus: true, alreadyCancelled: false }).allowed, false);
    assert.equal(getOperatorCancellationEligibility({ hasBooked: true, latestStatus: "IN_TRANSIT", alreadyCancelled: true }).allowed, false);
  });
});
