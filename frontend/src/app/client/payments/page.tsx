"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiRefreshCw } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  ClientDashboardLoading,
  ClientShellUser
} from "@/components/client/ClientDashboardShell";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, refreshAccessToken } from "@/lib/auth";
import { ClientDashboardAccount, getClientDashboard } from "@/lib/clientDashboard";
import { getClientAccountLedger, type PaymentsLedgerRow } from "@/lib/prepaidLedger";
import ClientPaymentLedger from "@/components/payments/ClientPaymentLedger";

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

export default function ClientPaymentsPage() {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [selectedBusinessAccountId, setSelectedBusinessAccountId] = useState("");
  const [ledgerTransactions, setLedgerTransactions] = useState<PaymentsLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ledgerError, setLedgerError] = useState("");
  const ledgerRequest = useRef(0);

  const selectedAccount = useMemo(
    () => accounts.find((item) => item.account.id === selectedBusinessAccountId) ?? accounts[0] ?? null,
    [accounts, selectedBusinessAccountId]
  );

  const loadLedger = useCallback(async (businessAccountId: string, quiet = false) => {
    const requestId = ++ledgerRequest.current;
    if (!quiet) setRefreshing(true);
    setLedgerError("");
    try {
      const result = await getClientAccountLedger(businessAccountId, { page: 1, limit: 50 });
      if (requestId !== ledgerRequest.current) return;
      setLedgerTransactions(result.transactions);
    } catch (caughtError) {
      if (requestId !== ledgerRequest.current) return;
      setLedgerError(caughtError instanceof Error ? caughtError.message : "Payments ledger could not be loaded.");
    } finally {
      if (requestId === ledgerRequest.current && !quiet) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadPage() {
      setLoading(true);
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
        const params = new URLSearchParams(window.location.search);
        const eligibleAccounts = dashboard.accounts.filter((item) =>
          ["account_owner", "account_admin", "finance"].includes(item.membership.role)
        );
        const requestedAccountId = params.get("businessAccountId") || "";
        const firstAccountId = eligibleAccounts.some((item) => item.account.id === requestedAccountId)
          ? requestedAccountId
          : eligibleAccounts[0]?.account.id || "";

        if (!mounted) return;
        setUser(currentUser);
        setAccounts(eligibleAccounts);
        setSelectedBusinessAccountId(firstAccountId);
        if (firstAccountId) {
          await loadLedger(firstAccountId, true);
        } else {
          toast.error("Your account role cannot access payments.");
        }
      } catch (caughtError) {
        if (!mounted) return;
        toast.error(caughtError instanceof Error ? caughtError.message : "Unable to load client payments.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadPage();
    return () => {
      mounted = false;
    };
  }, [router, loadLedger]);

  async function handleAccountChange(nextBusinessAccountId: string) {
    setSelectedBusinessAccountId(nextBusinessAccountId);
    await loadLedger(nextBusinessAccountId);
  }

  if (loading || !user) return <ClientDashboardLoading />;

  return (
    <div className="mx-auto max-w-8xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Payments</h1>
          <p className="mt-1 text-sm text-slate-500">Review online payments, cash receipts and refunds recorded for your business account. New shipments are paid in full when booked.</p>
        </div>
        <button
          type="button"
          onClick={() => selectedAccount && void loadLedger(selectedAccount.account.id)}
          disabled={refreshing || !selectedAccount}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FiRefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {accounts.length > 1 ? (
        <div className="border border-slate-200 bg-white p-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="businessAccount">
            Business Account
          </label>
          <select
            id="businessAccount"
            value={selectedBusinessAccountId}
            onChange={(event) => void handleAccountChange(event.target.value)}
            className="mt-2 h-11 w-full border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 focus:border-blue-900 focus:outline-none"
          >
            {accounts.map((item) => (
              <option key={item.account.id || item.account.accountId} value={item.account.id}>
                {item.account.company.companyName || item.account.accountId}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {ledgerError ? (
        <div role="alert" className="border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          <p className="font-semibold">Unable to load payments</p>
          <p className="mt-2">{ledgerError}</p>
          <button
            type="button"
            onClick={() => selectedAccount && void loadLedger(selectedAccount.account.id)}
            disabled={refreshing}
            className="mt-4 rounded-xl border border-red-300 bg-white px-4 py-2 font-semibold hover:bg-red-100 disabled:opacity-50"
          >
            {refreshing ? "Retrying..." : "Retry loading payments"}
          </button>
        </div>
      ) : null}

      {selectedAccount ? (
        <ClientPaymentLedger key={selectedAccount.account.id} businessAccountId={selectedAccount.account.id} initialTransactions={ledgerTransactions} />
      ) : (
        <div className="border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
          Payments are not available for this login.
        </div>
      )}
    </div>
  );
}
