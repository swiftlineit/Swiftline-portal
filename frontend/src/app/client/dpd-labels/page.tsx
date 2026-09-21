"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FiChevronLeft,
  FiChevronRight,
  FiEdit3,
  FiExternalLink,
  FiFileText,
  FiTrash2,
  FiInfo,
} from "react-icons/fi";
import { toast } from "react-toastify";
import {
  ClientDashboardLoading,
  ClientShellUser,
} from "@/components/client/ClientDashboardShell";
import ShipmentImportPanel from "@/components/shipments/ShipmentImportPanel";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, refreshAccessToken } from "@/lib/auth";
import {
  ClientDashboardAccount,
  ClientShipmentListItem,
  createClientManualShipmentDraft,
  getClientDashboard,
  getClientShipments,
} from "@/lib/clientDashboard";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { shipmentInvoicePageUrl } from "@/lib/shipmentInvoices";
import {
  useBulkDeleteShipmentDrafts,
  useDeleteShipmentDraft,
} from "@/lib/useDeleteShipmentDraft";
import { RiMenuAddLine } from "react-icons/ri";
import BookingPausedNotice from "@/components/booking/BookingPausedNotice";

async function loadCurrentUser() {
  let token = getAccessToken() ?? (await refreshAccessToken());
  if (!token) return null;

  let response = await fetch(apiUrl("/api/v1/auth/me"), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) return null;

    response = await fetch(apiUrl("/api/v1/auth/me"), {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  const data = await response.json();
  return data.success ? (data.user as ClientShellUser) : null;
}

function getAvailableBranches(account: ClientDashboardAccount) {
  if (account.assignedBranches.length) return account.assignedBranches;
  return account.account.assignedBranch ? [account.account.assignedBranch] : [];
}

function getAccountKey(account: ClientDashboardAccount) {
  return account.account.id || account.account.accountId;
}

export default function ClientDpdLabelsPage() {
  const router = useRouter();
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creatingManual, setCreatingManual] = useState(false);
  const [error, setError] = useState("");
  const [shipments, setShipments] = useState<ClientShipmentListItem[]>([]);
  const [shipmentPage, setShipmentPage] = useState(1);
  const [shipmentRefreshKey, setShipmentRefreshKey] = useState(0);
  const [shipmentsLoading, setShipmentsLoading] = useState(true);
  const [shipmentError, setShipmentError] = useState("");
  const [shipmentPagination, setShipmentPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
  });
  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);

  const selectedAccount = useMemo(
    () =>
      accounts.find((item) => getAccountKey(item) === accountId) ??
      accounts[0] ??
      null,
    [accountId, accounts],
  );
  const branches = useMemo(
    () => (selectedAccount ? getAvailableBranches(selectedAccount) : []),
    [selectedAccount],
  );
  const selectedBranch =
    branches.find((branch) => branch._id === branchId) ?? branches[0] ?? null;
  const rateCardAssigned = Boolean(selectedAccount?.account.rateCard.assigned);
  const canCreateManual = Boolean(
    rateCardAssigned && selectedBranch && !creatingManual,
  );
  const selectedAccountDocumentId = selectedAccount?.account.id ?? "";
  const selectedBranchId = selectedBranch?._id ?? "";

  useEffect(() => {
    let mounted = true;

    async function loadPage() {
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
        if (!mounted) return;

        setUser(currentUser);
        setAccounts(dashboard.accounts);

        const firstAccount = dashboard.accounts[0];
        if (firstAccount) {
          const firstBranch = getAvailableBranches(firstAccount)[0];
          setAccountId(getAccountKey(firstAccount));
          setBranchId(firstBranch?._id ?? "");
        }
      } catch (caughtError) {
        if (!mounted) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load shipment workspace.",
        );
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadPage();
    return () => {
      mounted = false;
    };
  }, [router]);

  useEffect(() => {
    if (!selectedAccountDocumentId || !selectedBranchId) return;

    let mounted = true;

    getClientShipments({
      businessAccountId: selectedAccountDocumentId,
      branchId: selectedBranchId,
      page: shipmentPage,
      limit: 10,
    })
      .then((result) => {
        if (!mounted) return;
        setShipments(result.shipments);
        setSelectedDraftIds([]);
        setShipmentPagination(result.pagination);
        setShipmentError("");
        if (result.pagination.page !== shipmentPage)
          setShipmentPage(result.pagination.page);
      })
      .catch((caughtError) => {
        if (!mounted) return;
        setShipments([]);
        setShipmentError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load shipments.",
        );
      })
      .finally(() => {
        if (mounted) setShipmentsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [
    selectedAccountDocumentId,
    selectedBranchId,
    shipmentPage,
    shipmentRefreshKey,
  ]);

  async function handleManualDraft() {
    if (!rateCardAssigned || !selectedBranchId) return;

    setCreatingManual(true);
    setError("");

    try {
      const result = await createClientManualShipmentDraft(selectedBranchId);
      toast.success("Blank shipment draft created.");
      router.push(`/client/dpd-labels/${result.shipmentDraft._id}`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to start a blank shipment draft. Please try again.",
      );
      setCreatingManual(false);
    }
  }

  function handleShipmentPageChange(page: number) {
    setShipmentsLoading(true);
    setShipmentError("");
    setSelectedDraftIds([]);
    setShipmentPage(page);
  }

  const { requestDelete: requestDraftDelete, dialog: deleteDraftDialog } =
    useDeleteShipmentDraft({
      actor: "client",
      onChanged: () => setShipmentRefreshKey((key) => key + 1),
    });
  const {
    requestBulkDelete,
    dialog: bulkDeleteDraftDialog,
    deleting: bulkDeleting,
  } = useBulkDeleteShipmentDrafts({
    actor: "client",
    onChanged: () => {
      setSelectedDraftIds([]);
      setShipmentRefreshKey((key) => key + 1);
    },
  });

  if (loading || !user) return <ClientDashboardLoading />;

  return (
    <div className="mx-auto max-w-8xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl  text-[#0D1282]">
            {" "}
            {/* <RiMenuAddLine className="inline-block mb-1 mr-1 text-lg" /> */}
            Create & Manage Shipment{" "}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Create a shipment manually or import workbooks to prefill editable
            drafts.
          </p>
        </div>
      </div>

      {error ? (
        <div className="mt-5 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {selectedAccount && !rateCardAssigned ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <FiInfo aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">
              Shipment booking is paused for your account.
            </p>
            <p className="mt-1">
              A rate card has not been assigned yet. Please contact Swiftline
              support.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="border border-slate-200 bg-white rounded-2xl">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase text-slate-500">
              Account Context
            </h2>
          </div>
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <ReadOnlyDetail
              label="Business Account"
              value={selectedAccount?.account.company.companyName}
            />
            <ReadOnlyDetail
              label="Sender Branch"
              value={selectedBranch?.name}
            />
          </div>
          <div className="px-5 pb-5">
            <BookingPausedNotice variant="client" />
          </div>
        </section>

        <aside className="space-y-5">
          <ShipmentImportPanel
            audience="client"
            branchId={selectedBranchId}
            disabled={!rateCardAssigned || !selectedBranchId || creatingManual}
            onDraftsCreated={() => {
              setShipmentPage(1);
              setShipmentsLoading(true);
              setShipmentRefreshKey((current) => current + 1);
            }}
          />
          <section className="border border-slate-200 bg-white p-5 rounded-2xl">
            <h2 className="text-center text-sm font-semibold uppercase text-slate-500">
              Manual Shipment
            </h2>
            <button
              type="button"
              onClick={handleManualDraft}
              disabled={!canCreateManual}
              className="mt-4 inline-flex h-10 w-full items-center rounded-xl justify-center gap-2 border border-blue-900 bg-white px-4 text-sm font-semibold text-blue-900 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              <FiEdit3 aria-hidden="true" className="h-4 w-4" />
              {creatingManual ? "Starting Draft..." : "Create Manually"}
            </button>
          </section>
        </aside>
      </div>

      <ClientShipmentTable
        shipments={shipments}
        loading={shipmentsLoading}
        error={shipmentError}
        pagination={shipmentPagination}
        onPageChange={handleShipmentPageChange}
        onDeleteDraft={requestDraftDelete}
        selectedDraftIds={selectedDraftIds}
        onSelectedDraftIdsChange={setSelectedDraftIds}
        onBulkDelete={requestBulkDelete}
        bulkDeleting={bulkDeleting}
      />

      {deleteDraftDialog}
      {bulkDeleteDraftDialog}
    </div>
  );
}

function ClientShipmentTable({
  shipments,
  loading,
  error,
  pagination,
  onPageChange,
  onDeleteDraft,
  selectedDraftIds,
  onSelectedDraftIdsChange,
  onBulkDelete,
  bulkDeleting,
}: {
  shipments: ClientShipmentListItem[];
  loading: boolean;
  error: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  onPageChange: (page: number) => void;
  onDeleteDraft: (draft: { id: string; label: string }) => void;
  selectedDraftIds: string[];
  onSelectedDraftIdsChange: (ids: string[]) => void;
  onBulkDelete: (drafts: Array<{ id: string; label: string }>) => void;
  bulkDeleting: boolean;
}) {
  const firstItem = pagination.total
    ? (pagination.page - 1) * pagination.limit + 1
    : 0;
  const lastItem = Math.min(
    pagination.page * pagination.limit,
    pagination.total,
  );
  const selectableDrafts = shipments.filter((shipment) => shipment.canDelete);
  const selectedIdSet = new Set(selectedDraftIds);
  const allVisibleDraftsSelected =
    selectableDrafts.length > 0 &&
    selectableDrafts.every((shipment) => selectedIdSet.has(shipment.id));

  return (
    <section className="mt-6 border border-slate-200 bg-white rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Your Shipment Drafts
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Unbooked drafts for the selected account and branch. Booked
            shipments live under{" "}
            <Link
              href="/client/shipments"
              className="font-semibold text-blue-900 hover:text-blue-700"
            >
              Shipments
            </Link>
            .
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedDraftIds.length ? (
            <button
              type="button"
              disabled={bulkDeleting}
              onClick={() =>
                onBulkDelete(
                  selectableDrafts
                    .filter((shipment) => selectedIdSet.has(shipment.id))
                    .map((shipment) => ({
                      id: shipment.id,
                      label: formatCapitalized(
                        shipment.destination.companyName ||
                          shipment.destination.contactName ||
                          "This draft",
                      ),
                    })),
                )
              }
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-600 disabled:opacity-50"
            >
              <FiTrash2 aria-hidden="true" /> Delete selected (
              {selectedDraftIds.length})
            </button>
          ) : null}
          <p className="text-sm font-semibold text-slate-600">
            {pagination.total} drafts
          </p>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto"  >
        <table id="drafts"  className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="w-12 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleDraftsSelected}
                  disabled={!selectableDrafts.length}
                  onChange={(event) =>
                    onSelectedDraftIdsChange(
                      event.target.checked
                        ? selectableDrafts.map((shipment) => shipment.id)
                        : [],
                    )
                  }
                  aria-label="Select all deletable drafts on this page"
                  className="h-4 w-4 accent-[#0D1282] disabled:opacity-40"
                />
              </th>
              <th className="px-4 py-3">AWB / Shipment No.</th>
              <th className="px-4 py-3">Consignee</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Chargeable Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center font-medium text-slate-500"
                >
                  Loading drafts...
                </td>
              </tr>
            ) : shipments.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  No drafts have been created for this branch.
                </td>
              </tr>
            ) : (
              shipments.map((shipment) => {
                const consignee =
                  shipment.destination.companyName ||
                  shipment.destination.contactName ||
                  "Not Available";
                const destination =
                  shipment.destination.townOrCity ||
                  shipment.destination.postcode ||
                  "Destination Not Set";
                const origin =
                  shipment.branch.city ||
                  shipment.branch.name ||
                  shipment.branch.code ||
                  "Origin Not Set";
                const hasInvoice = Boolean(shipment.shipmentInvoice);
                const viewHref = hasInvoice
                  ? `/client/shipments/${shipment.id}`
                  : `/client/dpd-labels/${shipment.id}`;
                // An unbooked draft is still being worked on, so it reads as
                // "continue" rather than "view" and is the only row that can be deleted.
                const isDraft = shipment.canDelete;

                return (
                  <tr
                    key={shipment.id}
                    className="border-b border-slate-100 text-slate-700 last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      {isDraft ? (
                        <input
                          type="checkbox"
                          checked={selectedIdSet.has(shipment.id)}
                          onChange={(event) =>
                            onSelectedDraftIdsChange(
                              event.target.checked
                                ? [
                                    ...new Set([
                                      ...selectedDraftIds,
                                      shipment.id,
                                    ]),
                                  ]
                                : selectedDraftIds.filter(
                                    (id) => id !== shipment.id,
                                  ),
                            )
                          }
                          aria-label={`Select draft for ${formatCapitalized(consignee) || "this consignee"}`}
                          className="h-4 w-4 accent-[#0D1282]"
                        />
                      ) : null}
                    </td>
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
                      <p className="font-medium text-slate-900">
                        {formatCapitalized(consignee)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatCapitalized(
                          shipment.destination.postcode ||
                            shipment.destination.countryName ||
                            shipment.destination.countryCode,
                        ) || "Not Available"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {formatCapitalized(origin)} to{" "}
                        {formatCapitalized(destination)}
                      </p>
                      {/* <p className="mt-1 text-xs text-slate-500">{formatCapitalized(shipment.branch.name || shipment.branch.code) || "Assigned Branch"}</p> */}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">
                      {shipment.shipmentInvoice
                        ? formatMinorMoney(
                            shipment.shipmentInvoice.chargeableAmountMinor,
                            shipment.shipmentInvoice.currency,
                          )
                        : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex bg-white text-xs font-semibold text-slate-700">
                        {formatCapitalized(
                          shipment.statusLabel || shipment.status,
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-medium text-slate-500">
                      {formatDashboardDateTime(shipment.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-44 items-center justify-end gap-2">
                        <Link
                          href={viewHref}
                          className="inline-flex text-left items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                        >
                          {isDraft ? (
                            <>
                              <FiEdit3 aria-hidden="true" className="h-4 w-4" />
                              Continue Draft
                            </>
                          ) : (
                            <>
                              <FiExternalLink
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                              View Shipment
                            </>
                          )}
                        </Link>
                        {isDraft ? (
                          <button
                            type="button"
                            title="Delete draft"
                            aria-label="Delete draft"
                            onClick={() =>
                              onDeleteDraft({
                                id: shipment.id,
                                label:
                                  formatCapitalized(consignee) || "This draft",
                              })
                            }
                            className="inline-flex rounded h-8 w-8 items-center justify-center border border-slate-200 text-slate-700 transition hover:border-red-600 hover:text-red-600"
                          >
                            <FiTrash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        ) : null}
                        {shipment.shipmentInvoice ? (
                          <>
                            <Link
                              href={shipmentInvoicePageUrl(
                                shipment.id,
                                "client",
                              )}
                              title="View invoice"
                              aria-label="View invoice"
                              className="inline-flex rounded h-8 w-8 items-center justify-center border border-slate-200 text-slate-700 hover:border-blue-900 hover:text-blue-900"
                            >
                              <FiFileText
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </Link>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 text-sm text-slate-600">
          <p>
            Showing {firstItem}-{lastItem} of {pagination.total} shipments
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Previous page"
              aria-label="Previous page"
              disabled={pagination.page === 1 || loading}
              onClick={() => onPageChange(pagination.page - 1)}
              className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FiChevronLeft aria-hidden="true" className="h-4 w-4" />
            </button>
            <span className="min-w-24 text-center font-semibold text-slate-700">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              type="button"
              title="Next page"
              aria-label="Next page"
              disabled={pagination.page === pagination.totalPages || loading}
              onClick={() => onPageChange(pagination.page + 1)}
              className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FiChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatCapitalized(value?: string | null) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMinorMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function ReadOnlyDetail({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  return (
    <div>
      <span className="text-xs font-semibold uppercase text-slate-500">
        {label}
      </span>
      <p className="mt-1 text-sm font-semibold text-slate-950">
        {value || "Not available"}
      </p>
    </div>
  );
}