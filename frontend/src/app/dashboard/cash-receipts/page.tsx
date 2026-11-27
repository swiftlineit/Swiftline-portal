"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiChevronDown, FiDownload, FiPlus, FiRefreshCw } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { listBusinessAccounts, type BusinessAccount } from "@/lib/businessAccounts";
import {
  createStandaloneCashReceipt,
  downloadStandaloneCashReceipt,
  exportStandaloneCashReceipts,
  listStandaloneCashReceipts,
  type StandaloneCashReceipt
} from "@/lib/cashReceipts";
import { formatDashboardDate } from "@/lib/dateFormat";
import { OPERATIONS_AREA } from "@/lib/roles";
import PaymentPagination from "@/components/payments/PaymentPagination";
import { useAdminUser } from "@/lib/useAdminUser";

function todayInIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function accountBranchId(account: BusinessAccount) {
  if (typeof account.assignedBranch === "string") return account.assignedBranch;
  return account.assignedBranch?._id ?? "";
}

function accountLabel(account: BusinessAccount) {
  return account.company.companyName || account.accountId;
}

function accountAddress(account: BusinessAccount) {
  return [
    account.company.registeredAddress,
    account.company.addressLine2,
    account.company.city,
    account.company.stateOrProvince,
    account.company.postalCode,
    account.company.addressCountry
  ].filter((part): part is string => Boolean(part?.trim())).map((part) => part.trim()).join(", ");
}

