"use client";

import { apiUrl } from "@/lib/api";
import { getAccessToken, readJsonSafely, refreshAccessToken } from "@/lib/auth";

export type AddressBookEntryType = "SENDER" | "RECIPIENT";
export type AddressBookValidationStatus =
  | "NOT_VALIDATED"
  | "VALIDATED"
  | "CORRECTION_SUGGESTED"
  | "INCOMPLETE"
  | "UNAVAILABLE"
  | "MANUALLY_CONFIRMED";

export type AddressBookPostalAddress = {
  countryCode: string;
  countryName: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  postcode: string;
};

export type AddressBookEntry = AddressBookPostalAddress & {
  id: string;
  type: AddressBookEntryType;
  label: string;
  isFavourite: boolean;
  companyName: string;
  contactName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  hasAadhaarNumber: boolean;
  aadhaarNumberMasked: string;
  instructions: string;
  providerPlaceId: string;
  validationStatus: AddressBookValidationStatus;
  validationProvider: string;
  validationMessage: string;
  suggestedAddress: AddressBookPostalAddress | null;
  validatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AddressBookInput = Omit<AddressBookEntry,
  "id" | "hasAadhaarNumber" | "aadhaarNumberMasked" | "validationStatus" | "validationProvider" | "validationMessage" | "suggestedAddress" | "validatedAt" | "createdAt" | "updatedAt"
> & { aadhaarNumber?: string };

export type AddressBookSelection = AddressBookEntry & { aadhaarNumber: string };

export const emptyAddressBookInput = (type: AddressBookEntryType = "RECIPIENT"): AddressBookInput => ({
  type,
  label: "",
  isFavourite: false,
  companyName: "",
  contactName: "",
  email: "",
  mobileCountryCode: type === "SENDER" ? "+91" : "",
  mobileNumber: "",
  aadhaarNumber: "",
  countryCode: type === "SENDER" ? "IN" : "GB",
  countryName: type === "SENDER" ? "India" : "United Kingdom",
  addressLine1: "",
  addressLine2: "",
  townOrCity: "",
  county: "",
  postcode: "",
  instructions: "",
  providerPlaceId: ""
});

type ApiErrorPayload = { success?: boolean; message?: string; errors?: Array<{ field?: string; message?: string }> };

async function authenticatedFetch(path: string, init: RequestInit = {}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl(path), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${token}` }
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const payload = await readJsonSafely(response) as ApiErrorPayload;
  if (!response.ok || !payload.success) {
    const fieldMessage = payload.errors?.find((error) => error.message)?.message;
    throw new Error(fieldMessage || payload.message || "The address-book request could not be completed.");
  }
  return payload as T;
}

export async function listAddressBookEntries(input: {
  businessAccountId: string;
  search?: string;
  type?: "" | AddressBookEntryType;
  favourite?: boolean;
  page?: number;
  limit?: number;
}) {
  const query = new URLSearchParams({
    businessAccountId: input.businessAccountId,
    page: String(input.page ?? 1),
    limit: String(input.limit ?? 20)
  });
  if (input.search) query.set("search", input.search);
  if (input.type) query.set("type", input.type);
  if (input.favourite) query.set("favourite", "true");
  return json<{ success: true; entries: AddressBookEntry[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
    `/api/v1/client/address-book?${query.toString()}`
  );
}

export async function createAddressBookEntry(businessAccountId: string, input: AddressBookInput) {
  return json<{ success: true; entry: AddressBookEntry }>("/api/v1/client/address-book", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessAccountId, ...input })
  });
}

export async function getAddressBookEntry(entryId: string) {
  return json<{ success: true; entry: AddressBookEntry }>(`/api/v1/client/address-book/${entryId}`);
}

export async function revealAddressBookAadhaar(entryId: string) {
  return json<{ success: true; aadhaarNumber: string }>(`/api/v1/client/address-book/${entryId}/aadhaar/reveal`, {
    method: "POST"
  });
}

export async function prepareAddressBookEntryForShipment(entry: AddressBookEntry): Promise<AddressBookSelection> {
  const aadhaarNumber = entry.type === "SENDER" && entry.hasAadhaarNumber
    ? (await revealAddressBookAadhaar(entry.id)).aadhaarNumber
    : "";
  return { ...entry, aadhaarNumber };
}

export async function updateAddressBookEntry(entryId: string, input: AddressBookInput) {
  return json<{ success: true; entry: AddressBookEntry }>(`/api/v1/client/address-book/${entryId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function deleteAddressBookEntry(entryId: string) {
  return json<{ success: true; message: string }>(`/api/v1/client/address-book/${entryId}`, { method: "DELETE" });
}

export async function setAddressBookFavourite(entryId: string, isFavourite: boolean) {
  return json<{ success: true; entry: AddressBookEntry }>(`/api/v1/client/address-book/${entryId}/favourite`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isFavourite })
  });
}

export async function duplicateAddressBookEntry(entryId: string) {
  return json<{ success: true; entry: AddressBookEntry }>(`/api/v1/client/address-book/${entryId}/duplicate`, { method: "POST" });
}

export async function runAddressBookAction(entryId: string, action: "validate" | "accept-suggestion" | "confirm") {
  return json<{ success: true; entry: AddressBookEntry }>(`/api/v1/client/address-book/${entryId}/${action}`, { method: "POST" });
}

export type AddressBookImportPreviewRow = {
  rowNumber: number;
  data: AddressBookInput | null;
  errors: string[];
  warnings: string[];
};

export async function previewAddressBookImport(businessAccountId: string, file: File) {
  const form = new FormData();
  form.append("businessAccountId", businessAccountId);
  form.append("addressFile", file);
  const response = await authenticatedFetch("/api/v1/client/address-book/imports/preview", { method: "POST", body: form });
  const payload = await readJsonSafely(response) as ApiErrorPayload;
  if (!response.ok || !payload.success) throw new Error(payload.message || "The address-book file could not be previewed.");
  return payload as unknown as {
    success: true;
    filename: string;
    errors: string[];
    rows: AddressBookImportPreviewRow[];
    summary: { total: number; valid: number; invalid: number };
  };
}

export async function importAddressBookEntries(businessAccountId: string, entries: AddressBookInput[]) {
  return json<{ success: true; importedCount: number; entries: AddressBookEntry[] }>("/api/v1/client/address-book/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessAccountId, entries })
  });
}

export async function downloadAddressBookTemplate(businessAccountId: string, format: "csv" | "xlsx") {
  const query = new URLSearchParams({ businessAccountId });
  const response = await authenticatedFetch(`/api/v1/client/address-book/template/${format}?${query.toString()}`);
  if (!response.ok) throw new Error("The address-book template could not be downloaded.");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `swiftline-address-book-template.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function addressBookInputFromEntry(entry: AddressBookEntry): AddressBookInput {
  return {
    type: entry.type,
    label: entry.label,
    isFavourite: entry.isFavourite,
    companyName: entry.companyName,
    contactName: entry.contactName,
    email: entry.email,
    mobileCountryCode: entry.mobileCountryCode,
    mobileNumber: entry.mobileNumber,
    countryCode: entry.countryCode,
    countryName: entry.countryName,
    addressLine1: entry.addressLine1,
    addressLine2: entry.addressLine2,
    townOrCity: entry.townOrCity,
    county: entry.county,
    postcode: entry.postcode,
    instructions: entry.instructions,
    providerPlaceId: entry.providerPlaceId
  };
}
