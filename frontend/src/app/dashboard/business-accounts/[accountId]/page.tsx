"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  FiChevronDown,
  FiFile,
  FiFileText,
} from "react-icons/fi";
import { BiEdit } from "react-icons/bi";
import { DashboardLoading } from "@/components/DashboardShell";
import { BusinessAccountAccessPanel } from "@/components/business-accounts/BusinessAccountAccessPanel";
import RateCardWorkspace from "@/components/rate-cards/RateCardWorkspace";
import { requestLeave } from "@/lib/useUnsavedChanges";
import {
  canadaRegistrationTypeOptions,
  companyTypeOptions,
  mobileTypeOptions,
  registrationConfig,
  titleOptions,
} from "@/components/business-accounts/FormFieldControls";
import { isUsTaxIdType, usTaxIdLabels } from "@/lib/usTaxId";
import { formatDashboardDate } from "@/lib/dateFormat";
import {
  BusinessAccount,
  BusinessKycCheckKey,
  BusinessKycCheckStatus,
  BusinessKycOverallStatus,
  DocumentType,
  getBusinessAccount,
  getBusinessAccountDocument,
  updateBusinessAccountGstBillingReview,
  updateBusinessAccountKycReview,
} from "@/lib/businessAccounts";
import { BUSINESS_ACCOUNT_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { useDialog } from "@/lib/useDialog";

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function formatShipmentType(value: string) {
  if (value === "international_cargo") return "International Cargo";
  if (value === "international_courier") return "International Courier";
  return value.replaceAll("_", " ");
}

function formatOperatingCountries(account: BusinessAccount) {
  return (
    account.company.operatingCountries ??
    (account.company.operatingCountry ? [account.company.operatingCountry] : [])
  ).join(", ");
}

function formatFromOptions(
  value: string | undefined,
  options: { value: string; label: string }[],
) {
  return options.find((option) => option.value === value)?.label ?? value ?? "";
}

function formatAssignedBranch(assignedBranch: BusinessAccount["assignedBranch"]) {
  if (!assignedBranch) return "Not assigned";
  if (typeof assignedBranch === "string") return assignedBranch;
  return assignedBranch.name || assignedBranch.code || "Not assigned";
}

function formatBillingAddress(account: BusinessAccount) {
  const billing = account.company.billingAddress;

  if (!billing) return "";

  return [
    billing.addressLine1,
    billing.addressLine2,
    billing.city,
    billing.stateOrProvince,
    billing.postalCode,
    billing.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function getRegistrationIdLabel(account: BusinessAccount) {
  // US accounts name the identifier they actually hold. The stored value for an
  // SSN or ITIN is only the mask, so the label is what tells a reviewer which
  // of the three they are looking at.
  if (account.company.registrationCountry === "United States") {
    const taxIdType = account.company.registrationIdType ?? "";
    return isUsTaxIdType(taxIdType) ? usTaxIdLabels[taxIdType] : "US Tax ID";
  }

  if (account.company.registrationCountry === "Canada") {
    return (
      canadaRegistrationTypeOptions.find(
        (option) => option.value === account.company.registrationIdType,
      )?.label ?? "Registration ID"
    );
  }

  return (
    registrationConfig[account.company.registrationCountry]?.primaryLabel ??
    "Registration ID"
  );
}

function getAccountStatusBadgeClasses(status: string) {
  switch (status) {
    case "active":
      return "bg-[#22C55E]/10 text-[#15803D] ring-1 ring-[#22C55E]/20";

    case "approved":
      return "bg-[#0D1282]/10 text-[#0D1282] ring-1 ring-[#0D1282]/20";

    case "pending":
      return "bg-[#F5B942]/15 text-[#A16207] ring-1 ring-[#F5B942]/30";

    case "draft":
      return "bg-[#6B7280]/10 text-[#4B5563] ring-1 ring-[#6B7280]/20";

    case "inactive":
      return "bg-[#6B7280]/10 text-[#4B5563] ring-1 ring-[#6B7280]/20";

    case "suspended":
      return "bg-[#F97316]/10 text-[#C2410C] ring-1 ring-[#F97316]/20";

    case "rejected":
      return "bg-[#EF4444]/10 text-[#B91C1C] ring-1 ring-[#EF4444]/20";

    default:
      return "bg-[#E5E7EB] text-[#4B5563] ring-1 ring-[#D1D5DB]";
  }
}
const documentSummaryRows: {
  key: DocumentType;
  label: string;
  required?: boolean;
}[] = [
  { key: "aadhaarCard", label: "Aadhaar Card", required: true },
  { key: "panCard", label: "PAN Card Copy", required: true },
  { key: "adCertificate", label: "AD Certificate" },
  { key: "msmeCertificate", label: "MSME Certificate" },
  { key: "tanCertificate", label: "TAN Certificate" },
  { key: "gstCertificate", label: "GST Certificate" },
  { key: "iecCertificate", label: "IEC Certificate" },
  { key: "otherCertificate", label: "Other Certificate" },
];

const kycCheckStatusOptions: {
  value: BusinessKycCheckStatus;
  label: string;
}[] = [
  { value: "not_started", label: "Not Started" },
  { value: "under_review", label: "Under Review" },
  { value: "verified", label: "Verified" },
  { value: "information_required", label: "Information Required" },
  { value: "reject", label: "Reject" },
];

const kycStatusStyles: Record<BusinessKycOverallStatus, string> = {
  documents_pending:
    "bg-[#F5B942]/15 text-[#A16207] ring-1 ring-[#F5B942]/30",

  submitted:
    "bg-[#0D1282]/10 text-[#0D1282] ring-1 ring-[#0D1282]/20",

  under_review:
    "bg-[#3B82F6]/10 text-[#1D4ED8] ring-1 ring-[#3B82F6]/20",

  additional_information_required:
    "bg-[#F97316]/10 text-[#C2410C] ring-1 ring-[#F97316]/20",

  verified:
    "bg-[#22C55E]/10 text-[#15803D] ring-1 ring-[#22C55E]/20",

  rejected:
    "bg-[#EF4444]/10 text-[#B91C1C] ring-1 ring-[#EF4444]/20",
};

function normalizeKycCheckStatus(status?: string): BusinessKycCheckStatus {
  if (status === "failed") return "reject";
  if (
    status === "replacement_required" ||
    status === "mismatched" ||
    status === "unclear"
  )
    return "information_required";
  if (kycCheckStatusOptions.some((option) => option.value === status))
    return status as BusinessKycCheckStatus;
  return "not_started";
}

type DetailTab = "overview" | "documents" | "kyc" | "access" | "rate-card";

const detailTabs: DetailTab[] = ["overview", "documents", "kyc", "access", "rate-card"];

// Notification links address a tab directly (…/business-accounts/SL-1#kyc), so
// the fragment picks the starting tab instead of always opening on Overview.
function tabFromLocationHash(): DetailTab {
  if (typeof window === "undefined") return "overview";
  const requested = window.location.hash.slice(1) as DetailTab;
  return detailTabs.includes(requested) ? requested : "overview";
}

export default function BusinessAccountDetailsPage() {
  const params = useParams<{ accountId: string }>();
  const { user, loading } = useAdminUser(BUSINESS_ACCOUNT_AREA);
  const [account, setAccount] = useState<BusinessAccount | null>(null);
  const [error, setError] = useState("");
  const [accountLoading, setAccountLoading] = useState(true);
  const [documentOpening, setDocumentOpening] = useState<DocumentType | null>(
    null,
  );
  const [kycSaving, setKycSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  // Read after mount so the server render and the first client render agree.
  useEffect(() => {
    const applyHash = window.setTimeout(() => setActiveTab(tabFromLocationHash()), 0);
    return () => window.clearTimeout(applyHash);
  }, [params.accountId]);


  useEffect(() => {
    if (!user || !params.accountId) return;

    async function loadAccount() {
      setAccountLoading(true);
      setError("");
      try {
        const data = await getBusinessAccount(params.accountId);
        setAccount(data.account);
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load business account.",
        );
      } finally {
        setAccountLoading(false);
      }
    }

    void loadAccount();
  }, [params.accountId, user]);

  async function handleViewDocument(documentType: DocumentType) {
    if (!account) return;

    setDocumentOpening(documentType);
    setError("");

    // Open the tab synchronously within the click gesture so browsers don't block
    // it as a popup; its location is set once the document blob has loaded. The
    // handle must stay real: `noopener` would make window.open return null, so the
    // blob could never be loaded into the new tab (it would fall back to the
    // current window) and the blank tab would be left behind.
    const documentWindow = window.open("", "_blank");

    try {
      const blob = await getBusinessAccountDocument(
        account.accountId,
        documentType,
      );
      const url = URL.createObjectURL(blob);

      if (documentWindow) {
        documentWindow.location.href = url;
      } else {
        // Popup was blocked despite the synchronous open; fall back to same tab.
        window.location.assign(url);
      }

      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (caughtError) {
      documentWindow?.close();
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to open document.",
      );
    } finally {
      setDocumentOpening(null);
    }
  }

  async function updateKycReview(
    update: Parameters<typeof updateBusinessAccountKycReview>[1],
  ) {
    if (!account) return;

    setKycSaving(true);
    setError("");

    try {
      const data = await updateBusinessAccountKycReview(
        account.accountId,
        update,
      );
      setAccount(data.account);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to update KYC review.",
      );
    } finally {
      setKycSaving(false);
    }
  }

  async function handleKycCheckChange(
    key: BusinessKycCheckKey,
    status: BusinessKycCheckStatus,
    note?: string | null,
  ) {
    await updateKycReview({ checks: { [key]: { status, note } } });
  }

  async function handleVerifyMandatoryChecks() {
    if (!account) return;

    const checks = getKycCheckRows(account).reduce(
      (nextChecks, row) => ({
        ...nextChecks,
        [row.key]: { status: "verified" as BusinessKycCheckStatus },
      }),
      {} as Record<BusinessKycCheckKey, { status: BusinessKycCheckStatus }>,
    );

    await updateKycReview({ checks, finalDecision: null, startReview: true });
  }

  async function handleStartKycReview() {
    if (!account) return;

    const checks = getKycCheckRows(account).reduce(
      (nextChecks, row) => ({
        ...nextChecks,
        [row.key]: { status: "under_review" as BusinessKycCheckStatus },
      }),
      {} as Record<BusinessKycCheckKey, { status: BusinessKycCheckStatus }>,
    );

    await updateKycReview({ checks, finalDecision: null, startReview: true });
  }

  async function handleRejectKyc() {
    if (!account) return;

    const checks = getKycCheckRows(account).reduce(
      (nextChecks, row) => ({
        ...nextChecks,
        [row.key]: { status: "reject" as BusinessKycCheckStatus },
      }),
      {} as Record<BusinessKycCheckKey, { status: BusinessKycCheckStatus }>,
    );

    await updateKycReview({
      checks,
      finalDecision: "rejected",
      startReview: true,
    });
  }

  if (loading || !user || accountLoading) return <DashboardLoading />;

  if (!account) {
    return (
      <div className="rounded-xl border border-[#D71313]/25 bg-[#D71313]/5 p-5">
        <p className="text-sm font-semibold text-[#D71313]">
          {error || "Business account not found."}
        </p>
      </div>
    );
  }

  const missingDocuments = getRequiredDocumentLabels(account);

  const tabs: { key: DetailTab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "documents", label: "Documents" },
    { key: "kyc", label: "KYC Review" },
    { key: "access", label: "Users & Access" },
    { key: "rate-card", label: "Rate Card" },
  ];

  const companyName = account.company?.companyName?.trim();


  return (
    <>
      {/* Account header and navigation actions */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1
                className={
                  companyName
                    ? "text-2xl font-bold text-slate-950"
                    : "text-2xl   text-slate-400"
                }
              >
                {companyName || "no company available "}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold capitalize leading-none ring-1 ring-inset ring-black/5 ${getAccountStatusBadgeClasses(account.status)}`}
              >
               
                {formatStatus(account.status)}
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold text-[#0D1282]">
              {account.accountId}
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href={`/dashboard/business-accounts/${account.accountId}/edit`}
              className="inline-flex items-center gap-2 rounded-4xl bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63]"
            >
              <BiEdit  aria-hidden="true" className="h-4 w-4" /> Edit Account
            </Link>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="mt-5 flex flex-wrap gap-1 border-t border-slate-100 pt-4">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => { void requestLeave().then((canLeave) => { if (canLeave) setActiveTab(tab.key); }); }}
                className={`relative inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  isActive
                    ? "bg-[#0D1282]/80 text-white shadow-sm shadow-[#0D1282]/25"
                    : "text-slate-600 bg-slate-200 hover:bg-[#0D1282]/8 hover:text-[#0D1282]"
                }`}
              >
                {tab.label}
                {tab.key === "documents" && missingDocuments.length ? (
                  <span
                    className={`h-2 w-2 rounded-full ${isActive ? "bg-white" : "bg-[#D71313]"}`}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error alert */}
      {error ? (
        <div className="mt-5 rounded-xl border border-[#D71313]/25 bg-[#D71313]/5 px-4 py-3 text-sm font-medium text-[#D71313]">
          {error}
        </div>
      ) : null}

      <div id={activeTab} className="mt-5">
        {activeTab === "overview" ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <GstBillingReviewPanel account={account} onUpdated={setAccount} />
            </div>
            <DetailSection
              title="Contact Details"
              rows={[
                [
                  "Primary Contact",
                  [
                    formatFromOptions(account.contact.title, titleOptions),
                    account.contact.firstName,
                    account.contact.lastName,
                  ]
                    .filter(Boolean)
                    .join(" "),
                ],
                ["Job Title", account.contact.jobTitle],
                ["Email", account.contact.email],
                [
                  "Mobile",
                  `${account.contact.countryCode} ${account.contact.mobileNumber}`,
                ],
                [
                  "Mobile Type",
                  formatFromOptions(
                    account.contact.mobileType,
                    mobileTypeOptions,
                  ),
                ],
                ["Department", account.contact.department],
                [
                  "Shipment Type",
                  account.contact.shipmentTypes
                    .map(formatShipmentType)
                    .join(", "),
                ],
              ]}
            />

            <DetailSection
              title="Company Details"
              rows={[
                ["Company Name", account.company.companyName],
                [
                  "Company Type",
                  formatFromOptions(
                    account.company.companyType,
                    companyTypeOptions,
                  ),
                ],
                ["Registration Country", account.company.registrationCountry],
                [
                  getRegistrationIdLabel(account),
                  account.company.registrationId || "Not provided",
                ],
                ...(account.company.secondaryRegistrationId
                  ? [
                      [
                        registrationConfig[account.company.registrationCountry]
                          ?.secondaryLabel ?? "Additional Registration Code",
                        account.company.secondaryRegistrationId,
                      ],
                    ]
                  : []),
                ...(account.company.gstin
                  ? [["GSTIN", account.company.gstin]]
                  : []),
                ...(account.company.gstExempt
                  ? [
                      ["GST Registration", "Exempt"],
                      ...(account.company.gstExemptReason
                        ? [
                            [
                              "GST Exempt Reason",
                              account.company.gstExemptReason,
                            ],
                          ]
                        : []),
                    ]
                  : []),
                [
                  "Registered Address",
                  [account.company.registeredAddress, account.company.addressLine2]
                    .filter(Boolean)
                    .join(", "),
                ],
                ["City", account.company.city],
                ["State or Province", account.company.stateOrProvince],
                ["Postal Code", account.company.postalCode],
                [
                  "Country",
                  account.company.addressCountry ||
                    account.company.registrationCountry,
                ],
                ["Operating Countries", formatOperatingCountries(account)],
                ["Industry", account.company.industry],
                ["Website", account.company.website || "Not provided"],
                ["Monthly Volume", account.company.monthlyShipmentVolume],
                [
                  "Requested Credit",
                  account.company.requestedCreditLimit.amount === null
                    ? "Not requested"
                    : `${account.company.requestedCreditLimit.currency} ${account.company.requestedCreditLimit.amount}`,
                ],
              ]}
            />

            <DetailSection
              title="Billing Address"
              rows={
                account.company.useCompanyAddressAsBillingAddress !== false
                  ? [["Billing Address", "Same as registered address"]]
                  : [
                      [
                        "Billing Address",
                        formatBillingAddress(account) || "Not provided",
                      ],
                    ]
              }
            />

            <DetailSection
              title="Account Summary"
              rows={[
                ["Created On", formatDashboardDate(account.createdAt)],
                [
                  "Submitted On",
                  account.submittedAt
                    ? formatDashboardDate(account.submittedAt)
                    : "Not submitted",
                ],
                [
                  "Assigned Branch",
                  formatAssignedBranch(account.assignedBranch),
                ],
                [
                  "Created By",
                  account.createdBy?.name || account.createdBy?.email || "-",
                ],
              ]}
            />
          </div>
        ) : null}

        {activeTab === "documents" ? (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-bold text-[#0D1282]">
              Documents
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {documentSummaryRows
                .filter((row) => row.required || account.documents?.[row.key])
                .map((row) => (
                  <DocumentSummary
                    key={row.key}
                    label={row.label}
                    value={account.documents?.[row.key]?.originalName}
                    required={row.required}
                    opening={documentOpening === row.key}
                    onView={
                      account.documents?.[row.key]
                        ? () => void handleViewDocument(row.key)
                        : undefined
                    }
                  />
                ))}
            </div>
          </section>
        ) : null}

        {activeTab === "kyc" ? (
          <KycReviewPanel
            account={account}
            saving={kycSaving}
            onStart={() => void handleStartKycReview()}
            onVerifyAll={() => void handleVerifyMandatoryChecks()}
            onReject={() => void handleRejectKyc()}
            onCheckChange={(key, status, note) =>
              void handleKycCheckChange(key, status, note)
            }
          />
        ) : null}

        {activeTab === "rate-card" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
            <RateCardWorkspace businessAccountId={account._id} cardName={companyName || account.accountId} />
          </div>
        ) : null}

        {activeTab === "access" ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <BusinessAccountAccessPanel account={account} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function getRequiredDocumentLabels(account: BusinessAccount) {
  const labels: string[] = [];
  if (!account.documents?.aadhaarCard) labels.push("Aadhaar Card");
  if (!account.documents?.panCard) labels.push("PAN Card Copy");

  return labels;
}

function getKycCheckRows(
  account: BusinessAccount,
): { key: BusinessKycCheckKey; label: string; helper: string }[] {
  const rows: { key: BusinessKycCheckKey; label: string; helper: string }[] = [
    {
      key: "contactDetails",
      label: "Contact Details",
      helper: "Name, email, mobile, department, and shipment type.",
    },
    {
      key: "companyDetails",
      label: "Company Details",
      helper:
        "Registration, address, operating countries, industry, and website.",
    },
    {
      key: "aadhaarCard",
      label: "Aadhaar Card",
      helper:
        account.documents?.aadhaarCard?.originalName ||
        "Required document missing.",
    },
    {
      key: "panCard",
      label: "PAN Card Copy",
      helper:
        account.documents?.panCard?.originalName ||
        "Required document missing.",
    },
  ];

  // Only accounts claiming exemption from GST registration carry this check, and
  // it must be cleared before the account can be approved or activated.
  if (account.company.gstExempt) {
    rows.splice(2, 0, {
      key: "gstExemption",
      label: "GST Exemption",
      helper:
        account.company.gstExemptReason ||
        "Claimed exempt from GST registration, no reason recorded.",
    });
  }

  for (const row of documentSummaryRows.filter((item) => !item.required)) {
    if (account.documents?.[row.key]) {
      rows.push({
        key: row.key,
        label: row.label,
        helper:
          account.documents[row.key]?.originalName ||
          "Uploaded optional document.",
      });
    }
  }

  return rows;
}

function KycReviewPanel({
  account,
  saving,
  onStart,
  onVerifyAll,
  onReject,
  onCheckChange,
}: {
  account: BusinessAccount;
  saving: boolean;
  onStart: () => void;
  onVerifyAll: () => void;
  onReject: () => void;
  onCheckChange: (
    key: BusinessKycCheckKey,
    status: BusinessKycCheckStatus,
    note?: string | null,
  ) => void;
}) {
  const overallStatus = account.kycReview?.overallStatus ?? "documents_pending";
  const missingDocuments = getRequiredDocumentLabels(account);
  const rows = getKycCheckRows(account);
  const additionalInfoReason = rows
    .map((row) => account.kycReview?.checks?.[row.key])
    .find(
      (check) =>
        normalizeKycCheckStatus(check?.status) === "information_required" &&
        check?.note,
    )?.note;
  const [infoRequest, setInfoRequest] = useState<{
    key: BusinessKycCheckKey;
    label: string;
  } | null>(null);
  const [infoReason, setInfoReason] = useState("");
  const [infoReasonError, setInfoReasonError] = useState("");

  function closeInfoRequest() {
    setInfoRequest(null);
    setInfoReason("");
    setInfoReasonError("");
  }

  const infoDialogRef = useDialog<HTMLDivElement>(
    Boolean(infoRequest),
    closeInfoRequest,
  );

  function handleSelectChange(
    row: { key: BusinessKycCheckKey; label: string },
    status: BusinessKycCheckStatus,
  ) {
    if (status === "information_required") {
      setInfoRequest(row);
      setInfoReason("");
      setInfoReasonError("");
      return;
    }

    onCheckChange(row.key, status, null);
  }

  function handleSubmitInfoReason() {
    if (!infoRequest) return;

    const reason = infoReason.trim();
    if (!reason) {
      setInfoReasonError("Reason is required.");
      return;
    }

    if (reason.length > 50) {
      setInfoReasonError("Reason must be 50 characters or less.");
      return;
    }

    onCheckChange(infoRequest.key, "information_required", reason);
    setInfoRequest(null);
    setInfoReason("");
    setInfoReasonError("");
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-[#0D1282]">KYC Review</h2>
          <p className="mt-1 text-sm text-slate-500">
            Review contact, company, and mandatory document checks before final
            verification.
          </p>
        </div>
        <div className="text-right">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold capitalize ${kycStatusStyles[overallStatus]}`}
          >
            {formatStatus(overallStatus)}
          </span>
          {overallStatus === "additional_information_required" &&
          additionalInfoReason ? (
            <p className="mt-1.5 max-w-xs text-xs font-medium text-[#8a7a00]">
              {additionalInfoReason}
            </p>
          ) : null}
        </div>
      </div>

      {missingDocuments.length ? (
        <div className="mt-4 rounded-xl border border-[#F0DE36]/50 bg-[#F0DE36]/15 px-4 py-3 text-sm font-medium text-[#8a7a00]">
          Missing required documents: {missingDocuments.join(", ")}
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-200 text-xs uppercase tracking-wide text-slate-700">
              <tr>
                <th className="px-4 py-3.5 font-semibold">Check</th>
                <th className="px-4 py-3.5 font-semibold">Review Status</th>
                <th className="px-4 py-3.5 font-semibold">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const value = normalizeKycCheckStatus(
                  account.kycReview?.checks?.[row.key]?.status,
                );

                return (
                  <tr
                    key={row.key}
                    className="transition-colors hover:bg-[#EEEDED]/40"
                  >
                    <td className="px-4 py-3.5 font-semibold text-slate-900">
                      {row.label}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="relative w-64">
                        <select
                          value={value}
                          onChange={(event) =>
                            handleSelectChange(
                              row,
                              event.target.value as BusinessKycCheckStatus,
                            )
                          }
                          disabled={saving}
                          className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-11 text-sm font-semibold text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15 disabled:opacity-60"
                        >
                          {kycCheckStatusOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <FiChevronDown
                          aria-hidden="true"
                          className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0D1282]"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-500">{row.helper}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onStart}
          disabled={saving}
          className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282] disabled:opacity-60"
        >
          Start Review
        </button>
        <button
          type="button"
          onClick={onVerifyAll}
          disabled={saving || Boolean(missingDocuments.length)}
          className="rounded-lg bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Verify Mandatory Checks
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={saving}
          className="rounded-lg bg-[#D71313] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#D71313]/20 transition hover:bg-[#b40f0f] disabled:opacity-60"
        >
          Reject KYC
        </button>
      </div>

      {infoRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1282]/30 px-4 backdrop-blur-sm">
          <div
            ref={infoDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Information required"
            tabIndex={-1}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl outline-none"
          >
            <h3 className="text-base font-bold text-[#0D1282]">
              Information Required
            </h3>
            <p className="mt-1 text-sm text-slate-500">{infoRequest.label}</p>
            <label className="mt-4 block text-sm font-semibold text-slate-700">
              Reason
              <input
                value={infoReason}
                maxLength={50}
                onChange={(event) => {
                  setInfoReason(event.target.value);
                  setInfoReasonError("");
                }}
                className="mt-2 block h-10 w-full rounded-lg border border-slate-200 bg-[#EEEDED]/50 px-3 text-sm outline-none transition focus:border-[#0D1282] focus:bg-white focus:ring-2 focus:ring-[#0D1282]/15"
              />
            </label>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-[#D71313]">
                {infoReasonError}
              </p>
              <p className="text-xs font-semibold text-slate-500">
                {infoReason.length}/50
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeInfoRequest}
                className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitInfoReason}
                className="rounded-lg bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63]"
              >
                Save Reason
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DetailSection({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-base font-bold text-[#0D1282]">{title}</h2>
      <dl className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-[#EEEDED]/40 px-3.5 py-3">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {label}
            </dt>
            <dd className="mt-1 break-words text-sm font-medium capitalize text-slate-800">
              {value || "\u2014"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function GstBillingReviewPanel({
  account,
  onUpdated
}: {
  account: BusinessAccount;
  onUpdated: (account: BusinessAccount) => void;
}) {
  const billing = account.gstBilling ?? {
    requestedTreatment: "GST_APPLICABLE" as const,
    status: "NOT_REQUIRED" as const,
    requestReason: "",
    decisionReason: "",
    version: 1
  };
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canDecide = billing.status === "PENDING";
  const canRevoke = billing.status === "APPROVED";

  async function review(decision: "APPROVE" | "REJECT" | "REVOKE") {
    if (reason.trim().length < 3) {
      setError("Enter at least 3 characters explaining this decision.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await updateBusinessAccountGstBillingReview(account.accountId, {
        decision,
        reason: reason.trim(),
        expectedVersion: billing.version
      });
      onUpdated(result.account);
      setReason("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update GST billing review.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#0D1282]">Shipment GST Billing</h2>
          <p className="mt-1 text-sm text-slate-600">
            This permission is separate from the customer&apos;s GST registration status.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
          {formatStatus(billing.status)}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-[#EEEDED]/40 px-3.5 py-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Requested treatment</dt>
          <dd className="mt-1 text-sm font-semibold text-slate-800">{billing.requestedTreatment === "NO_GST" ? "No GST" : "GST applicable"}</dd>
        </div>
        <div className="rounded-lg bg-[#EEEDED]/40 px-3.5 py-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Request reason</dt>
          <dd className="mt-1 text-sm font-medium text-slate-800">{billing.requestReason || "-"}</dd>
        </div>
        {billing.decisionReason ? (
          <div className="rounded-lg bg-[#EEEDED]/40 px-3.5 py-3 sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Latest decision reason</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{billing.decisionReason}</dd>
          </div>
        ) : null}
      </dl>
      {canDecide || canRevoke ? (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <label className="text-sm font-semibold text-slate-700" htmlFor="gst-review-reason">Decision reason</label>
          <textarea
            id="gst-review-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
          />
          {error ? <p className="mt-2 text-sm font-semibold text-[#D71313]">{error}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            {canDecide ? (
              <>
                <button type="button" disabled={saving} onClick={() => void review("APPROVE")} className="rounded-lg bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">Approve no GST</button>
                <button type="button" disabled={saving} onClick={() => void review("REJECT")} className="rounded-lg bg-[#D71313] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">Reject</button>
              </>
            ) : (
              <button type="button" disabled={saving} onClick={() => void review("REVOKE")} className="rounded-lg bg-[#D71313] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">Revoke no GST</button>
            )}
          </div>
        </div>
      ) : error ? <p className="mt-3 text-sm font-semibold text-[#D71313]">{error}</p> : null}
    </section>
  );
}

function DocumentSummary({
  label,
  value,
  required,
  helper,
  opening,
  onView,
}: {
  label: string;
  value?: string;
  required?: boolean;
  helper?: string;
  opening?: boolean;
  onView?: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 p-4 transition hover:border-[#0D1282]/30 hover:bg-[#EEEDED]/20">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#0D1282]/8 text-[#0D1282]">
          {value ? (
            <FiFileText aria-hidden="true" className="h-4 w-4" />
          ) : (
            <FiFile aria-hidden="true" className="h-4 w-4 text-slate-400" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {label}{" "}
            {required ? <span className="text-[#D71313]">*</span> : null}
          </p>
          <p className="mt-1 truncate text-sm text-slate-600">
            {value || "Not uploaded"}
          </p>
        </div>
      </div>
      {helper ? <p className="mt-2 text-xs text-slate-400">{helper}</p> : null}
      {onView ? (
        <button
          type="button"
          onClick={onView}
          disabled={opening}
          className="mt-4 self-start rounded-lg border border-[#0D1282] px-3 py-2 text-sm font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5 disabled:opacity-60"
        >
          {opening ? "Opening..." : "View Document"}
        </button>
      ) : null}
    </div>
  );
}
