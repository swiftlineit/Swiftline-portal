"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiAlertTriangle, FiBriefcase } from "react-icons/fi";
import {
  ClientDashboardLoading,
  ClientShellUser
} from "@/components/client/ClientDashboardShell";
import ClientAccessBlocked from "@/components/client/dashboard/ClientAccessBlocked";
import ClientBookingCapacityNotice from "@/components/client/dashboard/ClientBookingCapacityNotice";
import CreditPaymentStatusBanner from "@/components/credit/CreditPaymentStatusBanner";
import ClientDashboardHeader from "@/components/client/dashboard/ClientDashboardHeader";
import ClientQuickAccess from "@/components/client/dashboard/ClientQuickAccess";
import ClientRateCardNotice from "@/components/client/dashboard/ClientRateCardNotice";
import ClientRecentShipmentsCard from "@/components/client/dashboard/ClientRecentShipmentsCard";
import ClientShipmentPipelineCard from "@/components/client/dashboard/ClientShipmentPipelineCard";
import ClientTasksCard from "@/components/client/dashboard/ClientTasksCard";
import ClientUnavailableNotice from "@/components/client/dashboard/ClientUnavailableNotice";
import {
  ClientSummaryCards,
  ControlTowerSkeleton,
  NeedsAttention
} from "@/components/client/dashboard/ClientControlTower";
import { getClientOverview, type ClientOverview } from "@/lib/clientOverview";
import {
  canCreateShipment,
  hasQuoteAccess
} from "@/components/client/dashboard/clientDashboardPermissions";
import { EmptyState } from "@/components/dashboard/DashboardWidgets";
import OperationsMarquee from "@/components/OperationsMarquee";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, refreshAccessToken } from "@/lib/auth";
import {
  ClientDashboardAccount,
  ClientPrepaidAccount,
  ClientRecentShipment,
  ClientShipmentSummary,
  getClientDashboard,
  getClientPrepaidAccount
} from "@/lib/clientDashboard";
import {
  loadClientExtras,
  type ClientExtras
} from "@/lib/clientDashboardOverview";

function emptyShipmentSummary(branchId = ""): ClientShipmentSummary {
  return {
    branchId,
    totalShipments: 0,
    readyForLabel: 0,
    labelsCreated: 0,
    validationFailed: 0,
    needsReview: 0,
    addressValidated: 0,
    lastActivityAt: null
  };
}

function getShipmentDashboard(account: ClientDashboardAccount | null) {
  return account?.shipments ?? { summary: emptyShipmentSummary(), branchSummaries: [], recentShipments: [] };
}

const emptyExtras: ClientExtras = {
  quotesToConvert: 0,
  ticketsAwaitingReply: 0,
  credit: null,
  creditPermissions: [],
  statements: null,
  unavailable: []
};

