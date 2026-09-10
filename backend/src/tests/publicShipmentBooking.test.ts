import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicShipmentDraftPayloadSchema, publicShipmentQuoteAcceptanceSchema } from "../services/publicShipmentBooking.validation.js";
import { getPublicShipmentPolicySummary, publicShipmentPolicyVersions } from "../services/publicShipmentPolicies.service.js";
import { PublicShipmentBooking } from "../models/publicShipmentBooking.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";

function validPayload() {
  return {
    sender: { entityType: "INDIVIDUAL", companyName: "", contactName: "Ravi Kumar", email: "ravi@example.com", mobileCountryCode: "+91", mobileNumber: "9876543210", countryCode: "IN", countryName: "India", postcode: "110001", addressLine1: "10 Market Road", addressLine2: "", townOrCity: "Delhi", county: "Delhi", deliveryInstructions: "", aadhaarNumber: "234567890124" },
    consignee: { entityType: "INDIVIDUAL", companyName: "", contactName: "Alex Smith", email: "alex@example.com", mobileCountryCode: "+44", mobileNumber: "7400123456", countryCode: "GB", countryName: "United Kingdom", postcode: "SW1A 1AA", addressLine1: "10 Downing Street", addressLine2: "", townOrCity: "London", county: "", deliveryInstructions: "" },
    serviceType: "COURIER",
    csbType: "CSB_IV",
    kycUseForAllParcels: true,
    parcels: [{ weightKg: 2, lengthCm: 20, widthCm: 15, heightCm: 10, shipmentContentType: "PARCEL", shipmentReference1: "WEB-1", shipmentReference2: "", items: [{ description: "Cotton shirts", hsnCode: "", unitType: "Pcs", quantity: 2, unitRate: 500 }] }],
  };
}

describe("public shipment booking validation", () => {
  it("allows multiple draft-less sessions while keeping saved drafts unique", () => {
    const indexes = PublicShipmentBooking.schema.indexes() as Array<[
      Record<string, unknown>,
      { unique?: boolean; sparse?: boolean; partialFilterExpression?: Record<string, unknown> },
    ]>;
    const shipmentDraftIndex = indexes.find(([fields]) => fields.shipmentDraftId === 1);
    assert.ok(shipmentDraftIndex, "shipmentDraftId index is missing");
    assert.equal(shipmentDraftIndex[1].unique, true);
    assert.equal(shipmentDraftIndex[1].sparse, undefined);
    assert.deepEqual(shipmentDraftIndex[1].partialFilterExpression, {
      shipmentDraftId: { $type: "objectId" },
    });
  });

  it("accepts an individual CSB-IV booking without a company or HS code", () => {
    assert.equal(publicShipmentDraftPayloadSchema.safeParse(validPayload()).success, true);
  });

  it("produces a draft that also passes the quote validator", () => {
    const payload = publicShipmentDraftPayloadSchema.parse(validPayload());
    const draft = new ShipmentDraft({
      consignorAddress: payload.sender,
      consigneeEnteredAddress: payload.consignee,
      consigneeSelectedAddress: payload.consignee,
      consigneeValidatedAddress: payload.consignee,
      addressValidationStatus: "VALIDATED",
      kycUseForAllParcels: true,
      parcelCount: payload.parcels.length,
      parcelList: payload.parcels.map((parcel, index) => ({ sequence: index + 1, ...parcel })),
      csbType: payload.csbType,
      serviceType: payload.serviceType,
    });
    assert.deepEqual(validateShipmentDraftFields(draft, { requireValidatedAddress: true }), []);
  });

  it("rejects a mobile number that does not match its calling code", () => {
    const payload = validPayload();
    payload.consignee.mobileNumber = "0000000000";
    const result = publicShipmentDraftPayloadSchema.safeParse(payload);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "consignee.mobileNumber"));
  });

  it("requires a company name when the sender books as a company", () => {
    const payload = validPayload();
    payload.sender.entityType = "COMPANY";
    const result = publicShipmentDraftPayloadSchema.safeParse(payload);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "sender.companyName"));
  });

  it("requires an HS code for every CSB-V item", () => {
    const payload = validPayload();
    payload.csbType = "CSB_V";
    const result = publicShipmentDraftPayloadSchema.safeParse(payload);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "parcels.0.items.0.hsnCode"));
  });

  it("blocks restricted goods before a draft is saved", () => {
    const payload = validPayload();
    payload.parcels[0]!.items[0]!.description = "loose lithium battery";
    assert.equal(publicShipmentDraftPayloadSchema.safeParse(payload).success, false);
  });

  it("does not accept a domestic destination on the international booking route", () => {
    const payload = validPayload();
    payload.consignee.countryCode = "IN";
    payload.consignee.countryName = "India";
    const result = publicShipmentDraftPayloadSchema.safeParse(payload);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "consignee.countryCode"));
  });

  it("requires explicit consent to all three policy groups", () => {
    assert.equal(publicShipmentQuoteAcceptanceSchema.safeParse({ acceptedTerms: true, acceptedCancellationPolicy: true, acceptedProhibitedGoods: false }).success, false);
  });

  it("publishes versioned policies from the authoritative restricted list", () => {
    const policy = getPublicShipmentPolicySummary();
    assert.equal(policy.versions, publicShipmentPolicyVersions);
    assert.ok(policy.prohibitedGoods.includes("Loose Battery / Power Bank"));
    assert.ok(policy.prohibitedGoods.length > 10);
  });
});
