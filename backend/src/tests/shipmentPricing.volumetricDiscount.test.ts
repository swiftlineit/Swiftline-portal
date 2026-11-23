import assert from "node:assert/strict";
import test from "node:test";
import { discountedChargeableWeightKg } from "../services/shipmentPricing.service.js";

test("a 50% account discount applies only to the 5 kg volumetric excess", () => {
  assert.deepEqual(discountedChargeableWeightKg(20, 25, 50), {
    discountKg: 2.5,
    chargeableWeightKg: 22.5
  });
});

test("actual weight remains the minimum chargeable weight", () => {
  assert.deepEqual(discountedChargeableWeightKg(22, 18, 50), {
    discountKg: 0,
    chargeableWeightKg: 22
  });
});

test("accounts without a discount retain existing whole-kilogram rounding", () => {
  assert.deepEqual(discountedChargeableWeightKg(20, 25, 0), {
    discountKg: 0,
    chargeableWeightKg: 25
  });
  assert.deepEqual(discountedChargeableWeightKg(20, 25.1, 0), {
    discountKg: 0,
    chargeableWeightKg: 26
  });
});

test("a full excess discount leaves actual weight unchanged", () => {
  assert.deepEqual(discountedChargeableWeightKg(20.25, 25, 100), {
    discountKg: 4.75,
    chargeableWeightKg: 20.25
  });
});

test("discount arithmetic is settled to three decimal places", () => {
  assert.deepEqual(discountedChargeableWeightKg(2.5, 3.333, 33.333), {
    discountKg: 0.278,
    chargeableWeightKg: 3.055
  });
});
