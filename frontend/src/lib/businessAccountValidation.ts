// Single source of truth for business account field validation in the browser.
//
// Pure on purpose: it takes the form data and reports the state of every field,
// with no React, no side effects, and no opinion about when a message should be
// shown. The wizard uses one call for three jobs that previously each had their
// own copy of the rules- the live tick/warning on a field, the per-step gate,
// and the submit gate- so the three can no longer disagree.
//
// Deciding *when* to paint a field red stays in the UI: this module reports that
// an empty mandatory field is incomplete, and the form suppresses that until the
// user has visited the field or pressed a button.
//
// KEEP IN SYNC with the backend rules, which validate the same submission:
//   portal/backend/src/services/businessAccountRules.ts
//   portal/backend/src/controllers/businessAccount.controller.ts

import type { BusinessAccountFormData } from "./businessAccounts";
import {
  getPrimaryRegistrationRule,
  getSecondaryRegistrationRule
} from "./businessAccountRegistrationRules";
import {
  getPostalCodeValidationMessage,
  isValidPostalCodeForCountry
} from "./businessAccountPostalCodes";
import {
  BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX,
  emailValidationMessage,
  getPhoneValidationError,
  isHttpOrHttpsUrl,
  isValidBusinessContactEmail
} from "./businessAccountContactRules";
import { getGstinError, getGstinPanMismatchWarning, normalizeGstin } from "./gstin";
import {
  defaultUsTaxIdType,
  getUsTaxIdError,
  getUsTaxIdWarning,
  isUsTaxIdType,
  type UsTaxIdType
} from "./usTaxId";

export const GST_EXEMPT_REASON_MIN = 10;
export const GST_EXEMPT_REASON_MAX = 300;

// GSTIN is captured for Indian-registered accounts that have a company. An
// individual with no company cannot hold one, so the field is not shown at all.
export function collectsGstin(registrationCountry: string, noCompany?: boolean) {
  return registrationCountry === "India" && !noCompany;
}

export function requiresGstin(registrationCountry: string, noCompany?: boolean, gstExempt?: boolean) {
  return collectsGstin(registrationCountry, noCompany) && !gstExempt;
}

export type FieldValidity = {
  // Whether the field must be completed given the rest of the form. A country
  // change or a "no company" tick can flip this.
  required: boolean;
  filled: boolean;
  // Empty when the field is acceptable as it stands. A mandatory field left
  // empty reports its "is required" message here.
  error: string;
  // A caution the user should see but which does not block submission. Shown in
  // amber beneath the field; never affects the tick or the submit gate.
  warning?: string;
};

export type BusinessAccountValidation = Record<string, FieldValidity>;

// The US is not listed: a US account must supply a taxpayer ID (EIN, SSN or
// ITIN), carried by the same registrationId/registrationIdType pair as every
// other country.
export function countryRequiresRegistrationId(country: string) {
  return !["Kuwait"].includes(country);
}

// Neither escape hatch- "no registration number" nor "no company"- applies to
// the US. An individual with no company still holds an SSN or an ITIN, which is
// precisely why those are offered as types, so there is no route to a US account
// without a taxpayer ID.
export function countryAllowsSkippingRegistrationId(country: string) {
  return country !== "United States";
}

export function countryRequiresSecondaryRegistrationId(country: string) {
  return ["France", "Netherlands"].includes(country);
}

// Fields belonging to each wizard step, in display order. Drives the per-step
// gate and the order issues are listed back to the user.
export const stepFieldKeys: string[][] = [
  ["title", "firstName", "lastName", "email", "mobileType", "countryCode", "mobileNumber", "jobTitle", "department", "shipmentTypes"],
  [
    "registrationCountry",
    "registrationId",
    "secondaryRegistrationId",
    "gstin",
    "gstExemptReason",
    "gstBillingRequestReason",
    "companyType",
    "companyName",
    "registeredAddress",
    "addressLine2",
    "city",
    "stateOrProvince",
    "postalCode",
    "addressCountry",
    "billingAddressLine1",
    "billingCity",
    "billingState",
    "billingPostalCode",
    "billingCountry",
    "operatingCountries",
    "website",
    "industry",
    "monthlyShipmentVolume",
    "requestedCreditCurrency",
    "requestedCreditLimit"
  ],
  [],
  []
];