async function loadCurrentUser() {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) return null;

  let response = await fetch(apiUrl("/api/v1/auth/me"), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) return null;

    response = await fetch(apiUrl("/api/v1/auth/me"), {
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  const data = await response.json();
  return data.success ? data.user as ClientShellUser : null;
}

export default function ClientDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [walletsByAccountId, setWalletsByAccountId] = useState<Record<string, ClientPrepaidAccount>>({});
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [extras, setExtras] = useState<ClientExtras>(emptyExtras);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selectedAccountIdRef = useRef("");
  const selectedBranchIdRef = useRef("");
  const [overview, setOverview] = useState<ClientOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");

  const selectedAccount = useMemo(
    () => accounts.find((item) => item.account.id === selectedAccountId) ?? accounts[0] ?? null,
    [accounts, selectedAccountId]
  );

  const selectedBranch = useMemo(() => {
    if (!selectedAccount || !selectedBranchId) return null;
    return selectedAccount.assignedBranches.find((branch) => branch._id === selectedBranchId) ?? null;
  }, [selectedAccount, selectedBranchId]);

  const selectedShipmentSummary = useMemo(() => {
    if (!selectedAccount) return null;
    const shipments = getShipmentDashboard(selectedAccount);
    if (!selectedBranchId) return shipments.summary;
    return shipments.branchSummaries.find((summary) => summary.branchId === selectedBranchId) ?? shipments.summary;
  }, [selectedAccount, selectedBranchId]);

  const recentShipments: ClientRecentShipment[] = useMemo(() => {
    if (!selectedAccount) return [];
    const shipments = getShipmentDashboard(selectedAccount);
    return selectedBranchId
      ? shipments.recentShipments.filter((shipment) => shipment.branchId === selectedBranchId)
      : shipments.recentShipments;
  }, [selectedAccount, selectedBranchId]);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const currentUser = await loadCurrentUser();
      if (!currentUser) {
        await logout();
        router.replace("/");
        return;
      }

      if (currentUser.role !== "client") {
        router.replace("/dashboard");
        return;
      }

      const dashboard = await getClientDashboard();
      const walletEntries = await Promise.all(
        dashboard.accounts.map(async (item) => {
          try {
            const wallet = await getClientPrepaidAccount(item.account.id);
            return [item.account.id, wallet.prepaidAccount] as const;
          } catch {
            return null;
          }
        })
      );

      const nextSelectedAccount = dashboard.accounts.find((item) => item.account.id === selectedAccountIdRef.current)
        ?? dashboard.accounts.find((item) => item.dashboardAccess.state === "READY")
        ?? dashboard.accounts[0]
        ?? null;
      const nextSelectedBranch = nextSelectedAccount?.assignedBranches.find((branch) => branch._id === selectedBranchIdRef.current)
        ?? nextSelectedAccount?.assignedBranches[0]
        ?? null;
      const nextExtras = nextSelectedAccount && nextSelectedAccount.dashboardAccess.state === "READY"
        ? await loadClientExtras({
          businessAccountId: nextSelectedAccount.account.id,
          canViewQuotes: hasQuoteAccess(nextSelectedAccount)
        })
        : emptyExtras;

      setUser(currentUser);
      setAccounts(dashboard.accounts);
      setWalletsByAccountId(Object.fromEntries(walletEntries.filter((entry): entry is readonly [string, ClientPrepaidAccount] => Boolean(entry))));
      setExtras(nextExtras);
      selectedAccountIdRef.current = nextSelectedAccount?.account.id ?? "";
      selectedBranchIdRef.current = nextSelectedBranch?._id ?? "";
      setSelectedAccountId(nextSelectedAccount?.account.id ?? "");
      setSelectedBranchId(nextSelectedBranch?._id ?? "");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load client dashboard.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!cancelled) await loadDashboardData();
    }

    void run();
    return () => { cancelled = true; };
  }, [loadDashboardData]);

  // The control tower loads on its own so a slow aggregation never holds up the
  // rest of the page, and re-runs whenever the account or branch context moves.
  useEffect(() => {
    if (!selectedAccountId) return;
    let active = true;

    getClientOverview({ businessAccountId: selectedAccountId, branchId: selectedBranchId || undefined })
      .then((result) => {
        if (!active) return;
        setOverview(result);
        setOverviewError("");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setOverviewError(caught instanceof Error ? caught.message : "Summary could not be loaded.");
      })
      .finally(() => {
        if (active) setOverviewLoading(false);
      });

    return () => { active = false; };
  }, [selectedAccountId, selectedBranchId]);

  async function handleAccountChange(accountId: string) {
    const nextAccount = accounts.find((item) => item.account.id === accountId) ?? null;
    const nextBranchId = nextAccount?.assignedBranches[0]?._id ?? "";
    selectedAccountIdRef.current = accountId;
    selectedBranchIdRef.current = nextBranchId;
    setSelectedAccountId(accountId);
    setSelectedBranchId(nextBranchId);
    setError("");

    try {
      if (nextAccount && nextAccount.dashboardAccess.state === "READY") {
        setExtras(await loadClientExtras({
          businessAccountId: accountId,
          canViewQuotes: hasQuoteAccess(nextAccount)
        }));
      } else {
        setExtras(emptyExtras);
      }
    } catch (caughtError) {
      setExtras(emptyExtras);
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load account dashboard details.");
    }
  }

  function handleBranchChange(branchId: string) {
    selectedBranchIdRef.current = branchId;
    setSelectedBranchId(branchId);
  }

  if (loading || !user) return <ClientDashboardLoading />;

  const selectedSummary = selectedShipmentSummary ?? emptyShipmentSummary();
  const selectedWallet = selectedAccount ? walletsByAccountId[selectedAccount.account.id] : undefined;
  const shipmentCreationAllowed = selectedAccount ? canCreateShipment(selectedAccount) : false;

  return (
      <div className="flex w-full flex-col gap-6">
        <OperationsMarquee variant="client" />
            <ClientQuickAccess account={selectedAccount} />

        <ClientDashboardHeader
          user={user}
          accounts={accounts}
          selectedAccount={selectedAccount}
          selectedBranchId={selectedBranchId}
          selectedBranch={selectedBranch}
          onAccountChange={(id) => void handleAccountChange(id)}
          onBranchChange={handleBranchChange}
        />

        {error ? (
          <p className="flex items-start gap-2 rounded-xl border border-[#D71313]/25 bg-[#D71313]/[0.06] px-4 py-3 text-sm font-medium text-[#D71313]">
            <FiAlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <ClientUnavailableNotice sections={extras.unavailable} />

        {!accounts.length ? (
          <EmptyState
            icon={FiBriefcase}
            title="No business account linked"
            message="This login does not have an active customer business account membership yet."
            surface="light"
          />
        ) : !selectedAccount ? (
          <EmptyState icon={FiBriefcase} title="No dashboard context" message="Select a business account to continue." surface="light" />
        ) : selectedAccount.dashboardAccess.state !== "READY" ? (
          <ClientAccessBlocked account={selectedAccount} />
        ) : (
          <>
            <ClientRateCardNotice account={selectedAccount} />

            <CreditPaymentStatusBanner
              account={extras.credit}
              businessAccountId={selectedAccountId}
            />
            <ClientBookingCapacityNotice
              credit={extras.credit}
              permissions={extras.creditPermissions}
              wallet={selectedWallet}
            />



            {/* The control tower answers "where are my shipments, what is
                broken, what do you need from me" before anything else on the
                page. Its figures come counted from /client/overview. */}
            {overviewError ? (
              <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                <FiAlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                {overviewError}
              </p>
            ) : null}

            {overviewLoading && !overview ? (
              <ControlTowerSkeleton />
            ) : overview ? (
              <>
                <ClientSummaryCards
                  summary={overview.summary}
                  canViewFinancials={overview.summary.availableCreditMinor !== null}
                />
                <NeedsAttention items={overview.needsAttention} />
              </>
            ) : null}

            {/* The old KPI grid is gone: it counted drafts where the control
                tower counts booked shipments, so the two sat side by side
                showing different "total shipments" and reading as a
                contradiction. */}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <ClientShipmentPipelineCard
                summary={selectedSummary}
                refreshing={false}
                canCreateShipment={shipmentCreationAllowed}
              />
              <ClientTasksCard summary={selectedSummary} extras={extras} refreshing={false} />
            </div>

            <ClientRecentShipmentsCard
              shipments={recentShipments}
              canCreateShipment={shipmentCreationAllowed}
            />
          </>
        )}
      </div>
  );
}
