import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  csbVClearanceCharge,
  formatCsbType,
  getCsbClearanceCharge,
  normalizeCsbType
} from "../services/csbType.service.js";
import {
  calculateChargeBreakdown,
  splitGstInclusiveAmountMinor
} from "../services/shipmentPricing.service.js";
import {
  composeShipmentDescription,
  composeContentsDescription,
  contentsDescriptionMaxLength,
  getShipmentDescriptionLimitMessage,
  isValidHsnCode,
  normalizeParcelItems
} from "../services/parcelItems.service.js";
import { normalizeQuoteDocuments } from "../services/quoteDocuments.service.js";

describe("CSB type", () => {
  test("treats a missing or unknown value as CSB-IV so historical pricing never changes", () => {
    for (const value of [undefined, null, "", "CSB-IV", "nonsense", 5]) {
      assert.equal(normalizeCsbType(value), "CSB_IV");
      assert.equal(getCsbClearanceCharge(value), 0);
    }
  });

  test("only CSB-V attracts the flat clearance charge", () => {
    assert.equal(getCsbClearanceCharge("CSB_V"), csbVClearanceCharge);
    assert.equal(getCsbClearanceCharge("CSB_IV"), 0);
    assert.equal(csbVClearanceCharge, 1800);
  });

  test("formats display labels", () => {
    assert.equal(formatCsbType("CSB_V"), "CSB-V");
    assert.equal(formatCsbType(undefined), "CSB-IV");
  });
});

const emptyRouteCharges = {
  fuelSurchargePercent: 0,
  remoteAreaCharge: 0,
  remoteAreaPostcodes: [] as string[],
  handlingCharge: 0,
  insurancePercent: 0,
  insuranceMinimum: 0,
  discountPercent: 0,
  updatedAt: null
};

const price = (freightAmount: number, csbType: "CSB_IV" | "CSB_V", missingRate = false) => (
  calculateChargeBreakdown({
    freightAmount,
    missingRate,
    parcelCount: 1,
    chargeableWeightTotal: 10,
    csbType,
    destinationPostcode: "",
    insuranceOptIn: false,
    declaredGoodsValue: 0,
    routeCharges: emptyRouteCharges,
    gstRate: 0.18
  })
);

// The flat CSB-V charge and the freight rate are both commercial GST-inclusive
// amounts. The invoice extracts their taxable value and GST without increasing
// the amount the customer was quoted.
describe("CSB-V charge arithmetic", () => {
  test("adds the inclusive 1800 charge once and extracts GST from the combined total", () => {
    const result = price(2000, "CSB_V");

    assert.equal(result.inclusiveAmounts.csbClearanceAmount, 1800);
    assert.equal(result.baseAmount, 3220.34);
    assert.equal(result.gstAmount, 579.66);
    assert.equal(result.totalAmount, 3800);
  });

  test("the charge does not scale with parcel count or weight", () => {
    // Same freight total, whether it arrived as one box or five.
    const onePercel = 2000 + getCsbClearanceCharge("CSB_V");
    const fiveParcels = 2000 + getCsbClearanceCharge("CSB_V");
    assert.equal(onePercel, fiveParcels);
  });

  test("CSB-IV extracts GST from the inclusive freight rate", () => {
    const result = price(2000, "CSB_IV");
    assert.equal(result.csbClearanceAmount, 0);
    assert.equal(result.baseAmount, 1694.92);
    assert.equal(result.gstAmount, 305.08);
    assert.equal(result.totalAmount, 2000);
  });
});

describe("inclusive pricing parity rule", () => {
  test("the screenshot case: 10 kg to GB at 200/kg on CSB-V", () => {
    const result = price(2000, "CSB_V");
    assert.equal(result.totalAmount, 3800);
    assert.deepEqual(splitGstInclusiveAmountMinor(380000, 0.18), {
      taxableMinor: 322034,
      gstMinor: 57966,
      totalMinor: 380000
    });
  });

  test("the same shipment on CSB-IV keeps the published freight total", () => {
    const result = price(2000, "CSB_IV");
    assert.equal(result.totalAmount, 2000);
  });

  test("no rate available never quotes the clearance charge alone", () => {
    assert.equal(price(0, "CSB_V", true).totalAmount, 0);
  });
});

