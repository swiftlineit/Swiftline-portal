"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/api";
import { logout, readJsonSafely, refreshAccessTokenWithStatus, setSessionEndedReason } from "@/lib/auth";
import type { PortalRole } from "@/lib/roles";
import { useReportAuthRecoveryIssue } from "@/contexts/AuthRecoveryContext";
import { accessTokenForAuthCheck, authRecoveryIssueForError, authRecoveryIssueForRefresh, authRecoveryIssueForStatus, type AuthRecoveryIssue } from "@/lib/authRecovery";

export type AuthenticatedUser = {
  name?: string;
  email: string;
  role: PortalRole;
  hasSeenWelcome?: boolean;
};

// A shared empty default: a `[]` literal would be a new value on every render.
const ADMIN_ONLY: readonly PortalRole[] = [];

/**
 * Confirms the signed-in user may be on this page, redirecting when not.
 *
 * Admin always passes. `additionalRoles` names the other roles allowed here-
 * pass one of the area bundles from `@/lib/roles` so the page and the sidebar
 * link that leads to it stay in agreement.
 */
export function useAdminUser(additionalRoles: readonly PortalRole[] = ADMIN_ONLY) {
  const router = useRouter();
  const reportRecoveryIssue = useReportAuthRecoveryIssue();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");

  // The effect keys off a stable string rather than the array itself, so a caller
  // passing an inline list cannot restart the identity check on every render.
  const additionalRolesKey = [...additionalRoles].sort().join(",");

  useEffect(() => {
    let active = true;
    const allowedRoles = new Set<string>(["admin", ...additionalRolesKey.split(",").filter(Boolean)]);

    // Throttling, server faults, and dropped connections must not be mistaken
    // for a rejected session. Retry those twice before showing recovery actions.
    async function attempt(): Promise<
      | { kind: "done" }
      | { kind: "recovery"; issue: AuthRecoveryIssue }
      | { kind: "retry"; error?: unknown }
    > {
      const accessTokenResult = await accessTokenForAuthCheck();
      if (!active) return { kind: "done" };
      if ("issue" in accessTokenResult) return { kind: "recovery", issue: accessTokenResult.issue };
      let token = accessTokenResult.token;

      let response = await fetch(apiUrl("/api/v1/auth/me"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!active) return { kind: "done" };

      if (response.status === 401) {
        const refreshResult = await refreshAccessTokenWithStatus();
        if (!active) return { kind: "done" };
        if (refreshResult.outcome !== "refreshed") {
          return { kind: "recovery", issue: authRecoveryIssueForRefresh(refreshResult) };
        }
        token = refreshResult.token;
        response = await fetch(apiUrl("/api/v1/auth/me"), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!active) return { kind: "done" };
      }

      if (response.status === 401 || response.status === 403) {
        return { kind: "recovery", issue: authRecoveryIssueForStatus(response.status) };
      }

      const data = await readJsonSafely(response) as { success?: boolean; user?: AuthenticatedUser };
      if (!response.ok) return { kind: "retry", error: { status: response.status } };
      if (!data.success || !data.user) return { kind: "retry" };
      if (!active) return { kind: "done" };

      if (!allowedRoles.has(data.user.role)) {
        setForbidden(true);
        router.replace("/dashboard");
        return { kind: "done" };
      }

      setUser(data.user);
      return { kind: "done" };
    }

    async function loadUser() {
      let lastError: unknown;
      for (let remaining = 2; remaining > 0; remaining -= 1) {
        try {
          const outcome = await attempt();
          if (!active) return;
          if (outcome.kind === "done") {
            setLoading(false);
            return;
          }
          if (outcome.kind === "recovery") {
            const { issue } = outcome;
            const message = issue.message || (issue.kind === "session"
              ? "Your session has expired. Sign in again to continue."
              : issue.kind === "permission"
                ? "This account does not currently have permission to access this page."
                : issue.kind === "network"
                  ? "We could not reach Swiftline to confirm your sign-in. Check your connection and try again."
                  : `Swiftline could not confirm your sign-in${issue.status ? ` (HTTP ${issue.status})` : ""}. Try again or sign in.`);
            setError(message);
            if (issue.kind === "session") setSessionEndedReason(message);
            setLoading(false);
            reportRecoveryIssue?.({ ...issue, message });
            if (issue.kind === "session" || issue.kind === "permission") void logout();
            return;
          }
          lastError = outcome.error;
        } catch (error) {
          if (!active) return;
          lastError = error;
          // Fall through to the retry below.
        }
        if (remaining > 1) await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }

      if (!active) return;
      const issue = authRecoveryIssueForError(lastError);
      const message = issue.kind === "network"
        ? "We could not reach Swiftline to confirm your sign-in. Check your connection and try again."
        : issue.status
          ? `Swiftline could not confirm your sign-in (HTTP ${issue.status}). Try again shortly or sign in.`
          : "Swiftline could not confirm your sign-in right now. Try again shortly or sign in.";
      setError(message);
      reportRecoveryIssue?.({ ...issue, message });
      setLoading(false);
    }

    void loadUser();
    return () => { active = false; };
  }, [additionalRolesKey, reportRecoveryIssue, router]);

  return { user, loading, forbidden, error };
}
