import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { isValidAadhaarNumber } from "../services/aadhaarValidation.service.js";
import {
  decryptShipmentDraftAadhaar,
  encryptShipmentDraftAadhaar,
} from "../services/shipmentDraftAadhaar.service.js";
import { mapSurepassAadhaarFullResponse } from "../services/surepassAadhaarOcr.service.js";

const validAadhaar = "234567890124";

describe("Surepass Aadhaar Full mapping", () => {
  test("maps documented fields to consignor fields and preserves the full address", () => {
    const result = mapSurepassAadhaarFullResponse({
      success: true,
      data: {
        front_side: [{
          full_name: { value: "Ravi Kumar" },
          aadhaar_number: { value: validAadhaar, is_masked: false, input_validation: true },
        }],
        back_side: [{
          address: {
            value: "12 Lake Road, Near Park, Riverside, Kolkata, West Bengal - 700001",
            house_number: "12",
            first_line: "12 Lake Road",
            second_line: "Near Park",
            locality: "Riverside",
            district: "Kolkata",
            city: "Kolkata",
            state: "West Bengal",
            zip: "700001",
          },
          aadhaar_number: { value: validAadhaar, is_masked: false, input_validation: true },
        }],
      },
    });

    assert.equal(result.fullName, "Ravi Kumar");
    assert.equal(result.aadhaarNumber, validAadhaar);
    assert.equal(`${result.address.addressLine1}${result.address.addressLine2 ? ` ${result.address.addressLine2}` : ""}`, "12 Lake Road, Near Park, Riverside");
    assert.ok(result.address.addressLine1.length <= 120);
    assert.ok(result.address.addressLine2.length <= 120);
    assert.equal(result.address.townOrCity, "Kolkata");
    assert.equal(result.address.county, "West Bengal");
    assert.equal(result.address.postcode, "700001");
    assert.equal(result.address.fullAddress, "12 Lake Road, Near Park, Riverside, Kolkata, West Bengal - 700001");
  });

  test("accepts a locally valid unmasked number when the provider validation flag is false", () => {
    const masked = mapSurepassAadhaarFullResponse({
      success: true,
      data: {
        front_side: [{
          full_name: { value: "Ravi Kumar" },
          aadhaar_number: { value: "XXXX XXXX 0124", is_masked: true, input_validation: false },
        }],
        back_side: [{ address: { value: "10 Sample Road" } }],
      },
    });

    assert.equal(masked.aadhaarNumber, "");
    assert.match(masked.warnings[0] ?? "", /source document's Aadhaar number is masked/);

    const providerRejected = mapSurepassAadhaarFullResponse({
      success: true,
      data: {
        front_side: [{
          aadhaar_number: { value: validAadhaar, is_masked: false, input_validation: false },
        }],
      },
    });
    assert.equal(providerRejected.aadhaarNumber, validAadhaar);
    assert.match(providerRejected.warnings[0] ?? "", /couldn't confirm the Aadhaar number/);

    const checksumRejected = mapSurepassAadhaarFullResponse({
      success: true,
      data: {
        front_side: [{
          aadhaar_number: { value: "123456789012", is_masked: false, input_validation: true },
        }],
      },
    });
    assert.equal(checksumRejected.aadhaarNumber, "");
    assert.match(checksumRejected.warnings[0] ?? "", /failed the local checksum check/);
    assert.equal(isValidAadhaarNumber("123456789012"), false);
  });

  test("preserves the full address text and avoids autofilling a directional city fragment", () => {
    const sourceAddress = "Care of Sample, 20 Main Road, Palam Village, PO: Palam Village, DIST: South West Delhi, Delhi - 110045";
    const result = mapSurepassAadhaarFullResponse({
      success: true,
      data: {
        back_side: [{
          address: {
            value: sourceAddress,
            first_line: "20 Main Road",
            second_line: "Palam Village, PO: Palam Village, DIST:",
            locality: "Main Road",
            district: "South",
            city: "West",
            state: "Delhi",
            zip: "110045",
          },
        }],
      },
    });

    assert.equal(result.address.fullAddress, sourceAddress);
    assert.equal(result.address.townOrCity, "Palam Village");
    assert.equal(result.address.county, "Delhi");
    assert.equal(result.address.postcode, "110045");
    assert.equal(
      `${result.address.addressLine1}${result.address.addressLine2 ? ` ${result.address.addressLine2}` : ""}`,
      "Care of Sample, 20 Main Road, Palam Village, PO: Palam Village, DIST: South West Delhi",
    );
    assert.match(result.warnings.join(" "), /used the post office name/);
  });
});

describe("shipment draft Aadhaar encryption", () => {
  test("encrypts stored values while document readers and legacy rows remain compatible", () => {
    const encrypted = encryptShipmentDraftAadhaar(validAadhaar);
    assert.notEqual(encrypted, validAadhaar);
    assert.equal(decryptShipmentDraftAadhaar(encrypted), validAadhaar);
    assert.equal(decryptShipmentDraftAadhaar(validAadhaar), validAadhaar);

    const draft = new ShipmentDraft({
      consignorAddress: { aadhaarNumber: validAadhaar },
      parcelList: [{ aadhaarNumber: validAadhaar }],
    });
    const raw = draft.toObject({ getters: false }) as {
      consignorAddress: { aadhaarNumber: string };
      parcelList: Array<{ aadhaarNumber: string }>;
    };
    assert.notEqual(raw.consignorAddress.aadhaarNumber, validAadhaar);
    assert.notEqual(raw.parcelList[0]?.aadhaarNumber, validAadhaar);
    assert.equal(draft.consignorAddress?.aadhaarNumber, validAadhaar);
    assert.equal(draft.parcelList[0]?.aadhaarNumber, validAadhaar);
    assert.equal(JSON.parse(JSON.stringify(draft)).consignorAddress.aadhaarNumber, validAadhaar);
  });
});
