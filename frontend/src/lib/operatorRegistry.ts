import { requestJson } from "@/lib/shipmentsList";
import type { OperatorSupportGrant } from "@/lib/operatorSupport";

export type OperatorDraft = {
  id: string;
  companyName: string;
  slug: string;
  status: "DRAFT" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
  administrators?: OperatorAdministrator[];
};

export type OperatorAdministrator = {
  userId: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED";
  requiresSignIn: boolean;
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

export function deleteOperatorDraft(id: string) {
  return requestJson<{ success: true; operator: Pick<OperatorDraft, "id" | "companyName" | "slug"> }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export function updateOperatorSlug(id: string, slug: string) {
  return requestJson<{ success: true; operator: OperatorDraft }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/slug`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }
  );
}

export function startOperatorSupportSession(id: string, reason: string) {
  return requestJson<{ success: true; support: OperatorSupportGrant }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/support-sessions`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }
  );
}

export function endOperatorSupportSession(grant: OperatorSupportGrant) {
  return requestJson<{ success: true }>(
    `/api/v1/platform/operators/${encodeURIComponent(grant.tenantId)}/support-sessions/current`,
    { method: "DELETE", headers: { "X-Operator-Support-Token": grant.token } }
  );
}

export function activateOperatorPortal(id: string) {
  return requestJson<{ success: true; operator: OperatorDraft }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/activate`,
    { method: "POST" }
  );
}

export function updateOperatorStatus(id: string, status: "ACTIVE" | "SUSPENDED", reason: string) {
  return requestJson<{ success: true; operator: OperatorDraft }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/status`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, reason }) }
  );
}

export function inviteOperatorAdministrator(id: string, input: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  return requestJson<{
    success: true;
    administrator: Pick<OperatorAdministrator, "userId" | "email" | "status" | "requiresSignIn">;
    expiresAt: string;
    emailSent: boolean;
    emailSkipped: boolean;
    emailFailed: boolean;
  }>(`/api/v1/platform/operators/${encodeURIComponent(id)}/admin-invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function issueOperatorAdministratorLink(id: string, userId: string) {
  return requestJson<{ success: true; activationUrl: string; expiresAt: string }>(
    `/api/v1/platform/operators/${encodeURIComponent(id)}/admin-invitations/${encodeURIComponent(userId)}/link`,
    { method: "POST" }
  );
}

export function acceptOperatorInvitation(token: string) {
  return requestJson<{ success: true; message: string; operator: { slug: string } }>(
    "/api/v1/auth/accept-operator-invitation",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }
  );
}

export function acceptOperatorClientInvitation(token: string) {
  return requestJson<{ success: true; message: string; operator: { slug: string } }>(
    "/api/v1/auth/accept-operator-client-invitation",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }
  );
}
