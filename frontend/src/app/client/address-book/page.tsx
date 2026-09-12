"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FiCheckCircle,
  FiChevronDown,
  FiCopy,
  FiDownload,
  FiEdit3,
  FiEye,
  FiEyeOff,
  FiFileText,
  FiMapPin,
  FiPlus,
  FiSearch,
  FiStar,
  FiTrash2,
  FiTruck,
  FiUpload,
  FiX,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { AddressAutocompleteField } from "@/components/business-accounts/AddressAutocompleteField";
import {
  CheckboxField,
  Field,
} from "@/components/business-accounts/FormFieldControls";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import {
  addressBookInputFromEntry,
  createAddressBookEntry,
  deleteAddressBookEntry,
  downloadAddressBookTemplate,
  duplicateAddressBookEntry,
  emptyAddressBookInput,
  importAddressBookEntries,
  listAddressBookEntries,
  previewAddressBookImport,
  revealAddressBookAadhaar,
  runAddressBookAction,
  setAddressBookFavourite,
  updateAddressBookEntry,
  type AddressBookEntry,
  type AddressBookEntryType,
  type AddressBookImportPreviewRow,
  type AddressBookInput,
  type AddressBookValidationStatus,
} from "@/lib/addressBook";
import { formatAadhaarNumber, isValidAadhaarNumber, normalizeAadhaarNumber } from "@/lib/aadhaar";
import {
  createClientManualShipmentDraft,
  getClientDashboard,
  type ClientDashboardAccount,
} from "@/lib/clientDashboard";
import { countries } from "@/lib/countries";
import { useClientUser } from "@/lib/useClientUser";

const allowedRoles = new Set(["account_owner", "account_admin", "operations"]);
const emptyPagination = { page: 1, limit: 20, total: 0, totalPages: 1 };

function accountBranches(account: ClientDashboardAccount) {
  return account.assignedBranches.length
    ? account.assignedBranches
    : account.account.assignedBranch
      ? [account.account.assignedBranch]
      : [];
}

