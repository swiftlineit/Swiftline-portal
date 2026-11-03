import { API_BASE_URL } from "@/lib/api";

export type OperatorSupportGrant = {
  token: string;
  sessionId: string;
  tenantId: string;
  operatorSlug: string;
  companyName: string;
  reason: string;
  expiresAt: string;
};

const storageKey = "swiftline.operatorSupportSession";

export function getOperatorSupportGrant(): OperatorSupportGrant | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OperatorSupportGrant>;
    if (
      typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof value.sessionId !== "string" || typeof value.tenantId !== "string" ||
      typeof value.operatorSlug !== "string" || typeof value.companyName !== "string" ||
      typeof value.reason !== "string" || typeof value.expiresAt !== "string"
    ) return null;
    return value as OperatorSupportGrant;
  } catch {
    return null;
  }
}

export function storeOperatorSupportGrant(grant: OperatorSupportGrant) {
  window.sessionStorage.setItem(storageKey, JSON.stringify(grant));
}

export function clearOperatorSupportGrant() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(storageKey);
}

/** Adds the tab-scoped support credential only to operator API requests. */
export function operatorSupportHeaders(path: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (typeof window === "undefined") return result;
  let requestUrl: URL;
  let apiOrigin: string;
  try {
    requestUrl = new URL(path, window.location.origin);
    apiOrigin = new URL(API_BASE_URL, window.location.origin).origin;
  } catch {
    return result;
  }
  if (
    (requestUrl.origin !== window.location.origin && requestUrl.origin !== apiOrigin) ||
    !/^\/api\/v1\/operators\//.test(requestUrl.pathname)
  ) return result;
  const grant = getOperatorSupportGrant();
  if (grant) result.set("X-Operator-Support-Token", grant.token);
  return result;
}
