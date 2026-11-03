"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { ClientDashboardLoading, ClientDashboardShell, type ClientShellUser } from "@/components/client/ClientDashboardShell";
import { getClientWorkspaceAccess } from "@/lib/clientWorkspaceAccess";
import { clientRouteFallback } from "@/lib/clientWorkspaceRouting";

export default function ClientLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        let token = getAccessToken() ?? await refreshAccessToken();
        if (!token) {
          router.replace("/");
          return;
        }
        let response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 401) {
          token = await refreshAccessToken();
          if (!token) {
            router.replace("/");
            return;
          }
          response = await fetch(apiUrl("/api/v1/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        }
        if (response.status === 401 || response.status === 403) {
          router.replace("/");
          return;
        }
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error("Workspace access could not be loaded.");
        if (!active) return;
        if (data.user?.role !== "client") {
          router.replace("/dashboard");
          return;
        }

        const access = await getClientWorkspaceAccess();
        if (!active) return;
        const fallback = clientRouteFallback(access);
        if (fallback) {
          router.replace(fallback);
          return;
        }

        setUser(data.user as ClientShellUser);
        setAuthorized(true);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => { active = false; };
  }, [retryKey, router]);

  if (authorized && user) return <ClientDashboardShell user={user}>{children}</ClientDashboardShell>;
  if (failed) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#F6F8FC] px-4 py-8">
        <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-lg font-semibold text-slate-900">Workspace access could not be verified</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Your Swiftline client pages are paused until we can confirm this account’s workspace access.</p>
          <button type="button" onClick={() => { setFailed(false); setRetryKey((value) => value + 1); }}
            className="mt-5 inline-flex min-h-10 items-center justify-center rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#151c9a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
            Try again
          </button>
        </section>
      </main>
    );
  }
  return <ClientDashboardLoading />;
}