// Human labels for the outstanding-issues list, where a field name alone would
// not tell the user which control to go and fix.
export const fieldLabels: Record<string, string> = {
  title: "Title",
  firstName: "First name",
  lastName: "Last name",
  email: "Email address",
  mobileType: "Phone type",
  countryCode: "Country code",
  mobileNumber: "Mobile number",
  jobTitle: "Job title",
  department: "Department",
  shipmentTypes: "Shipment type",
  registrationCountry: "Country of registration",
  registrationId: "Registration ID",
  secondaryRegistrationId: "Additional registration code",
  gstin: "GSTIN",
  gstExemptReason: "GST exemption reason",
  gstBillingRequestReason: "No-GST billing reason",
  companyType: "Company type",
  companyName: "Company name",
  registeredAddress: "Company address",
  addressLine2: "Address line 2",
  billingAddressLine1: "Billing address",
  billingCity: "Billing city",
  billingState: "Billing state or province",
  billingPostalCode: "Billing postal code",
  billingCountry: "Billing country",
  city: "City",
  stateOrProvince: "State or province",
  postalCode: "Postal code",
  addressCountry: "Country",
  operatingCountries: "Operating countries",
  website: "Company website",
  industry: "Company industry",
  monthlyShipmentVolume: "Monthly shipment volume",
  requestedCreditCurrency: "Currency",
  requestedCreditLimit: "Requested credit limit"
};

function check(required: boolean, value: string, requiredMessage: string, formatError = ""): FieldValidity {
  const filled = Boolean(value.trim());

  if (!filled) return { required, filled, error: required ? requiredMessage : "" };

  return { required, filled, error: formatError };
}

function getContactNameError(label: string, value: string) {
  const length = value.trim().length;
  if (length < 3) return `${label} must be at least 3 characters.`;
  if (length > 22) return `${label} must be 22 characters or less.`;
  return "";
}