function validationStyle(status: AddressBookValidationStatus) {
  if (status === "VALIDATED")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "MANUALLY_CONFIRMED")
    return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "CORRECTION_SUGGESTED")
    return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "INCOMPLETE" || status === "UNAVAILABLE")
    return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function validationLabel(status: AddressBookValidationStatus) {
  return status
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

export default function ClientAddressBookPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useClientUser();
  const [account, setAccount] = useState<ClientDashboardAccount | null>(null);
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [type, setType] = useState<"" | AddressBookEntryType>("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState<AddressBookEntry | null | "new">(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [aadhaarBusyId, setAadhaarBusyId] = useState("");
  const [revealedAadhaar, setRevealedAadhaar] = useState<Record<string, string>>({});

  const accountId = account?.account.id ?? "";
  const branchId = account ? (accountBranches(account)[0]?._id ?? "") : "";

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    void getClientDashboard()
      .then((dashboard) => {
        if (!active) return;
        const available =
          dashboard.accounts.find(
            (item) =>
              allowedRoles.has(item.membership.role) &&
              item.dashboardAccess.state === "READY",
          ) ?? null;
        setAccount(available);
        if (!available)
          setError(
            "Your account role can view shipments but cannot manage booking addresses.",
          );
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load the address book.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void listAddressBookEntries({
        businessAccountId: accountId,
        search: deferredSearch,
        type,
        favourite: favouritesOnly,
        page,
      })
        .then((result) => {
          if (!active) return;
          setEntries(result.entries);
          setPagination(result.pagination);
        })
        .catch((caught) => {
          if (active)
            setError(
              caught instanceof Error
                ? caught.message
                : "Unable to load saved addresses.",
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [accountId, deferredSearch, favouritesOnly, page, refreshKey, type]);

  function refresh() {
    setRevealedAadhaar({});
    setRefreshKey((value) => value + 1);
  }

  async function toggleAadhaar(entry: AddressBookEntry) {
    if (revealedAadhaar[entry.id]) {
      setRevealedAadhaar((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      return;
    }
    if (aadhaarBusyId) return;
    setAadhaarBusyId(entry.id);
    try {
      const result = await revealAddressBookAadhaar(entry.id);
      setRevealedAadhaar((current) => ({ ...current, [entry.id]: result.aadhaarNumber }));
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The Aadhaar number could not be shown.");
    } finally {
      setAadhaarBusyId("");
    }
  }

  async function run(
    entry: AddressBookEntry,
    action:
      | "favourite"
      | "duplicate"
      | "delete"
      | "validate"
      | "accept-suggestion"
      | "confirm",
  ) {
    if (busyId) return;
    if (
      action === "delete" &&
      !window.confirm(
        `Delete “${entry.label}”? Existing shipments will not be changed.`,
      )
    )
      return;
    setBusyId(entry.id);
    try {
      if (action === "favourite") {
        await setAddressBookFavourite(entry.id, !entry.isFavourite);
        toast.success(
          entry.isFavourite
            ? "Removed from favourites."
            : "Added to favourites.",
        );
      } else if (action === "duplicate") {
        await duplicateAddressBookEntry(entry.id);
        toast.success("Address duplicated.");
      } else if (action === "delete") {
        await deleteAddressBookEntry(entry.id);
        toast.success("Address deleted.");
      } else {
        const result = await runAddressBookAction(entry.id, action);
        toast.success(
          result.entry.validationMessage || "Address validation updated.",
        );
      }
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "The address action could not be completed.",
      );
    } finally {
      setBusyId("");
    }
  }

  async function handleUseForShipment(entry: AddressBookEntry) {
    if (!branchId || account?.bookingAccess.state !== "READY") {
      toast.error(
        account?.bookingAccess.message ||
          "Shipment booking is not available for this account.",
      );
      return;
    }
    setBusyId(entry.id);
    try {
      const result = await createClientManualShipmentDraft(branchId);
      router.push(
        `/client/dpd-labels/${result.shipmentDraft._id}?addressBookEntryId=${encodeURIComponent(entry.id)}`,
      );
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Unable to start a shipment.",
      );
      setBusyId("");
    }
  }

  if (authLoading || !user || (loading && !account && !error))
    return <ClientDashboardLoading />;

  return (
    <div className="mx-auto max-w-375">
      <header className="overflow-hidden  ">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="mt-2 text-2xl font-semibold">Address Book</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Save frequently used sender and recipient details, validate them,
              and reuse them while booking shipments.
            </p>
          </div>
          {account ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-700 bg-white/10 px-4 text-sm font-semibold hover:bg-white/15"
              >
                <FiUpload className="h-4 w-4" /> Import
              </button>
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#F0DE36] px-4 text-sm font-semibold text-[#0D1282] hover:bg-[#e4d329]"
              >
                <FiPlus className="h-4 w-4" /> Add Address
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {account ? (
        <>
          <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_190px_auto]">
              <label className="relative block">
                <FiSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search label, contact, city or postcode"
                  className="h-11 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                />
              </label>
              <div className="relative">
                <select
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value as typeof type);
                    setPage(1);
                  }}
                  className="h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-700 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                >
                  <option value="">All address types</option>
                  <option value="SENDER">Senders</option>
                  <option value="RECIPIENT">Recipients</option>
                </select>
                <FiChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                />
              </div>
              <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={favouritesOnly}
                  onChange={(event) => {
                    setFavouritesOnly(event.target.checked);
                    setPage(1);
                  }}
                  className="h-4 w-4 accent-[#0D1282]"
                />{" "}
                Favourites
              </label>
            </div>
          </section>

          <section className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-700">
                {pagination.total} saved{" "}
                {pagination.total === 1 ? "address" : "addresses"}
              </p>
              {loading ? (
                <p className="text-xs font-medium text-slate-500">
                  Refreshing...
                </p>
              ) : null}
            </div>
            {!loading && !entries.length ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
                <FiMapPin className="mx-auto h-10 w-10 text-slate-300" />
                <h2 className="mt-4 text-lg font-semibold text-slate-900">
                  No saved addresses found
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  Add an address or import a CSV/Excel template to get started.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {entries.map((entry) => (
                  <article
                    key={entry.id}
                    className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-[#0D1282]/25 hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full bg-[#0D1282]/8 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#0D1282]">
                            {entry.type === "SENDER" ? "Sender" : "Recipient"}
                          </span>
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold ${validationStyle(entry.validationStatus)}`}
                          >
                            {validationLabel(entry.validationStatus)}
                          </span>
                        </div>

                        <h2 className="mt-2 truncate text-base font-semibold text-slate-950">
                          {entry.label}
                        </h2>
                        <p className="mt-0.5 truncate text-sm text-slate-600">
                          {entry.companyName || entry.contactName}
                        </p>
                      </div>

                      <button
                        type="button"
                        aria-label={
                          entry.isFavourite
                            ? "Remove favourite"
                            : "Add favourite"
                        }
                        onClick={() => void run(entry, "favourite")}
                        disabled={busyId === entry.id}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-400 transition hover:border-[#d2b800] hover:bg-[#F0DE36]/10 hover:text-[#b49c00] disabled:opacity-50"
                      >
                        <FiStar
                          className={`h-4 w-4 ${entry.isFavourite ? "fill-[#F0DE36] text-[#b49c00]" : ""}`}
                        />
                      </button>
                    </div>

                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <div className="flex items-start gap-2 text-sm leading-5 text-slate-600">
                        {/* <FiMapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /> */}
                        <p className="min-w-0 line-clamp-2">
                          {[entry.addressLine1, entry.addressLine2, entry.townOrCity, entry.county, entry.postcode, entry.countryName]
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      </div>

                      <div className="mt-2 grid min-w-0 grid-cols-1 gap-0.5  text-xs leading-5 text-slate-500">
                        <p className="truncate" title={entry.email}>{entry.email}</p>
                        <p>{entry.mobileCountryCode} {entry.mobileNumber}</p>
                      </div>

                      {entry.type === "SENDER" && entry.hasAadhaarNumber ? (
                        <div className="mt-2 flex min-h-8 items-center justify-between gap-3 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                          <span className="min-w-0">
                            <span className="font-semibold text-slate-700">Aadhaar</span>{" "}
                            <span className="tabular-nums" aria-live="polite">
                              {revealedAadhaar[entry.id]
                                ? formatAadhaarNumber(revealedAadhaar[entry.id])
                                : entry.aadhaarNumberMasked}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void toggleAadhaar(entry)}
                            disabled={aadhaarBusyId === entry.id}
                            aria-label={revealedAadhaar[entry.id] ? "Hide Aadhaar number" : "Show Aadhaar number"}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-white hover:text-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20 disabled:opacity-50"
                          >
                            {revealedAadhaar[entry.id] ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
                          </button>
                        </div>
                      ) : null}

                      {entry.validationMessage ? (
                        <p className="mt-2 line-clamp-1 text-xs text-slate-500" title={entry.validationMessage}>
                          {entry.validationMessage}
                        </p>
                      ) : null}
                    </div>

                    <div className="mt-auto border-t border-slate-100 pt-3">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                        <button
                          type="button"
                          onClick={() => void handleUseForShipment(entry)}
                          disabled={Boolean(busyId)}
                          className="inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-3 text-xs font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
                        >
                          <FiTruck className="h-4 w-4 shrink-0" />
                          <span className="truncate">
                            {busyId === entry.id ? "Please wait..." : "Use for Shipment"}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void run(entry, "validate")}
                          disabled={Boolean(busyId)}
                          className="inline-flex h-9 items-center justify-center rounded-lg border border-[#0D1282]/30 bg-white px-3 text-xs font-semibold text-[#0D1282] transition hover:border-[#0D1282] hover:bg-[#0D1282]/3 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                        >
                          {entry.validationStatus === "NOT_VALIDATED"
                            ? "Validate"
                            : "Revalidate"}
                        </button>
                      </div>

                      <div className="mt-2.5 flex min-h-8 flex-wrap items-center justify-between gap-2">
                        <div className="flex gap-1.5">
                          <ActionIcon
                            label="Edit"
                            onClick={() => setEditing(entry)}
                          >
                            <FiEdit3 />
                          </ActionIcon>
                          <ActionIcon
                            label="Duplicate"
                            onClick={() => void run(entry, "duplicate")}
                          >
                            <FiCopy />
                          </ActionIcon>
                          <ActionIcon
                            label="Delete"
                            danger
                            onClick={() => void run(entry, "delete")}
                          >
                            <FiTrash2 />
                          </ActionIcon>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2">
                          {entry.validationStatus === "CORRECTION_SUGGESTED" ? (
                            <SmallAction
                              label="Accept Correction"
                              onClick={() =>
                                void run(entry, "accept-suggestion")
                              }
                            />
                          ) : null}
                          {[
                            "INCOMPLETE",
                            "UNAVAILABLE",
                            "CORRECTION_SUGGESTED",
                          ].includes(entry.validationStatus) ? (
                            <SmallAction
                              label="Confirm Manually"
                              onClick={() => void run(entry, "confirm")}
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {pagination.totalPages > 1 ? (
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => value - 1)}
                className="h-9 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm font-semibold text-slate-600">
                Page {page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                disabled={page >= pagination.totalPages || loading}
                onClick={() => setPage((value) => value + 1)}
                className="h-9 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {editing ? (
        <AddressFormDialog
          initial={
            editing === "new"
              ? emptyAddressBookInput()
              : addressBookInputFromEntry(editing)
          }
          title={editing === "new" ? "Add Address" : "Edit Address"}
          existingAadhaarMasked={editing === "new" ? "" : editing.aadhaarNumberMasked}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (!accountId) return;
            if (editing === "new")
              await createAddressBookEntry(accountId, input);
            else await updateAddressBookEntry(editing.id, input);
            toast.success(
              editing === "new" ? "Address saved." : "Address updated.",
            );
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
      {importOpen && accountId ? (
        <AddressImportDialog
          businessAccountId={accountId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function ActionIcon({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 ${danger ? "text-red-600 hover:border-red-500" : "text-slate-600 hover:border-[#0D1282] hover:text-[#0D1282]"}`}
    >
      {children}
    </button>
  );
}

function SmallAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-semibold text-[#0D1282] hover:underline"
    >
      {label}
    </button>
  );
}

function AddressFormDialog({
  initial,
  title,
  existingAadhaarMasked,
  onClose,
  onSave,
}: {
  initial: AddressBookInput;
  title: string;
  existingAadhaarMasked: string;
  onClose: () => void;
  onSave: (input: AddressBookInput) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showAadhaar, setShowAadhaar] = useState(false);
  const set = <K extends keyof AddressBookInput>(
    field: K,
    value: AddressBookInput[K],
  ) => setForm((current) => ({ ...current, [field]: value }));

  function changeType(nextType: AddressBookEntryType) {
    setForm((current) => ({
      ...current,
      type: nextType,
      ...(nextType === "SENDER"
        ? {
            countryCode: "IN",
            countryName: "India",
            mobileCountryCode: current.mobileCountryCode || "+91",
          }
        : {}),
      ...(nextType === "RECIPIENT" ? { aadhaarNumber: "" } : {}),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (form.aadhaarNumber && !isValidAadhaarNumber(form.aadhaarNumber)) {
      setError("Enter a valid 12-digit Aadhaar number.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(form);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The address could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-70 flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <form
        onSubmit={submit}
        className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-xl font-semibold text-[#0D1282]">{title}</h2>
            <p className="mt-1 text-sm text-slate-500">
              Save contact and postal details. Sender Aadhaar is optional and stored securely.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-600"
          >
            <FiX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin sm:p-6">
          {error ? (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {error}
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                Address Type *
              </span>
              <select
                value={form.type}
                onChange={(event) =>
                  changeType(event.target.value as AddressBookEntryType)
                }
                className="h-14 w-full rounded-xl border border-[#EEEDED] bg-white px-4 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]/35"
              >
                <option value="RECIPIENT">Recipient</option>
                <option value="SENDER">Sender</option>
              </select>
            </label>
            <Field
              label="Address Label"
              required
              value={form.label}
              onChange={(value) => set("label", value)}
              maxLength={80}
              placeholder="e.g. London Office"
            />
            <Field
              label="Company Name"
              value={form.companyName}
              onChange={(value) => set("companyName", value.toUpperCase())}
              maxLength={120}
            />
            <Field
              label="Contact Name"
              required
              value={form.contactName}
              onChange={(value) => set("contactName", value.toUpperCase())}
              maxLength={120}
            />
            <Field
              label="Email"
              required
              type="email"
              value={form.email}
              onChange={(value) => set("email", value.toLowerCase())}
              maxLength={160}
            />
            <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
              <Field
                label="Dial Code"
                required
                value={form.mobileCountryCode}
                onChange={(value) => set("mobileCountryCode", value)}
                maxLength={8}
              />
              <Field
                label="Mobile Number"
                required
                type="tel"
                value={form.mobileNumber}
                onChange={(value) => set("mobileNumber", value)}
                maxLength={30}
              />
            </div>
            {form.type === "SENDER" ? (
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Aadhaar Number <span className="normal-case tracking-normal text-slate-400">(optional)</span>
                </span>
                <span className="relative block">
                  <input
                    type={showAadhaar ? "text" : "password"}
                    inputMode="numeric"
                    autoComplete="off"
                    value={formatAadhaarNumber(form.aadhaarNumber ?? "")}
                    onChange={(event) => set("aadhaarNumber", normalizeAadhaarNumber(event.target.value))}
                    maxLength={14}
                    placeholder={existingAadhaarMasked || "XXXX XXXX XXXX"}
                    aria-describedby="address-book-aadhaar-help"
                    className="h-14 w-full rounded-xl border border-[#EEEDED] bg-white px-4 pr-12 text-sm tabular-nums outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]/35"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAadhaar((value) => !value)}
                    aria-label={showAadhaar ? "Hide Aadhaar number" : "Show Aadhaar number"}
                    className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-[#0D1282] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20"
                  >
                    {showAadhaar ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
                  </button>
                </span>
                <span id="address-book-aadhaar-help" className="mt-1.5 block text-xs leading-5 text-slate-500">
                  {existingAadhaarMasked
                    ? `Saved as ${existingAadhaarMasked}. Leave blank to keep it, or enter a new number to replace it.`
                    : "Saved only with sender addresses and filled into new shipment drafts."}
                </span>
              </label>
            ) : null}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                Country *
              </span>
              <select
                disabled={form.type === "SENDER"}
                value={form.countryCode}
                onChange={(event) => {
                  const country = countries.find(
                    (item) => item.iso2.toUpperCase() === event.target.value,
                  );
                  if (country)
                    setForm((current) => ({
                      ...current,
                      countryCode: event.target.value,
                      countryName: country.name,
                    }));
                }}
                className="h-14 w-full rounded-xl border border-[#EEEDED] bg-white px-4 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]/35 disabled:bg-slate-100"
              >
                <option value="" disabled>
                  Select country
                </option>
                {countries.map((country) => (
                  <option key={country.iso2} value={country.iso2.toUpperCase()}>
                    {country.name}
                  </option>
                ))}
              </select>
            </label>
            <AddressAutocompleteField
              label="Address Line 1"
              required
              value={form.addressLine1}
              countryName={form.countryName}
              onChange={(value) => set("addressLine1", value.toUpperCase())}
              onAddressSelected={(address) =>
                setForm((current) => ({
                  ...current,
                  addressLine1: address.addressLine1.toUpperCase(),
                  addressLine2: address.addressLine2.toUpperCase(),
                  townOrCity: address.city.toUpperCase(),
                  county: address.state.toUpperCase(),
                  postcode: address.postalCode.toUpperCase(),
                  countryCode: address.countryCode,
                  countryName: address.countryName,
                }))
              }
            />
            <Field
              label="Address Line 2"
              value={form.addressLine2}
              onChange={(value) => set("addressLine2", value.toUpperCase())}
              maxLength={120}
            />
            <Field
              label="Town / City"
              required
              value={form.townOrCity}
              onChange={(value) => set("townOrCity", value.toUpperCase())}
              maxLength={80}
            />
            <Field
              label="State / County"
              value={form.county}
              onChange={(value) => set("county", value.toUpperCase())}
              maxLength={80}
            />
            <Field
              label="Postal Code"
              required
              value={form.postcode}
              onChange={(value) => set("postcode", value.toUpperCase())}
              maxLength={20}
            />
            <label className="block md:col-span-2">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                {form.type === "SENDER" ? "Pickup" : "Delivery"} Instructions
              </span>
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  set("instructions", event.target.value.toUpperCase())
                }
                maxLength={500}
                rows={3}
                className="w-full rounded-xl border border-[#EEEDED] px-4 py-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]/35"
              />
            </label>
            <div className="md:col-span-2">
              <CheckboxField
                label="Mark as favourite"
                checked={form.isFavourite}
                onChange={(value) => set("isFavourite", value)}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-10 rounded-xl bg-[#0D1282] px-5 text-sm font-semibold text-white disabled:bg-slate-400"
          >
            {saving ? "Saving..." : "Save Address"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddressImportDialog({
  businessAccountId,
  onClose,
  onImported,
}: {
  businessAccountId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<AddressBookImportPreviewRow[]>([]);
  const [globalErrors, setGlobalErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const validRows = useMemo(
    () => rows.flatMap((row) => (row.data ? [row.data] : [])),
    [rows],
  );

  async function preview() {
    if (!file) return;
    setBusy(true);
    try {
      const result = await previewAddressBookImport(businessAccountId, file);
      setRows(result.rows);
      setGlobalErrors(result.errors);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "The file could not be previewed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!validRows.length) return;
    setBusy(true);
    try {
      const result = await importAddressBookEntries(
        businessAccountId,
        validRows,
      );
      toast.success(`${result.importedCount} addresses imported.`);
      onImported();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "The addresses could not be imported.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-70 flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Import address book"
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-xl font-semibold text-[#0D1282]">
              Import CSV / Excel
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Preview and correct row errors before importing.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200"
          >
            <FiX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin sm:p-6">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void downloadAddressBookTemplate(businessAccountId, "xlsx")
              }
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-700"
            >
              <FiDownload /> Excel Template
            </button>
            <button
              type="button"
              onClick={() =>
                void downloadAddressBookTemplate(businessAccountId, "csv")
              }
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-700"
            >
              <FiFileText /> CSV Template
            </button>
          </div>
          <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#0D1282]/25 bg-[#0D1282]/3] px-5 py-8 text-center hover:border-[#0D1282]/50">
            <FiUpload className="h-7 w-7 text-[#0D1282]" />
            <span className="mt-3 text-sm font-semibold text-slate-800">
              {file?.name || "Choose a .csv or .xlsx file"}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              Maximum 5 MB and 500 address rows
            </span>
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setRows([]);
                setGlobalErrors([]);
              }}
            />
          </label>
          {file && !rows.length ? (
            <button
              type="button"
              onClick={() => void preview()}
              disabled={busy}
              className="mt-4 h-10 w-full rounded-xl bg-[#0D1282] text-sm font-semibold text-white disabled:bg-slate-400"
            >
              {busy ? "Reading File..." : "Preview Import"}
            </button>
          ) : null}
          {globalErrors.map((message) => (
            <p
              key={message}
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
            >
              {message}
            </p>
          ))}
          {rows.length ? (
            <div className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">Preview</h3>
                <p className="text-sm text-slate-600">
                  {validRows.length} valid · {rows.length - validRows.length}{" "}
                  invalid
                </p>
              </div>
              <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-slate-200 scrollbar-thin">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.rowNumber}
                        className="border-t border-slate-100"
                      >
                        <td className="px-3 py-3 font-semibold">
                          {row.rowNumber}
                        </td>
                        <td className="px-3 py-3">
                          {row.data
                            ? `${row.data.label} · ${row.data.contactName}`
                            : "Invalid row"}
                        </td>
                        <td className="px-3 py-3">
                          {row.errors.length ? (
                            <span className="text-xs font-semibold text-red-700">
                              {row.errors.join("; ")}
                            </span>
                          ) : row.warnings.length ? (
                            <span className="text-xs font-semibold text-amber-700">
                              {row.warnings.join("; ")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                              <FiCheckCircle /> Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700"
          >
            Cancel
          </button>
          {rows.length ? (
            <button
              type="button"
              onClick={() => void commit()}
              disabled={busy || !validRows.length}
              className="h-10 rounded-xl bg-[#0D1282] px-5 text-sm font-semibold text-white disabled:bg-slate-400"
            >
              {busy ? "Importing..." : `Import ${validRows.length} Valid`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
