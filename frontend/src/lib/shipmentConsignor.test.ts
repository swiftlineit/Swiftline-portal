import assert from "node:assert/strict";
import { test } from "node:test";
import { shipmentKycDocumentSlots } from "./dpdLabels";
import {
  createEmptyConsignorForm,
  getConsignorFormIssueDetail,
  getKycIssues,
  type ConsigneeContact,
  type ConsignorForm
} from "./shipmentConsignor";

const consignee: ConsigneeContact = {
  contactName: "ALEX SMITH",
  email: "alex@example.com",
  mobileCountryCode: "+44",
  mobileNumber: "7400123456"
};

test("shows the CSB-IV Aadhaar upload before PAN", () => {
  assert.deepEqual(shipmentKycDocumentSlots("CSB_IV"), ["aadhaar", "pan"]);
});

function completeConsignor(overrides: Partial<ConsignorForm> = {}): ConsignorForm {
  return {
    ...createEmptyConsignorForm(),
    contactName: "RAVI SHARMA",
    email: "ravi@example.com",
    mobileNumber: "9876543210",
    addressLine1: "12 CONNAUGHT PLACE",
    townOrCity: "NEW DELHI",
    county: "DELHI",
    postcode: "110001",
    ...overrides
  };
}

test("requires consignor state for shipment document data", () => {
  const missingState = getConsignorFormIssueDetail(
    completeConsignor({ county: "" }),
    consignee
  );
  assert.ok(missingState.missing.includes("Consignor state is required"));

  const complete = getConsignorFormIssueDetail(completeConsignor(), consignee);
  assert.equal(complete.missing.includes("Consignor state is required"), false);
});

test("keeps a separate Aadhaar back image optional for CSB-IV", () => {
  const issues = getKycIssues({
    csbType: "CSB_IV",
    useForAll: true,
    sharedAadhaar: "234567890124",
    sharedDocuments: {
      aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "front.jpg", mimeType: "image/jpeg", size: 100, uploadedAt: "2026-01-01" }
    },
    parcels: []
  });

  assert.deepEqual(issues, []);
});

test("accepts one Aadhaar PDF or a complete front-and-back image pair for CSB-IV", () => {
  const base = {
    csbType: "CSB_IV" as const,
    useForAll: true,
    sharedAadhaar: "234567890124",
    parcels: []
  };
  const pdfIssues = getKycIssues({
    ...base,
    sharedDocuments: {
      aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "aadhaar.pdf", mimeType: "application/pdf", size: 100, uploadedAt: "2026-01-01" }
    }
  });
  const imagePairIssues = getKycIssues({
    ...base,
    sharedDocuments: {
      aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "front.jpg", mimeType: "image/jpeg", size: 100, uploadedAt: "2026-01-01" },
      aadhaarBack: { type: "aadhaarBack", documentLabel: "Aadhaar Back Side", originalName: "back.png", mimeType: "image/png", size: 100, uploadedAt: "2026-01-01" }
    }
  });

  assert.deepEqual(pdfIssues, []);
  assert.deepEqual(imagePairIssues, []);
});

test("keeps the Aadhaar back image optional for per-parcel CSB-IV and CSB-V", () => {
  const perParcelIssues = getKycIssues({
    csbType: "CSB_IV",
    useForAll: false,
    sharedAadhaar: "",
    sharedDocuments: {},
    parcels: [{
      sequence: 1,
      aadhaarNumber: "234567890124",
      kycDocuments: {
        aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "front.jpg", mimeType: "image/jpeg", size: 100, uploadedAt: "2026-01-01" }
      }
    }]
  });
  const csbVIssues = getKycIssues({
    csbType: "CSB_V",
    useForAll: true,
    sharedAadhaar: "",
    sharedDocuments: {
      aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "front.jpg", mimeType: "image/jpeg", size: 100, uploadedAt: "2026-01-01" }
    },
    parcels: []
  });

  assert.deepEqual(perParcelIssues, []);
  assert.equal(csbVIssues.some((issue) => issue.toLowerCase().includes("aadhaar back-side")), false);
});
