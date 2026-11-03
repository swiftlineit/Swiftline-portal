import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isOperatorReadyForActivation } from "../services/tenantRegistry.service.js";

const acceptedAdministrator = {
  tenantStatus: "DRAFT",
  administratorMembershipStatus: "ACTIVE",
  administratorRole: "OPERATOR_ADMIN",
  userRole: "client",
  userStatus: "active",
  hasPassword: true
};

describe("operator portal activation readiness", () => {
  test("requires a draft operator and an active operator administrator login", () => {
    assert.equal(isOperatorReadyForActivation(acceptedAdministrator), true);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, tenantStatus: "ACTIVE" }), false);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, administratorMembershipStatus: "INVITED" }), false);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, administratorRole: "CLIENT" }), false);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, userRole: "admin" }), false);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, userStatus: "suspended" }), false);
    assert.equal(isOperatorReadyForActivation({ ...acceptedAdministrator, hasPassword: false }), false);
  });
});
