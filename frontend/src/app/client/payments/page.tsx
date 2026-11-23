"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiCreditCard, FiRefreshCw } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  ClientDashboardLoading,
  ClientShellUser
} from "@/components/client/ClientDashboardShell";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, refreshAccessToken } from "@/lib/auth";
import {
  ClientDashboardAccount,
  ClientPrepaidAccount,
  ClientPrepaidTransaction,
  ClientPrepaidTopUp,
  createClientPrepaidTopUp,
  getClientDashboard,
  getClientPrepaidAccount,
  getClientPrepaidTransactions,
  getClientPrepaidTopUps,
  verifyClientPrepaidTopUp
} from "@/lib/clientDashboard";
import WalletBalanceSummary from "@/components/payments/WalletBalanceSummary";
import ClientPaymentLedger from "@/components/payments/ClientPaymentLedger";
import PaymentReceiptHistory from "@/components/payments/PaymentReceiptHistory";
import PaymentInvoicePreview, { type PaymentInvoiceDetails, createIdempotencyKey, formatMinorMoney } from "@/components/payments/PaymentReceiptPreview";
import { acceptPaymentTerms, getPaymentTerms, PaymentTerms } from "@/lib/creditAccounts";

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

function loadRazorpayCheckout() {
  return new Promise<boolean>((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>("script[data-razorpay-checkout]");
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(true), { once: true });
      existingScript.addEventListener("error", () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.dataset.razorpayCheckout = "true";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default function ClientPaymentsPage() {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [selectedBusinessAccountId, setSelectedBusinessAccountId] = useState("");
  // Carries the per-transaction bounds and today's remaining top-up allowance.
  const [prepaidAccount, setPrepaidAccount] = useState<ClientPrepaidAccount | null>(null);
  const [topUps, setTopUps] = useState<ClientPrepaidTopUp[]>([]);
  const [ledgerTransactions, setLedgerTransactions] = useState<ClientPrepaidTransaction[]>([]);
  const [amountRupees, setAmountRupees] = useState("1000");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState("");
  const balanceRequest = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [previewInvoice, setPreviewInvoice] = useState<PaymentInvoiceDetails | null>(null);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((item) => item.account.id === selectedBusinessAccountId) ?? accounts[0] ?? null,
    [accounts, selectedBusinessAccountId]
  );

  // Both are absent on a backend that predates the top-up limits, so everything
  // reading them must tolerate undefined rather than assume the newer shape.
  const dailyTopUp = prepaidAccount?.dailyTopUp;
  const topUpBounds = typeof prepaidAccount?.minTopUpMinor === "number"
    && typeof prepaidAccount?.maxTopUpMinor === "number"
    ? { min: prepaidAccount.minTopUpMinor, max: prepaidAccount.maxTopUpMinor }
    : null;
  const maxTopUpRupees = topUpBounds ? topUpBounds.max / 100 : null;

  /** Refuses a keystroke that would take the amount past the per-payment ceiling. */
  function handleAmountChange(value: string) {
    if (maxTopUpRupees === null || value === "") {
      setAmountRupees(value);
      return;
    }
    const rupees = Number(value);
    if (!Number.isFinite(rupees) || rupees > maxTopUpRupees) return;
    setAmountRupees(value);
  }

  const loadBalances = useCallback(async (
    businessAccountId: string,
    quiet = false,
  ) => {
    const requestId = ++balanceRequest.current;
    if (!quiet) setRefreshing(true);
    setBalanceError("");
    setPrepaidAccount(null);
    setTopUps([]);
    setLedgerTransactions([]);
    try {
      const [topUpsResponse, ledgerResponse, prepaidResponse] = await Promise.all([
        getClientPrepaidTopUps(businessAccountId),
        getClientPrepaidTransactions(businessAccountId),
        getClientPrepaidAccount(businessAccountId)
      ]);

      if (requestId !== balanceRequest.current) return;
      setTopUps(topUpsResponse.topUps);
      setLedgerTransactions(ledgerResponse.transactions);
      setPrepaidAccount(prepaidResponse.prepaidAccount);
    } catch (caughtError) {
      if (requestId !== balanceRequest.current) return;
      setBalanceError(caughtError instanceof Error ? caughtError.message : "Unable to load account balances.");
    } finally {
      if (requestId === balanceRequest.current && !quiet) setRefreshing(false);
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

        const [dashboard, termsResponse] = await Promise.all([getClientDashboard(), getPaymentTerms()]);
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
        setPaymentTerms(termsResponse.terms);
        if (firstAccountId) {
          await loadBalances(firstAccountId, true);
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
  }, [router, loadBalances]);

  async function handleAccountChange(nextBusinessAccountId: string) {
    setSelectedBusinessAccountId(nextBusinessAccountId);
    setTermsAccepted(false);
    setNotice("");
    await loadBalances(nextBusinessAccountId, false);
  }

  async function handleTopUp() {
    if (!selectedAccount) return;

    const rupees = Number(amountRupees);
    const amountMinor = Math.round(rupees * 100);

    if (!Number.isFinite(rupees) || amountMinor <= 0) {
      toast.error("Enter a valid wallet top-up amount.");
      return;
    }
    if (topUpBounds && (amountMinor < topUpBounds.min || amountMinor > topUpBounds.max)) {
      toast.error(`Enter an amount between ${formatMinorMoney(topUpBounds.min)} and ${formatMinorMoney(topUpBounds.max)}.`);
      return;
    }
    if (dailyTopUp && amountMinor > dailyTopUp.remainingMinor) {
      toast.error(
        dailyTopUp.remainingMinor > 0
          ? `This exceeds today's ${formatMinorMoney(dailyTopUp.limitMinor)} limit. ${formatMinorMoney(dailyTopUp.remainingMinor)} is still available.`
          : `Today's ${formatMinorMoney(dailyTopUp.limitMinor)} top-up limit has been reached. Please try again after midnight.`
      );
      return;
    }
    if (!termsAccepted || !paymentTerms) {
      toast.error("Read and accept the current payment terms before continuing.");
      return;
    }

    setSubmitting(true);
    setNotice("");

    try {
      await acceptPaymentTerms({
        businessAccountId: selectedAccount.account.id,
        termsVersion: paymentTerms.version
      });
      const created = await createClientPrepaidTopUp({
        businessAccountId: selectedAccount.account.id,
        amountMinor,
        purpose: "CUSTOMER_ADVANCE",
        idempotencyKey: createIdempotencyKey()
      });

      if (!created.razorpay.keyId) {
        setNotice("Top-up request created, but Razorpay key is not configured yet.");
        await loadBalances(selectedAccount.account.id, true);
        return;
      }

      const scriptLoaded = await loadRazorpayCheckout();
      if (!scriptLoaded || !window.Razorpay) {
        setNotice("Top-up request created. Razorpay checkout could not be loaded in this browser.");
        await loadBalances(selectedAccount.account.id, true);
        return;
      }

      const checkout = new window.Razorpay({
        key: created.razorpay.keyId,
        amount: created.topUp.amountMinor,
        currency: created.topUp.currency,
        name: created.razorpay.merchantName,
        description: created.topUp.internalReference,
        order_id: created.topUp.razorpayOrderId,
        prefill: {
          name: user?.name,
          email: user?.email,
          contact: selectedAccount.account.contact.mobileNumber
        },
        theme: { color: "#1e3a8a" },
        modal: {
          ondismiss: () => {
            setNotice("Checkout closed. Your balance updates only after payment confirmation.");
            void loadBalances(selectedAccount.account.id, true);
          }
        },
        handler: (checkoutResponse) => {
          void (async () => {
            try {
              const verified = await verifyClientPrepaidTopUp({
                topUpId: created.topUp.id,
                ...checkoutResponse
              });
              setNotice(verified.message);
              await loadBalances(selectedAccount.account.id, true);
            } catch (caughtError) {
              toast.error(caughtError instanceof Error ? caughtError.message : "Unable to verify payment.");
            }
          })();
        }
      });

      checkout.open();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Unable to start top-up.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user) return <ClientDashboardLoading />;
  const paymentTitle = "Add wallet funds";
  const paymentButtonLabel = "Top up with Razorpay";

  return (
    <>
      <div className="mx-auto max-w-8xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">Payments</h1>
            <p className="mt-1 text-sm text-slate-500">Fund your business wallet before booking. New shipments require payment in full.</p>
          </div>
          <button
            type="button"
            onClick={() => selectedAccount && loadBalances(selectedAccount.account.id, false)}
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

        {notice ? <StatusBanner tone="info" message={notice} /> : null}

        {selectedAccount && prepaidAccount ? (
          <>
            <WalletBalanceSummary wallet={prepaidAccount} />

            <section className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div id="add-money" className="border border-slate-200 bg-white p-5 rounded-2xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center bg-blue-900 rounded-3xl text-white">
                    <FiCreditCard aria-hidden="true" className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">{paymentTitle}</h2>
                    <p className="text-sm text-slate-500">{selectedAccount.account.company.companyName || selectedAccount.account.accountId}</p>
                  </div>
                </div>

                <p className="mt-4 text-sm text-slate-600">
                  Add funds securely through Razorpay.
                </p>

                <div className="mt-5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="amountRupees">
                    Amount
                  </label>
                  <div className="mt-2 flex h-12 border border-slate-300 bg-white rounded focus-within:border-blue-900">
                    <span className="flex w-12 items-center justify-center border-r border-slate-200 text-sm font-semibold text-slate-500">
                      Rs.
                    </span>
                    <input
                      id="amountRupees"
                      type="number"
                      min="1"
                      step="1"
                      max={maxTopUpRupees ?? undefined}
                      value={amountRupees}
                      onChange={(event) => handleAmountChange(event.target.value)}
                      className="min-w-0 flex-1  px-3 text-sm font-semibold text-slate-950 outline-none"
                    />
                  </div>
                </div>

                <label className="mt-4 flex items-start gap-3 border rounded border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-blue-900"
                  />
                  <span>
                    I have read and accept the current{" "}
                    <Link href="/client/payment-terms" target="_blank" className="font-semibold text-blue-900 underline underline-offset-2">
                      payment terms
                    </Link>.
                  </span>
                </label>

                <button
                  type="button"
                  onClick={handleTopUp}
                  disabled={submitting || !termsAccepted || !paymentTerms}
                  className="mt-5 inline-flex rounded-4xl h-11 w-full items-center justify-center bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {submitting ? "Starting Payment..." : paymentButtonLabel}
                </button>
              </div>

              <PaymentReceiptHistory key={selectedAccount.account.id} account={selectedAccount.account} user={user} initialTopUps={topUps} onView={setPreviewInvoice} />
            </section>

            <ClientPaymentLedger key={selectedAccount.account.id} businessAccountId={selectedAccount.account.id} initialTransactions={ledgerTransactions} />

          </>
        ) : balanceError ? (
          <div role="alert" className="border border-red-200 bg-red-50 p-6 text-sm text-red-700">
            <p className="font-semibold">Unable to load wallet balances</p>
            <p className="mt-2">{balanceError}</p>
            <button
              type="button"
              onClick={() => selectedAccount && void loadBalances(selectedAccount.account.id)}
              disabled={refreshing}
              className="mt-4 rounded-xl border border-red-300 bg-white px-4 py-2 font-semibold hover:bg-red-100 disabled:opacity-50"
            >
              {refreshing ? "Retrying..." : "Retry loading balances"}
            </button>
          </div>
        ) : selectedAccount ? (
          <div role="status" className="border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
            Loading wallet balances...
          </div>
        ) : (
          <div className="border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
            Account balances are not available for this login.
          </div>
        )}
      </div>
      {previewInvoice ? (
        <PaymentInvoicePreview invoice={previewInvoice} onClose={() => setPreviewInvoice(null)} />
      ) : null}
    </>
  );
}

function StatusBanner({ tone, message }: { tone: "error" | "info"; message: string }) {
  const classes = tone === "error"
    ? "border-red-200 bg-red-50 text-red-700"
    : "border-blue-200 bg-blue-50 text-blue-900";

  return <div className={`border px-4 py-3 text-sm font-semibold ${classes}`}>{message}</div>;
}
