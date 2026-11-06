import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestDocumentParcelRow } from "../types/manifestDocument.js";
import type { ManifestPartySnapshot } from "../services/shipmentManifest.service.js";
import { ediCountryName } from "../services/reference/countryNames.js";
import {
  ediAadhaarNumber,
  ediAddressLine,
  ediDate,
  ediText,
  ediValue,
  titleCaseState
} from "../services/edi/ediTransforms.js";
import { EDI_COLUMNS, EDI_HEADERS, type EdiContext } from "../services/edi/ediColumns.js";

describe("edi transforms", () => {
  it("ediText trims and never yields null", () => {
    assert.equal(ediText("  hi "), "hi");
    assert.equal(ediText(42), "42");
    assert.equal(ediText(null), "");
    assert.equal(ediText(undefined), "");
  });

  it("ediAddressLine strips only a trailing comma", () => {
    assert.equal(ediAddressLine("AMUNPUR 31, "), "AMUNPUR 31");
    assert.equal(ediAddressLine("BATH RD, SLOUGH,"), "BATH RD, SLOUGH");
    assert.equal(ediAddressLine(""), "");
  });

  it("titleCaseState title-cases each word", () => {
    assert.equal(titleCaseState("PUNJAB"), "Punjab");
    assert.equal(titleCaseState("UTTAR PRADESH"), "Uttar Pradesh");
    assert.equal(titleCaseState("MANCHESTER"), "Manchester");
    assert.equal(titleCaseState("Uttar Pradesh"), "Uttar Pradesh");
    assert.equal(titleCaseState(""), "");
  });

  it("ediDate renders d/M/yyyy without leading zeros", () => {
    assert.equal(ediDate("2026-07-17"), "17/7/2026");
    assert.equal(ediDate("2026-11-05"), "5/11/2026");
    assert.equal(ediDate("not-a-date"), "not-a-date");
  });

  it("ediValue converts minor units, empty when absent", () => {
    assert.equal(ediValue(11_000_00), 11000);
    assert.equal(ediValue(null), "");
    assert.equal(ediValue(undefined), "");
  });

  it("ediAadhaarNumber yields a 12-digit number or empty", () => {
    assert.equal(ediAadhaarNumber("102158934472"), 102158934472);
    assert.equal(ediAadhaarNumber("1021 5893 4472"), 102158934472);
    assert.equal(ediAadhaarNumber("XXXX XXXX 4472"), "");
    assert.equal(ediAadhaarNumber(""), "");
  });

  it("ediCountryName maps ISO-2 to the customs name", () => {
    assert.equal(ediCountryName("IN"), "INDIA");
    assert.equal(ediCountryName("GB"), "UNITED KINGDOM");
    assert.equal(ediCountryName("US"), "UNITED STATES OF AMERICA");
    assert.equal(ediCountryName("DE"), "GERMANY");
    assert.equal(ediCountryName("GR"), "GREECE");
    assert.equal(ediCountryName("SPAIN"), "SPAIN"); // already a name
    assert.equal(ediCountryName(""), "");
  });
});

function party(overrides: Partial<ManifestPartySnapshot>): ManifestPartySnapshot {
  return {
    companyName: "", contactName: "", addressLine1: "", addressLine2: "",
    city: "", state: "", postcode: "", countryCode: "", countryName: "", phone: "",
    ...overrides
  };
}

// Consignment SLC170712 from the sample EDI (row 2), the first cleanly-mapped row.
function sampleRow(overrides: Partial<ManifestDocumentParcelRow> = {}): ManifestDocumentParcelRow {
  return {
    serial: 1,
    consignmentIndex: 0,
    parcelIndexInConsignment: 0,
    isFirstParcelOfConsignment: true,
    consignmentNumber: "SLC170712",
    formattedConsignmentNumber: "SLC170712",
    parcelNumber: "SLC170712",
    weightKg: 24.9,
    description: "SNACKS, SWEETS, DRYFRUITS ",
    bagNumber: "SLC01201",
    declaredValueMinor: 11_000_00,
    currency: "INR",
    serviceInfo: "EXP",
    consignor: {
      formatted: "",
      party: party({ contactName: "DINESH MARVADI", addressLine1: "RAULU MAJRA", city: "RUPNAGAR", state: "PUNJAB", postcode: "140102", countryCode: "IN", countryName: "India" })
    },
    consignee: {
      formatted: "",
      party: party({ contactName: "NAVPREET KAUR ", addressLine1: "492 HANWORTH ROAD", city: "HOUNSLOW", postcode: "TW4 5LG", countryCode: "GB", countryName: "United Kingdom" })
    },
    shipmentDraftId: "d1",
    dpdShipmentId: "s1",
    ...overrides
  };
}

const ctx: EdiContext = {
  mawbNumber: "607-54691055",
  departureDate: "2026-07-17",
  aadhaarFor: () => "102158934472"
};

function mapRow(row: ManifestDocumentParcelRow) {
  return Object.fromEntries(EDI_COLUMNS.map((column) => [column.header, column.value(row, ctx)]));
}

