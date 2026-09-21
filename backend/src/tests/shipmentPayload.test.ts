import assert from "node:assert/strict";
import { test } from "node:test";
import type { IShipmentDraft } from "../models/shipmentDraft.model.js";
import { maxParcelItems } from "../services/parcelItems.service.js";
import { validateShipmentPayload, type ShipmentPayload } from "../services/shipmentPayload.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";

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
