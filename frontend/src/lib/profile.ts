import { apiUrl } from "@/lib/api";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";
import {
  emailValidationMessage,
  getPhoneValidationError,
  isHttpOrHttpsUrl,
  isValidBusinessContactEmail
} from "@/lib/businessAccountContactRules";
import {
  getPostalCodeValidationMessage,
  isValidPostalCodeForCountry
} from "@/lib/businessAccountPostalCodes";
import type { StaffProfile } from "@/lib/users";

export type ProfileBranch = { id: string; name: string; code: string };

export type ProfileUser = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  userStatus: string;
  isVerified: boolean;
  emailVerifiedAt: string | null;
  lastLogin: string | null;
  createdAt: string | null;
  assignedBranches: ProfileBranch[];
  hasProfileImage: boolean;
  /** Present for internal staff; null for clients and pre-staff-form accounts. */
  staffProfile: StaffProfile | null;
};

export type ProfileCompany = {
  companyName: string;
  companyType: string;
  registrationCountry: string;
  registrationIdType: string;
  registrationId: string;
  gstin: string;
  registeredAddress: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  addressCountry: string;
  noCompany: boolean;
  website: string;
  industry: string;
  monthlyShipmentVolume: string;
  operatingCountries: string[];
};

export type ProfileContact = {
  title: string;
  firstName: string;
  lastName: string;
  email: string;
  countryCode: string;
  mobileNumber: string;
  jobTitle: string;
  department: string;
};

export type ProfileBusinessAccount = {
  id: string;
  accountId: string;
  status: string;
  membershipRole: string;
  canEdit: boolean;
  joinedAt: string | null;
  accountAssignedBranch: ProfileBranch | null;
  assignedBranches: ProfileBranch[];
  company: ProfileCompany;
  contact: ProfileContact;
};

export type Profile = {
  user: ProfileUser;
  businessAccounts: ProfileBusinessAccount[];
};

/** The company fields an account owner or admin may change after KYC. */
export type EditableCompany = Pick<
  ProfileCompany,
  "registeredAddress" | "city" | "stateOrProvince" | "postalCode" | "website" | "industry" | "monthlyShipmentVolume"
>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`
    }
  });

  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  const payload = await readJsonSafely(response) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "The profile request could not be completed.");
  }
  return payload as T;
}

export function getProfile() {
  return request<{ success: true } & Profile>("/api/v1/profile");
}

function operatorProfilePath(operatorSlug: string, resource = "profile") {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/${resource}`;
}

/** Operator-client profiles are served inside their verified operator tenant. */
export function getOperatorProfile(operatorSlug: string) {
  return request<{ success: true } & Profile>(operatorProfilePath(operatorSlug));
}