describe("edi column mapping", () => {
  it("has 36 columns in the exact sample order", () => {
    assert.equal(EDI_COLUMNS.length, 36);
    assert.deepEqual(EDI_HEADERS, [
      "MAWBNumber", "HAWBNumber", "ConsignorName", "ConsignorAddress1", "ConsignorAddress2",
      "ConsignorCity", "ConsignorState", "ConsignorPostalCode", "ConsignorCountry", "ConsigneeName",
      "ConsigneeAddress1", "ConsigneeAddress2", "ConsigneeCity", "ConsigneeState", "ConsigneePostalCode",
      "ConsigneeCountry", "PKG", "Weight", "DescriptionofGoods", "Value", "ExportInvoiceNo", "GSTInvoiceNo",
      "InvoiceValue", "CurrencyType", "PayType", "IGSTPaid", "Bond", "MHBSNo", "GSTINType", "GSTINNumber",
      "GSTDate", "ExportDate", "ADCode", "CRN_NO", "CRN_MHBS_NO", "FOB_Value"
    ]);
  });

  it("maps a sample consignment to all 36 columns", () => {
    assert.deepEqual(mapRow(sampleRow()), {
      MAWBNumber: "607-54691055",
      HAWBNumber: "SLC170712",
      ConsignorName: "DINESH MARVADI",
      ConsignorAddress1: "RAULU MAJRA",
      ConsignorAddress2: "",
      ConsignorCity: "RUPNAGAR",
      ConsignorState: "Punjab",
      ConsignorPostalCode: "140102",
      ConsignorCountry: "INDIA",
      ConsigneeName: "NAVPREET KAUR",
      ConsigneeAddress1: "492 HANWORTH ROAD",
      ConsigneeAddress2: "",
      ConsigneeCity: "HOUNSLOW",
      ConsigneeState: "",
      ConsigneePostalCode: "TW4 5LG",
      ConsigneeCountry: "UNITED KINGDOM",
      PKG: 1,
      Weight: 24.9,
      DescriptionofGoods: "SNACKS, SWEETS, DRYFRUITS",
      Value: 11000,
      ExportInvoiceNo: "SLC170712",
      GSTInvoiceNo: "SLC170712",
      InvoiceValue: 11000,
      CurrencyType: "INR",
      PayType: "N",
      IGSTPaid: 0,
      Bond: "NA",
      MHBSNo: "SLC01201",
      GSTINType: "Aadhaar Number",
      GSTINNumber: 102158934472,
      GSTDate: "17/7/2026",
      ExportDate: "17/7/2026",
      ADCode: "",
      CRN_NO: "SLC170712",
      CRN_MHBS_NO: "SLC01201",
      FOB_Value: 11000
    });
  });

  it("compacts parcel-derived HAWB, export invoice, GST invoice, and CRN values", () => {
    const row = mapRow(sampleRow({
      consignmentNumber: "SLCDEL031126016",
      formattedConsignmentNumber: "SLCDEL031126016",
      parcelNumber: "SLCDEL031126016-01"
    }));

    assert.equal(row.HAWBNumber, "SLCDEL03112601601");
    assert.equal(row.ExportInvoiceNo, "SLCDEL03112601601");
    assert.equal(row.GSTInvoiceNo, "SLCDEL03112601601");
    assert.equal(row.CRN_NO, "SLCDEL03112601601");
    assert.equal(row.MAWBNumber, "607-54691055");

    const customInvoice = mapRow(sampleRow({
      consignmentNumber: "SLCDEL031126016",
      parcelNumber: "SLCDEL031126016-01",
      exportInvoiceNumber: "INV-100"
    }));
    assert.equal(customInvoice.HAWBNumber, "SLCDEL03112601601");
    assert.equal(customInvoice.ExportInvoiceNo, "INV-100");
    assert.equal(customInvoice.GSTInvoiceNo, "INV-100");
  });

  it("uses the consignee contact name, never the company name", () => {
    const row = mapRow(sampleRow({
      consignee: { formatted: "", party: party({ contactName: "NAVPREET KAUR", companyName: "ACME LTD", city: "HOUNSLOW", countryCode: "GB" }) }
    }));
    assert.equal(row.ConsigneeName, "NAVPREET KAUR");
  });

  it("shows each parcel's own value on its row when the row carries one", () => {
    const secondParcel = mapRow(sampleRow({ isFirstParcelOfConsignment: false, parcelIndexInConsignment: 1, declaredValueMinor: 5_000_00, parcelNumber: "SLC170712-02" }));
    assert.equal(secondParcel.Value, 5000);
    assert.equal(secondParcel.InvoiceValue, 5000);
    assert.equal(secondParcel.FOB_Value, 5000);
    assert.equal(secondParcel.HAWBNumber, "SLC170712-02");
  });

  it("leaves value columns empty on a row with no value (legacy non-first parcel)", () => {
    const secondParcel = mapRow(sampleRow({ isFirstParcelOfConsignment: false, parcelIndexInConsignment: 1, declaredValueMinor: null, parcelNumber: "SLC170712-02" }));
    assert.equal(secondParcel.Value, "");
    assert.equal(secondParcel.InvoiceValue, "");
    assert.equal(secondParcel.FOB_Value, "");
    // The parcel still carries its own HAWB and stays linked by MHBS.
    assert.equal(secondParcel.HAWBNumber, "SLC170712-02");
    assert.equal(secondParcel.MHBSNo, "SLC01201");
  });

  it("emits blank address fields when a legacy row has no structured party", () => {
    const legacy = mapRow(sampleRow({ consignor: { formatted: "X", party: null }, consignee: { formatted: "Y", party: null } }));
    assert.equal(legacy.ConsignorName, "");
    assert.equal(legacy.ConsignorCountry, "");
    assert.equal(legacy.ConsigneeCity, "");
    // Non-party columns are unaffected.
    assert.equal(legacy.MAWBNumber, "607-54691055");
    assert.equal(legacy.PayType, "N");
  });
});
