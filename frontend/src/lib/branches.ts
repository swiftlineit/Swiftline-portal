import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type BranchDocumentType = "PAN" | "GST" | "OTHER";

export type BranchDocument = {
  type: BranchDocumentType;
  title: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
};

export type BranchImageRef = {
  fileName: string;
  mimeType: string;
  uploadedAt: string;
};

export type BranchPhoneNumber = {
  label: string;
  number: string;
};

export const branchServices = [
  "EXPRESS_COURIER",
  "AIR_FREIGHT",
  "SEA_FREIGHT",
  "ROAD_FREIGHT",
  "RAIL_FREIGHT",
  "CUSTOMS_CLEARANCE",
  "WAREHOUSING",
  "COMMERCIAL_CARGO",
  "PERSONAL_SHIPMENTS",
  "LAST_MILE_DELIVERY"
] as const;

export const shipmentCoverageTypes = ["DOMESTIC", "INTERNATIONAL", "IMPORT", "EXPORT"] as const;
export const workingDays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export const branchStatuses = ["DRAFT", "ACTIVE", "INACTIVE", "SUSPENDED", "CLOSED"] as const;

export type BranchService = (typeof branchServices)[number];
export type ShipmentCoverage = (typeof shipmentCoverageTypes)[number];
export type WorkingDay = (typeof workingDays)[number];
export type BranchStatus = (typeof branchStatuses)[number];

// Allowed lifecycle transitions, mirroring the backend state machine so the UI
// only ever offers status actions the API will accept.
export const branchStatusTransitions: Record<BranchStatus, BranchStatus[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["INACTIVE", "SUSPENDED", "CLOSED"],
  INACTIVE: ["ACTIVE", "CLOSED"],
  SUSPENDED: ["ACTIVE", "CLOSED"],
  CLOSED: []
};

export type Branch = {
  _id: string;
  name: string;
  code: string;
  labelCode: string;
  openingDate?: string | null;
  description?: string;
  address: {
    countryCode: string;
    countryName: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    address: string;
  };
  contact: {
    email: string;
    phone: string;
  };
  operations: {
    supportedServices: BranchService[];
    shipmentCoverage: ShipmentCoverage[];
    operatingCountries: string[];
    workingDays: WorkingDay[];
  };
  baseCurrency: string;
  gstin: string;
  invoiceSacCode: string;
  status: BranchStatus;
  // Set on first activation; once present, code and labelCode are frozen.
  activatedAt?: string | null;
  images: BranchImageRef[];
  documents: BranchDocument[];
  phoneNumbers: BranchPhoneNumber[];
  createdBy?: { email?: string; name?: string };
  createdAt: string;
  updatedAt: string;
};

export type BranchFormData = {
  name: string;
  code: string;
  labelCode: string;
  openingDate: string;
  description: string;
  address: Branch["address"];
  contact: Branch["contact"];
  operations: Branch["operations"];
  baseCurrency: string;
  gstin: string;
  invoiceSacCode: string;
  phoneNumbers: BranchPhoneNumber[];
  existingImages: BranchImageRef[];
  existingDocuments: BranchDocument[];
};

export const countryOptions = [
  { code: "IN", name: "India" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "SG", name: "Singapore" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "CN", name: "China" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "MY", name: "Malaysia" },
  { code: "TH", name: "Thailand" }
] as const;

export const currencyOptions = ["INR", "USD", "AED", "GBP", "EUR", "SGD", "CAD", "AUD", "SAR"] as const;

export function formatBranchLabel(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildAuthHeaders(headers: HeadersInit | undefined, token: string | null) {
  const nextHeaders = new Headers(headers);

  if (token) {
    nextHeaders.set("Authorization", `Bearer ${token}`);
  }

  return nextHeaders;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const response = await fetch(input, {
    ...init,
    headers: buildAuthHeaders(init.headers, token)
  });

  if (response.status !== 401) return response;

  const refreshedToken = await refreshAccessToken();
  if (!refreshedToken) return response;

  return fetch(input, {
    ...init,
    headers: buildAuthHeaders(init.headers, refreshedToken)
  });
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || !data.success) {
    const formattedError = findFirstApiError(data.errors);
    throw new Error(data.message || formattedError || "Branch request failed");
  }

  return data as T;
}

function findFirstApiError(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const errors = (value as { _errors?: unknown })._errors;
  if (Array.isArray(errors) && typeof errors[0] === "string") {
    return errors[0];
  }

  for (const nested of Object.values(value)) {
    const message = findFirstApiError(nested);
    if (message) return message;
  }

  return "";
}

function branchApiPath(resource = "", operatorSlug?: string): string {
  const base = operatorSlug
    ? `/api/v1/operators/${encodeURIComponent(operatorSlug)}/branches`
    : "/api/v1/branches";
  const suffix = resource.replace(/^\/+/, "");
  return suffix ? `${base}/${suffix}` : base;
}

// Pagination is opt-in: pass a page to receive a bounded window plus the total
// count; omit it (e.g. branch pickers) to receive every matching branch.
export async function listBranches(search = "", status = "", page?: number, pageSize?: number) {
  const url = new URL(apiUrl("/api/v1/branches"));
  if (search) url.searchParams.set("search", search);
  if (status) url.searchParams.set("status", status);
  if (page) url.searchParams.set("page", String(page));
  if (pageSize) url.searchParams.set("pageSize", String(pageSize));

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{
    success: true;
    branches: Branch[];
    total?: number;
    page?: number;
    pageSize?: number;
  }>(response);
}

