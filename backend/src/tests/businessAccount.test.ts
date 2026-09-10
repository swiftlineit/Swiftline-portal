import assert from "node:assert/strict";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import {
  BusinessAccount,
  DocumentType,
  IBusinessDocument,
  IBusinessKycReview
} from "../models/businessAccount.model.js";
import {
  businessAccountStatusTransitions,
  deriveKycOverallStatus,
  getDocumentRequirementError,
  getRequiredKycCheckKeys,
  kycGatedStatuses
} from "../controllers/businessAccount.controller.js";
import {
  countriesWithoutRegistrationId,
  isHttpOrHttpsUrl,
  isValidBusinessContactEmail,
  isValidPhoneForCountryCode,
  isValidPostalCodeForCountry,
  getPrimaryRegistrationError
} from "../services/businessAccountRules.js";
import {
  getUsTaxIdError,
  isMaskedUsTaxId,
  isSensitiveUsTaxIdType,
  maskUsTaxId
} from "../services/usTaxId.js";
import { decryptSecret, encryptSecret } from "../services/credentialEncryption.service.js";
import { getGstinError, isValidGstin, requiresGstin } from "../services/gstin.js";

function testDocument(type: DocumentType): IBusinessDocument {
  return {
    type,
    originalName: `${type}.pdf`,
    storageKey: `business-accounts/test-account/kyc/${type}.pdf`,
    mimeType: "application/pdf",
    size: 1024,
    uploadedAt: new Date()
  };
}

function emptyReview(overrides: Partial<IBusinessKycReview> = {}): IBusinessKycReview {
  return {
    overallStatus: "documents_pending",
    checks: {},
    finalDecision: null,
    reviewStartedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    ...overrides
  };
}

const requiredDocuments = {
  aadhaarCard: testDocument("aadhaarCard"),
  panCard: testDocument("panCard")
};

function validAccountData(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "BA-2026-100001",
    status: "draft",
    contact: {
      title: "mr.",
      firstName: "John",
      lastName: "Doe",
      email: "john@acme.com",
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: "9876543210",
      jobTitle: "Director",
      department: "Management",
      shipmentTypes: ["international_cargo"]
    },
    company: {
      registrationCountry: "India",
      registrationId: "ABCDE1234F",
      companyType: "pvt_ltd",
      companyName: "Acme Exports",
      registeredAddress: "1 Trade Street",
      city: "New Delhi",
      stateOrProvince: "Delhi",
      postalCode: "110001",
      operatingCountries: ["India"],
      industry: "Retail",
      monthlyShipmentVolume: "1-50 shipments",
      requestedCreditLimit: { currency: "INR", amount: null }
    },
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides
  };
}

describe("business account status transitions", () => {
  it("permits only the defined lifecycle moves", () => {
    assert.deepEqual(businessAccountStatusTransitions.draft, ["pending_review"]);
    assert.ok(businessAccountStatusTransitions.pending_review.includes("approved"));
    assert.ok(businessAccountStatusTransitions.pending_review.includes("rejected"));
    assert.ok(businessAccountStatusTransitions.approved.includes("active"));
    assert.ok(businessAccountStatusTransitions.active.includes("suspended"));
    assert.ok(businessAccountStatusTransitions.suspended.includes("active"));
  });

  it("blocks skipping straight from draft to active", () => {
    assert.ok(!businessAccountStatusTransitions.draft.includes("active"));
  });

  it("treats rejected as terminal", () => {
    assert.deepEqual(businessAccountStatusTransitions.rejected, []);
  });

  it("gates approval and activation behind KYC", () => {
    assert.deepEqual([...kycGatedStatuses].sort(), ["active", "approved"]);
  });
});

