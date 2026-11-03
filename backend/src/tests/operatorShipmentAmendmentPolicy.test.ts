import assert from "node:assert/strict";
import test from "node:test";
import {
  getOperatorShipmentAmendmentEligibility,
  operatorAmendmentActionAllowed,
  operatorAmendmentBranchAllowed
} from "../services/operatorShipmentAmendmentPolicy.service.js";

test("operator amendment actions keep finance read-only", () => {
  assert.equal(operatorAmendmentActionAllowed("CLIENT", "request"), true);
  assert.equal(operatorAmendmentActionAllowed("OPERATIONS", "review"), true);
  assert.equal(operatorAmendmentActionAllowed("FINANCE", "read"), true);
  assert.equal(operatorAmendmentActionAllowed("FINANCE", "request"), false);
  assert.equal(operatorAmendmentActionAllowed("FINANCE", "review"), false);
});

test("operator amendment review respects branch assignments", () => {
  assert.equal(operatorAmendmentBranchAllowed({ role: "OPERATIONS", assignedBranches: ["branch-a"] }, "branch-a"), true);
  assert.equal(operatorAmendmentBranchAllowed({ role: "OPERATIONS", assignedBranches: ["branch-a"] }, "branch-b"), false);
  assert.equal(operatorAmendmentBranchAllowed({ role: "OPERATOR_ADMIN", assignedBranches: [] }, "branch-b"), true);
});

test("amendments require a booked shipment before operator collection", () => {
  const base = {
    booked: true,
    hasCancellationRequest: false,
    hasCompletedCancellation: false,
    hasPendingAmendment: false
  };
  assert.equal(getOperatorShipmentAmendmentEligibility(base).allowed, true);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, booked: false }).allowed, false);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, latestTrackingStatus: "PARCEL_COLLECTED" }).allowed, false);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, latestTrackingStatus: "IN_TRANSIT" }).allowed, false);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, hasCancellationRequest: true }).allowed, false);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, hasCompletedCancellation: true }).allowed, false);
  assert.equal(getOperatorShipmentAmendmentEligibility({ ...base, hasPendingAmendment: true }).allowed, false);
});
