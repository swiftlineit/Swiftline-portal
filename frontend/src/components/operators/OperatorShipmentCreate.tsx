"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiLoader, FiSearch } from "react-icons/fi";
import OperatorSelect from "@/components/operators/OperatorSelect";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";
import OperatorShipmentDraftForm from "@/components/operators/OperatorShipmentDraftForm";
import {
  getOperatorSession,
  listOperatorBranches,
  listOperatorBusinessAccounts,
  type OperatorBranch,
  type OperatorBusinessAccount,
  type OperatorSession
} from "@/lib/operatorDirectory";
import { createOperatorManualShipmentDraft } from "@/lib/operatorShipments";

function isBookableAccount(account: OperatorBusinessAccount) {
  return ["active", "approved"].includes(account.status.toLowerCase()) && Boolean(account.assignedBranch?._id);
}

function isActiveBranch(branch: OperatorBranch | undefined): branch is OperatorBranch {
  return Boolean(branch && branch.status.toUpperCase() === "ACTIVE");
}

function businessAccountDisplayName(account: OperatorBusinessAccount) {
  const companyName = account.company?.companyName?.trim();
  if (companyName) return companyName;
  const contactName = [account.contact?.firstName, account.contact?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return contactName || "Unnamed business account";
}

export default function OperatorShipmentCreate({
  operatorSlug,
  initialDraftId = ""
}: {
  operatorSlug: string;
  initialDraftId?: string;
}) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [branches, setBranches] = useState<OperatorBranch[]>([]);
  const [accounts, setAccounts] = useState<OperatorBusinessAccount[]>([]);
  const [accountCache, setAccountCache] = useState<Record<string, OperatorBusinessAccount>>({});
  const [accountTotal, setAccountTotal] = useState(0);
  const [accountSearchInput, setAccountSearchInput] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [draftId, setDraftId] = useState(initialDraftId);
  const [selectionStepVisible] = useState(!initialDraftId);
  const [loading, setLoading] = useState(true);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createRetry, setCreateRetry] = useState(0);
  const autoCreateKey = useRef("");

  useEffect(() => {
    const timer = window.setTimeout(() => setAccountSearch(accountSearchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [accountSearchInput]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.all([
      getOperatorSession(operatorSlug, controller.signal),
      listOperatorBranches(operatorSlug, { page: 1, pageSize: 100 }, controller.signal)
    ]).then(([operator, branchResult]) => {
      if (!active) return;
      setSession(operator);
      setBranches(branchResult.branches);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
      if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/shipments/new`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load operator booking access.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, router]);

  useEffect(() => {
    if (!session || draftId) return;
    let active = true;
    const controller = new AbortController();
    listOperatorBusinessAccounts(operatorSlug, { page: 1, pageSize: 100, search: accountSearch || undefined }, controller.signal)
      .then((result) => {
        if (!active) return;
        setAccounts(result.accounts);
        setAccountTotal(result.pagination.total);
        setAccountCache((current) => ({
          ...current,
          ...Object.fromEntries(result.accounts.map((account) => [account._id, account]))
        }));
        if (session.membership.role === "CLIENT") {
          const clientAccounts = result.accounts.filter(isBookableAccount);
          setAccountId(result.pagination.total === 1 && clientAccounts.length === 1 ? clientAccounts[0]._id : "");
        }
        setAccountsLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Unable to load operator business accounts.");
      })
      .finally(() => { if (active) setAccountsLoaded(true); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, session, accountSearch, draftId]);

  const canCreate = Boolean(
    session &&
    session.access?.mode === "MEMBER" &&
    !session.access.readOnly &&
    ["OPERATOR_ADMIN", "OPERATIONS", "CLIENT"].includes(session.membership.role)
  );
  const isOperatorClient = session?.membership.role === "CLIENT";
  const selectedAccount = accountCache[accountId] ?? accounts.find((account) => account._id === accountId) ?? null;
  const eligibleAccounts = accounts.filter(isBookableAccount);
  const accountOptions = useMemo(() => {
    const options = eligibleAccounts.map((account) => ({ value: account._id, label: businessAccountDisplayName(account) }));
    if (selectedAccount && isBookableAccount(selectedAccount) && !options.some((option) => option.value === selectedAccount._id)) {
      options.unshift({ value: selectedAccount._id, label: businessAccountDisplayName(selectedAccount) });
    }
    return options;
  }, [eligibleAccounts, selectedAccount]);
  const selectedBranch = branches.find((branch) => branch._id === selectedAccount?.assignedBranch?._id && isActiveBranch(branch));
  const selectedBranchId = selectedBranch?._id ?? "";
  const clientAccount = isOperatorClient && accountTotal === 1 && eligibleAccounts.length === 1
    ? eligibleAccounts[0]
    : null;
  const clientBranch = clientAccount
    ? branches.find((branch) => branch._id === clientAccount.assignedBranch?._id && isActiveBranch(branch))
    : null;
  const clientSetupReady = Boolean(clientAccount && clientBranch);
  const clientSetupMessage = isOperatorClient && accountsLoaded && !draftId
    ? accountTotal !== 1
      ? accountTotal === 0
        ? "Your operator login is not linked to a business account. Ask the operator administrator to check your access."
        : "Your operator login is linked to more than one business account. Ask the operator administrator to confirm the correct account."
      : !clientAccount
        ? "Your business account must be approved before you can create a shipment."
        : !clientBranch
          ? "Your business account does not have an active assigned branch. Ask the operator administrator to check its assignment."
          : ""
    : "";
  const visibleError = error || clientSetupMessage;

  const startDraft = useCallback(async (businessAccountId: string, branchId: string) => {
    setSaving(true);
    setError("");
    try {
      const result = await createOperatorManualShipmentDraft(operatorSlug, { branchId, businessAccountId });
      const createdDraftId = result.shipmentDraft._id;
      setDraftId(createdDraftId);
      router.replace(`/portal/${encodeURIComponent(operatorSlug)}/shipments/new?draftId=${encodeURIComponent(createdDraftId)}`, { scroll: false });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start this shipment.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [operatorSlug, router]);

  useEffect(() => {
    if (!isOperatorClient || !canCreate || loading || !accountsLoaded || draftId || !clientSetupReady || !clientAccount || !clientBranch) return;
    const requestKey = `${clientAccount._id}:${clientBranch._id}`;
    if (autoCreateKey.current === requestKey) return;
    autoCreateKey.current = requestKey;
    void startDraft(clientAccount._id, clientBranch._id).then((created) => {
      if (!created) autoCreateKey.current = "";
    });
  }, [
    isOperatorClient,
    canCreate,
    loading,
    accountsLoaded,
    draftId,
    clientAccount,
    clientBranch,
    clientSetupReady,
    startDraft,
    createRetry
  ]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate || saving || draftId || !selectedAccount || !isBookableAccount(selectedAccount) || !selectedBranchId) return;
    await startDraft(selectedAccount._id, selectedBranchId);
  }

  const bookingPath = `/portal/${encodeURIComponent(operatorSlug)}/shipments/new`;

  return (
    <div className={`min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900 ${draftId ? "xl:h-[calc(100dvh-5rem)] xl:min-h-0 xl:overflow-y-auto" : ""}`}>
      <main className={`mx-auto w-full max-w-[1440px] px-3 py-5 sm:px-6 sm:py-6 lg:px-8 ${draftId ? "xl:flex xl:min-h-full xl:flex-col xl:gap-4" : "space-y-6"}`}>
        <div className={`flex shrink-0 flex-wrap items-end justify-between gap-4 ${draftId ? "xl:gap-3" : ""}`}>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950">Create a shipment</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              {isOperatorClient
                ? "Enter the shipment, recipient, parcel, and goods details for your business account."
                : "Choose a business account. Its assigned dispatch branch will be used for this booking."}
            </p>
          </div>
          <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments`} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
            <FiArrowLeft aria-hidden="true" className="h-4 w-4" /> Shipments
          </Link>
        </div>

        {visibleError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-white p-4 text-sm leading-5 text-rose-800">
            <span>{visibleError} {visibleError.toLowerCase().includes("sign in") ? <Link className="font-semibold underline" href={`/?next=${encodeURIComponent(bookingPath)}`}>Sign in</Link> : null}</span>
            {isOperatorClient && clientSetupReady && !draftId && !saving ? (
              <button type="button" onClick={() => { autoCreateKey.current = ""; setCreateRetry((current) => current + 1); }} className="min-h-9 rounded-md border border-rose-300 px-3 font-semibold text-rose-900 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700">Try again</button>
            ) : null}
          </div>
        ) : null}

        {!loading && session && !canCreate ? <div role="alert" className="rounded-lg border border-amber-200 bg-white p-4 text-sm text-amber-900">Your operator role can view shipments but cannot create a booking.</div> : null}

        {loading ? (
          <OperatorLoadingIndicator label="Loading your operator workspace…" className="min-h-[calc(100dvh-16rem)]" />
        ) : null}

        {!loading && session && canCreate && !isOperatorClient && selectionStepVisible ? (
          <form onSubmit={(event) => void handleCreate(event)} className={`rounded-xl border border-slate-200 bg-white p-5 sm:p-6 ${draftId ? "xl:shrink-0" : ""}`}>
            {accountTotal > 100 ? (
              <div className="mb-5 max-w-xl">
                <label htmlFor="operator-account-search" className="mb-1.5 block text-sm font-medium text-slate-700">Find a business account</label>
                <div className="relative">
                  <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input id="operator-account-search" value={accountSearchInput} onChange={(event) => setAccountSearchInput(event.target.value)} maxLength={100} disabled={Boolean(draftId)} placeholder="Search company or account ID" className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:bg-slate-100" />
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">Search by company or account ID to find accounts beyond the first 100.</p>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <OperatorSelect
                id="operator-booking-account"
                label="Business account"
                value={accountId}
                options={accountOptions}
                placeholder={!accountsLoaded || accountSearchInput.trim() !== accountSearch ? "Loading business accounts…" : "Select an approved business account"}
                disabled={Boolean(draftId) || !accountsLoaded || accountSearchInput.trim() !== accountSearch || eligibleAccounts.length === 0}
                onChange={(value) => { setAccountId(value); setError(""); }}
              />
              <OperatorSelect
                id="operator-booking-branch"
                label="Assigned dispatch branch"
                value={selectedBranchId}
                options={selectedBranch ? [{ value: selectedBranch._id, label: `${selectedBranch.name} (${selectedBranch.code})` }] : []}
                placeholder={selectedAccount ? "No active assigned branch" : "Select a business account first"}
                disabled={!selectedBranch || Boolean(draftId)}
                onChange={() => { /* The account assignment determines the branch. */ }}
              />
            </div>

            {selectedAccount && !isBookableAccount(selectedAccount) ? <p role="alert" className="mt-3 text-sm text-amber-800">This account must be approved and assigned to an active branch before it can book.</p> : null}
            {accountsLoaded && eligibleAccounts.length === 0 ? <p className="mt-3 text-sm text-amber-800">No approved business account with an active branch is available for shipment booking.</p> : null}
            {selectedAccount && !selectedBranch ? <p role="alert" className="mt-3 text-sm text-amber-800">The assigned branch is unavailable or inactive. Ask an operator administrator to review the account assignment.</p> : null}

            <div className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
              {draftId ? <p role="status" className="text-sm font-medium text-emerald-800">Shipment form ready for {selectedAccount ? businessAccountDisplayName(selectedAccount) : "business account"} · {selectedBranch?.name}.</p> : <span />}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments`} className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Cancel</Link>
                {!draftId ? (
                  <button type="submit" disabled={saving || !selectedAccount || !isBookableAccount(selectedAccount) || !selectedBranchId} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-55">
                    {saving ? <FiLoader aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
                    {saving ? "Preparing shipment…" : "Continue to shipment details"}
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        ) : null}

        {isOperatorClient && !draftId && !visibleError && canCreate ? (
          <div role="status" className="flex min-h-24 flex-col items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 text-center text-sm font-medium text-slate-600 sm:flex-row">
            <FiLoader aria-hidden="true" className="h-4 w-4 animate-spin text-[#0D1282]" />
            {saving ? "Preparing your shipment form…" : !accountsLoaded ? "Loading your business account…" : "Opening the shipment form…"}
          </div>
        ) : null}

        {draftId ? (
          <div className="min-w-0 xl:h-[clamp(32.5rem,78dvh,56.25rem)] xl:shrink-0 xl:overflow-hidden">
            <OperatorShipmentDraftForm key={draftId} operatorSlug={operatorSlug} shipmentDraftId={draftId} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