export function updateOperatorProfileDetails(operatorSlug: string, input: {
  firstName: string;
  lastName: string;
  phone: string;
}) {
  return request<{ success: true; message: string } & Profile>(operatorProfilePath(operatorSlug), {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateOperatorProfileBusinessAccount(
  operatorSlug: string,
  accountId: string,
  input: { company: EditableCompany; contact: ProfileContact }
) {
  return request<{ success: true; message: string } & Profile>(
    operatorProfilePath(operatorSlug, `profile/business-accounts/${encodeURIComponent(accountId)}`),
    { method: "PATCH", body: JSON.stringify(input) }
  );
}

export function uploadProfileImage(file: File) {
  const form = new FormData();
  form.append("profileImage", file);
  return request<{ success: true; message: string; hasProfileImage: boolean }>("/api/v1/profile/image", {
    method: "POST",
    body: form
  });
}

export function deleteProfileImage() {
  return request<{ success: true; message: string; hasProfileImage: boolean }>("/api/v1/profile/image", {
    method: "DELETE"
  });
}

export async function loadProfileImageUrl() {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl("/api/v1/profile/image"), { headers: { Authorization: `Bearer ${token}` } });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  if (!response.ok) throw new Error("Profile image not found.");
  return URL.createObjectURL(await response.blob());
}

/**
 * `address` and `emergencyContact` are only written when the signed-in user has
 * a staff record; the server ignores them otherwise. Job details, role, branches
 * and documents are HR/admin-owned and are not accepted here.
 */
export function updateProfileDetails(input: {
  firstName: string;
  lastName: string;
  phone: string;
  address?: { line1: string; city: string; state: string; postalCode: string };
  emergencyContact?: { name: string; phone: string; relationship: string };
}) {
  return request<{ success: true; message: string } & Profile>("/api/v1/profile", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateProfileBusinessAccount(
  accountId: string,
  input: { company: EditableCompany; contact: ProfileContact }
) {
  return request<{ success: true; message: string } & Profile>(`/api/v1/profile/business-accounts/${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function changeProfilePassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}) {
  return request<{ success: true; message: string }>("/api/v1/profile/password", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function formatProfileRole(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Titles the business account form accepts, so the profile offers the same set. */
export const contactTitles = ["mr.", "mrs.", "ms.", "dr.", "prof."];

/**
 * Inline mirror of the profile controller's rules, which themselves mirror the
 * business-account creation schema. The server is still the authority; this only
 * saves a round trip and points at the offending field.
 *
 * KEEP IN SYNC with portal/backend/src/controllers/profile.controller.ts
 */
/**
 * A number is typed the way it reads- "+91 87450 63206"- and checked as
 * digits. Kept in step with `isValidProfilePhone` in profile.controller.ts, so
 * this cannot reject a value the server would have accepted, or the reverse.
 */
function isValidProfilePhone(value: string) {
  const compact = value.trim().replace(/[\s\-()]/g, "");
  return !compact || /^\+?\d{6,15}$/.test(compact);
}

export function validateProfileUser(input: {
  firstName: string;
  lastName: string;
  phone: string;
  address?: { postalCode: string };
  emergencyContact?: { phone: string };
}) {
  const errors: Record<string, string> = {};
  if (input.firstName.trim().length < 2) errors.firstName = "First name must be at least 2 characters.";
  if (input.firstName.trim().length > 22) errors.firstName = "First name must be 22 characters or fewer.";
  if (input.lastName.trim().length > 22) errors.lastName = "Last name must be 22 characters or fewer.";
  if (!isValidProfilePhone(input.phone)) {
    errors.phone = "Enter a valid phone number, 6 to 15 digits.";
  }

  const postalCode = input.address?.postalCode.trim();
  if (postalCode && !/^\d{6}$/.test(postalCode)) errors.postalCode = "Enter a valid 6-digit PIN code.";

  if (!isValidProfilePhone(input.emergencyContact?.phone ?? "")) {
    errors.emergencyContactPhone = "Enter a valid phone number, 6 to 15 digits.";
  }

  return errors;
}

export function validateProfileAccount(
  input: { company: EditableCompany; contact: ProfileContact },
  context: { addressCountry: string; noCompany: boolean }
) {
  const errors: Record<string, string> = {};
  const { company, contact } = input;

  if (!contactTitles.includes(contact.title)) errors.title = "Select a title.";
  if (contact.firstName.trim().length < 2) errors.contactFirstName = "Enter at least 2 characters.";
  if (contact.firstName.trim().length > 22) errors.contactFirstName = "Enter 22 characters or fewer.";
  if (contact.lastName.trim().length < 1) errors.contactLastName = "Last name is required.";
  if (contact.lastName.trim().length > 22) errors.contactLastName = "Enter 22 characters or fewer.";
  if (!isValidBusinessContactEmail(contact.email)) errors.contactEmail = emailValidationMessage;
  if (!contact.countryCode.trim()) errors.countryCode = "Country code is required.";
  if (!/^\d{6,15}$/.test(contact.mobileNumber.trim())) {
    errors.mobileNumber = "Mobile number must contain 6 to 15 digits.";
  } else {
    const phoneError = getPhoneValidationError(contact.countryCode, contact.mobileNumber);
    if (phoneError) errors.mobileNumber = phoneError;
  }
  if (!contact.jobTitle.trim()) errors.jobTitle = "Job title is required.";
  if (!contact.department.trim()) errors.department = "Department is required.";

  if (company.website.trim() && !isHttpOrHttpsUrl(company.website.trim())) {
    errors.website = "Website must start with http:// or https://";
  }

  // Accounts registered without a company are not held to the company rules.
  if (!context.noCompany) {
    if (!company.registeredAddress.trim()) errors.registeredAddress = "Registered address is required.";
    if (!company.city.trim()) errors.city = "City is required.";
    if (!company.stateOrProvince.trim()) errors.stateOrProvince = "State or province is required.";
    if (!company.industry.trim()) errors.industry = "Company industry is required.";
    if (!company.monthlyShipmentVolume.trim()) errors.monthlyShipmentVolume = "Monthly shipment volume is required.";
    if (!company.postalCode.trim()) {
      errors.postalCode = "Postal code is required.";
    } else if (context.addressCountry && !isValidPostalCodeForCountry(context.addressCountry, company.postalCode)) {
      errors.postalCode = getPostalCodeValidationMessage(context.addressCountry);
    }
  }

  return errors;
}

export function profileHref(audience: "admin" | "client") {
  return audience === "client" ? "/client/profile" : "/dashboard/profile";
}
