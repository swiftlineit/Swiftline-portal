import assert from "node:assert/strict";
import test, { afterEach, describe } from "node:test";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import {
  RateCardRequiredError,
  RateCardAssignmentMismatchError,
  RateCardPricingContextError,
  calculateShipmentPricingEstimate,
  resolveRateCardBand,
} from "../services/shipmentPricing.service.js";
import { buildPricingHash } from "../services/shipmentCostEstimate.service.js";
import { normalizeUserPhone } from "../services/userIdentity.service.js";

const originalAccountFindById = BusinessAccount.findById;
const originalRateFind = CountryRateCard.find;
const originalRouteFindOne = CountryRouteCharge.findOne;

afterEach(() => {
  BusinessAccount.findById = originalAccountFindById;
  CountryRateCard.find = originalRateFind;
  CountryRouteCharge.findOne = originalRouteFindOne;
});

function mockAccount(account: { rateCardBand?: "BAND_A" | "BAND_B" | "BAND_C" | "BAND_D" | null; accountKind?: string } | null) {
  BusinessAccount.findById = (() => ({
    select: () => ({
      lean: () => ({ session() { return this; }, exec: async () => account })
    })
  })) as unknown as typeof BusinessAccount.findById;
}

function mockCommercialData() {
  CountryRateCard.find = ((filter: { band: "BAND_A" | "BAND_B" | "BAND_C" | "BAND_D" }) => ({
    sort: () => ({
      lean: () => ({
        session() { return this; },
        exec: async () => filter.band === "BAND_D"
          ? [{ _id: "d-rate", fromKg: 0, toKg: 30, chargesPerKg: 450, maxBoxKg: 30, gstTreatment: "EXCLUDED", gstRatePercent: 18 }]
          : filter.band === "BAND_C"
          ? [{ _id: "c-rate", fromKg: 0, toKg: 30, chargesPerKg: 100, maxBoxKg: 30 }]
          : filter.band === "BAND_A"
            ? [{ _id: "a-rate", fromKg: 0, toKg: 30, chargesPerKg: 200, maxBoxKg: 30 }]
            : []
      })
    })
  })) as unknown as typeof CountryRateCard.find;

  CountryRouteCharge.findOne = ((filter: { band: "BAND_A" | "BAND_B" | "BAND_C" | "BAND_D" }) => ({
    lean: () => ({
      session() { return this; },
      exec: async () => filter.band === "BAND_D"
        ? { fuelSurchargePercent: 0, remoteAreaCharge: 0, remoteAreaPostcodes: [], handlingCharge: 0, insurancePercent: 0, insuranceMinimum: 0, discountPercent: 0, updatedAt: new Date("2026-08-05T00:00:00.000Z") }
        : filter.band === "BAND_C"
        ? { fuelSurchargePercent: 8, remoteAreaCharge: 0, remoteAreaPostcodes: [], handlingCharge: 0, insurancePercent: 0, insuranceMinimum: 0, discountPercent: 0, updatedAt: new Date("2026-08-05T00:00:00Z") }
        : { fuelSurchargePercent: 18, remoteAreaCharge: 0, remoteAreaPostcodes: [], handlingCharge: 0, insurancePercent: 0, insuranceMinimum: 0, discountPercent: 0, updatedAt: new Date("2026-08-05T00:00:00Z") }
    })
  })) as unknown as typeof CountryRouteCharge.findOne;
}

