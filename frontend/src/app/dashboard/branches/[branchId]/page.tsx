"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  FiChevronDown,
  FiEdit2,
  FiExternalLink,
  FiRefreshCw,
  FiSearch,
} from "react-icons/fi";

import { BiSolidEdit } from "react-icons/bi";
import { DashboardLoading } from "@/components/DashboardShell";
import BranchFinanceSection from "@/components/branches/BranchFinanceSection";
import { BranchFileModal, BranchImage } from "@/components/branches/BranchFileView";
import BranchUsersSection from "@/components/branches/BranchUsersSection";
import { AssignBranchModal } from "@/components/business-accounts/AssignBranchModal";
import {
  BusinessAccountsTable,
  getAssignedBranch,
} from "@/components/business-accounts/BusinessAccountsTable";
import TicketTable from "@/components/tickets/TicketTable";
import {
  Branch,
  branchDocumentUrl,
  branchImageUrl,
  BranchStatus,
  branchStatusTransitions,
  formatBranchLabel,
  getBranch,
  listBranches,
  updateBranchStatus,
} from "@/lib/branches";
import {
  assignBusinessAccountBranch,
  BusinessAccount,
  BusinessAccountOperationalAction,
  BusinessAccountStatus,
  listBusinessAccounts,
  submitBusinessAccount,
  updateBusinessAccountOperationalAction,
  updateBusinessAccountStatus,
} from "@/lib/businessAccounts";
import {
  CreditAccount,
  listAdminCreditAccounts,
} from "@/lib/creditAccounts";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { listShipments, type ShipmentListItem } from "@/lib/shipmentsList";
import {
  listSupportTickets,
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
  ticketStatusLabels,
  type SupportTicket,
} from "@/lib/supportTickets";
import { BRANCH_VIEW_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

type BranchTab =
  | "overview"
  | "businessAccounts"
  | "shipments"
  | "finance"
  | "users"
  | "tickets";

const branchTabs: Array<{ id: BranchTab; label: string; roles: string[] }> = [
  { id: "overview", label: "Overview", roles: ["admin", "operations", "finance"] },
  { id: "businessAccounts", label: "Business Accounts", roles: ["admin", "operations"] },
  { id: "shipments", label: "Shipments", roles: ["admin", "operations"] },
  { id: "users", label: "Users", roles: ["admin", "operations", "hr"] },
  { id: "tickets", label: "Tickets", roles: ["admin", "operations"] },
  { id: "finance", label: "Finance", roles: ["admin", "operations", "finance"] },
];

// Human labels for the branch lifecycle actions offered per status.
const branchStatusActionLabels: Record<BranchStatus, string> = {
  DRAFT: "Move to Draft",
  ACTIVE: "Activate",
  INACTIVE: "Deactivate",
  SUSPENDED: "Suspend",
  CLOSED: "Close",
};

function getBranchStatusBadgeClasses(status: BranchStatus) {
  switch (status) {
    case "ACTIVE":
      return "bg-[#0D1282] text-white";
    case "DRAFT":
      return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
    case "INACTIVE":
      return "bg-[#F0DE36]/25 text-[#8a7a00] ring-1 ring-[#F0DE36]/50";
    case "SUSPENDED":
    case "CLOSED":
      return "bg-[#D71313]/10 text-[#D71313] ring-1 ring-[#D71313]/20";
    default:
      return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
  }
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="rounded-lg bg-[#EEEDED]/40 px-3.5 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-medium text-slate-800">
        {value || "-"}
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  // A numeric zero is a real value, so only null/undefined/"" fall back to the dash.
  const display =
    value === null || value === undefined || value === "" ? "-" : value;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-lg font-bold text-[#0D1282]">{display}</p>
    </div>
  );
}

function formatValues(values: string[]) {
  return values.length ? values.map(formatBranchLabel).join(", ") : "";
}

type FilePreview = { fileUrl: string; fileName: string; title: string };

export default function BranchDetailPage() {
  const params = useParams<{ branchId: string }>();
  const router = useRouter();
  // Read-only for operations: the edit link and status control below are gated
  // on `canManage`, mirroring the admin-only writes on the branch router.
  const { user, loading } = useAdminUser(BRANCH_VIEW_AREA);
  const canManage = user?.role === "admin";
  const [branch, setBranch] = useState<Branch | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<BusinessAccount[]>([]);
  const [activeTab, setActiveTab] = useState<BranchTab>("overview");
  const [branchLoading, setBranchLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingAction, setUpdatingAction] = useState<string | null>(null);
  const [updatingBranchStatus, setUpdatingBranchStatus] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchSearch, setBranchSearch] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [assigningAccount, setAssigningAccount] =
    useState<BusinessAccount | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  // Credit facilities keyed by business account _id, so the linked-accounts table
  // can show available credit and outstanding alongside each account.
  const [creditByBusinessId, setCreditByBusinessId] = useState<
    Map<string, CreditAccount>
  >(new Map());

  useEffect(() => {
    if (!user || !params.branchId) return;

    let active = true;
    const role = user.role;

    async function loadBranchForRoute() {
      await Promise.resolve();
      if (!active) return;

      setBranchLoading(true);
      setError("");

      try {
        const canLoadAccounts = role === "admin" || role === "operations";
        const [branchData, accountsData] = await Promise.all([
          getBranch(params.branchId),
          canLoadAccounts
            ? listBusinessAccounts("", params.branchId)
            : Promise.resolve({ accounts: [] as BusinessAccount[] }),
        ]);

        if (!active) return;
        setBranch(branchData.branch);
        setLinkedAccounts(accountsData.accounts);
      } catch (caughtError) {
        if (!active) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load branch.",
        );
      } finally {
        if (active) setBranchLoading(false);
      }
    }

    void loadBranchForRoute();
    // Supporting detail for the table, so a failure leaves the credit columns
    // blank rather than breaking the branch page.
    if (role === "admin" || role === "operations") {
      void listAdminCreditAccounts()
        .then((data) => {
          if (active) {
            setCreditByBusinessId(
              new Map(
                data.creditAccounts.map((account) => [
                  account.businessAccountId,
                  account,
                ]),
              ),
            );
          }
        })
        .catch(() => {
          if (active) setCreditByBusinessId(new Map());
        });
    }

    return () => {
      active = false;
    };
  }, [params.branchId, user]);

  async function handleBranchStatusChange(nextStatus: BranchStatus) {
    if (!branch) return;

    setUpdatingBranchStatus(true);
    setError("");

    try {
      const data = await updateBranchStatus(branch._id, nextStatus);
      setBranch(data.branch);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to update branch status.",
      );
    } finally {
      setUpdatingBranchStatus(false);
    }
  }

  async function refreshAccount(
    accountId: string,
    updater: () => Promise<{ account: BusinessAccount }>,
  ) {
    setUpdatingAction(accountId);
    setError("");

    try {
      const data = await updater();
      const assignedBranch = getAssignedBranch(data.account);
      setLinkedAccounts((current) => {
        if (assignedBranch && assignedBranch._id !== params.branchId) {
          return current.filter((account) => account.accountId !== accountId);
        }

        return current.map((account) =>
          account.accountId === accountId ? data.account : account,
        );
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to update business account.",
      );
    } finally {
      setUpdatingAction(null);
    }
  }

  async function openAssignBranchModal(account: BusinessAccount) {
    const assignedBranch = getAssignedBranch(account);

    setAssigningAccount(account);
    setSelectedBranchId(assignedBranch?._id ?? "");
    setBranchSearch("");
    setBranchesLoading(true);
    setError("");

    try {
      const data = await listBranches("", "ACTIVE");
      setBranches(data.branches);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load branches.",
      );
    } finally {
      setBranchesLoading(false);
    }
  }

  function closeAssignBranchModal() {
    setAssigningAccount(null);
    setSelectedBranchId("");
    setBranchSearch("");
  }

  async function handleAssignBranch() {
    if (!assigningAccount || !selectedBranchId) return;

    await refreshAccount(assigningAccount.accountId, () =>
      assignBusinessAccountBranch(assigningAccount.accountId, selectedBranchId),
    );
    closeAssignBranchModal();
  }

  async function handleAccountMenuChange(
    account: BusinessAccount,
    value: string,
  ) {
    if (!value || value.startsWith("current:")) return;

    if (value === "view" || value === "kyc") {
      router.push(`/dashboard/business-accounts/${account.accountId}`);
      return;
    }

    if (value === "submit") {
      await refreshAccount(account.accountId, () =>
        submitBusinessAccount(account.accountId),
      );
      return;
    }

    if (value === "assign_branch") {
      await openAssignBranchModal(account);
      return;
    }

    if (value.startsWith("status:")) {
      await refreshAccount(account.accountId, () =>
        updateBusinessAccountStatus(
          account.accountId,
          value.replace("status:", "") as BusinessAccountStatus,
        ),
      );
      return;
    }

    if (value.startsWith("operation:")) {
      await refreshAccount(account.accountId, () =>
        updateBusinessAccountOperationalAction(
          account.accountId,
          value.replace("operation:", "") as BusinessAccountOperationalAction,
        ),
      );
    }
  }

  if (loading || !user) return <DashboardLoading />;

  const visibleTabs = branchTabs.filter((tab) => tab.roles.includes(user.role));
  const displayedTab = visibleTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? "overview";

  const filteredBranches = branches.filter((item) =>
    `${item.name} ${item.code} ${item.address.city} ${item.address.countryName}`
      .toLowerCase()
      .includes(branchSearch.toLowerCase()),
  );

  return (
      <div className="min-h-full bg-[#EEEDED]/60 -m-6 p-6 lg:-m-8 lg:p-8">
        {/* Branch header and lifecycle actions */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              {/* <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold text-slate-950">
                  {branch?.name ?? "Branch Details"}
                </h1>
                {branch ? (
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${getBranchStatusBadgeClasses(branch.status)}`}
                  >
                    {formatBranchLabel(branch.status)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm font-semibold text-[#0D1282]">
                {branch?.code ?? "Review branch profile and operating setup."}
              </p> */}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {canManage && branch && branchStatusTransitions[branch.status].length ? (
                <div className="relative w-44">
                  <select
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        void handleBranchStatusChange(
                          event.target.value as BranchStatus,
                        );
                    }}
                    disabled={updatingBranchStatus}
                    aria-label="Change branch status"
                    className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-semibold text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15 disabled:opacity-60"
                  >
                    <option value="">
                      {updatingBranchStatus ? "Updating..." : "Change Status"}
                    </option>
                    {branchStatusTransitions[branch.status].map(
                      (nextStatus) => (
                        <option key={nextStatus} value={nextStatus}>
                          {branchStatusActionLabels[nextStatus]}
                        </option>
                      ),
                    )}
                  </select>
                  <FiChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0D1282]"
                  />
                </div>
              ) : null}
              {canManage && branch ? (
                <Link
                  href={`/dashboard/branches/${branch._id}/edit`}
                  className="inline-flex items-center gap-2 rounded-4xl border border-slate-200 px-4 py-2.5 text-sm font-semibold shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63] hover:text-white"
                >
                  <BiSolidEdit  aria-hidden="true" className="h-4 w-4" /> Edit Branch
                </Link>
              ) : null}
            </div>
          </div>

          {/* Tab navigation */}
          {branch ? (
            <div className="mt-5 flex flex-wrap gap-1 border-t border-slate-200 pt-4">
              {visibleTabs.map((tab) => {
                const isActive = displayedTab === tab.id;

                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                      isActive
                        ? "bg-[#0D1282] text-white shadow-sm shadow-[#0D1282]/25"
                        : "text-slate-600 hover:bg-[#0D1282]/8 hover:text-[#0D1282]"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[#D71313]/25 bg-[#D71313]/5 px-4 py-3 text-sm font-medium text-[#D71313]">
            {error}
          </div>
        ) : null}

        <div className="mt-5">
          {branchLoading ? (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 shadow-sm">
              Loading branch...
            </div>
          ) : branch ? (
            <>
              {displayedTab === "overview" ? (
                <BranchOverview
                  branch={branch}
                  accountCount={user.role === "admin" || user.role === "operations" ? linkedAccounts.length : null}
                />
              ) : null}
              {displayedTab === "businessAccounts" ? (
                <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                    <div>
                      <h2 className="text-base font-bold text-[#0D1282]">
                        Business Accounts
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">
                        {linkedAccounts.length} linked to this branch.
                      </p>
                    </div>
                    <Link
                      href="/dashboard/business-accounts/create"
                      className="inline-flex items-center gap-2 rounded-4xl border border-slate-200  px-4 py-2.5 text-sm font-semibold shadow-sm shadow-[#0D1282]/20 transition "
                    >
                      <span className="text-base leading-none">+</span> Create
                      Business Account
                    </Link>
                  </div>
                  <BusinessAccountsTable
                    accounts={linkedAccounts}
                    updatingAccountId={updatingAction}
                    creditByBusinessId={creditByBusinessId}
                    onAccountMenuChange={handleAccountMenuChange}
                  />
                </section>
              ) : null}
              {displayedTab === "shipments" && branch ? (
                <BranchShipmentsSection branchId={branch._id} />
              ) : null}
              {displayedTab === "tickets" && branch ? (
                <BranchTicketsSection branchId={branch._id} />
              ) : null}
              {displayedTab === "users" && branch ? (
                <BranchUsersSection branchId={branch._id} viewerRole={user.role} />
              ) : null}
              {displayedTab === "finance" && branch ? (
                <BranchFinanceSection branchId={branch._id} />
              ) : null}
            </>
          ) : (
            <div className="rounded-xl border border-[#D71313]/25 bg-[#D71313]/5 p-5">
              <p className="text-sm font-semibold text-[#D71313]">
                Branch not found.
              </p>
            </div>
          )}
        </div>

        {assigningAccount ? (
          <AssignBranchModal
            account={assigningAccount}
            branches={filteredBranches}
            branchSearch={branchSearch}
            selectedBranchId={selectedBranchId}
            branchesLoading={branchesLoading}
            updating={updatingAction === assigningAccount.accountId}
            onSearchChange={setBranchSearch}
            onSelectBranch={setSelectedBranchId}
            onCancel={closeAssignBranchModal}
            onAssign={handleAssignBranch}
          />
        ) : null}
      </div>
  );
}

/* ── Shipments tab ─────────────────────────────────────────────── */
function BranchShipmentsSection({ branchId }: { branchId: string }) {
  const [shipments, setShipments] = useState<ShipmentListItem[]>([]);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listShipments("admin", { branchId, page, status });
      setShipments(data.shipments);
      setTotalPages(data.pagination.totalPages);
      setTotal(data.pagination.total);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load shipments.",
      );
    } finally {
      setLoading(false);
    }
  }, [branchId, page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-bold text-[#0D1282]">Shipments</h2>
          <p className="mt-1 text-sm text-slate-500">
            Booked shipments from this branch.
          </p>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
          </span>
          <div className="relative">
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className="h-9 w-44 appearance-none rounded-lg border border-slate-200 bg-white pl-2.5 pr-8 text-xs font-semibold text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            >
              <option value="">All Status</option>
              <option value="SHIPMENT_BOOKED">Shipment Booked</option>
              <option value="ON_HOLD">On Hold</option>
              <option value="PARCEL_COLLECTED">Shipment Collected</option>
              <option value="WAREHOUSE_SCAN_IN">Received at Origin Facility</option>
              <option value="ORIGIN_HUB_PROCESSED">Processed at Delhi Hub</option>
              <option value="READY_FOR_EXPORT">Ready for Dispatch</option>
              <option value="ORIGIN_HUB_DISPATCHED">Departed from Origin Facility</option>
              <option value="DESTINATION_ARRIVED">Destination Arrived</option>
              <option value="IMPORT_CUSTOMS_CLEARANCE">Customs Clearance in Progress</option>
              <option value="IMPORT_CUSTOMS_CLEARED">Customs Cleared</option>
              <option value="DELIVERY_PARTNER_TRANSFERRED">Transferred to Delivery Partner</option>
              <option value="DELIVERY_HUB_ARRIVED">Arrived at Delivery Hub</option>
              <option value="OUT_FOR_DELIVERY">Out For Delivery</option>
              <option value="DELIVERED">Delivered</option>
              <option value="RETURNED">Returned</option>
              <option value="SHIPMENT_CANCELLED">Cancelled</option>
            </select>
            <FiChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#0D1282]"
            />
          </div>
        </label>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">AWB / Shipment No.</th>
              <th className="px-4 py-3">Consignee</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Chargeable Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  Loading shipments...
                </td>
              </tr>
            ) : !shipments.length ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  No booked shipments found for this branch.
                </td>
              </tr>
            ) : (
              shipments.map((shipment) => (
                <tr
                  key={shipment.id}
                  className="border-b border-slate-100 last:border-b-0"
                >
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-950">
                      {shipment.swiftlineTrackingNumber || "AWB Pending"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {shipment.shipmentInvoice?.invoiceNumber
                        ? `Tax Invoice: ${shipment.shipmentInvoice.invoiceNumber}`
                        : "Tax Invoice Pending"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">
                      {shipment.consignee || "Not set"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {shipment.destination || "Not set"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">
                      {shipment.route}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {shipment.branch.name || shipment.branch.code}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">
                    {shipment.shipmentInvoice
                      ? new Intl.NumberFormat("en-IN", {
                          style: "currency",
                          currency: shipment.shipmentInvoice.currency,
                          minimumFractionDigits: 2,
                        }).format(
                          shipment.shipmentInvoice.chargeableAmountMinor / 100,
                        )
                      : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex py-1 text-xs font-semibold text-slate-700">
                      {shipment.statusLabel}
                    </span>
                    {shipment.manifest ? (
                      <p className="mt-1 text-xs font-semibold text-[#0D1282]">
                        Manifest {shipment.manifest.manifestNumber}
                      </p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {formatDashboardDateTime(shipment.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/shipments/${shipment.id}`}
                      className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                    >
                      <FiExternalLink aria-hidden="true" className="h-4 w-4" />
                      View Details
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
            className="h-8 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#0D1282] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-slate-600">
            Page {page} of {totalPages} · {total} total
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
            className="h-8 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#0D1282] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ── Tickets tab ───────────────────────────────────────────────── */
function BranchTicketsSection({ branchId }: { branchId: string }) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listSupportTickets("admin", {
        page,
        status,
        priority,
        category,
        search,
        branchId,
      });
      setTickets(result.tickets);
      setTotalPages(result.pagination.totalPages);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load tickets.",
      );
    } finally {
      setLoading(false);
    }
  }, [branchId, category, page, priority, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-bold text-[#0D1282]">Tickets</h2>
          <p className="mt-1 text-sm text-slate-500">
            Support tickets from business accounts linked to this branch.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          title="Refresh"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-[#0D1282]"
        >
          <FiRefreshCw
            aria-hidden="true"
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[1fr_160px_140px_180px]">
        <label className="relative">
          <span className="sr-only">Search tickets</span>
          <FiSearch className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Ticket number or subject"
            className="h-10 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-[#0D1282]"
          />
        </label>
   <div className="relative">
  <select
    value={status}
    onChange={(event) => {
      setStatus(event.target.value);
      setPage(1);
    }}
    className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm"
  >
    <option value="">All Status</option>
    {ticketStatuses.map((value) => (
      <option key={value} value={value}>
        {ticketStatusLabels[value]}
      </option>
    ))}
  </select>
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
</div>

<div className="relative">
  <select
    value={priority}
    onChange={(event) => {
      setPriority(event.target.value);
      setPage(1);
    }}
    className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm"
  >
    <option value="">All priorities</option>
    {ticketPriorities.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
</div>

<div className="relative">
  <select
    value={category}
    onChange={(event) => {
      setCategory(event.target.value);
      setPage(1);
    }}
    className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm"
  >
    <option value="">All categories</option>
    {ticketCategories.map((item) => (
      <option key={item.value} value={item.value}>
        {item.label}
      </option>
    ))}
  </select>
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
</div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <TicketTable tickets={tickets} audience="admin" loading={loading} />

      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
            className="h-8 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#0D1282] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-slate-600">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
            className="h-8 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#0D1282] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

function BranchOverview({
  branch,
  accountCount,
}: {
  branch: Branch;
  accountCount: number | null;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Status" value={formatBranchLabel(branch.status)} />
        <SummaryTile label="Base Currency" value={branch.baseCurrency} />
        <SummaryTile label="Linked Accounts" value={accountCount} />
        <SummaryTile
          label="Opening Date"
          value={
            branch.openingDate
              ? new Date(branch.openingDate).toLocaleDateString()
              : ""
          }
        />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-bold text-[#0D1282]">Branch Profile</h2>
        <p className="mt-1 text-sm text-slate-500">
          {branch.description || "No branch description added."}
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DetailRow label="Branch Name" value={branch.name} />
          <DetailRow label="Branch Code" value={branch.code} />
          <DetailRow label="Station Code" value={branch.labelCode} />
          <DetailRow
            label="Created By"
            value={branch.createdBy?.name || branch.createdBy?.email || ""}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-bold text-[#0D1282]">
            Address and Contact
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailRow
              label="Country"
              value={branch.address.countryName || branch.address.countryCode}
            />
            <DetailRow label="City" value={branch.address.city} />
            <DetailRow label="Postal Code" value={branch.address.postalCode} />
            <DetailRow
              label="State or Province"
              value={branch.address.stateOrProvince}
            />
            <DetailRow label="Email" value={branch.contact.email} />
            <DetailRow label="Phone" value={branch.contact.phone} />
            <div className="sm:col-span-2">
              <DetailRow label="Full Address" value={branch.address.address} />
            </div>
          </div>
          {branch.phoneNumbers?.length ? (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h3 className="mb-3 text-sm font-bold text-[#0D1282]">Additional Contacts</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {branch.phoneNumbers.map((phone, index) =>
                  phone.label || phone.number ? (
                    <DetailRow key={index} label={phone.label || `Phone ${index + 1}`} value={phone.number} />
                  ) : null
                )}
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-bold text-[#0D1282]">
            Operations and Tax
          </h2>
          <div className="grid gap-4">
            <DetailRow
              label="Supported Services"
              value={formatValues(branch.operations.supportedServices)}
            />
            <DetailRow
              label="Shipment Coverage"
              value={formatValues(branch.operations.shipmentCoverage)}
            />
            <DetailRow
              label="Operating Countries"
              value={branch.operations.operatingCountries.join(", ")}
            />
            <DetailRow
              label="Working Days"
              value={formatValues(branch.operations.workingDays)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailRow label="GSTIN" value={branch.gstin} />
              <DetailRow
                label="Invoice SAC Code"
                value={branch.invoiceSacCode}
              />
            </div>
          </div>
        </section>
      </div>

      {branch.images?.length ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-bold text-[#0D1282]">Branch Images</h2>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {branch.images.map((image, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setPreview({
                  fileUrl: branchImageUrl(branch._id, index),
                  fileName: image.fileName || `branch-image-${index + 1}`,
                  title: `Branch image ${index + 1}`
                })}
                aria-label={`View branch image ${index + 1}`}
                className="group overflow-hidden rounded-lg border border-slate-200 bg-[#EEEDED]/40 text-left transition hover:border-[#0D1282]/40 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20"
              >
                <BranchImage
                  fileUrl={branchImageUrl(branch._id, index)}
                  alt={`Branch image ${index + 1}`}
                  className="h-32 w-full object-cover"
                />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {branch.documents?.length ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-bold text-[#0D1282]">Branch Documents</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {branch.documents.map((doc, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setPreview({
                  fileUrl: branchDocumentUrl(branch._id, index),
                  fileName: doc.fileName,
                  title: doc.title || doc.type
                })}
                aria-label={`View document ${doc.title || doc.type}`}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-[#EEEDED]/40 px-4 py-3 text-left transition hover:border-[#0D1282]/40 hover:bg-[#EEEDED]/70 focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#0D1282]">
                    {doc.title || doc.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{doc.fileName}</p>
                </div>
                <span className="inline-flex shrink-0 items-center rounded-full bg-[#0D1282]/8 px-2.5 py-0.5 text-xs font-semibold text-[#0D1282]">{doc.type}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {preview ? (
        <BranchFileModal
          key={preview.fileUrl}
          fileUrl={preview.fileUrl}
          fileName={preview.fileName}
          title={preview.title}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