export function validateBusinessAccountForm(
  formData: BusinessAccountFormData,
  { requireBillingAddressForNoCompany = false }: { requireBillingAddressForNoCompany?: boolean } = {}
): BusinessAccountValidation {
  const { contact, company } = formData;
  const noCompany = Boolean(company.noCompany);
  const canSkipRegistration = !countryRequiresRegistrationId(company.registrationCountry)
    || (countryAllowsSkippingRegistrationId(company.registrationCountry)
      && (noCompany || Boolean(company.noCompanyRegistration)));

  const isUnitedStates = company.registrationCountry === "United States";
  const usTaxIdType: UsTaxIdType = isUsTaxIdType(company.registrationIdType ?? "")
    ? company.registrationIdType as UsTaxIdType
    : defaultUsTaxIdType(noCompany);

  const phoneError = getPhoneValidationError(contact.countryCode, contact.mobileNumber);
  const primaryRegistrationRule = getPrimaryRegistrationRule(company.registrationCountry, company.registrationIdType);
  const secondaryRegistrationRule = getSecondaryRegistrationRule(company.registrationCountry);

  const registrationId = company.registrationId.trim();
  const secondaryRegistrationId = company.secondaryRegistrationId?.trim() ?? "";
  const postalCode = company.postalCode.trim();
  const addressCountry = company.addressCountry?.trim() ?? "";
  const website = company.website?.trim() ?? "";
  const gstin = normalizeGstin(company.gstin ?? "");
  const requestedCreditLimit = company.requestedCreditLimit.trim();

  const gstExempt = Boolean(company.gstExempt);
  const gstExemptReason = company.gstExemptReason?.trim() ?? "";
  const gstBillingRequestReason = formData.gstBilling.requestReason.trim();
  const collectsGst = collectsGstin(company.registrationCountry, noCompany);
  const gstinRequired = requiresGstin(company.registrationCountry, noCompany, gstExempt);
  const gstinError = !collectsGst
    ? ""
    : gstExempt && gstin
      ? "Remove the GSTIN or untick GST exempt. An account cannot be both registered and exempt."
      : !gstin
        ? (gstinRequired ? "GSTIN is required for Indian business accounts. Tick GST exempt if the business is not registered under GST." : "")
        : getGstinError(gstin);

  // A separate billing address must be as complete as the company one, or
  // invoices are issued to somewhere unusable. When the company address is
  // reused these fields are not required and carry no messages.
  const billing = company.billingAddress ?? null;
  const needsBillingAddress = (!noCompany && !company.useCompanyAddressAsBillingAddress)
    || (noCompany && requireBillingAddressForNoCompany);
  const billingCountry = billing?.country?.trim() ?? "";
  const billingPostalCode = billing?.postalCode?.trim() ?? "";

  const billingValidity: BusinessAccountValidation = {
    billingAddressLine1: check(needsBillingAddress, billing?.addressLine1 ?? "", "Billing address is required."),
    billingCity: check(needsBillingAddress, billing?.city ?? "", "Billing city is required."),
    billingState: check(needsBillingAddress, billing?.stateOrProvince ?? "", "Billing state or province is required."),
    billingCountry: check(needsBillingAddress, billingCountry, "Billing country is required."),
    billingPostalCode: check(
      needsBillingAddress,
      billingPostalCode,
      "Billing postal code is required.",
      !needsBillingAddress || !billingCountry || isValidPostalCodeForCountry(billingCountry, billingPostalCode)
        ? ""
        : getPostalCodeValidationMessage(billingCountry)
    )
  };

  function creditLimitError() {
    if (!requestedCreditLimit) return "";
    if (!Number.isFinite(Number(requestedCreditLimit)) || Number(requestedCreditLimit) < 0) {
      return "Requested credit limit must be a valid positive amount.";
    }
    if (Number(requestedCreditLimit) > BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX) {
      return `Requested credit limit cannot exceed ${BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}.`;
    }
    return "";
  }

  return {
    // Contact details
    title: check(true, contact.title, "Title is required."),
    firstName: check(
      true,
      contact.firstName,
      "First name is required.",
      getContactNameError("First name", contact.firstName)
    ),
    lastName: check(
      true,
      contact.lastName,
      "Last name is required.",
      getContactNameError("Last name", contact.lastName)
    ),
    email: check(
      true,
      contact.email,
      "Email address is required.",
      isValidBusinessContactEmail(contact.email.trim()) ? "" : emailValidationMessage
    ),
    mobileType: check(true, contact.mobileType, "Phone type is required."),
    countryCode: check(
      true,
      contact.countryCode,
      "Country code is required.",
      phoneError === "Country code is required." ? phoneError : ""
    ),
    mobileNumber: check(
      true,
      contact.mobileNumber,
      "Mobile number is required.",
      phoneError && phoneError !== "Country code is required." ? phoneError : ""
    ),
    jobTitle: check(true, contact.jobTitle, "Job title is required."),
    department: check(true, contact.department, "Department is required."),
    shipmentTypes: {
      required: true,
      filled: contact.shipmentTypes.length > 0,
      error: contact.shipmentTypes.length ? "" : "Select at least one shipment type."
    },

    // Company details
    registrationCountry: check(true, company.registrationCountry, "Country of registration is required."),
    registrationId: {
      ...check(
        !canSkipRegistration,
        registrationId,
        isUnitedStates ? "US Tax ID is required." : "Registration ID is required.",
        canSkipRegistration || !primaryRegistrationRule || primaryRegistrationRule.validate(registrationId)
          ? ""
          : // The US rules explain exactly which part is wrong; every other
            // country has one format and one message.
            isUnitedStates
              ? getUsTaxIdError(registrationId, usTaxIdType) || primaryRegistrationRule.message
              : primaryRegistrationRule.message
      ),
      warning: isUnitedStates ? getUsTaxIdWarning(registrationId, usTaxIdType) : ""
    },
    secondaryRegistrationId: check(
      !canSkipRegistration && countryRequiresSecondaryRegistrationId(company.registrationCountry),
      secondaryRegistrationId,
      "Additional registration code is required.",
      canSkipRegistration || !secondaryRegistrationRule || secondaryRegistrationRule.validate(secondaryRegistrationId)
        ? ""
        : secondaryRegistrationRule.message
    ),
    gstin: {
      required: gstinRequired,
      filled: Boolean(gstin),
      error: gstinError,
      // Non-blocking: the PAN inside the GSTIN should belong to the same company
      // as the PAN captured above, but a related entity is possible.
      warning: gstinError ? "" : getGstinPanMismatchWarning(gstin, registrationId)
    },
    gstExemptReason: check(
      gstExempt && collectsGst,
      gstExemptReason,
      `Explain why this business is not registered under GST, in at least ${GST_EXEMPT_REASON_MIN} characters.`,
      gstExempt && collectsGst && gstExemptReason.length < GST_EXEMPT_REASON_MIN
        ? `Give at least ${GST_EXEMPT_REASON_MIN} characters so an administrator can assess the claim.`
        : ""
    ),
    gstBillingRequestReason: check(
      formData.gstBilling.requestedTreatment === "NO_GST",
      gstBillingRequestReason,
      "Enter a reason for requesting no-GST shipment billing.",
      formData.gstBilling.requestedTreatment === "NO_GST" && gstBillingRequestReason.length < 3
        ? "Give at least 3 characters so an administrator can review the request."
        : ""
    ),
    companyType: check(!noCompany, company.companyType, "Company type is required."),
    companyName: check(!noCompany, company.companyName, "Company name is required."),
    registeredAddress: check(!noCompany, company.registeredAddress, "Registered address is required."),
    addressLine2: check(false, company.addressLine2 ?? "", ""),
    ...billingValidity,
    city: check(!noCompany, company.city, "City is required."),
    stateOrProvince: check(!noCompany, company.stateOrProvince, "State or province is required."),
    postalCode: check(
      !noCompany,
      postalCode,
      "Postal code is required.",
      noCompany || !addressCountry || isValidPostalCodeForCountry(addressCountry, postalCode)
        ? ""
        : getPostalCodeValidationMessage(addressCountry)
    ),
    addressCountry: check(!noCompany, addressCountry, "Country is required."),
    operatingCountries: {
      required: !noCompany,
      filled: company.operatingCountries.length > 0,
      error: noCompany || company.operatingCountries.length ? "" : "Select at least one operating country.",
    },
    website: check(
      false,
      website,
      "",
      noCompany || isHttpOrHttpsUrl(website) ? "" : "Website must start with http:// or https://"
    ),
    industry: check(!noCompany, company.industry, "Company industry is required."),
    monthlyShipmentVolume: check(!noCompany, company.monthlyShipmentVolume, "Monthly shipment volume is required."),
    requestedCreditCurrency: check(true, company.requestedCreditCurrency, "Currency is required."),
    requestedCreditLimit: check(false, requestedCreditLimit, "", noCompany ? "" : creditLimitError())
  };
}

/**
 * The least a draft can be saved with.
 *
 * These are the fields the server keys its duplicate-account indexes off, so a
 * draft without them could not be de-duplicated and blank values would collide
 * between drafts. Everything else on the form can be filled in later.
 */
export const draftRequiredFieldKeys = [
  "firstName",
  "lastName",
  "email",
  "countryCode",
  "mobileNumber"
];

// Field keys of a step that are not yet acceptable, in display order.
export function getStepIssues(validation: BusinessAccountValidation, step: number) {
  return (stepFieldKeys[step] ?? []).filter((key) => Boolean(validation[key]?.error));
}

/** Whether the identity fields a draft needs are all acceptable. */
export function isDraftSavable(validation: BusinessAccountValidation) {
  return draftRequiredFieldKeys.every((key) => !validation[key]?.error && validation[key]?.filled);
}

export function isStepValid(validation: BusinessAccountValidation, step: number) {
  return getStepIssues(validation, step).length === 0;
}
