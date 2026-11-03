import { readJsonSafely } from "@/lib/auth";
import { fetchWithAuth } from "@/lib/shipmentsList";

export type OperatorDirectoryPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type OperatorSession = {
  success: true;
  operator: { id: string; slug: string; companyName: string };
  membership: { role: "OPERATOR_ADMIN" | "OPERATIONS" | "FINANCE" | "CLIENT"; assignedBranches: string[] };
  access: { mode: "MEMBER" | "PLATFORM_SUPPORT"; readOnly: boolean; expiresAt?: string };
};

export type OperatorBusinessAccount = {
  _id: string;
  accountId: string;
  accountKind: "BUSINESS" | "INDIVIDUAL_SENTINEL";
  status: string;
  contact?: { firstName?: string; lastName?: string; email?: string };
  company?: { companyName?: string };
  kycReview?: { overallStatus?: string };
  assignedBranch?: { _id: string; name: string; code: string; status: string } | null;
  creditSummary?: { availableCreditMinor: number; outstandingMinor: number } | null;
  createdAt: string;
  updatedAt: string;
};

export type OperatorBranch = {
  _id: string;
  name: string;
  code: string;
  labelCode?: string;
  address?: { countryCode?: string; countryName?: string; city?: string; stateOrProvince?: string };
  contact?: { email?: string; phone?: string };
  openingDate?: string | null;
  status: string;
  operations?: { supportedServices?: string[] };
};

export type OperatorBranchDetails = OperatorBranch & {
  openingDate?: string | null;
  description?: string;
  address?: {
    countryCode?: string;
    countryName?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    address?: string;
  };
  contact?: { email?: string; phone?: string };
  operations?: {
    supportedServices?: string[];
    shipmentCoverage?: string[];
    operatingCountries?: string[];
    workingDays?: string[];
  };
  baseCurrency?: string;
  gstin?: string;
  invoiceSacCode?: string;
  activatedAt?: string | null;
  phoneNumbers?: Array<{ label: string; number: string }>;
  documents?: Array<{ type: string; title?: string; fileName: string; mimeType?: string; uploadedAt: string }>;
  createdAt: string;
  updatedAt: string;
};

export type OperatorBranchUser = {
  _id: string;
  role: string;
  membershipStatus: string;
  createdAt: string;
  user: {
    _id: string;
    firstName: string;
    lastName: string;
    name: string;
    email: string;
    phone: string;
    designation: string;
    userStatus: string;
    lastLogin: string | null;
  } | null;
  account?: { accountId: string; companyName: string } | null;
};

export type OperatorBranchUserProfile = {
  success: true;
  branch: { _id: string; name: string };
  user: OperatorBranchUser;
};

export type OperatorDirectoryQuery = {
  page: number;
  pageSize: number;
  search?: string;
};

export type OperatorUserDirectoryRow = {
  _id: string;
  role: string;
  membershipStatus: string;
  createdAt: string;
  user: {
    _id: string | null;
    firstName: string;
    lastName: string;
    name: string;
    email: string;
    phone: string;
    designation: string;
    userStatus: string;
    lastLogin: string | null;
  };
  account?: { accountId: string; companyName: string };
};

export type OperatorUserProfile = {
  success: true;
  profile: {
    audience: "team" | "clients";
    membership: { id: string; role: string; status: string; createdAt: string };
    user: {
      id: string;
      firstName: string;
      lastName: string;
      name: string;
      email: string;
      phone: string;
      designation: string;
      userStatus: string;
      lastLogin: string | null;
    };
    account: { accountId: string; companyName: string } | null;
    branches: Array<{ id: string; name: string; code: string }>;
    allBranchesAccess: boolean;
  };
};

export type OperatorUserDirectoryResult = {
  success: true;
  teamUsers: OperatorUserDirectoryRow[];
  teamPagination: OperatorDirectoryPagination;
  clientUsers: OperatorUserDirectoryRow[];
  clientPagination: OperatorDirectoryPagination;
};

export type OperatorBranchDirectoryQuery = OperatorDirectoryQuery & { status?: string };
export type OperatorBusinessAccountDirectoryQuery = OperatorDirectoryQuery & { branchId?: string };

class OperatorDirectoryRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly canonicalSlug?: string
  ) {
    super(message);
    this.name = "OperatorDirectoryRequestError";
  }
}

async function requestOperatorJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(path, { ...init, signal });
  const payload = await readJsonSafely(response) as {
    success?: boolean;
    message?: string;
    canonicalSlug?: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new OperatorDirectoryRequestError(
      payload.message || "The operator request could not be completed.",
      response.status,
      typeof payload.canonicalSlug === "string" ? payload.canonicalSlug : undefined
    );
  }
  return payload as T;
}

function queryString(query: OperatorDirectoryQuery & { status?: string; branchId?: string }): string {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.branchId) params.set("branchId", query.branchId);
  return params.toString();
}

function operatorPath(operatorSlug: string, resource: string): string {
  return `/api/v1/operators/${encodeURIComponent(operatorSlug)}/${resource}`;
}

export function getOperatorSession(operatorSlug: string, signal?: AbortSignal) {
  return requestOperatorJson<OperatorSession>(operatorPath(operatorSlug, "me"), signal);
}

export function listOperatorBusinessAccounts(operatorSlug: string, query: OperatorBusinessAccountDirectoryQuery, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    accounts: OperatorBusinessAccount[];
    pagination: OperatorDirectoryPagination;
  }>(`${operatorPath(operatorSlug, "business-accounts")}?${queryString(query)}`, signal);
}

export function listOperatorBranches(operatorSlug: string, query: OperatorBranchDirectoryQuery, signal?: AbortSignal) {
  return requestOperatorJson<{
    success: true;
    branches: OperatorBranch[];
    pagination: OperatorDirectoryPagination;
  }>(`${operatorPath(operatorSlug, "branches")}?${queryString(query)}`, signal);
}

export function getOperatorBranchDetails(operatorSlug: string, branchId: string, signal?: AbortSignal) {
  return requestOperatorJson<{ success: true; branch: OperatorBranchDetails }>(
    operatorPath(operatorSlug, `branches/${encodeURIComponent(branchId)}/details`),
    signal
  );
}

export function listOperatorBranchUsers(
  operatorSlug: string,
  branchId: string,
  query: OperatorDirectoryQuery,
  signal?: AbortSignal
) {
  return requestOperatorJson<{
    success: true;
    users: OperatorBranchUser[];
    pagination: OperatorDirectoryPagination;
  }>(`${operatorPath(operatorSlug, `branches/${encodeURIComponent(branchId)}/users`)}?${queryString(query)}`, signal);
}

export function getOperatorBranchUser(
  operatorSlug: string,
  branchId: string,
  membershipId: string,
  signal?: AbortSignal
) {
  return requestOperatorJson<OperatorBranchUserProfile>(
    operatorPath(operatorSlug, `branches/${encodeURIComponent(branchId)}/users/${encodeURIComponent(membershipId)}`),
    signal
  );
}

export function listOperatorUsers(
  operatorSlug: string,
  query: { teamPage: number; clientPage: number; pageSize: number; search?: string },
  signal?: AbortSignal
) {
  const params = new URLSearchParams({
    teamPage: String(query.teamPage),
    clientPage: String(query.clientPage),
    pageSize: String(query.pageSize)
  });
  if (query.search) params.set("search", query.search);
  return requestOperatorJson<OperatorUserDirectoryResult>(`${operatorPath(operatorSlug, "users")}?${params.toString()}`, signal);
}

export function getOperatorUserProfile(
  operatorSlug: string,
  audience: "team" | "clients",
  membershipId: string,
  signal?: AbortSignal
) {
  return requestOperatorJson<OperatorUserProfile>(
    operatorPath(operatorSlug, `users/${audience}/${encodeURIComponent(membershipId)}`),
    signal
  );
}

export function updateOperatorSlug(operatorSlug: string, slug: string) {
  return requestOperatorJson<{
    success: true;
    operator: { id: string; slug: string; companyName: string };
  }>(operatorPath(operatorSlug, "settings/slug"), undefined, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug })
  });
}
