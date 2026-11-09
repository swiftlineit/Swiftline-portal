"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/api";
import { readJsonSafely, refreshAccessTokenWithStatus, setSessionEndedReason } from "@/lib/auth";
import { ClientDashboardLoading, ClientDashboardShell, type ClientShellUser } from "@/components/client/ClientDashboardShell";
import { getClientWorkspaceAccess, type ClientWorkspaceAccess } from "@/lib/clientWorkspaceAccess";
import { clientRouteFallback } from "@/lib/clientWorkspaceRouting";
import AuthRecoveryPage from "@/components/auth/AuthRecoveryPage";
import { accessTokenForAuthCheck, authRecoveryIssueForError, authRecoveryIssueForRefresh, authRecoveryIssueForStatus, type AuthRecoveryIssue } from "@/lib/authRecovery";

export default function ClientLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [failure, setFailure] = useState<AuthRecoveryIssue | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    function showFailure(issue: AuthRecoveryIssue) {
      if (!active) return;
      if (issue.kind === "session") {
        setSessionEndedReason(issue.message || "Your session may have expired. Please sign in again.");
      }
      setFailure(issue);
    }

    async function load() {
      try {
        const accessTokenResult = await accessTokenForAuthCheck();
        if ("issue" in accessTokenResult) {
          showFailure(accessTokenResult.issue);
          return;
        }
        let token = accessTokenResult.token;
        let response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 401) {
          const refreshResult = await refreshAccessTokenWithStatus();
          if (refreshResult.outcome !== "refreshed") {
            showFailure(authRecoveryIssueForRefresh(refreshResult));
            return;
          }
          token = refreshResult.token;
          response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        }
        if (response.status === 401 || response.status === 403) {
          showFailure(authRecoveryIssueForStatus(response.status));
          return;
        }
        if (!response.ok) {
          showFailure(authRecoveryIssueForStatus(response.status));
          return;
        }
        const data = await readJsonSafely(response) as { success?: boolean; user?: ClientShellUser };
        if (!data.success || !data.user) {
          showFailure({ kind: "service" });
          return;
        }
        if (!active) return;
        if (data.user?.role !== "client") {
          router.replace("/dashboard");
          return;
        }

        let access: ClientWorkspaceAccess;
        try {
          access = await getClientWorkspaceAccess();
        } catch (error) {
          showFailure(authRecoveryIssueForError(error));
          return;
        }
        if (!active) return;
        const fallback = clientRouteFallback(access);
        if (fallback) {
          router.replace(fallback);
          return;
        }

        setUser(data.user as ClientShellUser);
        setAuthorized(true);
      } catch (error) {
        showFailure(authRecoveryIssueForError(error));
      }
    }
    void load();
    return () => { active = false; };
  }, [retryKey, router]);

  if (authorized && user) return <ClientDashboardShell user={user}>{children}</ClientDashboardShell>;
  if (failure) return <AuthRecoveryPage issue={failure} onRetry={() => { setFailure(null); setRetryKey((value) => value + 1); }} />;
  return <ClientDashboardLoading fullPage announce />;
}
