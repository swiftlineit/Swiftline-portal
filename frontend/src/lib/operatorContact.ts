import { readJsonSafely } from "@/lib/auth";
import { fetchWithAuth } from "@/lib/shipmentsList";

export type OperatorContactQuery = {
  id: string;
  kind: "ISSUE" | "HELP";
  subject: string;
  message?: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  businessAccountName: string;
  awbNumbers: string[];
  createdAt: string;
};

export type OperatorContactInput = {
  kind: "ISSUE" | "HELP";
  subject: string;
  message: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  awbNumbers: string[];
};

const base = (slug: string) => `/api/v1/operators/${encodeURIComponent(slug)}`;

async function requestContactJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuth(path, init);
  const payload = await readJsonSafely(response) as {
    success?: boolean;
    message?: string;
    canonicalSlug?: unknown;
  };
  if (!response.ok || !payload.success) {
    const error = new Error(payload.message || "The operator request could not be completed.") as Error & { canonicalSlug?: string };
    if (typeof payload.canonicalSlug === "string") error.canonicalSlug = payload.canonicalSlug;
    throw error;
  }
  return payload as T;
}

export function submitOperatorContact(slug: string, input: OperatorContactInput) {
  return requestContactJson<{ success: true; query: OperatorContactQuery }>(`${base(slug)}/contact`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listOperatorContactQueries(slug: string, page: number, search: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("search", search);
  return requestContactJson<{
    success: true;
    queries: OperatorContactQuery[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }>(`${base(slug)}/queries?${params}`, { signal });
}

export function getOperatorContactQuery(slug: string, id: string, signal?: AbortSignal) {
  return requestContactJson<{ success: true; query: OperatorContactQuery }>(
    `${base(slug)}/queries/${encodeURIComponent(id)}`, { signal }
  );
}
