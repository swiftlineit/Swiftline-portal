import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyConsignorForm,
  getConsignorFormIssueDetail,
  type ConsigneeContact,
  type ConsignorForm
} from "./shipmentConsignor";

const consignee: ConsigneeContact = {
  contactName: "ALEX SMITH",
  email: "alex@example.com",
  mobileCountryCode: "+44",
  mobileNumber: "7400123456"
};

function completeConsignor(overrides: Partial<ConsignorForm> = {}): ConsignorForm {
  return {
    ...createEmptyConsignorForm(),
    contactName: "RAVI SHARMA",
    email: "ravi@example.com",
    mobileNumber: "9876543210",
    addressLine1: "12 CONNAUGHT PLACE",
    townOrCity: "NEW DELHI",
    county: "DELHI",
    postcode: "110001",
    ...overrides
  };
}

test("requires consignor state for shipment document data", () => {
  const missingState = getConsignorFormIssueDetail(
    completeConsignor({ county: "" }),
    consignee
  );
  assert.ok(missingState.missing.includes("Consignor state is required"));

  const complete = getConsignorFormIssueDetail(completeConsignor(), consignee);
  assert.equal(complete.missing.includes("Consignor state is required"), false);
});
