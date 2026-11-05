import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getOperatorShipmentEligibilityError,
  isOperatorBusinessAccountBookable,
  getOperatorTrackingTransitionError
} from "../services/operatorShipmentPolicy.service.js";
import { OperatorCounterPayment } from "../models/operatorCounterPayment.model.js";

describe("operator client account booking readiness", () => {
  test("allows locally approved or active accounts after KYC verification", () => {
    assert.equal(isOperatorBusinessAccountBookable({ status: "approved", kycStatus: "verified" }), true);
    assert.equal(isOperatorBusinessAccountBookable({ status: "active", kycStatus: "verified" }), true);
  });

  test("keeps unreviewed, rejected, or unverified accounts out of booking", () => {
    assert.equal(isOperatorBusinessAccountBookable({ status: "pending_review", kycStatus: "verified" }), false);
    assert.equal(isOperatorBusinessAccountBookable({ status: "approved", kycStatus: "pending" }), false);
    assert.equal(isOperatorBusinessAccountBookable({ status: "active", kycStatus: null }), false);
  });
});

describe("operator shipment eligibility", () => {
  test("permits booking only for an approved account on its active assigned branch", () => {
    assert.equal(getOperatorShipmentEligibilityError({
      branchStatus: "ACTIVE",
      accountStatus: "approved",
      assignedBranchId: "branch-1",
      shipmentBranchId: "branch-1"
    }), null);
    assert.equal(getOperatorShipmentEligibilityError({
      branchStatus: "ACTIVE",
      accountStatus: "active",
      assignedBranchId: "branch-1",
      shipmentBranchId: "branch-1"
    }), null);
  });

  test("rejects inactive branches, unapproved accounts, and changed branch assignments", () => {
    const common = { branchStatus: "ACTIVE", accountStatus: "approved", assignedBranchId: "branch-1", shipmentBranchId: "branch-1" };
    assert.match(getOperatorShipmentEligibilityError({ ...common, branchStatus: "SUSPENDED" }) ?? "", /branch is not active/);
    assert.match(getOperatorShipmentEligibilityError({ ...common, accountStatus: "pending_review" }) ?? "", /must be approved/);
    assert.match(getOperatorShipmentEligibilityError({ ...common, shipmentBranchId: "branch-2" }) ?? "", /not assigned/);
    assert.match(getOperatorShipmentEligibilityError({ ...common, assignedBranchId: undefined }) ?? "", /not assigned/);
  });

  test("allows an individual sentinel on an active branch without an account assignment", () => {
    const individual = {
      branchStatus: "ACTIVE",
      accountStatus: "approved",
      accountKind: "INDIVIDUAL_SENTINEL",
      assignedBranchId: undefined,
      shipmentBranchId: "branch-2"
    };

    assert.equal(getOperatorShipmentEligibilityError(individual), null);
    assert.match(getOperatorShipmentEligibilityError({ ...individual, branchStatus: "SUSPENDED" }) ?? "", /branch is not active/);
    assert.match(getOperatorShipmentEligibilityError({ ...individual, accountStatus: "suspended" }) ?? "", /must be approved/);
  });

  test("keeps operator payment events tenant-scoped and unique per booking, amendment, or cancellation", () => {
    const indexes = OperatorCounterPayment.schema.indexes() as Array<[
      Record<string, number>,
      { unique?: boolean; name?: string }
    ]>;
    assert.equal(OperatorCounterPayment.schema.path("tenantId")?.isRequired, true);
    assert.ok(indexes.some(([key, options]) =>
      key.tenantId === 1 && key.sourceType === 1 && key.sourceId === 1 && options.unique === true
    ));
    assert.equal(OperatorCounterPayment.schema.path("direction")?.isRequired, true);
    assert.equal(OperatorCounterPayment.schema.path("sourceId")?.isRequired, true);
  });
});

describe("manual operator tracking progression", () => {
  const start = new Date("2026-10-20T10:00:00.000Z");

  test("allows a forward milestone and rejects a repeated or earlier milestone", () => {
    assert.equal(getOperatorTrackingTransitionError({
      currentStatus: "PARCEL_COLLECTED",
      currentEventAt: start,
      nextStatus: "IN_TRANSIT",
      nextEventAt: new Date(start.getTime() + 60_000)
    }), null);
    assert.match(getOperatorTrackingTransitionError({
      currentStatus: "IN_TRANSIT",
      currentEventAt: start,
      nextStatus: "IN_TRANSIT",
      nextEventAt: new Date(start.getTime() + 60_000)
    }) ?? "", /already been recorded/);
    assert.match(getOperatorTrackingTransitionError({
      currentStatus: "DESTINATION_ARRIVED",
      currentEventAt: start,
      nextStatus: "IN_TRANSIT",
      nextEventAt: new Date(start.getTime() + 60_000)
    }) ?? "", /move the shipment backwards/);
  });

  test("rejects out-of-order timestamps and changes after delivery or return", () => {
    assert.match(getOperatorTrackingTransitionError({
      currentStatus: "IN_TRANSIT",
      currentEventAt: start,
      nextStatus: "DESTINATION_ARRIVED",
      nextEventAt: new Date(start.getTime() - 1)
    }) ?? "", /chronological order/);
    for (const currentStatus of ["DELIVERED", "RETURNED"]) {
      assert.match(getOperatorTrackingTransitionError({
        currentStatus,
        currentEventAt: start,
        nextStatus: "IN_TRANSIT",
        nextEventAt: new Date(start.getTime() + 60_000)
      }) ?? "", /terminal tracking status/);
    }
  });
});
