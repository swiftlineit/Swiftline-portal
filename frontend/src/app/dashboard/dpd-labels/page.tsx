"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  FiArrowDown,
  FiDownload,
  FiExternalLink,
  FiFileText,
  FiPrinter,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import ShipmentDraftsPanel from "@/components/shipments/ShipmentDraftsPanel";
import ShipmentImportPanel from "@/components/shipments/ShipmentImportPanel";
import { BusinessAccount, listBusinessAccounts } from "@/lib/businessAccounts";
import {
  createIndividualShipmentDraft,
  type IndividualCustomerDetails,
} from "@/lib/dpdLabels";
import { Branch, listBranches } from "@/lib/branches";
import {
  DpdShipmentHistoryItem,
  ShipmentHoldReason,
  ShipmentOperationalStatus,
  createManualShipmentDraft,
  downloadDpdLabel,
  findMissingStatusPrerequisites,
  firstAllowedOperationalStatus,
  hasRecordedOperationalStatus,
  holdDpdShipment,
  listDpdShipments,
  releaseDpdShipment,
  shipmentHoldReasonOptions,
  shipmentOperationalStatusOptions,
  updateDpdShipmentOperationalStatus,
} from "@/lib/dpdLabels";
import { currentDateTimeLocal, dateTimeLocalToIso, formatDashboardDateTime } from "@/lib/dateFormat";
import {
  downloadShipmentInvoicePdf,
  shipmentInvoicePageUrl,
} from "@/lib/shipmentInvoices";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { RiMenuAddLine } from "react-icons/ri";
import BookingPausedNotice from "@/components/booking/BookingPausedNotice";

function FieldLabel({
  children,
  required = false,
}: {
  children: string;
  required?: boolean;
}) {
  return (
    <span className="text-xs font-semibold uppercase text-slate-500">
      {children}
      {required ? <span className="ml-1 text-red-600">*</span> : null}
    </span>
  );
}

function getAccountLabel(account: BusinessAccount) {
  return `${account.accountId} - ${account.company.companyName || account.contact.email}`;
}