describe("rate-card band resolution", () => {
  test("a controlled non-account preview may select a band, but missing context never defaults", async () => {
    assert.equal(await resolveRateCardBand({ rateCardBand: "BAND_C", businessAccountId: null }), "BAND_C");
    await assert.rejects(resolveRateCardBand({}), RateCardPricingContextError);
  });

  test("a business account uses its assignment and an unassigned account is blocked", async () => {
    mockAccount({ rateCardBand: "BAND_B", accountKind: "BUSINESS" });
    assert.equal(await resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011" }), "BAND_B");
    assert.equal(await resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011", rateCardBand: "BAND_B" }), "BAND_B");
    await assert.rejects(
      resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011", rateCardBand: "BAND_C" }),
      RateCardAssignmentMismatchError
    );

    mockAccount({ rateCardBand: null, accountKind: "BUSINESS" });
    await assert.rejects(
      resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011" }),
      (error: unknown) => error instanceof RateCardRequiredError && error.code === "RATE_CARD_REQUIRED"
    );

    mockAccount({ rateCardBand: "BAND_D", accountKind: "BUSINESS" });
    await assert.rejects(
      resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011" }),
      (error: unknown) => error instanceof RateCardRequiredError && error.code === "PUBLIC_RATE_CARD_NOT_FOR_INTERNAL_ACCOUNT"
    );
  });

  test("the individual counter sentinel preserves Band A before or after backfill", async () => {
    mockAccount({ rateCardBand: null, accountKind: "INDIVIDUAL_SENTINEL" });
    assert.equal(await resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011" }), "BAND_A");
    assert.equal(await resolveRateCardBand({ businessAccountId: "507f1f77bcf86cd799439011", rateCardBand: "BAND_C" }), "BAND_A");
  });
});

describe("band-aware pricing", () => {
  test("slabs, route charges and the price lock are isolated by band", async () => {
    mockCommercialData();
    const common = { countryCode: "GB", serviceType: "COURIER" as const, parcels: [{ weightKg: 10 }] };
    const bandA = await calculateShipmentPricingEstimate({ ...common, rateCardBand: "BAND_A" });
    const bandC = await calculateShipmentPricingEstimate({ ...common, rateCardBand: "BAND_C" });

    assert.equal(bandA.parcels[0]?.chargesPerKg, 200);
    // Route charges are GST-inclusive too, so the persisted breakdown allocates
    // their tax-exclusive share while the total remains the commercial amount.
    assert.equal(bandA.fuelSurchargeAmount, 305.08);
    assert.equal(bandC.parcels[0]?.chargesPerKg, 100);
    assert.equal(bandC.fuelSurchargeAmount, 67.8);
    assert.equal(bandA.pricingBasis.rateCardBand, "BAND_A");
    assert.equal(bandC.pricingBasis.rateCardBand, "BAND_C");
    assert.notEqual(buildPricingHash(bandA), buildPricingHash(bandC));
  });

  test("missing coverage is evaluated inside the selected band", async () => {
    mockCommercialData();
    const input = { countryCode: "GB", serviceType: "COURIER" as const, parcels: [{ weightKg: 10 }] };
    assert.equal((await calculateShipmentPricingEstimate({ ...input, rateCardBand: "BAND_B" })).missingRate, true);
    assert.equal((await calculateShipmentPricingEstimate({ ...input, rateCardBand: "BAND_C" })).missingRate, false);
  });

  test("Band D treats the entered public rate as GST-inclusive", async () => {
    mockCommercialData();
    const pricing = await calculateShipmentPricingEstimate({
      countryCode: "GB",
      serviceType: "COURIER",
      parcels: [{ weightKg: 1 }],
      rateCardBand: "BAND_D",
      gstRate: 0.18,
    });

    assert.equal(pricing.parcels[0]?.chargesPerKg, 450);
    assert.equal(pricing.inclusiveAmounts?.freightAmount, 450);
    assert.equal(pricing.freightAmount, 381.36);
    assert.equal(pricing.gstAmount, 68.64);
    assert.equal(pricing.totalAmount, 450);
    assert.deepEqual(pricing.lines.map((line) => line.code), ["FREIGHT", "GST"]);
    assert.equal(pricing.pricingBasis.rateCardBand, "BAND_D");
  });
});

test("user phones normalize to one E.164 identity", () => {
  assert.equal(normalizeUserPhone("+91 98765 43210"), "+919876543210");
  assert.equal(normalizeUserPhone("not-a-phone"), null);
});