describe("business account GST billing permission", () => {
  it("defaults existing/new accounts to normal GST without granting no-GST access", async () => {
    const account = new BusinessAccount(validAccountData());
    await account.validate();
    assert.equal(account.gstBilling.requestedTreatment, "GST_APPLICABLE");
    assert.equal(account.gstBilling.status, "NOT_REQUIRED");
    assert.equal(account.gstBilling.version, 1);
  });

  it("stores a no-GST request as pending rather than treating it as approved", async () => {
    const requester = new mongoose.Types.ObjectId();
    const account = new BusinessAccount(validAccountData({
      gstBilling: {
        requestedTreatment: "NO_GST",
        status: "PENDING",
        requestReason: "Commercial approval requested",
        requestedAt: new Date(),
        requestedBy: requester,
        version: 1
      }
    }));
    await account.validate();
    assert.equal(account.gstBilling.status, "PENDING");
    assert.equal(account.gstBilling.effectiveFrom, null);
  });
});

describe("individual shipment rate-card guard", () => {
  it("forces the system sentinel to Band D", async () => {
    const account = new BusinessAccount(validAccountData({
      accountKind: "INDIVIDUAL_SENTINEL",
      rateCardBand: "BAND_C"
    }));

    await account.validate();
    assert.equal(account.rateCardBand, "BAND_D");
  });
});

describe("deriveKycOverallStatus", () => {
  it("stays documents_pending until required documents are present", () => {
    assert.equal(deriveKycOverallStatus({}, emptyReview()), "documents_pending");
    assert.equal(deriveKycOverallStatus({ aadhaarCard: testDocument("aadhaarCard") }, emptyReview()), "documents_pending");
  });

  it("is submitted when documents are present but review has not started", () => {
    assert.equal(deriveKycOverallStatus(requiredDocuments, emptyReview()), "submitted");
  });

  it("is verified only when every required check is verified", () => {
    const review = emptyReview({
      reviewStartedAt: new Date(),
      checks: {
        contactDetails: { status: "verified" },
        companyDetails: { status: "verified" },
        aadhaarCard: { status: "verified" },
        panCard: { status: "verified" }
      }
    });
    assert.equal(deriveKycOverallStatus(requiredDocuments, review), "verified");
  });

  it("reports additional_information_required when a check needs info", () => {
    const review = emptyReview({
      reviewStartedAt: new Date(),
      checks: { aadhaarCard: { status: "information_required", note: "Blurry scan" } }
    });
    assert.equal(deriveKycOverallStatus(requiredDocuments, review), "additional_information_required");
  });

  it("is rejected on a rejected check or a final decision", () => {
    assert.equal(
      deriveKycOverallStatus(requiredDocuments, emptyReview({ checks: { panCard: { status: "reject" } } })),
      "rejected"
    );
    assert.equal(
      deriveKycOverallStatus(requiredDocuments, emptyReview({ finalDecision: "rejected" })),
      "rejected"
    );
  });
});

describe("GST exemption review gate", () => {
  const verifiedChecks: IBusinessKycReview["checks"] = {
    contactDetails: { status: "verified" },
    companyDetails: { status: "verified" },
    aadhaarCard: { status: "verified" },
    panCard: { status: "verified" }
  };

  it("adds the exemption check only for accounts claiming exemption", () => {
    assert.ok(!getRequiredKycCheckKeys(requiredDocuments).includes("gstExemption"));
    assert.ok(!getRequiredKycCheckKeys(requiredDocuments, { gstExempt: false }).includes("gstExemption"));
    assert.ok(getRequiredKycCheckKeys(requiredDocuments, { gstExempt: true }).includes("gstExemption"));
  });

  it("withholds verified while an exemption is unreviewed", () => {
    const review = emptyReview({ reviewStartedAt: new Date(), checks: verifiedChecks });

    // Same review, same documents: only the exemption claim differs.
    assert.equal(deriveKycOverallStatus(requiredDocuments, review), "verified");
    assert.equal(deriveKycOverallStatus(requiredDocuments, review, { gstExempt: true }), "under_review");
  });

  it("reaches verified once the exemption is cleared", () => {
    const review = emptyReview({
      reviewStartedAt: new Date(),
      checks: { ...verifiedChecks, gstExemption: { status: "verified" } }
    });

    assert.equal(deriveKycOverallStatus(requiredDocuments, review, { gstExempt: true }), "verified");
  });

  it("rejects the account when the exemption is rejected", () => {
    const review = emptyReview({
      reviewStartedAt: new Date(),
      checks: { ...verifiedChecks, gstExemption: { status: "reject" } }
    });

    assert.equal(deriveKycOverallStatus(requiredDocuments, review, { gstExempt: true }), "rejected");
  });
});

