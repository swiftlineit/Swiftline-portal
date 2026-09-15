"use client";

import { ReactNode, useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiCreditCard, FiDownload, FiEye, FiPrinter, FiRefreshCw, FiX } from "react-icons/fi";
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
  ClientPrepaidTopUp,
  createClientPrepaidTopUp,
  getClientDashboard,
  getClientPrepaidAccount,
  getClientPrepaidTopUps,
  verifyClientPrepaidTopUp
} from "@/lib/clientDashboard";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/dateFormat";
import { acceptPaymentTerms, getClientCreditAccount, getPaymentTerms, CreditAccount, PaymentTerms } from "@/lib/creditAccounts";

type PaymentInvoiceDetails = {
  invoiceNumber: string;
  issuedAt: string;
  companyName: string;
  accountId: string;
  billingAddress: string;
  contactName: string;
  contactEmail: string;
  paymentReference: string;
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  purpose: "CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT";
  status: string;
};

function formatMinorMoney(amountMinor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(amountMinor / 100);
}

function formatDateTime(value?: string) {
  return formatDashboardDateTime(value);
}

function createIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatInvoiceDate(value?: string) {
  return formatDashboardDate(value);
}

function buildBillingAddress(account: ClientDashboardAccount["account"]) {
  return [
    account.company.registeredAddress,
    account.company.city,
    account.company.stateOrProvince,
    account.company.postalCode,
    account.company.addressCountry
  ].filter(Boolean).join(", ") || "Not available";
}

function buildPaymentInvoice(
  topUp: ClientPrepaidTopUp,
  account: ClientDashboardAccount["account"],
  user: ClientShellUser
): PaymentInvoiceDetails {
  const contactName = [account.contact.firstName, account.contact.lastName].filter(Boolean).join(" ") || user.name || "Client";

  return {
    invoiceNumber: `INV-${topUp.internalReference}`,
    issuedAt: topUp.updatedAt || topUp.createdAt || new Date().toISOString(),
    companyName: account.company.companyName || account.accountId,
    accountId: account.accountId,
    billingAddress: buildBillingAddress(account),
    contactName,
    contactEmail: account.contact.email || user.email || "Not available",
    paymentReference: topUp.internalReference,
    orderId: topUp.razorpayOrderId,
    paymentId: topUp.razorpayPaymentId || "Not available",
    amountMinor: topUp.amountMinor,
    currency: topUp.currency,
    purpose: topUp.purpose,
    status: topUp.status
  };
}

