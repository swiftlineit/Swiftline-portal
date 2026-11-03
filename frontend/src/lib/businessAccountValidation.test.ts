import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusinessAccountFormData } from "./businessAccounts";
import { validateBusinessAccountForm } from "./businessAccountValidation";

function noCompanyForm(): BusinessAccountFormData {
  return {
    contact: {
      title: "",
      firstName: "",
      lastName: "",
      email: "",
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: "",
      jobTitle: "",
      department: "",
      shipmentTypes: []
    },
    company: {
      registrationCountry: "India",
      registrationIdType: "pan",
      registrationId: "",
      gstin: "",
      gstExempt: false,
      gstExemptReason: "",
      secondaryRegistrationId: "",
      noCompanyRegistration: true,
      noCompany: true,
      companyType: "",
      companyName: "",
      registeredAddress: "",
      addressLine2: "",
      city: "",
      stateOrProvince: "",
      postalCode: "",
      addressCountry: "India",
      useCompanyAddressAsBillingAddress: true,
      billingAddress: {
        addressLine1: "",
        addressLine2: "",
        city: "",
        stateOrProvince: "",
        postalCode: "",
        country: ""
      },
      operatingCountries: [],
      website: "",
      industry: "",
      monthlyShipmentVolume: "",
      requestedCreditCurrency: "INR",
      requestedCreditLimit: ""
    },
    gstBilling: { requestedTreatment: "GST_APPLICABLE", requestReason: "" }
  };
}

test("no-company billing address is required only in the operator account workflow", () => {
  const form = noCompanyForm();
  const swiftlineValidation = validateBusinessAccountForm(form);
  const operatorValidation = validateBusinessAccountForm(form, {
    requireBillingAddressForNoCompany: true
  });

  assert.equal(swiftlineValidation.billingAddressLine1.required, false);
  assert.equal(swiftlineValidation.billingAddressLine1.error, "");
  assert.equal(operatorValidation.billingAddressLine1.required, true);
  assert.equal(operatorValidation.billingAddressLine1.error, "Billing address is required.");
});
