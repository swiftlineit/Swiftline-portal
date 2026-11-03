import { getClientLoginReturnPath, getOperatorInvitationReturnPath } from "./operatorInvitationRouting";
import type { ClientWorkspaceAccess } from "./clientWorkspaceAccess";

function safeInternalPath(value: string | null, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "";
  } catch {
    return "";
  }
}

function requestedOperatorSlug(path: string, origin: string): string {
  const allowedPath = getClientLoginReturnPath(path, origin);
  if (!allowedPath) return "";
  try {
    return new URL(allowedPath, origin).pathname.match(/^\/portal\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function requestedClientPath(path: string, origin: string): string {
  const safePath = safeInternalPath(path, origin);
  if (!safePath) return "";
  try {
    const url = new URL(safePath, origin);
    return /^\/client(?:\/|$)/.test(url.pathname) ? safePath : "";
  } catch {
    return "";
  }
}

/** Resolve a client login from actual workspace memberships, never the global client role. */
export function resolveClientLoginDestination(
  access: ClientWorkspaceAccess,
  requestedPath: string | null,
  origin: string
): string {
  const invitationPath = getOperatorInvitationReturnPath(requestedPath, origin);
  if (invitationPath) return invitationPath;

  const operatorSlug = requestedOperatorSlug(requestedPath ?? "", origin);
  if (operatorSlug && access.operators.some((workspace) => workspace.slug === operatorSlug && workspace.status === "ACTIVE")) {
    return getClientLoginReturnPath(requestedPath, origin);
  }

  const clientPath = requestedClientPath(requestedPath ?? "", origin);
  if (clientPath && access.swiftline) return clientPath;

  const activeOperators = access.operators.filter((workspace) => workspace.status === "ACTIVE");
  const activeWorkspaceCount = Number(access.swiftline) + activeOperators.length;
  if (activeWorkspaceCount === 1 && access.swiftline) return "/client/dashboard";
  if (activeWorkspaceCount === 1 && activeOperators.length === 1) {
    return `/portal/${encodeURIComponent(activeOperators[0].slug)}`;
  }
  return "/workspaces";
}

/** Redirects an operator-only identity away from any Swiftline client route. */
export function clientRouteFallback(access: ClientWorkspaceAccess): string | null {
  if (access.swiftline) return null;
  const activeOperators = access.operators.filter((workspace) => workspace.status === "ACTIVE");
  if (activeOperators.length === 1) return `/portal/${encodeURIComponent(activeOperators[0].slug)}`;
  return "/workspaces";
}
