import { isValidAadhaarNumber, normalizeAadhaarNumber } from "@/lib/aadhaar";
import { getShipmentMobileError, isAcceptableShipmentEmail } from "@/lib/shipmentContactValidation";
import {
  requiredShipmentKycDocumentTypes,
  shipmentKycDocumentLabels,
  type ShipmentAddress,
  type ShipmentConsignorAddress,
  type ShipmentKycDocuments
} from "@/lib/dpdLabels";
import type { CsbType } from "@/lib/csbType";

// Consignors are always Indian senders, so these are shown read-only and are
// re-pinned by the server on every save.
export const consignorCountryCode = "IN";
export const consignorCountryName = "India";
export const consignorMobileCountryCode = "+91";

export type ConsignorForm = {
  companyName: string;
  contactName: string;
  email: string;
  mobileNumber: string;
  aadhaarNumber: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  postcode: string;
  pickupInstructions: string;
};

export function createEmptyConsignorForm(): ConsignorForm {
  return {
    companyName: "",
    contactName: "",
    email: "",
    mobileNumber: "",
    aadhaarNumber: "",
    addressLine1: "",
    addressLine2: "",
    townOrCity: "",
    county: "",
    postcode: "",
    pickupInstructions: ""
  };
}

export function consignorFormFromDraft(consignor: ShipmentConsignorAddress | undefined): ConsignorForm {
  return {
    companyName: consignor?.companyName ?? "",
    contactName: consignor?.contactName ?? "",
    email: consignor?.email ?? "",
    mobileNumber: consignor?.mobileNumber ?? "",
    aadhaarNumber: consignor?.aadhaarNumber ?? "",
    addressLine1: consignor?.addressLine1 ?? "",
    addressLine2: consignor?.addressLine2 ?? "",
    townOrCity: consignor?.townOrCity ?? "",
    county: consignor?.county ?? "",
    postcode: consignor?.postcode ?? "",
    pickupInstructions: consignor?.pickupInstructions ?? ""
  };
}

export function consignorFormsMatch(form: ConsignorForm, consignor: ShipmentConsignorAddress | undefined) {
  const current = consignorFormFromDraft(consignor);
  return (Object.keys(current) as Array<keyof ConsignorForm>).every((key) => form[key] === current[key]);
}

/**
 * One-way Company → Contact Name autofill.
 *
 * Mirrors the company value into the contact name while the contact still holds
 * its autofilled value (blank or equal to the previous company), so typing
 * "AMAN" yields "AMAN" in both fields. Once the user edits the contact to
 * something different it is left alone. Both fields stay editable afterwards.
 */
export function nextContactNameOnCompanyChange(
  previousCompanyName: string,
  previousContactName: string,
  nextCompanyName: string
): string {
  if (previousContactName.trim() && previousContactName !== previousCompanyName) {
    return previousContactName;
  }
  return nextCompanyName;
}

function comparableText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Compares the subscriber part so "+91 98…" and "098…" still read as equal. */
function comparablePhone(countryCode: string, mobileNumber: string) {
  return `${countryCode}${mobileNumber}`.replace(/\D/g, "").replace(/^0+/, "").slice(-10);
}

export type ConsigneeContact = {
  contactName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
};

/**
 * Form problems split by whether the user can defer them.
 *
 * `missing` is a field left blank- allowed in a saved draft, blocked at booking.
 * `invalid` is a field filled in wrongly, which is never storable: keeping it
 * would mean a draft reopens holding data the form itself rejects.
 */
export type ShipmentFormIssues = {
  missing: string[];
  invalid: string[];
};

export function allShipmentFormIssues(issues: ShipmentFormIssues) {
  return [...issues.missing, ...issues.invalid];
}

export function mergeShipmentFormIssues(...groups: ShipmentFormIssues[]): ShipmentFormIssues {
  return {
    missing: groups.flatMap((group) => group.missing),
    invalid: groups.flatMap((group) => group.invalid)
  };
}