describe("GSTIN rules", () => {
  it("accepts a well-formed GSTIN in any case or spacing", () => {
    assert.equal(getGstinError("27ABCDE1234F1Z5"), "");
    assert.equal(getGstinError(" 27abcde1234f1z5 "), "");
  });

  it("rejects a wrong length", () => {
    assert.match(getGstinError("27ABCDE1234F1Z"), /exactly 15/);
    assert.match(getGstinError("27ABCDE1234F1Z55"), /exactly 15/);
  });

  it("rejects an invalid state code but allows merged and central jurisdictions", () => {
    assert.match(getGstinError("00ABCDE1234F1Z5"), /state code/);
    assert.match(getGstinError("39ABCDE1234F1Z5"), /state code/);
    assert.equal(getGstinError("97ABCDE1234F1Z5"), "");
    assert.equal(getGstinError("25ABCDE1234F1Z5"), "");
  });

  it("rejects a malformed PAN section", () => {
    assert.match(getGstinError("27ABC1E1234F1Z5"), /must be a valid PAN/);
  });

  it("rejects a bad entity code or missing Z", () => {
    assert.ok(getGstinError("27ABCDE1234F0Z5"));
    assert.ok(getGstinError("27ABCDE1234F1X5"));
  });

  it("treats an empty value as the caller's problem, not a format error", () => {
    assert.equal(getGstinError(""), "");
    assert.equal(isValidGstin(""), false);
  });

  it("requires a GSTIN only for Indian accounts that have a company and claim no exemption", () => {
    assert.equal(requiresGstin({ registrationCountry: "India" }), true);
    assert.equal(requiresGstin({ registrationCountry: "India", noCompany: true }), false);
    assert.equal(requiresGstin({ registrationCountry: "India", gstExempt: true }), false);
    assert.equal(requiresGstin({ registrationCountry: "United Kingdom" }), false);
  });
});

describe("US tax ID rules", () => {
  it("accepts a nine-digit EIN and rejects any other length", () => {
    assert.equal(getUsTaxIdError("12-3456789", "ein"), "");
    assert.match(getUsTaxIdError("12-345678", "ein"), /9 digits/);
  });

  it("rejects SSN area numbers that are never issued", () => {
    assert.equal(getUsTaxIdError("123-45-6789", "ssn"), "");
    assert.match(getUsTaxIdError("000-45-6789", "ssn"), /cannot begin with 000/);
    assert.match(getUsTaxIdError("666-45-6789", "ssn"), /cannot begin with 666/);
    assert.match(getUsTaxIdError("912-70-1234", "ssn"), /ITIN/);
    assert.match(getUsTaxIdError("123-00-6789", "ssn"), /00 as its middle/);
    assert.match(getUsTaxIdError("123-45-0000", "ssn"), /end in 0000/);
  });

  it("requires an ITIN to begin with 9", () => {
    assert.equal(getUsTaxIdError("912-70-1234", "itin"), "");
    assert.match(getUsTaxIdError("123-70-1234", "itin"), /begins with 9/);
  });

  it("treats a masked value as unchanged rather than invalid", () => {
    const masked = maskUsTaxId("123456789", "ssn");

    assert.equal(masked, "•••-••-6789");
    assert.equal(isMaskedUsTaxId(masked), true);
    assert.equal(getUsTaxIdError(masked, "ssn"), "");
  });

  it("masks SSN and ITIN but leaves an EIN readable", () => {
    assert.equal(maskUsTaxId("123456789", "itin"), "•••-••-6789");
    assert.equal(maskUsTaxId("123456789", "ein"), "12-3456789");
    assert.equal(isSensitiveUsTaxIdType("ssn"), true);
    assert.equal(isSensitiveUsTaxIdType("itin"), true);
    assert.equal(isSensitiveUsTaxIdType("ein"), false);
  });

  it("routes US registration errors through the tax ID rules", () => {
    assert.equal(getPrimaryRegistrationError("United States", "12-3456789", "ein"), "");
    assert.match(getPrimaryRegistrationError("United States", "000-45-6789", "ssn"), /cannot begin with 000/);
  });

  it("no longer exempts the US from supplying a registration ID", () => {
    assert.equal(countriesWithoutRegistrationId.has("United States"), false);
    assert.equal(countriesWithoutRegistrationId.has("Kuwait"), true);
  });

  it("round-trips an encrypted tax ID", () => {
    const encrypted = encryptSecret("123456789", "taxId");

    assert.notEqual(encrypted, "123456789");
    assert.equal(decryptSecret<string>(encrypted, "taxId"), "123456789");
  });
});