function renderPaymentInvoiceHtml(invoice: PaymentInvoiceDetails, logoUrl: string) {
  const safe = (value: string) => escapeHtml(value);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe(invoice.invoiceNumber)}</title>
  <style>
    @font-face {
      font-family: "IBM Plex Sans";
      src: url("/fonts/ibm-plex-sans/IBMPlexSans[wdth,wght].ttf") format("truetype");
      font-weight: 100 700;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "IBM Plex Sans";
      src: url("/fonts/ibm-plex-sans/IBMPlexSans-Italic[wdth,wght].ttf") format("truetype");
      font-weight: 100 700;
      font-style: italic;
      font-display: swap;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: "IBM Plex Sans", Arial, Helvetica, sans-serif; }
    .page { width: min(860px, 100%); margin: 0 auto; background: #fff; padding: 40px; }
    .top { display: flex; min-height: 126px; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0f172a; padding-bottom: 16px; }
    .brand { display: flex; width: 180px; height: 120px; align-items: flex-start; justify-content: flex-start; }
    .brand img { display: block; width: 180px; height: 120px; object-fit: contain; object-position: left top; }
    .meta { display: flex; max-width: 300px; padding-top: 14px; flex-direction: column; align-items: flex-end; text-align: right; font-size: 11px; line-height: 1.75; }
    .invoice-title { margin: 0 0 12px; font-size: 24px; line-height: 1.1; }
    .meta strong { display: block; max-width: 240px; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 28px; }
    .box { border: 1px solid #e2e8f0; padding: 18px; min-height: 132px; }
    .label { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 14px; line-height: 1.6; }
    table { width: 100%; margin-top: 28px; border-collapse: collapse; }
    th { background: #0f172a; color: #fff; padding: 13px; text-align: left; font-size: 12px; text-transform: uppercase; }
    td { border: 1px solid #e2e8f0; padding: 14px 13px; font-size: 14px; vertical-align: top; }
    .right { text-align: right; }
    .total { margin-left: auto; margin-top: 20px; width: min(340px, 100%); border: 1px solid #0f172a; }
    .total-row { display: flex; justify-content: space-between; gap: 16px; padding: 14px 16px; font-size: 14px; }
    .total-row.final { background: #0f172a; color: #fff; font-size: 18px; font-weight: 700; }
    .note { margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 12px; line-height: 1.7; color: #64748b; }
    @media print { body { background: #fff; } .page { width: 100%; padding: 24px; } }
    @media (max-width: 680px) { .page { padding: 24px; } .top { display: block; } .grid { display: block; } .brand { max-width: 100%; } .brand img { max-width: 100%; } .meta { align-items: flex-start; margin-top: 14px; padding-top: 0; text-align: left; } .box + .box { margin-top: 16px; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="top">
      <div>
        <div class="brand">
          <img src="${safe(logoUrl)}" alt="Swiftline" />
        </div>
      </div>
      <div class="meta">
        <h1 class="invoice-title">PAYMENT RECEIPT</h1>
        <strong>${safe(invoice.invoiceNumber)}</strong><br />
        Issued: ${safe(formatInvoiceDate(invoice.issuedAt))}<br />
        Account: ${safe(invoice.accountId)}
      </div>
    </section>

    <section class="grid">
      <div class="box">
        <div class="label">Billed To</div>
        <div class="value">
          <strong>${safe(invoice.companyName)}</strong><br />
          ${safe(invoice.contactName)}<br />
          ${safe(invoice.contactEmail)}<br />
          ${safe(invoice.billingAddress)}
        </div>
      </div>
      <div class="box">
        <div class="label">Payment Details</div>
        <div class="value">
          Reference: ${safe(invoice.paymentReference)}<br />
          Razorpay Order: ${safe(invoice.orderId)}<br />
          Razorpay Payment: ${safe(invoice.paymentId)}
        </div>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${invoice.purpose === "SECURITY_DEPOSIT" ? "Security deposit received against the approved credit facility." : "Customer Advance credited after successful payment capture."}</td>
          <td class="right">${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</td>
        </tr>
      </tbody>
    </table>

    <section class="total">
      <div class="total-row"><span>Subtotal</span><strong>${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</strong></div>
      <div class="total-row final"><span>Total Paid</span><span>${safe(formatMinorMoney(invoice.amountMinor, invoice.currency))}</span></div>
    </section>

    <p class="note">${invoice.purpose === "SECURITY_DEPOSIT" ? "This receipt is generated from the recorded security deposit payment in Swiftline Portal." : "This receipt is generated from the successful Customer Advance payment in Swiftline Portal."}</p>
  </main>
</body>
</html>`;
}

function printPaymentInvoice(invoice: PaymentInvoiceDetails) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return;

  printWindow.document.write(renderPaymentInvoiceHtml(invoice, `${window.location.origin}/swiftline-invoice-logo.png`));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 500);
}

function downloadPaymentInvoice(invoice: PaymentInvoiceDetails) {
  const blob = new Blob([renderPaymentInvoiceHtml(invoice, `${window.location.origin}/swiftline-invoice-logo.png`)], {
    type: "text/html;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${invoice.invoiceNumber}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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
  const [creditAccount, setCreditAccount] = useState<CreditAccount | null>(null);
  const [requiredDepositMinor, setRequiredDepositMinor] = useState(0);
  // Carries the per-transaction bounds and today's remaining top-up allowance.
  const [prepaidAccount, setPrepaidAccount] = useState<ClientPrepaidAccount | null>(null);
  const [topUps, setTopUps] = useState<ClientPrepaidTopUp[]>([]);
  const [amountRupees, setAmountRupees] = useState("1000");
  const [paymentPurpose, setPaymentPurpose] = useState<"CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT">("CUSTOMER_ADVANCE");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
    // Deposits are exempt from the ceiling, and are set programmatically anyway.
    if (paymentPurpose === "SECURITY_DEPOSIT" || maxTopUpRupees === null || value === "") {
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
    purpose: "CUSTOMER_ADVANCE" | "SECURITY_DEPOSIT" = "CUSTOMER_ADVANCE"
  ) => {
    if (!quiet) setRefreshing(true);
    try {
      const [topUpsResponse, creditResponse, prepaidResponse] = await Promise.all([
        getClientPrepaidTopUps(businessAccountId),
        getClientCreditAccount(businessAccountId),
        getClientPrepaidAccount(businessAccountId)
      ]);

      setTopUps(topUpsResponse.topUps);
      setCreditAccount(creditResponse.creditAccount);
      setPrepaidAccount(prepaidResponse.prepaidAccount);
      setRequiredDepositMinor(creditResponse.creditAccount.securityDepositRequiredMinor || 0);
      if (purpose === "SECURITY_DEPOSIT" && creditResponse.creditAccount.securityDepositRequiredMinor) {
        setAmountRupees(String(creditResponse.creditAccount.securityDepositRequiredMinor / 100));
      }
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Unable to load account balances.");
    } finally {
      if (!quiet) setRefreshing(false);
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
        const initialPurpose = params.get("purpose") === "SECURITY_DEPOSIT" ? "SECURITY_DEPOSIT" : "CUSTOMER_ADVANCE";
        setPaymentPurpose(initialPurpose);

        if (firstAccountId) {
          await loadBalances(firstAccountId, true, initialPurpose);
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
    await loadBalances(nextBusinessAccountId, false, paymentPurpose);
  }

  async function handleTopUp() {
    if (!selectedAccount) return;

    const rupees = Number(amountRupees);
    const amountMinor = Math.round(rupees * 100);

    if (!Number.isFinite(rupees) || amountMinor <= 0) {
      toast.error(paymentPurpose === "SECURITY_DEPOSIT" ? "Enter the required deposit amount." : "Enter a valid top-up amount.");
      return;
    }
    if (paymentPurpose === "SECURITY_DEPOSIT" && requiredDepositMinor > 0 && amountMinor !== requiredDepositMinor) {
      toast.error("Enter the exact required deposit amount.");
      return;
    }
    // Security deposits are exempt from both bounds, matching the server. Each
    // check is skipped when the backend did not send its limit; the server still
    // rejects the payment, so this only affects how early the customer is told.
    if (paymentPurpose !== "SECURITY_DEPOSIT") {
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
        purpose: paymentPurpose,
        idempotencyKey: createIdempotencyKey()
      });

      if (!created.razorpay.keyId) {
        setNotice("Top-up request created, but Razorpay key is not configured yet.");
        await loadBalances(selectedAccount.account.id, true, paymentPurpose);
        return;
      }

      const scriptLoaded = await loadRazorpayCheckout();
      if (!scriptLoaded || !window.Razorpay) {
        setNotice("Top-up request created. Razorpay checkout could not be loaded in this browser.");
        await loadBalances(selectedAccount.account.id, true, paymentPurpose);
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
            void loadBalances(selectedAccount.account.id, true, paymentPurpose);
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
              await loadBalances(selectedAccount.account.id, true, paymentPurpose);
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
  const paymentTitle = paymentPurpose === "SECURITY_DEPOSIT" ? "Security Deposit" : "Add Balance";
  const paymentButtonLabel = paymentPurpose === "SECURITY_DEPOSIT" ? "Pay Security Deposit" : "Top Up With Razorpay";

  return (
    <>
      <div className="mx-auto max-w-8xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">Payments</h1>
            <p className="mt-1 text-sm text-slate-500">Manage Customer Advance and required security deposits for the selected business account.</p>
          </div>
          <button
            type="button"
            onClick={() => selectedAccount && loadBalances(selectedAccount.account.id, false, paymentPurpose)}
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

        {selectedAccount && creditAccount ? (
          <>
            <section className="grid gap-4 md:grid-cols-3">
              <BalanceTile label="Booking Capacity" value={creditAccount.availableBookingCapacityMinor || 0} currency={creditAccount.currency} emphasis />
              <BalanceTile label="Customer Advance" value={creditAccount.availableAdvanceMinor || 0} currency={creditAccount.currency} />
              <BalanceTile label="Available Credit" value={creditAccount.availableCreditMinor || 0} currency={creditAccount.currency} />
            </section>

            <section className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="border border-slate-200 bg-white p-5 rounded-2xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center bg-blue-900 rounded-3xl text-white">
                    <FiCreditCard aria-hidden="true" className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">{paymentTitle}</h2>
                    <p className="text-sm text-slate-500">{selectedAccount.account.company.companyName || selectedAccount.account.accountId}</p>
                  </div>
                </div>

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
                      max={paymentPurpose === "SECURITY_DEPOSIT" ? undefined : maxTopUpRupees ?? undefined}
                      value={amountRupees}
                      onChange={(event) => handleAmountChange(event.target.value)}
                      readOnly={paymentPurpose === "SECURITY_DEPOSIT"}
                      className="min-w-0 flex-1  px-3 text-sm font-semibold text-slate-950 outline-none"
                    />
                  </div>
                  <p className="mt-2 text-xs font-medium text-slate-500">
                    {paymentPurpose === "SECURITY_DEPOSIT"
                      ? `Required deposit: ${formatMinorMoney(requiredDepositMinor, "INR")}. This does not increase booking capacity.`
                      : `Add to Customer Advance: ${formatMinorMoney(Math.max(Math.round((Number(amountRupees) || 0) * 100), 0), "INR")}.`}
                  </p>
                  {/* Deposits are exempt from both limits, so this only shows for
                      top-ups, and each half appears only if the server sent it. */}
                  {/* {paymentPurpose !== "SECURITY_DEPOSIT" && (topUpBounds || dailyTopUp) ? (
                    <p className="mt-1 text-xs font-medium text-slate-500">
                      {topUpBounds ? (
                        <>
                          Per payment {formatMinorMoney(topUpBounds.min, "INR")} to{" "}
                          {formatMinorMoney(topUpBounds.max, "INR")}.{" "}
                        </>
                      ) : null}
                      {dailyTopUp ? (
                        <span className={dailyTopUp.remainingMinor > 0 ? "text-slate-700" : "font-semibold text-red-600"}>
                          Today {formatMinorMoney(dailyTopUp.usedMinor, "INR")} of{" "}
                          {formatMinorMoney(dailyTopUp.limitMinor, "INR")} used
                          {dailyTopUp.remainingMinor > 0
                            ? ` (${formatMinorMoney(dailyTopUp.remainingMinor, "INR")} left)`
                            : " (limit reached)"}.
                        </span>
                      ) : null}
                    </p>
                  ) : null} */}
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
                    <Link href="/client/credit/payment-terms" target="_blank" className="font-semibold text-blue-900 underline underline-offset-2">
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

              <div id="payment-history" className="border border-slate-200 bg-white p-5 rounded-2xl">
                <h2 className="text-base font-semibold text-slate-950 ">Recent Payments</h2>
                <hr className="my-4 text-slate-300" />
                <div className="mt-4 divide-y divide-slate-200">
                  {topUps.length ? topUps.slice(0, 6).map((topUp) => {
                    const invoice = buildPaymentInvoice(topUp, selectedAccount.account, user);

                    return (
                      <TopUpRow
                        key={topUp.id}
                        topUp={topUp}
                        invoice={invoice}
                        onView={() => setPreviewInvoice(invoice)}
                      />
                    );
                  }) : (
                    <p className="py-6 text-sm font-medium text-slate-500">No payments have been created yet.</p>
                  )}
                </div>
              </div>
            </section>

          </>
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

function BalanceTile({
  label,
  value,
  currency,
  emphasis = false
}: {
  label: string;
  value: number;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`border p-5 rounded-xl ${emphasis ? "border-blue-900 bg-blue-900 text-white" : "border-slate-200 bg-white text-slate-950"}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${emphasis ? "text-blue-100" : "text-slate-500"}`}>{label}</p>
      <p className="mt-3 text-2xl font-semibold">{formatMinorMoney(value, currency)}</p>
    </div>
  );
}

function TopUpRow({
  topUp,
  invoice,
  onView
}: {
  topUp: ClientPrepaidTopUp;
  invoice: PaymentInvoiceDetails;
  onView: () => void;
}) {
  const canGenerateInvoice = topUp.status === "CAPTURED";

  return (
    <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-950">{topUp.internalReference}</p>
        <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {topUp.purpose === "SECURITY_DEPOSIT" ? "Security Deposit" : "Customer Advance"}
        </p>
        <p className="mt-1 text-xs font-medium text-slate-500">{formatDateTime(topUp.createdAt)}</p>
        {canGenerateInvoice ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <InvoiceActionButton label="View" icon={<FiEye aria-hidden="true" className="h-3.5 w-3.5" />} onClick={onView} />
            <InvoiceActionButton label="Print" icon={<FiPrinter aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => printPaymentInvoice(invoice)} />
            <InvoiceActionButton label="Download" icon={<FiDownload aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => downloadPaymentInvoice(invoice)} />
          </div>
        ) : null}
      </div>
      <div className="md:text-right">
        <p className="text-sm font-semibold text-slate-950">{formatMinorMoney(topUp.amountMinor, topUp.currency)}</p>
        <p className={`mt-1 text-xs font-semibold uppercase ${canGenerateInvoice ? "text-emerald-700" : "text-slate-500"}`}>
          {topUp.status.replace(/_/g, " ")}
        </p>
      </div>
    </div>
  );
}

function InvoiceActionButton({
  label,
  icon,
  onClick
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center justify-center rounded-4xl gap-1.5 border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900"
    >
      {icon}
      {label}
    </button>
  );
}

function PaymentInvoicePreview({ invoice, onClose }: { invoice: PaymentInvoiceDetails; onClose: () => void }) {
  const html = renderPaymentInvoiceHtml(invoice, "/swiftline-invoice-logo.png");

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 px-4 py-6">
      <div className="mx-auto flex h-full max-w-5xl flex-col bg-white shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">{invoice.invoiceNumber}</p>
            <p className="text-xs font-medium text-slate-500">{invoice.companyName}</p>
          </div>
          <div className="flex items-center gap-2">
            <InvoiceActionButton label="Print" icon={<FiPrinter aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => printPaymentInvoice(invoice)} />
            <InvoiceActionButton label="Download" icon={<FiDownload aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => downloadPaymentInvoice(invoice)} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close invoice preview"
              className="flex h-8 w-8 items-center justify-center border border-slate-300 text-slate-600 hover:border-slate-900 hover:text-slate-950"
            >
              <FiX aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
        <iframe title="Payment invoice preview" srcDoc={html} className="min-h-0 flex-1 border-0 bg-white" />
      </div>
    </div>
  );
}
