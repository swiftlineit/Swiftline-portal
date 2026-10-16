import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  revisedAutomaticBoxAmounts,
  revisedBoxAmount,
  revisedChargeableKg,
  revisedTaxableFromRows,
  revisedTaxTotals,
  revisedVolumetricKg,
} from "./revisedInvoiceCalculations";

describe("revised tax invoice calculations", () => {
  it("recalculates volumetric weight with the shipment service divisor", () => {
    const dimensions = { len: "50", wid: "40", hei: "30" };
    assert.equal(revisedVolumetricKg(dimensions, "COURIER"), "12.000");
    assert.equal(revisedVolumetricKg(dimensions, "CARGO"), "10.000");
    assert.equal(revisedVolumetricKg({ ...dimensions, hei: "" }, "COURIER"), null);
  });

  it("bills the larger weight using the portal's whole-kilogram rule", () => {
    assert.equal(revisedChargeableKg("6.1", "12"), "12");
    assert.equal(revisedChargeableKg("12.1", "10"), "13");
    assert.equal(revisedChargeableKg("10.000000001", "9"), "10");
    assert.equal(revisedChargeableKg("", ""), "");
  });

  it("converts GST-inclusive rate per kg to the taxable box amount", () => {
    assert.equal(revisedBoxAmount("5", "100", 18), "423.73");
    assert.equal(revisedBoxAmount("5", "120", 18), "508.47");
    assert.equal(revisedBoxAmount("5", "100", 0), "500.00");
    assert.equal(revisedBoxAmount("5", "", 18), null);
  });

  it("allocates a GST rounding remainder and preserves manually entered amounts", () => {
    const boxes = [
      { chargeable: "1", rate: "0.03", amount: "", amountManual: false },
      { chargeable: "1", rate: "0.03", amount: "", amountManual: false },
    ];
    const allocated = revisedAutomaticBoxAmounts(boxes, 18);
    assert.deepEqual(allocated.map((box) => box.amount), ["0.02", "0.03"]);
    assert.equal(revisedTaxTotals(5, 18, "IGST").totalMinor, 6);

    const manual = revisedAutomaticBoxAmounts([
      { ...allocated[0], amount: "1.23", amountManual: true },
      allocated[1],
    ], 0);
    assert.deepEqual(manual.map((box) => box.amount), ["1.23", "0.03"]);
  });

  it("derives taxable value from editable box and charge rows", () => {
    const taxable = revisedTaxableFromRows(
      [{ amount: "423.73" }, { amount: "100.00" }],
      [
        { amount: "20.00", kind: "CHARGE" },
        { amount: "5.00", kind: "DEDUCTION" },
      ],
    );
    assert.equal(taxable, "538.73");
    assert.deepEqual(revisedTaxTotals(42373, 18, "CGST_SGST"), {
      cgst: 3813,
      sgst: 3814,
      igst: 0,
      taxMinor: 7627,
      totalMinor: 50000,
    });
    assert.deepEqual(revisedTaxTotals(53873, 18, "IGST"), {
      cgst: 0,
      sgst: 0,
      igst: 9697,
      taxMinor: 9697,
      totalMinor: 63570,
    });
    assert.equal(revisedTaxTotals(53873, 0, "IGST").totalMinor, 53873);
  });
});