describe("KYC document helpers", () => {
  it("requires Aadhaar and PAN before submission", () => {
    assert.equal(getDocumentRequirementError({}), "Aadhaar Card is required");
    assert.equal(getDocumentRequirementError({ aadhaarCard: testDocument("aadhaarCard") }), "PAN Card Copy is required");
    assert.equal(getDocumentRequirementError(requiredDocuments), null);
  });

  it("adds optional uploaded documents to the required check list", () => {
    const keys = getRequiredKycCheckKeys({ ...requiredDocuments, gstCertificate: testDocument("gstCertificate") });
    assert.ok(keys.includes("gstCertificate"));
    assert.ok(!keys.includes("iecCertificate"));
  });
});

describe("business account field rules", () => {
  it("accepts company and allow-listed personal email domains, rejects typo TLDs", () => {
    assert.equal(isValidBusinessContactEmail("ops@acme.com"), true);
    assert.equal(isValidBusinessContactEmail("person@gmail.com"), true);
    assert.equal(isValidBusinessContactEmail("person@gmail.con"), false);
    assert.equal(isValidBusinessContactEmail("person@gmail.org"), false);
  });

  it("validates a phone number against its country code", () => {
    assert.equal(isValidPhoneForCountryCode("+91", "9876543210"), true);
    assert.equal(isValidPhoneForCountryCode("+91", "123"), false);
  });

  it("validates postal codes and registration IDs per country", () => {
    assert.equal(isValidPostalCodeForCountry("India", "110001"), true);
    assert.equal(isValidPostalCodeForCountry("India", "11001"), false);
    assert.equal(getPrimaryRegistrationError("India", "ABCDE1234F"), "");
    assert.notEqual(getPrimaryRegistrationError("India", "INVALID"), "");
  });

  it("accepts only http and https website URLs", () => {
    assert.equal(isHttpOrHttpsUrl("https://acme.com"), true);
    assert.equal(isHttpOrHttpsUrl("http://acme.com"), true);
    assert.equal(isHttpOrHttpsUrl("javascript:alert(1)"), false);
    assert.equal(isHttpOrHttpsUrl("not a url"), false);
  });
});

describe("business account model validation", () => {
  it("accepts a fully populated account", async () => {
    await assert.doesNotReject(new BusinessAccount(validAccountData()).validate());
  });

  it("requires at least one operating country for a company account", async () => {
    const account = new BusinessAccount(validAccountData({
      company: { ...validAccountData().company, operatingCountries: [] }
    }));
    await assert.rejects(account.validate(), (error: unknown) => {
      const errors = (error as { errors?: Record<string, unknown> }).errors ?? {};
      return Boolean(errors["company.operatingCountries"]);
    });
  });

  it("allows a companyless account to skip operating countries", async () => {
    const account = new BusinessAccount(validAccountData({
      company: { ...validAccountData().company, noCompany: true, operatingCountries: [] }
    }));
    await assert.doesNotReject(account.validate());
  });
});
