"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BusinessAccountAccessPanel } from "@/components/business-accounts/BusinessAccountAccessPanel";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import RateCardWorkspace from "@/components/rate-cards/RateCardWorkspace";
import OperatorBusinessAccountBillingAddress from "@/components/operators/OperatorBusinessAccountBillingAddress";
import {
  assignBusinessAccountBranch,
  BusinessAccount,
  BusinessAddress,
  BusinessKycCheckKey,
  BusinessKycCheckStatus,
  BusinessKycReviewUpdate,
  DocumentType,
  getBusinessAccount,
  getBusinessAccountDocument,
  submitBusinessAccount,
  updateBusinessAccountKycReview,
  updateBusinessAccountStatus
} from "@/lib/businessAccounts";
import { getOperatorSession, listOperatorBranches, OperatorBranch, OperatorSession } from "@/lib/operatorDirectory";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";

const documentLabels: Record<DocumentType, string> = {
  aadhaarCard: "Aadhaar Card",
  panCard: "PAN Card",
  adCertificate: "AD Certificate",
  msmeCertificate: "MSME Certificate",
  tanCertificate: "TAN Certificate",
  otherCertificate: "Other Certificate",
  gstCertificate: "GST Certificate",
  iecCertificate: "IEC Certificate"
};

const documentOrder: DocumentType[] = [
  "aadhaarCard", "panCard", "adCertificate", "msmeCertificate", "tanCertificate",
  "gstCertificate", "iecCertificate", "otherCertificate"
];

const checkLabels: Record<BusinessKycCheckKey, string> = {
  contactDetails: "Contact details",
  companyDetails: "Company details",
  gstExemption: "GST exemption",
  aadhaarCard: "Aadhaar Card",
  panCard: "PAN Card Copy",
  adCertificate: "AD Certificate",
  msmeCertificate: "MSME Certificate",
  tanCertificate: "TAN Certificate",
  otherCertificate: "Other Certificate",
  gstCertificate: "GST Certificate",
  iecCertificate: "IEC Certificate"
};

const checkStatuses: BusinessKycCheckStatus[] = ["not_started", "under_review", "verified", "information_required", "reject"];

function assignedBranchId(account: BusinessAccount): string {
  if (!account.assignedBranch) return "";
  return typeof account.assignedBranch === "string" ? account.assignedBranch : account.assignedBranch._id;
}

function displayStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function AccountDetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm leading-5 text-slate-800">
        {value === null || value === undefined || value === "" ? <span className="text-slate-500">Not provided</span> : value}
      </dd>
    </div>
  );
}

function formatAddress(address?: BusinessAddress | null) {
  if (!address) return "";
  return [
    address.addressLine1,
    address.addressLine2,
    [address.city, address.stateOrProvince, address.postalCode].filter(Boolean).join(", "),
    address.country
  ].filter(Boolean).join(", ");
}