export default function StandaloneCashReceiptsPage() {
  const { user, loading: userLoading } = useAdminUser(OPERATIONS_AREA);
  const [accounts, setAccounts] = useState<BusinessAccount[]>([]);
  const [receipts, setReceipts] = useState<StandaloneCashReceipt[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [customerNameOverride, setCustomerNameOverride] = useState<string | null>(null);
  const [gstinOverride, setGstinOverride] = useState<string | null>(null);
  const [addressOverride, setAddressOverride] = useState<string | null>(null);
  const [receiptDate, setReceiptDate] = useState(todayInIndia);
  const [amount, setAmount] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [customerReference, setCustomerReference] = useState("");
  const [service, setService] = useState<"" | "COURIER" | "CARGO">("");
  const [pieces, setPieces] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadingId, setDownloadingId] = useState("");
  const [requestKey, setRequestKey] = useState("");

  const selectedAccount = useMemo(
    () => accounts.find((account) => account._id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  );
  const customerName = customerNameOverride ?? (selectedAccount ? accountLabel(selectedAccount) : "");
  const gstin = gstinOverride ?? (selectedAccount?.company.gstin?.trim().toUpperCase() ?? "");
  const address = addressOverride ?? (selectedAccount ? accountAddress(selectedAccount) : "");

  const fetchReceipts = useCallback(
    () => listStandaloneCashReceipts({ from: from || undefined, to: to || undefined, page, limit: 5 }),
    [from, page, to]
  );

  const loadReceipts = useCallback(async (isActive: () => boolean = () => true) => {
    try {
      const response = await fetchReceipts();
      if (!isActive()) return;
      setReceipts(response.receipts);
      setTotalPages(response.pagination.totalPages);
    } catch (error) {
      if (isActive()) toast.error(error instanceof Error ? error.message : "Cash receipts could not be loaded.");
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [fetchReceipts]);

  useEffect(() => {
    let active = true;
    void listBusinessAccounts()
      .then((accountResponse) => {
        if (!active) return;
        const eligibleAccounts = accountResponse.accounts.filter((account) => account.status === "active" || account.status === "approved");
        setAccounts(eligibleAccounts);
        setSelectedAccountId((current) => current || eligibleAccounts[0]?._id || "");
      })
      .catch((error: unknown) => {
        if (!active) return;
        toast.error(error instanceof Error ? error.message : "Cash receipts could not be loaded.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetchReceipts()
      .then((response) => {
        if (!active) return;
        setReceipts(response.receipts);
        setTotalPages(response.pagination.totalPages);
      })
      .catch((error: unknown) => {
        if (!active) return;
        toast.error(error instanceof Error ? error.message : "Cash receipts could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [fetchReceipts]);

  async function handleCreateReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount) {
      toast.error("Select a business account assigned to your branch.");
      return;
    }
    const amountMinor = Math.round(Number(amount) * 100);
    const parsedWeight = weightKg.trim() ? Number(weightKg) : undefined;
    const parsedPieces = pieces.trim() ? Number(pieces) : undefined;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid cash amount.");
      return;
    }
    if (
      (parsedWeight !== undefined && (!Number.isFinite(parsedWeight) || parsedWeight < 0))
      || (parsedPieces !== undefined && (!Number.isSafeInteger(parsedPieces) || parsedPieces < 1))
    ) {
      toast.error("Enter valid shipment pieces or weight, or leave those optional fields blank.");
      return;
    }
    setSaving(true);
    const currentKey = requestKey || crypto.randomUUID();
    setRequestKey(currentKey);
    try {
      const result = await createStandaloneCashReceipt({
        idempotencyKey: currentKey,
        businessAccountId: selectedAccount._id,
        branchId: accountBranchId(selectedAccount),
        customerName,
        gstin: gstin.trim(),
        address: address.trim(),
        receiptDate,
        amountMinor,
        paymentReference,
        customerReference,
        ...(service ? { service } : {}),
        ...(parsedPieces !== undefined ? { pieces: parsedPieces } : {}),
        ...(parsedWeight !== undefined ? { weightKg: parsedWeight } : {})
      });
      toast.success(result.duplicate ? "The existing receipt was loaded." : "Cash receipt recorded and shared with Swiftline staff.");
      setRequestKey(crypto.randomUUID());
      setAmount("");
      setPaymentReference("");
      setCustomerReference("");
      setService("");
      setPieces("");
      setWeightKg("");
      setGstinOverride(null);
      setAddressOverride(null);
      setLoading(true);
      await loadReceipts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cash receipt could not be created.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload(receipt: StandaloneCashReceipt) {
    setDownloadingId(receipt.id);
    try {
      await downloadStandaloneCashReceipt(receipt);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Receipt could not be downloaded.");
    } finally {
      setDownloadingId("");
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      await exportStandaloneCashReceipts({ from: from || undefined, to: to || undefined });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Receipt export could not be downloaded.");
    } finally {
      setExporting(false);
    }
  }

  if (userLoading || !user) return <DashboardLoading />;
  const branchId = selectedAccount ? accountBranchId(selectedAccount) : "";

  return (
    <div className="mx-auto max-w-8xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Cash receipts</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">Record cash received outside a shipment booking. These standalone receipts are visible to Swiftline staff only.</p>
        </div>
        <button type="button" onClick={() => { setLoading(true); void loadReceipts(); }} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:opacity-60">
          <FiRefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      <section className="grid items-stretch gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <form onSubmit={handleCreateReceipt} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Create a standalone receipt</h2>
            <p className="mt-1 text-sm text-slate-600">The receipt is issued once and emailed to the operations team and admins. It does not create a shipment or change a wallet balance.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business account</span>
              <div className="relative mt-1.5">
                <select value={selectedAccountId} onChange={(event) => { setSelectedAccountId(event.target.value); setCustomerNameOverride(null); setGstinOverride(null); setAddressOverride(null); }} required className="h-11 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-950">
                  {accounts.map((account) => <option key={account._id} value={account._id}>{accountLabel(account)} ({account.accountId})</option>)}
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Received from</span>
              <input value={customerName} onChange={(event) => setCustomerNameOverride(event.target.value)} maxLength={200} required className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">GSTIN <span className="font-normal normal-case">(optional)</span></span>
              <input value={gstin} onChange={(event) => setGstinOverride(event.target.value.toUpperCase())} maxLength={15} placeholder="e.g. 07ABPCS3159R1ZC" className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label className="sm:col-span-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing address</span>
              <textarea value={address} onChange={(event) => setAddressOverride(event.target.value)} maxLength={500} rows={2} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Receipt date</span>
              <input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} required className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amount received (INR)</span>
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payment reference</span>
              <input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} maxLength={160} required className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Courier / Cargo <span className="font-normal normal-case">(optional)</span></span>
              <div className="relative mt-1.5">
                <select value={service} onChange={(event) => setService(event.target.value as "" | "COURIER" | "CARGO")} className="h-11 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-950">
                  <option value="">Not specified</option><option value="COURIER">Courier</option><option value="CARGO">Cargo</option>
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Customer reference</span>
              <input value={customerReference} onChange={(event) => setCustomerReference(event.target.value)} maxLength={160} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pieces <span className="font-normal normal-case">(optional)</span></span>
              <input type="number" min="1" step="1" value={pieces} onChange={(event) => setPieces(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
            <label>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total weight (kg) <span className="font-normal normal-case">(optional)</span></span>
              <input type="number" min="0" step="0.01" value={weightKg} onChange={(event) => setWeightKg(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950" />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-xs text-slate-500">Recorded by {user.name || "signed-in staff"}{selectedAccount?.assignedBranch && typeof selectedAccount.assignedBranch !== "string" ? ` · ${selectedAccount.assignedBranch.name}` : ""}</p>
            <button type="submit" disabled={saving || !accounts.length || !branchId} className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400">
              <FiPlus aria-hidden="true" className="h-4 w-4" /> {saving ? "Recording receipt…" : "Generate cash receipt"}
            </button>
          </div>
        </form>

        <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="space-y-4 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-slate-950">Standalone receipt history</h2>
              <p className="mt-1 text-sm text-slate-600">Staff-only records. Download a receipt to view its full details.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="relative inline-flex h-11 min-w-44 items-center rounded-lg border border-slate-300 bg-white px-3 pt-1 focus-within:border-blue-900 focus-within:ring-2 focus-within:ring-blue-900/10">
                <span className="absolute -top-2 left-2 bg-white px-1 text-[11px] font-semibold lowercase tracking-wide text-slate-500">from</span>
                <input aria-label="From date" type="date" value={from} onChange={(event) => { setLoading(true); setPage(1); setFrom(event.target.value); }} className="min-w-0 w-full bg-transparent text-sm text-slate-900 outline-none" />
              </label>
              <label className="relative inline-flex h-11 min-w-44 items-center rounded-lg border border-slate-300 bg-white px-3 pt-1 focus-within:border-blue-900 focus-within:ring-2 focus-within:ring-blue-900/10">
                <span className="absolute -top-2 left-2 bg-white px-1 text-[11px] font-semibold lowercase tracking-wide text-slate-500">to</span>
                <input aria-label="To date" type="date" value={to} onChange={(event) => { setLoading(true); setPage(1); setTo(event.target.value); }} className="min-w-0 w-full bg-transparent text-sm text-slate-900 outline-none" />
              </label>
              <button type="button" onClick={() => void handleExport()} disabled={exporting} className="ml-auto inline-flex h-11 items-center gap-2 rounded-lg border border-slate-300 px-3.5 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:opacity-60">
                <FiDownload aria-hidden="true" className="h-4 w-4" /> {exporting ? "Preparing…" : "Export CSV"}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Receipt</th><th className="px-5 py-3">Received from</th><th className="px-5 py-3 text-right">Download</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className="whitespace-nowrap px-5 py-3"><p className="font-semibold text-slate-900">{receipt.receiptNumber}</p><p className="mt-1 text-xs text-slate-500">{formatDashboardDate(receipt.receiptDate)}</p></td>
                    <td className="px-5 py-3 font-medium text-slate-900">{receipt.customerName}</td>
                    <td className="px-5 py-3 text-right"><button type="button" onClick={() => void handleDownload(receipt)} disabled={downloadingId === receipt.id} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:opacity-60"><FiDownload aria-hidden="true" className="h-3.5 w-3.5" />{downloadingId === receipt.id ? "Loading" : "Download"}</button></td>
                  </tr>
                ))}
                {!loading && !receipts.length ? <tr><td colSpan={3} className="px-5 py-10 text-center text-sm text-slate-500">No standalone cash receipts in this date range.</td></tr> : null}
                {loading ? <tr><td colSpan={3} className="px-5 py-10 text-center text-sm text-slate-500">Loading receipts…</td></tr> : null}
              </tbody>
            </table>
          </div>
          <PaymentPagination label="Standalone receipt pages" page={page} totalPages={totalPages} busy={loading} onPageChange={(nextPage) => { setLoading(true); setPage(nextPage); }} />
        </section>
      </section>
    </div>
  );
}
