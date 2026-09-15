"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminActivityCard from "@/components/dashboard/admin/AdminActivityCard";
import AdminDashboardBootstrap from "@/components/dashboard/admin/AdminDashboardBootstrap";
import AdminDashboardHeader from "@/components/dashboard/admin/AdminDashboardHeader";
import AdminKpiGrid from "@/components/dashboard/admin/AdminKpiGrid";
import AdminPipelineCard from "@/components/dashboard/admin/AdminPipelineCard";
import AdminQuickAccess from "@/components/dashboard/admin/AdminQuickAccess";
import AdminRecentManifestsCard from "@/components/dashboard/admin/AdminRecentManifestsCard";
import AdminReportingScopeCard from "@/components/dashboard/admin/AdminReportingScopeCard";
import AdminTasksCard from "@/components/dashboard/admin/AdminTasksCard";
import AdminTrendCard from "@/components/dashboard/admin/AdminTrendCard";
import AdminUnavailableNotice from "@/components/dashboard/admin/AdminUnavailableNotice";
import WelcomeModal from "@/components/WelcomeModal";
import OperationsMarquee from "@/components/OperationsMarquee";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, readJsonSafely, refreshAccessToken } from "@/lib/auth";
import {
  type DashboardOverview,
  getDashboardCapabilities,
  loadDashboardOverview,
  quickLinksForRole
} from "@/lib/dashboardOverview";
import type { AuthenticatedUser } from "@/lib/useAdminUser";

export default function DashboardPage() {
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [refreshing] = useState(false);

  useEffect(() => {
    async function loadUser() {
      let token = getAccessToken();
      if (!token) {
        token = await refreshAccessToken();
      }

      if (!token) {
        router.replace("/");
        return;
      }

      async function applyProfile(bearer: string) {
        const response = await fetch(apiUrl("/api/v1/auth/me"), {
          headers: { Authorization: `Bearer ${bearer}` }
        });
        const data = await readJsonSafely(response) as {
          success?: boolean;
          user?: AuthenticatedUser;
        };

        if (response.status === 401 || response.status === 403) return "signed-out" as const;
        if (!response.ok || !data.success || !data.user) return "retry" as const;

        if (data.user.role === "client") {
          router.replace("/client/dashboard");
          return "done" as const;
        }

        setUser(data.user);
        if (!data.user.hasSeenWelcome) setShowModal(true);
        return "done" as const;
      }

      try {
        let outcome = await applyProfile(token);
        if (outcome !== "done") {
          const refreshed = await refreshAccessToken();
          outcome = refreshed ? await applyProfile(refreshed) : "signed-out";
        }
        if (outcome === "signed-out") {
          await logout();
          router.replace("/");
        }
      } catch {
        // Leave the session intact; the operator can reload once the network settles.
      } finally {
        setLoading(false);
      }
    }

    void loadUser();
  }, [router]);

  const loadData = useCallback(async (role: string) => {
    setOverview(await loadDashboardOverview(role));
  }, []);

  useEffect(() => {
    if (!user) return;
    const role = user.role;
    let cancelled = false;

    async function run() {
      setDataLoading(true);
      await loadData(role);
      if (!cancelled) setDataLoading(false);
    }

    void run();
    return () => { cancelled = true; };
  }, [user, loadData]);

  async function handleClose() {
    setShowModal(false);
    const token = getAccessToken();
    if (!token) return;

    await fetch(apiUrl("/api/v1/auth/welcome-seen"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      }
    });
  }

  if (loading || !user) return <AdminDashboardBootstrap />;

  const capabilities = getDashboardCapabilities(user.role);
  const links = quickLinksForRole(user.role);
  const tracksShipments = capabilities.includes("shipments");
  const hasScope = capabilities.length > 0;

  return (
    <>
      <div className="-m-6 min-h-full bg-[#EEEDED]/60 p-6 lg:-m-8 lg:p-8">
        <div className="flex w-full flex-col gap-6">
          <OperationsMarquee variant="staff" />
          <AdminDashboardHeader user={user} />
          <AdminUnavailableNotice sections={overview?.unavailable ?? []} />

          {hasScope ? (
            <>
              <AdminKpiGrid
                overview={overview}
                dataLoading={dataLoading}
                tracksShipments={tracksShipments}
                role={user.role}
              />

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <AdminPipelineCard
                  overview={overview}
                  dataLoading={dataLoading}
                  refreshing={refreshing}
                  tracksShipments={tracksShipments}
                />
                <AdminTasksCard
                  overview={overview}
                  dataLoading={dataLoading}
                  refreshing={refreshing}
                />
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {tracksShipments ? (
                  <AdminTrendCard overview={overview} dataLoading={dataLoading} refreshing={refreshing} />
                ) : (
                  <AdminActivityCard overview={overview} dataLoading={dataLoading} refreshing={refreshing} className="lg:col-span-2" />
                )}
              </div>

              {tracksShipments ? (
                <AdminActivityCard overview={overview} dataLoading={dataLoading} refreshing={refreshing} className="lg:col-span-2" />
              ) : null}

              {!tracksShipments ? (
                <AdminRecentManifestsCard overview={overview} refreshing={refreshing} />
              ) : null}
            </>
          ) : (
            <div className="grid grid-cols-1 gap-6">
              <AdminReportingScopeCard role={user.role} />
            </div>
          )}

          <AdminQuickAccess links={links} />
        </div>
      </div>

      {showModal && <WelcomeModal onClose={handleClose} />}
    </>
  );
}
