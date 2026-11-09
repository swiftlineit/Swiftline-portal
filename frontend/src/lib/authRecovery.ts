import { getAccessToken, refreshAccessTokenWithStatus, type AccessTokenRefreshResult } from "@/lib/auth";

export type AuthRecoveryIssue = {
  kind: "session" | "permission" | "network" | "service";
  status?: number;
  message?: string;
};

export function authRecoveryIssueForStatus(status: number): AuthRecoveryIssue {
  if (status === 401) return { kind: "session" };
  if (status === 403) return { kind: "permission" };
  return { kind: "service", status };
}

export function authRecoveryIssueForRefresh(result: Exclude<AccessTokenRefreshResult, { outcome: "refreshed" }>): AuthRecoveryIssue {
  switch (result.outcome) {
    case "expired":
      return { kind: "session", message: "Your session has expired. Sign in again to continue." };
    case "ended":
      return { kind: "session", message: result.message };
    case "unavailable":
      return result.reason === "network"
        ? { kind: "network" }
        : { kind: "service", status: result.status };
  }
}

export async function accessTokenForAuthCheck(): Promise<
  | { token: string }
  | { token: null; issue: AuthRecoveryIssue }
> {
  const currentToken = getAccessToken();
  if (currentToken) return { token: currentToken };

  const refreshed = await refreshAccessTokenWithStatus();
  return refreshed.outcome === "refreshed"
    ? { token: refreshed.token }
    : { token: null, issue: authRecoveryIssueForRefresh(refreshed) };
}

export function authRecoveryIssueForError(error: unknown): AuthRecoveryIssue {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; status?: unknown; message?: unknown };
    if (candidate.name === "SessionEndedError") {
      return {
        kind: "session",
        message: typeof candidate.message === "string" ? candidate.message : undefined
      };
    }
    if (typeof candidate.status === "number") return authRecoveryIssueForStatus(candidate.status);
    if (typeof candidate.message === "string" && /session has expired|sign in again/i.test(candidate.message)) {
      return { kind: "session", message: candidate.message };
    }
  }

  if (error instanceof TypeError || (error instanceof Error && /failed to fetch|network|load failed/i.test(error.message))) {
    return { kind: "network" };
  }

  return { kind: "service" };
}