export async function getBranch(branchId: string, operatorSlug?: string, signal?: AbortSignal) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(encodeURIComponent(branchId), operatorSlug)), { signal });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

export async function validateBranchCode(code: string, operatorSlug?: string) {
  const url = new URL(apiUrl(branchApiPath("validate-code", operatorSlug)));
  url.searchParams.set("code", code);

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; exists: boolean; valid: boolean }>(response);
}

export async function validateBranchCodeForEdit(code: string, branchId: string, operatorSlug?: string) {
  const url = new URL(apiUrl(branchApiPath("validate-code", operatorSlug)));
  url.searchParams.set("code", code);
  url.searchParams.set("excludeBranchId", branchId);

  const response = await fetchWithAuth(url.toString());

  return parseApiResponse<{ success: true; exists: boolean; valid: boolean }>(response);
}

export function branchToFormData(branch: Branch): BranchFormData {
  return {
    name: branch.name,
    code: branch.code,
    labelCode: branch.labelCode ?? "",
    openingDate: branch.openingDate ? branch.openingDate.slice(0, 10) : "",
    description: branch.description ?? "",
    address: {
      countryCode: branch.address.countryCode ?? "",
      countryName: branch.address.countryName ?? "",
      city: branch.address.city ?? "",
      stateOrProvince: branch.address.stateOrProvince ?? "",
      postalCode: branch.address.postalCode ?? "",
      address: branch.address.address ?? ""
    },
    contact: {
      email: branch.contact.email ?? "",
      phone: branch.contact.phone ?? ""
    },
    operations: {
      supportedServices: branch.operations.supportedServices ?? [],
      shipmentCoverage: branch.operations.shipmentCoverage ?? [],
      operatingCountries: branch.operations.operatingCountries ?? [],
      workingDays: branch.operations.workingDays ?? []
    },
    baseCurrency: branch.baseCurrency ?? "",
    gstin: branch.gstin ?? "",
    invoiceSacCode: branch.invoiceSacCode ?? "",
    phoneNumbers: branch.phoneNumbers ?? [],
    existingImages: branch.images ?? [],
    existingDocuments: branch.documents ?? []
  };
}

export async function createBranch(data: BranchFormData, status: "DRAFT" | "ACTIVE", operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath("", operatorSlug)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, status })
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

// Updates branch fields only. Lifecycle status is changed through updateBranchStatus.
export async function updateBranch(branchId: string, data: BranchFormData, operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(encodeURIComponent(branchId), operatorSlug)), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

export async function updateBranchStatus(branchId: string, status: BranchStatus, operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(`${encodeURIComponent(branchId)}/status`, operatorSlug)), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

/**
 * Removes a branch that was never activated.
 *
 * Draft branches only- an activated branch is closed instead, so its history
 * survives. The server refuses the delete if anything still points at it.
 */
export async function deleteBranchDraft(branchId: string, operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(encodeURIComponent(branchId), operatorSlug)), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; message: string }>(response);
}

/**
 * Endpoints that stream a branch's stored files.
 *
 * Addressed by branch and position rather than by a storage path, so the server
 * can apply the same branch-access check it applies to the rest of the record.
 */
export function branchImageUrl(branchId: string, index: number, operatorSlug?: string) {
  return branchApiPath(`${encodeURIComponent(branchId)}/images/${index}`, operatorSlug);
}

export function branchDocumentUrl(branchId: string, index: number, operatorSlug?: string) {
  return branchApiPath(`${encodeURIComponent(branchId)}/documents/${index}`, operatorSlug);
}

// These endpoints require a Bearer token, which a plain <img src> or <a href>
// cannot send- so the bytes are fetched with auth and handed to the browser as
// an object URL instead.
export async function fetchBranchFileObjectUrl(fileUrl: string) {
  const response = await fetchWithAuth(apiUrl(fileUrl));
  if (!response.ok) throw new Error("Unable to load file");

  return URL.createObjectURL(await response.blob());
}

export async function uploadBranchImages(branchId: string, files: File[], operatorSlug?: string) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  const response = await fetchWithAuth(apiUrl(branchApiPath(`${encodeURIComponent(branchId)}/images`, operatorSlug)), {
    method: "POST",
    body: formData
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

export async function deleteBranchImage(branchId: string, imageIndex: number, operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(`${encodeURIComponent(branchId)}/images/${imageIndex}`, operatorSlug)), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

export async function uploadBranchDocument(
  branchId: string,
  type: BranchDocumentType,
  title: string,
  file: File,
  operatorSlug?: string
) {
  const formData = new FormData();
  formData.append("document", file);
  formData.append("type", type);
  formData.append("title", title);

  const response = await fetchWithAuth(apiUrl(branchApiPath(`${encodeURIComponent(branchId)}/documents`, operatorSlug)), {
    method: "POST",
    body: formData
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}

export async function deleteBranchDocument(branchId: string, docIndex: number, operatorSlug?: string) {
  const response = await fetchWithAuth(apiUrl(branchApiPath(`${encodeURIComponent(branchId)}/documents/${docIndex}`, operatorSlug)), {
    method: "DELETE"
  });

  return parseApiResponse<{ success: true; branch: Branch }>(response);
}