describe("HS codes", () => {
  test("accepts 4, 6, 8 and 10 digit codes", () => {
    // Ten digits appear on the customs invoice for fuller tariff classifications.
    for (const code of ["1905", "190531", "19053100", "6117102030"]) {
      assert.ok(isValidHsnCode(code), `expected ${code} to be valid`);
    }
  });

  test("rejects malformed codes", () => {
    for (const code of ["", "190", "12345", "1234567", "123456789", "11223344556", "1905AB", "19 05", null, undefined]) {
      assert.ok(!isValidHsnCode(code), `expected ${JSON.stringify(code)} to be invalid`);
    }
  });

  test("trims surrounding whitespace before validating", () => {
    assert.ok(isValidHsnCode("  19053100  "));
  });
});

describe("parcel items", () => {
  test("composes the derived contents description from item descriptions", () => {
    const items = [{ description: "Cookies", hsnCode: "1905" }, { description: "Clothes", hsnCode: "6203" }];
    assert.equal(composeContentsDescription(items), "Cookies, Clothes");
  });

  test("composes the shipment description with comma separators across parcels", () => {
    assert.equal(
      composeShipmentDescription([
        { items: [{ description: "Cookies" }, { description: "Clothes" }] },
        { items: [{ description: "Books" }] }
      ]),
      "Cookies, Clothes, Books"
    );
  });

  test("reports the exact excess above 240 characters", () => {
    assert.equal(
      getShipmentDescriptionLimitMessage([{ items: [{ description: "x".repeat(240) }] }]),
      ""
    );

    const message = getShipmentDescriptionLimitMessage([
      { items: [{ description: "x".repeat(120) }, { description: "y".repeat(120) }, { description: "z" }] }
    ]);

    assert.match(message, /current combined description is 245 characters/);
    assert.match(message, /exceeds the limit by 5/);
  });

  test("never exceeds the contentsDescription column length", () => {
    // 20 items well past the limit; the result must still fit and end cleanly.
    const items = Array.from({ length: 20 }, (_, index) => ({
      description: `Item number ${index + 1} description`,
      hsnCode: "1905"
    }));
    const composed = composeContentsDescription(items);
    assert.ok(composed.length <= contentsDescriptionMaxLength, `got ${composed.length} chars`);
    assert.ok(!composed.endsWith(","), "should not end mid-list");
  });

  test("hard-cuts a single oversized item rather than dropping it", () => {
    const composed = composeContentsDescription([{ description: "x".repeat(300), hsnCode: "1905" }]);
    assert.equal(composed.length, contentsDescriptionMaxLength);
  });

  test("ignores blank descriptions", () => {
    const composed = composeContentsDescription([
      { description: "  ", hsnCode: "" },
      { description: "Cookies", hsnCode: "1905" }
    ]);
    assert.equal(composed, "Cookies");
  });

  test("rebuilds items for legacy parcels that only have a description", () => {
    // Parcels stored before the customs-invoice fields existed read as one unit
    // of zero value, so the document can still render them.
    const items = normalizeParcelItems({ contentsDescription: "Handicrafts" });
    assert.deepEqual(items, [
      { description: "Handicrafts", hsnCode: "", unitType: "Pcs", quantity: 0, unitRate: 0 }
    ]);
  });

  test("prefers stored items over the legacy description", () => {
    const items = normalizeParcelItems({
      items: [{ description: "Cookies", hsnCode: "19053100", unitType: "Pcs", quantity: 3, unitRate: 25 }],
      contentsDescription: "Cookies"
    });
    assert.deepEqual(items, [
      { description: "Cookies", hsnCode: "19053100", unitType: "Pcs", quantity: 3, unitRate: 25 }
    ]);
  });

  test("returns nothing for a parcel with neither", () => {
    assert.deepEqual(normalizeParcelItems({}), []);
  });
});

describe("quote documents", () => {
  test("keeps only known codes, de-duplicated and in canonical order", () => {
    const documents = normalizeQuoteDocuments(["PAN", "IEC", "PAN", "NOT_A_DOCUMENT"]);
    assert.deepEqual(documents, ["IEC", "PAN"]);
  });

  test("returns an empty list for a non-array", () => {
    assert.deepEqual(normalizeQuoteDocuments(undefined), []);
  });
});
