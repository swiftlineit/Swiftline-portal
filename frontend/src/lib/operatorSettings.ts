import { readJsonSafely } from "@/lib/auth";
import { fetchWithAuth } from "@/lib/shipmentsList";

export type OperatorSettingsBranch = {
  _id: string;
  name: string;
  code: string;
  status: string;
  labelCode?: string;
  openingDate?: string | null;
  description?: string;
  address: {
    countryCode?: string;
    countryName?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    address?: string;
  };
  contact: { email?: string; phone?: string };
  operations?: {
    supportedServices?: string[];
    shipmentCoverage?: string[];
    operatingCountries?: string[];
    workingDays?: string[];
  };
  gstin?: string;
  invoiceSacCode?: string;
  baseCurrency?: string;
  phoneNumbers?: Array<{ label: string; number: string }>;
  createdAt?: string;
};

export type OperatorSettingsBanner = {
  id: string;
  url: string;
  mimeType: string;
  uploadedAt: string;
  heading: string;
  description: string;
};

export type OperatorSettingsPayload = {
  success: true;
  operator: {
    id: string;
    slug: string;
    companyName: string;
    logo: { url: string; mimeType: string; updatedAt: string } | null;
  };
  banners: OperatorSettingsBanner[];
  branches: OperatorSettingsBranch[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export class OperatorSettingsError extends Error {
  constructor(message: string, public readonly canonicalSlug?: string) {
    super(message);
    this.name = "OperatorSettingsError";
  }
}

function operatorPath(operatorSlug: string, resource: string) {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/${resource}`;
}

async function requestOperatorSettings<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(path, init);
  const payload = await readJsonSafely(response) as {
    success?: boolean;
    message?: string;
    canonicalSlug?: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new OperatorSettingsError(
      payload.message || "Operator settings could not be saved.",
      typeof payload.canonicalSlug === "string" ? payload.canonicalSlug : undefined
    );
  }
  return payload as T;
}

export function getOperatorSettings(operatorSlug: string, page: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ page: String(page), pageSize: "25" });
  return requestOperatorSettings<OperatorSettingsPayload>(
    `${operatorPath(operatorSlug, "settings")}?${query.toString()}`,
    { signal }
  );
}

export function updateOperatorCompanyName(operatorSlug: string, companyName: string) {
  return requestOperatorSettings<{
    success: true;
    operator: { id: string; slug: string; companyName: string };
  }>(operatorPath(operatorSlug, "settings/company"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyName })
  });
}

export function updateOperatorCompanyLogo(operatorSlug: string, file: File) {
  const form = new FormData();
  form.append("logo", file);
  return requestOperatorSettings<{
    success: true;
    logo: { url: string; mimeType: string; updatedAt: string };
  }>(operatorPath(operatorSlug, "settings/logo"), { method: "PUT", body: form });
}

export function removeOperatorCompanyLogo(operatorSlug: string) {
  return requestOperatorSettings<{ success: true; logo: null }>(
    operatorPath(operatorSlug, "settings/logo"),
    { method: "DELETE" }
  );
}

export function uploadOperatorBanner(operatorSlug: string, file: File, heading: string, description: string) {
  const form = new FormData();
  form.append("banner", file);
  form.append("heading", heading);
  form.append("description", description);
  return requestOperatorSettings<{ success: true; banner: OperatorSettingsBanner }>(
    operatorPath(operatorSlug, "settings/banners"),
    { method: "POST", body: form }
  );
}

export function removeOperatorBanner(operatorSlug: string, bannerId: string) {
  return requestOperatorSettings<{ success: true; banner: null }>(
    operatorPath(operatorSlug, `settings/banners/${encodeURIComponent(bannerId)}`),
    { method: "DELETE" }
  );
}

export async function loadOperatorBannerImage(operatorSlug: string, bannerId: string, signal?: AbortSignal) {
  const response = await fetchWithAuth(operatorPath(operatorSlug, `settings/banners/${encodeURIComponent(bannerId)}`), { signal });
  if (!response.ok) throw new OperatorSettingsError("Banner image could not be loaded.");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new OperatorSettingsError("The stored banner is not a supported image.");
  }
  return URL.createObjectURL(await response.blob());
}

export async function loadOperatorCompanyLogo(operatorSlug: string, signal?: AbortSignal) {
  const response = await fetchWithAuth(operatorPath(operatorSlug, "settings/logo"), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new OperatorSettingsError("Company logo could not be loaded.");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new OperatorSettingsError("The stored company logo is not a supported image.");
  }
  return URL.createObjectURL(await response.blob());
}

export function updateOperatorBranch(
  operatorSlug: string,
  branchId: string,
  update: Pick<OperatorSettingsBranch, "name" | "openingDate" | "description" | "address" | "contact" | "gstin" | "invoiceSacCode" | "baseCurrency">
) {
  return requestOperatorSettings<{ success: true; branch: OperatorSettingsBranch }>(
    operatorPath(operatorSlug, `branches/${encodeURIComponent(branchId)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update)
    }
  );
}
