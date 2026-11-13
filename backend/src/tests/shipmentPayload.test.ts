import assert from "node:assert/strict";
import { test } from "node:test";
import type { IShipmentDraft } from "../models/shipmentDraft.model.js";
import { maxParcelItemAmountExclusive, maxParcelItems } from "../services/parcelItems.service.js";
import {
  buildShipmentPayload,
  OPERATOR_INTERNAL_SERVICE_CODE,
  SWIFTLINE_SERVICE_CODE,
  validateShipmentPayload,
  type ShipmentPayload
} from "../services/shipmentPayload.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";
import { getStates } from "../services/reference/geography.service.js";

function payload(parcelCount: number): ShipmentPayload {
  return {
    serviceCode: "EXPRESS WORLDWIDE",
    references: { invoiceNumber: "INV-100", shipmentReference: "REF-100" },
    consignee: {
      contactName: "Consignee",
      phone: "+447123456789",
      countryCode: "GB",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcels: Array.from({ length: parcelCount }, (_, index) => ({
      sequence: index + 1,
      weightKg: 1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      shipmentContentType: "PARCEL",
      contentsDescription: "BOOKS"
    }))
  };
}

test("uses a 50-item per-parcel limit", () => {
  assert.equal(maxParcelItems, 50);
});

test("keeps Swiftline's carrier service and allows the operator internal service to be explicit", () => {
  const draft = {
    _id: "64b000000000000000000001",
    consigneeEnteredAddress: {
      contactName: "Consignee",
      mobileCountryCode: "+44",
      mobileNumber: "7123456789",
      countryCode: "GB",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcelList: [{ shipmentReference1: "REF-100" }]
  } as never;

  assert.equal(buildShipmentPayload(draft).serviceCode, SWIFTLINE_SERVICE_CODE);
  assert.equal(buildShipmentPayload(draft, OPERATOR_INTERNAL_SERVICE_CODE).serviceCode, "INTERNAL SHIPMENT");
});

test("enforces the per-item derived amount limit for CSB-IV while allowing higher CSB-V values", () => {
  assert.equal(maxParcelItemAmountExclusive, 5001);

  const makeDraft = (csbType: "CSB_IV" | "CSB_V", quantity: number, unitRate: number) => ({
    csbType,
    csbVGstin: csbType === "CSB_V" ? "08ABCDE1234F1Z5" : "",
    csbVAccountNumber: csbType === "CSB_V" ? "001234" : "",
    csbVIecCode: csbType === "CSB_V" ? "1305023269" : "",
    csbVInvoiceNumber: csbType === "CSB_V" ? "INV-100" : "",
    consigneeEnteredAddress: {
      contactName: "Consignee",
      mobileCountryCode: "+44",
      mobileNumber: "7123456789",
      email: "consignee@example.com",
      countryCode: csbType === "CSB_V" ? "US" : "GB",
      countryName: csbType === "CSB_V" ? "United States" : "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London",
      county: csbType === "CSB_V" ? "Ohio" : "",
      stateCode: csbType === "CSB_V" ? "39" : ""
    },
    parcelCount: 1,
    parcelList: [{
      sequence: 1,
      weightKg: 1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      shipmentContentType: "PARCEL",
      contentsDescription: "BOOKS",
      items: [{ description: "BOOKS", hsnCode: csbType === "CSB_V" ? "49019900" : "", unitType: "Pcs", quantity, unitRate }]
    }]
  });

  const allowedIssues = validateShipmentDraftFields(
    makeDraft("CSB_IV", 1, 5000) as unknown as IShipmentDraft,
    { requireConsignorDetails: false }
  );
  assert.equal(allowedIssues.some((issue) => issue.includes("item amount")), false);

  const rejectedIssues = validateShipmentDraftFields(
    makeDraft("CSB_IV", 2, 2500.5) as unknown as IShipmentDraft,
    { requireConsignorDetails: false }
  );
  assert.ok(rejectedIssues.includes("Parcel 1 item 1: item amount must be below 5001"));

  const csbVIssues = validateShipmentDraftFields(
    makeDraft("CSB_V", 2, 2500.5) as unknown as IShipmentDraft,
    { requireConsignorDetails: false }
  );
  assert.equal(csbVIssues.some((issue) => issue.includes("item amount")), false);
});

test("checks CSB-IV consignee state against the destination reference list at booking", () => {
  const makeDraft = (countryCode: string, county: string) => ({
    csbType: "CSB_IV",
    consigneeEnteredAddress: {
      contactName: "Consignee",
      mobileCountryCode: "+44",
      mobileNumber: "7123456789",
      email: "consignee@example.com",
      countryCode,
      postcode: countryCode === "GB" ? "SW1A 1AA" : "00000",
      addressLine1: "1 Test Street",
      townOrCity: "London",
      county
    },
    parcelCount: 1,
    parcelList: [{
      sequence: 1,
      weightKg: 1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      shipmentContentType: "PARCEL",
      contentsDescription: "BOOKS",
      items: []
    }]
  } as unknown as IShipmentDraft);
  const hasStateIssue = (draft: IShipmentDraft, requireConsigneeStateMatch: boolean) =>
    validateShipmentDraftFields(draft, {
      requireConsignorDetails: false,
      requireItemHsnCodes: false,
      requireConsigneeStateMatch
    }).includes("Consignee state is not valid for the selected country");

  const gbStates = getStates("GB");
  assert.ok(gbStates.length, "GB reference states must be available for this test");
  const validGbState = gbStates[0]?.name ?? "";
  assert.ok(validGbState, "GB reference state must have a name");
  const validDraft = makeDraft("GB", validGbState);
  const invalidDraft = makeDraft("GB", "Not a real state");

  assert.equal(hasStateIssue(validDraft, true), false);
  assert.equal(hasStateIssue(invalidDraft, true), true);
  // Other draft-validation callers, including legacy amendment review, retain
  // their prior behavior until they explicitly opt into the booking check.
  assert.equal(hasStateIssue(invalidDraft, false), false);
  // Countries without a subdivision list keep the existing free-text behavior.
  assert.equal(hasStateIssue(makeDraft("AQ", "Free-text county"), true), false);
});

test("rejects more than 50 normalized item lines during booking validation", () => {
  const issues = validateShipmentDraftFields({
    consigneeEnteredAddress: {
      contactName: "Consignee",
      mobileCountryCode: "+44",
      mobileNumber: "7123456789",
      email: "consignee@example.com",
      countryCode: "GB",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcelCount: 1,
    parcelList: [{
      sequence: 1,
      weightKg: 1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      shipmentContentType: "PARCEL",
      contentsDescription: "BOOKS",
      items: Array.from({ length: 51 }, () => ({ description: "BOOKS", hsnCode: "", unitType: "Pcs", quantity: 0, unitRate: 0 }))
    }]
  } as unknown as IShipmentDraft, { requireConsignorDetails: false, requireItemHsnCodes: false });

  assert.ok(issues.includes("Parcel 1: can contain at most 50 items"));
});

test("accepts 100 parcels in the booking payload", () => {
  assert.equal(validateShipmentPayload(payload(100)).some((issue) => issue.includes("Number of Parcels")), false);
});

test("rejects the 101st parcel with the shared limit message", () => {
  assert.ok(validateShipmentPayload(payload(101)).includes("Number of Parcels (PCS) must be 100 or fewer"));
});
