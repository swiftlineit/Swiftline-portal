import { requestJson } from "@/lib/shipmentsList";

export type OperatorDraft = {
  id: string;
  companyName: string;
  slug: string;
  status: "DRAFT" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
};

export function listOperatorDrafts(page = 1) {
  return requestJson<{
    success: true;
    operators: OperatorDraft[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(`/api/v1/platform/operators?page=${page}&limit=20`);
}

export function createOperatorDraft(input: { companyName: string; slug?: string }) {
  return requestJson<{ success: true; operator: OperatorDraft }>("/api/v1/platform/operators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function updateOperatorSlug(id: string, slug: string) {
  return requestJson<{ success: true; operator: OperatorDraft }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/slug`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }
  );
}
