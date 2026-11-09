"use client";

import { ReactNode, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { readJsonSafely, refreshAccessTokenWithStatus, setSessionEndedReason } from "@/lib/auth";
import DashboardShell from "@/components/DashboardShell";
import { type AuthenticatedUser } from "@/lib/useAdminUser";
import { AuthRecoveryBoundary } from "@/components/auth/AuthRecoveryBoundary";
import { useReportAuthRecoveryIssue } from "@/contexts/AuthRecoveryContext";
import { accessTokenForAuthCheck, authRecoveryIssueForError, authRecoveryIssueForRefresh, authRecoveryIssueForStatus } from "@/lib/authRecovery";

// Empty role renders no sidebar nav items (Sidebar filters by
// `roles.includes(userRole)`) rather than crashing or over-privileging while
// the real role loads in the background.
const FALLBACK_USER: AuthenticatedUser = { email: "", role: "" as AuthenticatedUser["role"] };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthRecoveryBoundary>
      <DashboardLayoutContent>{children}</DashboardLayoutContent>
    </AuthRecoveryBoundary>
  );
}

function DashboardLayoutContent({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser>(FALLBACK_USER);
  const reportRecoveryIssue = useReportAuthRecoveryIssue();

  useEffect(() => {
    let active = true;
    function report(issue: ReturnType<typeof authRecoveryIssueForStatus>) {
      if (!active) return;
      if (issue.kind === "session") {
        setSessionEndedReason(issue.message || "Your session may have expired. Please sign in again.");
      }
      reportRecoveryIssue?.(issue);
    }

    async function load() {
      try {
        const accessTokenResult = await accessTokenForAuthCheck();
        if ("issue" in accessTokenResult) {
          report(accessTokenResult.issue);
          return;
        }
        let token = accessTokenResult.token;
        let response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 401) {
          const refreshResult = await refreshAccessTokenWithStatus();
          if (refreshResult.outcome !== "refreshed") {
            report(authRecoveryIssueForRefresh(refreshResult));
            return;
          }
          token = refreshResult.token;
          response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        }
        if (response.status === 401 || response.status === 403) {
          report(authRecoveryIssueForStatus(response.status));
          return;
        }
        if (!response.ok) {
          report(authRecoveryIssueForStatus(response.status));
          return;
        }
        const data = await readJsonSafely(response) as { success?: boolean; user?: AuthenticatedUser };
        if (!data.success || !data.user) {
          report({ kind: "service" });
          return;
        }
        if (active) setUser(data.user);
      } catch (error) {
        const issue = authRecoveryIssueForError(error);
        report(issue);
      }
    }
    void load();
    return () => { active = false; };
  }, [reportRecoveryIssue]);

  return <DashboardShell user={user}>{children}</DashboardShell>;
}