export function getConsignorFormIssueDetail(
  form: ConsignorForm,
  consignee: ConsigneeContact
): ShipmentFormIssues {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!form.contactName.trim()) missing.push("Consignor contact name is required");
  if (!form.mobileNumber.trim()) {
    missing.push("Consignor mobile number is required");
  } else if (getShipmentMobileError(consignorMobileCountryCode, form.mobileNumber)) {
    invalid.push("Enter a valid consignor mobile number");
  }
  if (!form.email.trim()) {
    missing.push("Consignor email is required");
  } else if (!isAcceptableShipmentEmail(form.email)) {
    invalid.push("Enter a valid consignor email address");
  }
  // Aadhaar now lives in the KYC section (shared or per parcel); see getKycIssues.
  if (!form.addressLine1.trim()) missing.push("Consignor address line 1 is required");
  if (!form.townOrCity.trim()) missing.push("Consignor town or city is required");
  if (!form.county.trim()) missing.push("Consignor state is required");
  if (!form.postcode.trim()) {
    missing.push("Consignor PIN code is required");
  } else if (!/^[1-9]\d{5}$/.test(form.postcode.trim())) {
    invalid.push("Enter a valid 6 digit consignor PIN code");
  }

  // The consignor and the consignee must be different parties. Only reachable
  // once both sides are filled in, so a clash is always a genuine conflict.
  const consignorName = comparableText(form.contactName);
  if (consignorName && consignorName === comparableText(consignee.contactName)) {
    invalid.push("Consignor and consignee contact names must be different");
  }

  const consignorPhone = comparablePhone(consignorMobileCountryCode, form.mobileNumber);
  if (consignorPhone && consignorPhone === comparablePhone(consignee.mobileCountryCode, consignee.mobileNumber)) {
    invalid.push("Consignor and consignee mobile numbers must be different");
  }

  const consignorEmail = comparableText(form.email);
  if (consignorEmail && consignorEmail === comparableText(consignee.email)) {
    invalid.push("Consignor and consignee email addresses must be different");
  }

  return { missing, invalid };
}

/** Every consignor problem, blank fields included. Use before booking. */
export function getConsignorFormIssues(form: ConsignorForm, consignee: ConsigneeContact) {
  return allShipmentFormIssues(getConsignorFormIssueDetail(form, consignee));
}

export type ParcelKycState = {
  sequence: number;
  aadhaarNumber: string;
  kycDocuments: ShipmentKycDocuments | undefined;
};

// CSB-V uses the complete customs checklist. CSB-IV is the simplified low-value
// route and requires nothing, though anything supplied is still validated.
// When KYC is shared, one set covers every parcel; otherwise each parcel supplies it.
export function getKycIssues(input: {
  csbType: CsbType;
  useForAll: boolean;
  sharedAadhaar: string;
  sharedDocuments: ShipmentKycDocuments | undefined;
  parcels: ParcelKycState[];
}) {
  const issues: string[] = [];
  const isCsbV = input.csbType === "CSB_V";
  const requiredDocuments = requiredShipmentKycDocumentTypes(input.csbType);

  function appendMissingDocuments(documents: ShipmentKycDocuments | undefined, scope?: string) {
    requiredDocuments.forEach((type) => {
      if (!documents?.[type]) {
        issues.push(`${scope ? `${scope}: upload` : "Upload"} ${shipmentKycDocumentLabels[type]}`);
      }
    });
  }

  // Mirrors the server rule: the Aadhaar number identifies the sender and is
  // required on every route, whatever the document checklist asks for.
  function appendAadhaarIssue(value: string, label?: string) {
    const scope = label ? `${label}: ` : "";

    if (!value.trim()) {
      issues.push(`${scope}Aadhaar number is required`);
      return;
    }
    if (!isValidAadhaarNumber(value)) {
      issues.push(`${scope}${label ? "enter" : "Enter"} a valid 12 digit Aadhaar number`);
    }
  }

  if (input.useForAll) {
    appendAadhaarIssue(input.sharedAadhaar);
    appendMissingDocuments(input.sharedDocuments);
    return issues;
  }

  input.parcels.forEach((parcel, index) => {
    const label = `Parcel ${index + 1}`;
    appendAadhaarIssue(parcel.aadhaarNumber, label);
    appendMissingDocuments(parcel.kycDocuments, label);
  });

  return issues;
}

export function consignorFormToPatch(form: ConsignorForm): Partial<ShipmentConsignorAddress> {
  return {
    companyName: form.companyName.toUpperCase(),
    contactName: form.contactName.toUpperCase(),
    email: form.email,
    mobileNumber: form.mobileNumber,
    aadhaarNumber: normalizeAadhaarNumber(form.aadhaarNumber),
    addressLine1: form.addressLine1.toUpperCase(),
    addressLine2: form.addressLine2.toUpperCase(),
    townOrCity: form.townOrCity.toUpperCase(),
    county: form.county.toUpperCase(),
    postcode: form.postcode,
    pickupInstructions: form.pickupInstructions.toUpperCase()
  };
}

export function consigneeContactFrom(address: Pick<
  ShipmentAddress,
  "contactName" | "email" | "mobileCountryCode" | "mobileNumber"
>): ConsigneeContact {
  return {
    contactName: address.contactName ?? "",
    email: address.email ?? "",
    mobileCountryCode: address.mobileCountryCode ?? "",
    mobileNumber: address.mobileNumber ?? ""
  };
}
