import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShipmentQuote } from "../models/shipmentQuote.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import {
  calculatePublishedQuotePricing,
  effectiveQuoteStatus,
  loadQuoteContext,
  loadQuoteDisplayContext
} from "../services/shipmentQuote.service.js";
import {
  missingQuoteDocuments,
  normalizeQuoteDocuments,
  quoteDocumentCodeValues,
  requiredQuoteDocuments
} from "../services/quoteDocuments.service.js";

describe("shipment quote policy", () => {
  it("extracts GST from staff-entered inclusive quote charges", () => {
    const result = calculatePublishedQuotePricing({
      freightMinor: 100_000,
      fuelSurchargeMinor: 5_000,
      taxableAddOnsMinor: 2_500
    });
    assert.equal(result.taxableSubtotalMinor, 91_102);
    assert.equal(result.gstMinor, 16_398);
    assert.equal(result.totalMinor, 107_500);
    assert.equal(result.inclusiveSubtotalMinor, 107_500);
    assert.deepEqual(Object.keys(result).sort(), [
      "currency", "freightMinor", "fuelSurchargeMinor", "gstMinor", "gstRate",
      "inclusiveFreightMinor", "inclusiveFuelSurchargeMinor", "inclusiveSubtotalMinor",
      "inclusiveTaxableAddOnsMinor", "taxTreatment", "taxableAddOnsMinor", "taxableSubtotalMinor", "totalMinor"
    ]);
  });

  it("publishes a no-GST quote without adding tax", () => {
    const result = calculatePublishedQuotePricing({
      freightMinor: 100_000,
      fuelSurchargeMinor: 5_000,
      taxableAddOnsMinor: 2_500,
      gstRate: 0
    });
    assert.equal(result.taxTreatment, "NO_GST");
    assert.equal(result.gstMinor, 0);
    assert.equal(result.totalMinor, 107_500);
    assert.equal(result.taxableSubtotalMinor, 107_500);
  });

  it("splits a four-thousand-rupee published quote without changing its total", () => {
    const result = calculatePublishedQuotePricing({
      freightMinor: 400_000,
      fuelSurchargeMinor: 0,
      taxableAddOnsMinor: 0
    });

    assert.equal(result.taxableSubtotalMinor, 338_983);
    assert.equal(result.gstMinor, 61_017);
    assert.equal(result.totalMinor, 400_000);
  });

  it("reports an elapsed published quote as expired", () => {
    assert.equal(effectiveQuoteStatus({
      status: "QUOTED",
      validUntil: new Date("2026-07-20T00:00:00.000Z")
    }, new Date("2026-07-21T00:00:00.000Z")), "EXPIRED");
  });

  it("asks CSB-IV for identity documents only and CSB-V for the full set", () => {
    assert.deepEqual(requiredQuoteDocuments("CSB_IV"), ["PAN", "AADHAR"]);
    assert.deepEqual(requiredQuoteDocuments("CSB_V"), [...quoteDocumentCodeValues]);
  });

  it("treats every document the route asks for as mandatory", () => {
    // One of the two is not enough for CSB-IV; the list is the requirement.
    assert.deepEqual(missingQuoteDocuments("CSB_IV", ["PAN"]), ["AADHAR"]);
    assert.deepEqual(missingQuoteDocuments("CSB_IV", ["PAN", "AADHAR"]), []);
    assert.deepEqual(missingQuoteDocuments("CSB_V", ["PAN", "AADHAR"]),
      quoteDocumentCodeValues.filter((code) => code !== "PAN" && code !== "AADHAR"));
    assert.deepEqual(missingQuoteDocuments("CSB_V", [...quoteDocumentCodeValues]), []);
  });

  it("drops documents the chosen route does not ask for", () => {
    // Switching CSB-V to CSB-IV must not leave an LUT tick on the stored snapshot.
    assert.deepEqual(
      normalizeQuoteDocuments(["LUT", "PAN", "AADHAR", "IEC"], "CSB_IV"),
      ["PAN", "AADHAR"]
    );
    // Canonical order, never the order the boxes were ticked.
    assert.deepEqual(normalizeQuoteDocuments(["AADHAR", "PAN"], "CSB_IV"), ["PAN", "AADHAR"]);
    // Without a route nothing is filtered, which is what the display helpers want.
    assert.deepEqual(normalizeQuoteDocuments(["LUT", "PAN"]), ["PAN", "LUT"]);
  });

  it("requires request and estimate snapshots", async () => {
    const quote = new ShipmentQuote({
      quoteNumber: "QT/26-27/00001",
      businessAccountId: "64b000000000000000000001",
      branchId: "64b000000000000000000002",
      source: "CLIENT",
      requestedBy: "64b000000000000000000003"
    });
    await assert.rejects(quote.validate(), (error: unknown) => {
      const errors = (error as { errors?: Record<string, unknown> }).errors ?? {};
      return Boolean(errors.requestSnapshot && errors.estimateSnapshot);
    });
  });

  it("keeps historical quote details readable when the account is unassigned", async () => {
    const originalAccountFind = BusinessAccount.findById;
    const originalBranchFind = Branch.findById;
    BusinessAccount.findById = (() => ({
      exec: async () => ({
        _id: "64b000000000000000000001",
        accountId: "BA-2026-100001",
        company: { companyName: "Acme Exports" },
        rateCardBand: null
      })
    })) as unknown as typeof BusinessAccount.findById;
    Branch.findById = (() => ({
      exec: async () => ({
        _id: "64b000000000000000000002",
        name: "Delhi",
        code: "DEL",
        address: { city: "Delhi" },
        contact: { email: "delhi@example.com", phone: "+911112223333" }
      })
    })) as unknown as typeof Branch.findById;

    try {
      const quote = {
        businessAccountId: "64b000000000000000000001",
        branchId: "64b000000000000000000002"
      } as unknown as InstanceType<typeof ShipmentQuote>;
      const display = await loadQuoteDisplayContext(quote);
      assert.equal(display?.companyName, "Acme Exports");
      await assert.rejects(loadQuoteContext(quote), /configure.*rate card/i);
    } finally {
      BusinessAccount.findById = originalAccountFind;
      Branch.findById = originalBranchFind;
    }
  });
});