function formatCapitalized(value?: string | null) {
  const cleaned = value?.trim();
  if (!cleaned) return "";

  return cleaned
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function getBranchLocation(item: DpdShipmentHistoryItem) {
  return (
    formatCapitalized(
      item.branch?.city || item.branch?.name || item.branch?.code,
    ) || "Origin Not Set"
  );
}

function getRouteLabel(item: DpdShipmentHistoryItem) {
  const origin = getBranchLocation(item);
  const destination =
    formatCapitalized(
      item.shipmentDraft?.consigneeTownOrCity ||
        item.shipmentDraft?.deliveryPostcode,
    ) || "Destination Not Set";
  return `${origin} to ${destination}`;
}

export default function DpdLabelsPage() {
  const router = useRouter();
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [accounts, setAccounts] = useState<BusinessAccount[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [branchId, setBranchId] = useState("");
  // A walk-in has no account to pick, so their details are captured here instead
  // and the branch is chosen directly rather than derived from an account.
  const [customerType, setCustomerType] = useState<"BUSINESS" | "INDIVIDUAL">(
    "BUSINESS",
  );
  const [customer, setCustomer] = useState<IndividualCustomerDetails>({
    contactName: "",
  });
  const [history, setHistory] = useState<DpdShipmentHistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);
  const [error, setError] = useState("");
  const [shipmentAction, setShipmentAction] = useState<{
    mode: "hold" | "release" | "status";
    shipment: DpdShipmentHistoryItem;
  } | null>(null);
  const [holdReason, setHoldReason] =
    useState<ShipmentHoldReason>("missing_documents");
  const [nextStatus, setNextStatus] =
    useState<ShipmentOperationalStatus>("PARCEL_COLLECTED");
  const [actionNote, setActionNote] = useState("");
  /**
   * When this scan actually happened, as a datetime-local value. Optional-
   * empty stamps the event with the moment it is saved, exactly as before.
   */
  const [actionAt, setActionAt] = useState("");

  /**
   * Every status the shipment in the action row has recorded, which decides how
   * far up the ladder it may go next- the same rule as the detail page. See
   * findMissingStatusPrerequisites.
   */
  const recordedStatuses = useMemo(
    () => shipmentAction?.mode === "status"
      ? (shipmentAction.shipment.events ?? []).map((event) => event.status)
      : [],
    [shipmentAction],
  );
  const statusChoices = useMemo(
    () => shipmentOperationalStatusOptions.map((option) => ({
      ...option,
      completed: hasRecordedOperationalStatus(option.value, recordedStatuses),
      missing: findMissingStatusPrerequisites(option.value, recordedStatuses),
    })),
    [recordedStatuses],
  );
  const blockedStatus = statusChoices.find(
    (option) => option.value === nextStatus,
  );

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.status === "active"),
    [accounts],
  );

  const selectedAccount = useMemo(
    () =>
      activeAccounts.find(
        (account) => account.accountId === businessAccountId,
      ) ?? null,
    [activeAccounts, businessAccountId],
  );

  const selectedAssignedBranch = useMemo(() => {
    if (!selectedAccount?.assignedBranch) return null;

    if (typeof selectedAccount.assignedBranch === "string") {
      return (
        branches.find(
          (branch) =>
            branch._id === selectedAccount.assignedBranch ||
            branch.code === selectedAccount.assignedBranch,
        ) ?? null
      );
    }

    const assignedBranch = selectedAccount.assignedBranch;
    return (
      branches.find(
        (branch) =>
          branch._id === assignedBranch._id ||
          branch.code === assignedBranch.code,
      ) ?? null
    );
  }, [branches, selectedAccount]);

  const branchOptions = useMemo(() => {
    // A business shipment must go through the branch its account is assigned to.
    // A walk-in belongs to no account, so any active branch may take the booking.
    if (customerType === "INDIVIDUAL") return branches;
    if (!selectedAssignedBranch) return [];
    return branches.filter(
      (branch) =>
        branch._id === selectedAssignedBranch._id ||
        branch.code === selectedAssignedBranch.code,
    );
  }, [branches, customerType, selectedAssignedBranch]);

  const canCreateManual = Boolean(
    businessAccountId && branchId && !busy && !creatingManual,
  );
  const canCreateIndividual = Boolean(
    branchId && customer.contactName.trim() && !busy && !creatingManual,
  );

  useEffect(() => {
    if (!user) return;

    async function loadOptions() {
      setError("");

      try {
        const [accountData, branchData, shipmentData] = await Promise.all([
          listBusinessAccounts(),
          listBranches("", "ACTIVE"),
          listDpdShipments(10),
        ]);

        setAccounts(accountData.accounts);
        setBranches(branchData.branches);
        setHistory(shipmentData.shipments);
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load upload options.",
        );
      }
    }

    void loadOptions();
  }, [user]);

  function handleBusinessAccountChange(nextAccountId: string) {
    setBusinessAccountId(nextAccountId);

    const account = activeAccounts.find((item) => item.accountId === nextAccountId);
    if (!account?.assignedBranch) {
      setBranchId("");
      return;
    }

    const assigned = account.assignedBranch;
    const assignedBranch = typeof assigned === "string"
      ? branches.find((branch) => branch._id === assigned || branch.code === assigned)
      : branches.find((branch) => (
          branch._id === assigned._id || branch.code === assigned.code
        ));
    setBranchId(assignedBranch?.code ?? "");
  }

  async function handleManualDraft() {
    if (!businessAccountId || !branchId) return;

    setCreatingManual(true);
    setError("");

    try {
      const result = await createManualShipmentDraft({
        businessAccountId,
        branchId,
      });
      toast.success("Blank shipment draft created.");
      router.push(`/dashboard/dpd-labels/${result.shipmentDraft._id}`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to start a blank shipment draft. Please try again.",
      );
      setCreatingManual(false);
    }
  }

  async function handleIndividualDraft() {
    if (!canCreateIndividual) return;

    setCreatingManual(true);
    setError("");

    try {
      const result = await createIndividualShipmentDraft({
        branchId,
        customer,
      });
      toast.success("Individual shipment draft created.");
      router.push(`/dashboard/dpd-labels/${result.shipmentDraft._id}`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to start an individual shipment draft. Please try again.",
      );
      setCreatingManual(false);
    }
  }

  async function handleLabelDownload(
    dpdShipmentId: string,
    labelId: string,
    parcelNumber?: string,
    format = "PDF",
  ) {
    setBusy(true);
    setError("");

    try {
      const blob = await downloadDpdLabel(dpdShipmentId, labelId);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dpd-label-${parcelNumber || dpdShipmentId}.${format.toLowerCase()}`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to download shipment label.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleInvoiceDownload(item: DpdShipmentHistoryItem) {
    if (!item.shipmentDraft) return;
    setBusy(true);
    setError("");
    try {
      await downloadShipmentInvoicePdf(
        item.shipmentDraft.id,
        "admin",
        item.shipmentInvoice?.invoiceNumber,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to download shipment invoice.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshHistory() {
    const shipmentData = await listDpdShipments(10);
    setHistory(shipmentData.shipments);
  }

  async function handleShipmentAction() {
    if (!shipmentAction) return;
    if (shipmentAction.mode !== "status" && actionNote.trim().length < 3)
      return;

    setBusy(true);
    setError("");

    try {
      if (shipmentAction.mode === "hold") {
        await holdDpdShipment({
          dpdShipmentId: shipmentAction.shipment.dpdShipment.id,
          reason: holdReason,
          note: actionNote,
        });
      } else if (shipmentAction.mode === "release") {
        await releaseDpdShipment({
          dpdShipmentId: shipmentAction.shipment.dpdShipment.id,
          note: actionNote,
        });
      } else {
        await updateDpdShipmentOperationalStatus({
          dpdShipmentId: shipmentAction.shipment.dpdShipment.id,
          status: nextStatus,
          note: actionNote,
          eventAt: dateTimeLocalToIso(actionAt),
        });
      }

      setShipmentAction(null);
      setActionNote("");
      setActionAt("");
      await refreshHistory();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Shipment action failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl  text-[#0D1282]">
            {" "}
            {/* <RiMenuAddLine className="inline-block mb-1 mr-1 text-lg" /> */}
            Create & Manage Shipment{" "}
          </h1>

          <p className="mt-1 text-sm text-slate-500">
            Import shipment data or create manually by selecting a business account
            first.
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-4 border border-red-200 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="border border-slate-200 bg-white rounded-2xl">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase text-slate-500">
              Account Context
            </h2>
          </div>

          <div className="flex gap-2 border-b border-slate-200 px-5 py-4">
            {(
              [
                { value: "BUSINESS", label: "Business Account" },
                { value: "INDIVIDUAL", label: "Individual Customer" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setCustomerType(option.value);
                  setError("");
                  setBranchId("");
                  setBusinessAccountId("");
                }}
                className={`h-9 rounded-4xl border px-4 text-sm font-semibold transition ${
                  customerType === option.value
                    ? "border-blue-900 bg-blue-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 p-5 md:grid-cols-2">
            {customerType === "BUSINESS" ? (
              <label className="block">
                <FieldLabel required>Business Account</FieldLabel>
                <div className="relative mt-2">
                  <select
                    value={businessAccountId}
                    onChange={(event) => handleBusinessAccountChange(event.target.value)}
                    className="h-10 w-full appearance-none border rounded-xl border-slate-300 bg-white px-3 pr-11 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="">Select account</option>
                    {activeAccounts.map((account) => (
                      <option key={account._id} value={account.accountId}>
                        {getAccountLabel(account)}
                      </option>
                    ))}
                  </select>
                  <FiArrowDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                  />
                </div>
              </label>
            ) : (
              // Only the name is taken here; the rest of the customer's details
              // are filled in on the draft form itself.
              <label className="block">
                <FieldLabel required>Customer Name</FieldLabel>
                <input
                  value={customer.contactName}
                  onChange={(event) =>
                    setCustomer({ contactName: event.target.value })
                  }
                  placeholder="Full name as on ID"
                  className="mt-2 h-10 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                />
              </label>
            )}

            <label className="block">
              <FieldLabel required>Branch</FieldLabel>
              <div className="relative mt-2">
                <select
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  disabled={customerType === "BUSINESS" && !businessAccountId}
                  className="h-10 w-full appearance-none border border-slate-300 rounded-xl bg-white px-3 pr-11 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100"
                >
                  <option value="">
                    {customerType === "INDIVIDUAL" || businessAccountId
                      ? "Select branch"
                      : "Choose account first"}
                  </option>
                  {branchOptions.map((branch) => (
                    <option key={branch._id} value={branch.code}>
                      {branch.code} - {branch.name}
                    </option>
                  ))}
                </select>
                <FiArrowDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                />
              </div>
            </label>
          </div>
          <div className="px-5 pb-5">
            <BookingPausedNotice variant="staff" />
          </div>
        </section>

        <aside className="space-y-5">
          {customerType === "BUSINESS" ? (
            <ShipmentImportPanel
              audience="admin"
              businessAccountId={selectedAccount?._id}
              branchId={selectedAssignedBranch?._id ?? ""}
              disabled={!selectedAccount || !selectedAssignedBranch || busy || creatingManual}
              onDraftsCreated={() => void refreshHistory()}
            />
          ) : null}
          <section className="border border-slate-200 bg-white p-5 rounded-2xl">
            <h2 className="text-sm font-semibold uppercase text-slate-500 text-center">
              {customerType === "INDIVIDUAL"
                ? "Start Shipment"
                : "Manual Shipment"}
            </h2>
            {customerType === "BUSINESS" ? (
              <div className="group relative mt-4 w-full">
                  <button
                    type="button"
                    onClick={handleManualDraft}
                    disabled={!canCreateManual}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-blue-900 bg-white px-4 text-sm font-semibold text-blue-900 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
                  >
                    {creatingManual
                      ? "Starting Draft..."
                      : "Create Manually"}
                  </button>

                  {!canCreateManual && (
                    <div className="pointer-events-none absolute left-1/2 top-full z-9999 mt-3 hidden w-64 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-3 text-center shadow-xl group-hover:block">
                      <p className="text-xs font-semibold text-slate-900">
                        Business Account Required
                      </p>
                      <p className="mt-1 text-xs  text-slate-600">
                        Please select a business account before creating a
                        shipment draft.
                      </p>
                    </div>
                  )}
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-sm text-slate-600">
                  Enter the customer&apos;s details and choose a branch, then
                  continue to add parcels, the consignee and KYC documents.
                </p>
                <button
                  type="button"
                  onClick={handleIndividualDraft}
                  disabled={!canCreateIndividual}
                  className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  <FiFileText aria-hidden="true" className="h-4 w-4" />
                  {creatingManual
                    ? "Starting Draft..."
                    : "Start Individual Shipment"}
                </button>
                {!canCreateIndividual ? (
                  <p className="mt-2 text-xs font-medium text-slate-500">
                    Customer name and branch are required.
                  </p>
                ) : null}
              </div>
            )}
          </section>

        </aside>
      </div>

      <ShipmentDraftsPanel branchId={branchId} />

      <section className="mt-6 border border-slate-200 bg-white rounded-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold uppercase text-slate-500">
              Recent Shipments
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Open existing shipments without creating duplicates.
            </p>
          </div>
        </div>
        {shipmentAction ? (
          <div className="border-b border-slate-200 bg-slate-50 p-4">
            <div className={`grid gap-4 lg:items-start ${
              shipmentAction.mode === "status"
                ? "lg:grid-cols-[220px_minmax(0,1fr)_210px_auto]"
                : "lg:grid-cols-[220px_minmax(0,1fr)_auto]"
            }`}>
              {shipmentAction.mode === "hold" ? (
                <label>
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Hold Reason
                  </span>
                  <div className="relative mt-2">
                    <select
                      value={holdReason}
                      onChange={(event) =>
                        setHoldReason(event.target.value as ShipmentHoldReason)
                      }
                      className="h-10 w-full appearance-none border border-slate-300 bg-white px-3 pr-10 text-sm font-semibold text-slate-900 focus:border-blue-900 focus:outline-none"
                    >
                      {shipmentHoldReasonOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <FiArrowDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    />
                  </div>
                </label>
              ) : shipmentAction.mode === "status" ? (
                <label>
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Next Status
                  </span>
                  <div className="relative mt-2">
                    <select
                      value={nextStatus}
                      onChange={(event) =>
                        setNextStatus(
                          event.target.value as ShipmentOperationalStatus,
                        )
                      }
                      className="h-10 w-full appearance-none border border-slate-300 bg-white px-3 pr-10 text-sm font-semibold text-slate-900 focus:border-blue-900 focus:outline-none"
                    >
                      {statusChoices.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          // A stage the shipment has not reached yet. Shown rather
                          // than hidden so the whole journey stays visible and the
                          // outstanding step explains itself.
                          disabled={option.completed || option.missing.length > 0}
                        >
                          {option.label}
                          {option.completed ? " - completed" : option.missing.length ? " - not yet reached" : ""}
                        </option>
                      ))}
                    </select>
                    <FiArrowDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    />
                  </div>
                  {/* Says which step is outstanding before anything is submitted,
                      rather than leaving the server to explain it afterwards. */}
                  {blockedStatus?.missing.length ? (
                    <p className="mt-2 text-xs font-medium leading-5 text-amber-700">
                      Record{" "}
                      {blockedStatus.missing
                        .map((status) => shipmentOperationalStatusOptions.find((option) => option.value === status)?.label ?? status)
                        .join(", ")}{" "}
                      before {blockedStatus.label.toLowerCase()} becomes available. Shipment progress is
                      recorded in order.
                    </p>
                  ) : null}
                </label>
              ) : (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Release Action
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    {shipmentAction.shipment.dpdShipment.swiftlineTrackingNumber || "AWB Pending"}
                  </p>
                </div>
              )}
              <label>
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {shipmentAction.mode === "hold"
                    ? "Hold Note"
                    : shipmentAction.mode === "release"
                      ? "Release Note"
                      : "Status Note"}
                </span>
                <input
                  value={actionNote}
                  onChange={(event) => setActionNote(event.target.value)}
                  placeholder={
                    shipmentAction.mode === "hold"
                      ? "Explain why this shipment is on hold"
                      : shipmentAction.mode === "release"
                        ? "Explain why this shipment can continue"
                        : "Optional update note"
                  }
                  className="mt-2 h-10 w-full border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                />
              </label>
              {shipmentAction.mode === "status" ? (
                <label>
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Status Date{" "}
                    <span className="font-normal normal-case text-slate-400">
                      (optional)
                    </span>
                  </span>
                  <input
                    type="datetime-local"
                    value={actionAt}
                    onChange={(event) => setActionAt(event.target.value)}
                    max={currentDateTimeLocal()}
                    title="When this scan actually happened. Leave empty to record it as happening now."
                    className="mt-2 h-10 w-full border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs font-medium leading-4 text-slate-500">
                    Shown on the timeline instead of the moment you press Update.
                  </span>
                </label>
              ) : null}
              <div className="flex gap-2 lg:mt-6">
                <button
                  type="button"
                  onClick={handleShipmentAction}
                  disabled={
                    busy ||
                    (shipmentAction.mode !== "status" &&
                      actionNote.trim().length < 3) ||
                    (shipmentAction.mode === "status" &&
                      Boolean(blockedStatus?.completed || blockedStatus?.missing.length))
                  }
                  className="h-10 bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {busy
                    ? "Saving..."
                    : shipmentAction.mode === "hold"
                      ? "Hold"
                      : shipmentAction.mode === "release"
                        ? "Release"
                        : "Update"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShipmentAction(null);
                    setActionNote("");
                    setActionAt("");
                  }}
                  className="h-10 border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
                >
                  Cancel
                </button>
              </div>
            </div>
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
              {history.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    No shipments yet.
                  </td>
                </tr>
              ) : (
                history.map((item) => (
                  <tr
                    key={item.dpdShipment.id}
                    className="border-b border-slate-100 last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-950">
                        {item.dpdShipment.swiftlineTrackingNumber || "AWB Pending"}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {item.shipmentInvoice?.invoiceNumber
                          ? `Tax Invoice: ${item.shipmentInvoice.invoiceNumber}`
                          : "Tax Invoice Pending"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">
                        {item.shipmentDraft?.consigneeName || "Not set"}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {item.shipmentDraft?.deliveryPostcode || "Not set"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">
                        {getRouteLabel(item)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatCapitalized(
                          item.branch?.name || item.branch?.code,
                        ) || "Assigned Branch"}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">
                      {item.shipmentInvoice
                        ? new Intl.NumberFormat("en-IN", {
                            style: "currency",
                            currency: item.shipmentInvoice.currency,
                            minimumFractionDigits: 2,
                          }).format(
                            item.shipmentInvoice.chargeableAmountMinor / 100,
                          )
                        : "-"}
                    </td>
                    <td className="px-4 py-3">
                      {item.currentEvent?.statusLabel ||
                        item.dpdShipment.status}
                    </td>
                    <td className="px-4 py-3">
                      {formatDashboardDateTime(item.dpdShipment.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        {item.shipmentDraft ? (
                          <>
                            <Link
                              href={`/dashboard/shipments/${item.shipmentDraft.id}`}
                              className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                            >
                              <FiExternalLink
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                              View Details
                            </Link>
                            <Link
                              href={shipmentInvoicePageUrl(
                                item.shipmentDraft.id,
                                "admin",
                              )}
                              className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                            >
                              <FiFileText
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                              Invoice
                            </Link>
                            <button
                              type="button"
                              title="Download invoice PDF"
                              aria-label="Download invoice PDF"
                              disabled={busy}
                              onClick={() => void handleInvoiceDownload(item)}
                              className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-700 hover:border-blue-900 hover:text-blue-900 disabled:opacity-50"
                            >
                              <FiDownload
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </button>
                            <Link
                              href={shipmentInvoicePageUrl(
                                item.shipmentDraft.id,
                                "admin",
                                true,
                              )}
                              title="Print invoice"
                              aria-label="Print invoice"
                              className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-700 hover:border-blue-900 hover:text-blue-900"
                            >
                              <FiPrinter
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </Link>
                          </>
                        ) : null}
                        {item.currentEvent?.status === "ON_HOLD" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setShipmentAction({
                                mode: "release",
                                shipment: item,
                              });
                              setActionNote("");
                              setActionAt("");
                            }}
                            className="font-semibold text-emerald-700 hover:text-emerald-800"
                          >
                            Release
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setShipmentAction({
                                  mode: "status",
                                  shipment: item,
                                });
                                // Opens on the earliest stage this shipment may
                                // record, never on a status the row already has.
                                setNextStatus(
                                  firstAllowedOperationalStatus(
                                    (item.events ?? []).map((event) => event.status),
                                  ),
                                );
                                setActionNote("");
                                setActionAt("");
                              }}
                              className="font-semibold text-blue-900 hover:text-blue-700"
                            >
                              Update Status
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setShipmentAction({
                                  mode: "hold",
                                  shipment: item,
                                });
                                setActionNote("");
                                setActionAt("");
                              }}
                              className="font-semibold text-amber-700 hover:text-amber-800"
                            >
                              Hold
                            </button>
                          </>
                        )}
                        {item.labels.length ? (
                          <button
                            type="button"
                            onClick={() => {
                              const label = item.labels[0];
                              if (label)
                                void handleLabelDownload(
                                  item.dpdShipment.id,
                                  label.id,
                                  label.parcelNumber,
                                  label.format,
                                );
                            }}
                            className="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-800"
                          >
                            <FiDownload
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                            Label
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