function accountMoney(amount: number | null | undefined, currency: string | undefined) {
  if (amount == null) return "Not provided";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency || "INR"} ${amount.toLocaleString("en-IN")}`;
  }
}

function accountDate(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

type BusinessAccountDetailTab = "overview" | "rate-card" | "users";

function accountCheckKeys(account: BusinessAccount): BusinessKycCheckKey[] {
  const keys: BusinessKycCheckKey[] = ["contactDetails", "companyDetails", "aadhaarCard", "panCard"];
  if (account.company.gstExempt) keys.push("gstExemption");
  for (const key of documentOrder.slice(2)) {
    if (account.documents?.[key]) keys.push(key);
  }
  return keys;
}

function asObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export default function OperatorBusinessAccountDetail({ operatorSlug, accountId }: { operatorSlug: string; accountId: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [account, setAccount] = useState<BusinessAccount | null>(null);
  const [branches, setBranches] = useState<OperatorBranch[]>([]);
  const [branchDraft, setBranchDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openingDocument, setOpeningDocument] = useState<DocumentType | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [infoRequest, setInfoRequest] = useState<BusinessKycCheckKey | null>(null);
  const [infoReason, setInfoReason] = useState("");
  const [activeTab, setActiveTab] = useState<BusinessAccountDetailTab>("overview");
  const [visitedTabs, setVisitedTabs] = useState<Record<BusinessAccountDetailTab, boolean>>({ overview: true, "rate-card": false, users: false });
  const [pendingStatusChange, setPendingStatusChange] = useState<"active" | "suspended" | null>(null);

  function selectTab(tab: BusinessAccountDetailTab) {
    setActiveTab(tab);
    setVisitedTabs((current) => current[tab] ? current : { ...current, [tab]: true });
  }

  const isOperatorAdmin = !supportReadOnly && operator?.membership.role === "OPERATOR_ADMIN";
  const canReview = useMemo(() => account ? accountCheckKeys(account) : [], [account]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [session, accountResult, branchResult] = await Promise.all([
          getOperatorSession(operatorSlug),
          getBusinessAccount(accountId, operatorSlug),
          listOperatorBranches(operatorSlug, { page: 1, pageSize: 100 })
        ]);
        if (!active) return;
        if (!["OPERATOR_ADMIN", "OPERATIONS"].includes(session.membership.role)) {
          setError("You do not have permission to review business accounts.");
          return;
        }
        setOperator(session);
        setAccount(accountResult.account);
        setBranchDraft(assignedBranchId(accountResult.account));
        setBranches(branchResult.branches.filter((branch) => branch.status === "ACTIVE"));
      } catch (cause) {
        if (!active) return;
        const requestError = cause && typeof cause === "object"
          ? cause as { canonicalSlug?: unknown }
          : null;
        if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug !== operatorSlug) {
          router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/business-accounts/${encodeURIComponent(accountId)}`);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to open this business account.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, operatorSlug, router]);

  async function updateAccountAction(action: () => Promise<{ account: BusinessAccount }>, successMessage: string): Promise<boolean> {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      setAccount(result.account);
      setBranchDraft(assignedBranchId(result.account));
      setNotice(successMessage);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The business account could not be updated.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveKyc(update: BusinessKycReviewUpdate) {
    if (!account) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await updateBusinessAccountKycReview(account.accountId, update, operatorSlug);
      setAccount(result.account);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the local KYC review.");
    } finally {
      setSaving(false);
    }
  }

  async function changeCheck(key: BusinessKycCheckKey, status: BusinessKycCheckStatus) {
    if (status === "information_required") {
      setInfoRequest(key);
      setInfoReason("");
      return;
    }
    await saveKyc({ checks: { [key]: { status } } });
  }

  async function submitInformationRequest() {
    if (!infoRequest) return;
    const reason = infoReason.trim();
    if (!reason || reason.length > 50) {
      setError("Enter a reason of 1 to 50 characters.");
      return;
    }
    const key = infoRequest;
    setInfoRequest(null);
    setInfoReason("");
    await saveKyc({ checks: { [key]: { status: "information_required", note: reason } } });
  }

  async function viewDocument(type: DocumentType) {
    if (!account) return;
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    setOpeningDocument(type);
    setError("");
    try {
      const blob = await getBusinessAccountDocument(account.accountId, type, operatorSlug);
      const url = asObjectUrl(blob);
      if (popup) popup.location.href = url;
      else window.location.assign(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : "Unable to open this document.");
    } finally {
      setOpeningDocument(null);
    }
  }

  async function assignBranch() {
    if (!account || !branchDraft) return;
    await updateAccountAction(
      () => assignBusinessAccountBranch(account.accountId, branchDraft, operatorSlug),
      "Branch assignment saved."
    );
  }

  async function confirmStatusChange() {
    if (!account || !pendingStatusChange) return;
    const targetStatus = pendingStatusChange;
    const successMessage = targetStatus === "active"
      ? "Business account activated and ready for bookings."
      : "Business account deactivated. New shipment bookings are blocked.";
    const updated = await updateAccountAction(
      () => updateBusinessAccountStatus(account.accountId, targetStatus, operatorSlug),
      successMessage
    );
    if (updated) setPendingStatusChange(null);
  }

  const workspaceHref = `/portal/${encodeURIComponent(operatorSlug)}`;
  if (loading) {
    return <OperatorPageLoading label="Loading business account…" />;
  }

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-slate-600">Business accounts / Details</p>
            <h1 className="mt-1 break-words text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-3xl">{account?.company.companyName || "Business account"}</h1>
            {account ? <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>{account.accountId}</span><span aria-hidden="true">·</span><span className="capitalize">{displayStatus(account.status)}</span></div> : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {isOperatorAdmin && account && (account.status === "approved" || account.status === "active") ? (
              <button type="button" onClick={() => setPendingStatusChange("suspended")} disabled={saving} className="inline-flex min-h-10 items-center justify-center rounded-md border border-rose-300 bg-white px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-wait disabled:opacity-50">Deactivate account</button>
            ) : null}
            {isOperatorAdmin && account?.status === "suspended" ? (
              <button type="button" onClick={() => setPendingStatusChange("active")} disabled={saving || account.kycReview?.overallStatus !== "verified"} title={account.kycReview?.overallStatus !== "verified" ? "KYC must be verified before this account can be activated." : undefined} className="inline-flex min-h-10 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">Activate account</button>
            ) : null}
            <Link href={`${workspaceHref}/business-accounts`} className="inline-flex min-h-10 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Business accounts</Link>
            <Link href={workspaceHref} className="inline-flex min-h-10 items-center justify-center rounded-md bg-[#0D1282] px-3 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Workspace home</Link>
          </div>
        </header>

        {error ? <div role="alert" className="rounded-md border border-rose-200 bg-white px-4 py-3 text-sm text-rose-700">{error}</div> : null}
        {notice ? <div role="status" className="rounded-md border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

        {account ? (
          <>
            <div role="tablist" aria-label="Business account sections" className="flex gap-5 overflow-x-auto border-b border-slate-300 bg-transparent">
              {([
                ["overview", "Overview"],
                ["rate-card", "Rate card"],
                ["users", "Users"]
              ] as const).map(([tab, label]) => (
                <button key={tab} id={`account-tab-${tab}`} type="button" role="tab" tabIndex={activeTab === tab ? 0 : -1} aria-selected={activeTab === tab} aria-controls={`account-panel-${tab}`} onClick={() => selectTab(tab)} onKeyDown={(event) => {
                  const index = ["overview", "rate-card", "users"].indexOf(tab);
                  const nextIndex = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const nextTab = (["overview", "rate-card", "users"] as const)[nextIndex];
                  selectTab(nextTab);
                  document.getElementById(`account-tab-${nextTab}`)?.focus();
                }} className={`relative min-h-12 shrink-0 border-b-2 px-1 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D1282] ${activeTab === tab ? "border-[#0D1282] text-[#0D1282]" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-950"}`}>
                  {label}
                </button>
              ))}
            </div>

            <section id="account-panel-overview" role="tabpanel" aria-labelledby="account-tab-overview" hidden={activeTab !== "overview"} className="space-y-5">
              {account.status === "draft" && !supportReadOnly && operator && ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role) ? (
                <section className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                  <div><h2 className="font-semibold text-slate-950">Ready for local review?</h2><p className="mt-1 text-sm text-slate-600">Submitting moves this draft to your operator’s review queue.</p></div>
                  <button type="button" disabled={saving} onClick={() => void updateAccountAction(() => submitBusinessAccount(account.accountId, operatorSlug), "Submitted for operator review.")} className="min-h-10 shrink-0 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Submitting…" : "Submit for review"}</button>
                </section>
              ) : null}

              <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 className="font-semibold text-slate-950">Company and registration</h2><p className="mt-1 text-sm text-slate-600">Legal, billing, and operating details supplied for this account.</p></div>
                <dl className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
                  <AccountDetailField label="Company name" value={account.company.companyName} />
                  <AccountDetailField label="Company type" value={account.company.companyType} />
                  <AccountDetailField label="Registration country" value={account.company.registrationCountry} />
                  <AccountDetailField label="Registration ID type" value={account.company.registrationIdType} />
                  <AccountDetailField label="Registration ID" value={account.company.registrationId} />
                  <AccountDetailField label="Secondary registration ID" value={account.company.secondaryRegistrationId} />
                  <AccountDetailField label="Company registration status" value={account.company.noCompanyRegistration ? "No company registration" : account.company.noCompany ? "Individual / no company" : "Registered business"} />
                  <AccountDetailField label="GSTIN" value={account.company.gstin} />
                  <AccountDetailField label="GST registration exemption" value={account.company.gstExempt ? `Yes${account.company.gstExemptReason ? ` — ${account.company.gstExemptReason}` : ""}` : "No"} />
                  <AccountDetailField label="Website" value={account.company.website} />
                  <AccountDetailField label="Industry" value={account.company.industry} />
                  <AccountDetailField label="Monthly shipment volume" value={account.company.monthlyShipmentVolume} />
                  <AccountDetailField label="Requested credit limit" value={accountMoney(account.company.requestedCreditLimit.amount, account.company.requestedCreditLimit.currency)} />
                  <AccountDetailField label="Operating countries" value={(account.company.operatingCountries?.length ? account.company.operatingCountries : [account.company.operatingCountry]).filter(Boolean).join(", ")} />
                  <AccountDetailField label="Account origin" value={account.origin} />
                  <AccountDetailField label="Shipment types" value={account.contact.shipmentTypes?.map(displayStatus).join(", ")} />
                </dl>
              </section>

              <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 className="font-semibold text-slate-950">Contact and addresses</h2><p className="mt-1 text-sm text-slate-600">Primary account contact, registered location, and invoice address.</p></div>
                <dl className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
                  <AccountDetailField label="Contact name" value={[account.contact.title, account.contact.firstName, account.contact.lastName].filter(Boolean).join(" ")} />
                  <AccountDetailField label="Email" value={account.contact.email ? <a className="break-all text-[#0D1282] underline underline-offset-2" href={`mailto:${account.contact.email}`}>{account.contact.email}</a> : null} />
                  <AccountDetailField label="Phone" value={[account.contact.countryCode, account.contact.mobileNumber].filter(Boolean).join(" ")} />
                  <AccountDetailField label="Phone type" value={account.contact.mobileType} />
                  <AccountDetailField label="Job title" value={account.contact.jobTitle} />
                  <AccountDetailField label="Department" value={account.contact.department} />
                  <AccountDetailField label="Registered address" value={formatAddress({ addressLine1: account.company.registeredAddress, addressLine2: account.company.addressLine2 || "", city: account.company.city, stateOrProvince: account.company.stateOrProvince, postalCode: account.company.postalCode, country: account.company.addressCountry || account.company.registrationCountry })} />
                  {!account.company.noCompany ? <AccountDetailField label="Billing address" value={account.company.useCompanyAddressAsBillingAddress ? "Same as registered address" : formatAddress(account.company.billingAddress)} /> : null}
                </dl>
              </section>

              {account.company.noCompany ? (
                <OperatorBusinessAccountBillingAddress
                  account={account}
                  operatorSlug={operatorSlug}
                  canEdit={!supportReadOnly && Boolean(operator && ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role))}
                  onUpdated={(updatedAccount) => setAccount(updatedAccount)}
                />
              ) : null}

              <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 className="font-semibold text-slate-950">Account setup and billing</h2><p className="mt-1 text-sm text-slate-600">Operator-local branch, credit, and tax billing configuration.</p></div>
                <dl className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
                  <AccountDetailField label="Assigned branch" value={account.assignedBranch && typeof account.assignedBranch !== "string" ? `${account.assignedBranch.name} (${account.assignedBranch.code})` : "Not assigned"} />
                  <AccountDetailField label="Credit limit review" value={account.creditLimitStatus} />
                  <AccountDetailField label="Deposit status" value={account.depositStatus} />
                  <AccountDetailField label="Agreement status" value={account.agreementStatus} />
                  <AccountDetailField label="GST billing preference" value={account.gstBilling?.requestedTreatment} />
                  <AccountDetailField label="GST billing review" value={account.gstBilling?.status} />
                  <AccountDetailField label="GST billing request reason" value={account.gstBilling?.requestReason} />
                  <AccountDetailField label="GST billing decision reason" value={account.gstBilling?.decisionReason} />
                  <AccountDetailField label="GST billing effective period" value={account.gstBilling?.effectiveFrom || account.gstBilling?.effectiveUntil ? `${accountDate(account.gstBilling.effectiveFrom)} – ${accountDate(account.gstBilling.effectiveUntil)}` : null} />
                  <AccountDetailField label="Account created" value={accountDate(account.createdAt)} />
                  <AccountDetailField label="Submitted for review" value={accountDate(account.submittedAt)} />
                  <AccountDetailField label="Created by" value={account.createdBy?.name || account.createdBy?.email} />
                </dl>
                {isOperatorAdmin ? <div className="border-t border-slate-200 p-4 sm:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><div className="min-w-0 flex-1"><label htmlFor="operator-account-branch" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Change assigned branch</label><select id="operator-account-branch" value={branchDraft} onChange={(event) => setBranchDraft(event.target.value)} className="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800"><option value="">Select active branch</option>{branches.map((branch) => <option key={branch._id} value={branch._id}>{branch.name} ({branch.code})</option>)}</select></div><button type="button" onClick={() => void assignBranch()} disabled={!branchDraft || branchDraft === assignedBranchId(account) || saving} className="min-h-10 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Saving…" : "Save branch"}</button></div>{branches.length === 0 ? <p className="mt-2 text-xs text-amber-700">No active branches are available. Configure an operator branch before inviting a client.</p> : null}</div> : null}
              </section>

              <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-950">{account.status === "pending_review" ? "Local KYC review" : "KYC documents"}</h2><p className="mt-1 text-sm text-slate-600">Uploaded verification files for this business account.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold capitalize text-slate-700">{displayStatus(account.kycReview?.overallStatus || "documents_pending")}</span></div></div>
                {account.status === "pending_review" ? <div className="space-y-4 p-4 sm:p-5">
                  <p className="text-sm text-slate-600">Only this operator’s administrator can update the review. Approval is enabled after required checks are verified.</p>
                  <div className="overflow-x-auto rounded-md border border-slate-200"><table className="min-w-[660px] w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600"><tr><th className="px-3 py-3">Check</th><th className="px-3 py-3">Review status</th><th className="px-3 py-3">Evidence</th></tr></thead><tbody className="divide-y divide-slate-100">{canReview.map((key) => {
                    const status = account.kycReview?.checks?.[key]?.status || "not_started";
                    const documentType = documentOrder.includes(key as DocumentType) ? key as DocumentType : null;
                    const document = documentType ? account.documents?.[documentType] : null;
                    return <tr key={key}><td className="px-3 py-3 font-medium text-slate-800">{checkLabels[key]}</td><td className="px-3 py-3"><select aria-label={`${checkLabels[key]} review status`} value={status} onChange={(event) => void changeCheck(key, event.target.value as BusinessKycCheckStatus)} disabled={!isOperatorAdmin || saving} className="min-h-10 w-full min-w-40 rounded-md border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100 disabled:text-slate-500">{checkStatuses.map((option) => <option key={option} value={option}>{displayStatus(option)}</option>)}</select>{account.kycReview?.checks?.[key]?.note ? <p className="mt-1 max-w-xs text-xs text-amber-700">{account.kycReview.checks[key]?.note}</p> : null}</td><td className="px-3 py-3">{document && documentType ? <button type="button" onClick={() => void viewDocument(documentType)} disabled={openingDocument === documentType} className="max-w-xs break-all text-left font-semibold text-[#0D1282] underline underline-offset-2 disabled:opacity-50">{openingDocument === documentType ? "Opening…" : document.originalName || documentLabels[documentType]}</button> : key === "contactDetails" || key === "companyDetails" || key === "gstExemption" ? <span className="text-slate-500">Account information</span> : <span className="text-slate-500">Document missing</span>}</td></tr>;
                  })}</tbody></table></div>
                  {infoRequest ? <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"><label className="text-sm font-medium text-slate-800">Reason for requesting information on {checkLabels[infoRequest]}<input autoFocus maxLength={50} value={infoReason} onChange={(event) => setInfoReason(event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3" /></label><button type="button" onClick={() => void submitInformationRequest()} className="min-h-10 rounded-md bg-[#0D1282] px-3 text-sm font-semibold text-white">Save reason</button><button type="button" onClick={() => setInfoRequest(null)} className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700">Cancel</button></div> : null}
                  {isOperatorAdmin ? <div className="flex flex-wrap gap-2"><button type="button" disabled={saving || account.kycReview?.overallStatus !== "verified"} onClick={() => void updateAccountAction(() => updateBusinessAccountStatus(account.accountId, "approved", operatorSlug), "Business account approved locally.")} className="min-h-10 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">Approve account</button><button type="button" disabled={saving || account.kycReview?.overallStatus !== "rejected"} onClick={() => void updateAccountAction(() => updateBusinessAccountStatus(account.accountId, "rejected", operatorSlug), "Business account rejected.")} className="min-h-10 rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-45">Reject account</button></div> : null}
                </div> : <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">{documentOrder.map((type) => {
                  const document = account.documents?.[type];
                  if (!document) return null;
                  return <div key={type} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{documentLabels[type]}</p><p className="mt-1 truncate text-sm text-slate-800">{document.originalName}</p></div><button type="button" onClick={() => void viewDocument(type)} disabled={openingDocument === type} className="shrink-0 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 disabled:opacity-50">{openingDocument === type ? "Opening…" : "Preview"}</button></div>;
                })}{!documentOrder.some((type) => account.documents?.[type]) ? <p className="text-sm text-slate-600">No KYC documents have been uploaded.</p> : null}</div>}
              </section>
            </section>

            <section id="account-panel-rate-card" role="tabpanel" aria-labelledby="account-tab-rate-card" hidden={activeTab !== "rate-card"} className="space-y-4">
              {visitedTabs["rate-card"] ? isOperatorAdmin || supportReadOnly ? <div className="relative min-w-0 rounded-lg border border-slate-200 bg-white p-3 sm:p-5"><RateCardWorkspace businessAccountId={account._id} cardName={`${account.company.companyName || account.accountId} rate card`} operatorSlug={operatorSlug} /></div> : <div className="rounded-lg border border-amber-200 bg-white p-5 text-sm text-amber-900">Rate card access is available to operator administrators and authorized read-only support sessions.</div> : null}
            </section>

            <section id="account-panel-users" role="tabpanel" aria-labelledby="account-tab-users" hidden={activeTab !== "users"} className="space-y-4">
              {visitedTabs.users ? isOperatorAdmin && account.status !== "pending_review" && account.status !== "draft" ? <BusinessAccountAccessPanel account={account} operatorSlug={operatorSlug} /> : isOperatorAdmin ? <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-700">Client logins can be managed after this account has been approved.</div> : <div className="rounded-lg border border-amber-200 bg-white p-5 text-sm text-amber-900">Only operator administrators can manage client users for this account.</div> : null}
            </section>
          </>
        ) : null}
      </main>
      {account && pendingStatusChange ? (
        <ConfirmDialog
          title={pendingStatusChange === "active" ? "Activate business account?" : "Deactivate business account?"}
          description={pendingStatusChange === "active"
            ? <>This will reactivate <span className="font-semibold text-slate-900">{account.company.companyName || account.accountId}</span> for new shipment bookings.</>
            : <>This will suspend <span className="font-semibold text-slate-900">{account.company.companyName || account.accountId}</span> and block new shipment bookings until it is activated again.</>}
          confirmLabel={pendingStatusChange === "active" ? "Activate account" : "Deactivate account"}
          tone={pendingStatusChange === "active" ? "primary" : "danger"}
          busy={saving}
          busyLabel={pendingStatusChange === "active" ? "Activating..." : "Deactivating..."}
          onConfirm={() => void confirmStatusChange()}
          onCancel={() => setPendingStatusChange(null)}
        />
      ) : null}
    </div>
  );
}
