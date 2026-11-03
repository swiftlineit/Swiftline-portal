"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiArrowRight, FiPlus, FiSearch } from "react-icons/fi";
import OperatorSelect from "@/components/operators/OperatorSelect";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import CreateManifestDialog, { type ManifestDialogValues } from "@/components/shipments/CreateManifestDialog";
import { ShipmentHoverCard } from "@/components/shipments/ParcelManifestCell";
import {
  getOperatorSession,
  listOperatorBranches,
  listOperatorBusinessAccounts,
  type OperatorBranch,
  type OperatorBusinessAccount,
  type OperatorSession
} from "@/lib/operatorDirectory";
import {
  listOperatorClientBookedShipments,
  listOperatorClientShipmentDrafts,
  listOperatorStaffBookedShipments,
  listOperatorStaffShipmentDrafts,
  type OperatorShipmentListPagination,
  type OperatorStaffShipmentDraft,
  type OperatorStaffShipmentRow
} from "@/lib/operatorShipments";
import type { ClientShipmentListItem } from "@/lib/clientDashboard";
import { shipmentStatusOptions, type ShipmentListItem } from "@/lib/shipmentsList";
import { createBulkShipmentManifest, createCombinedShipmentManifest, type CreateBulkShipmentManifestInput } from "@/lib/shipmentManifests";

const STAFF_PAGE_SIZE = 10;
const CLIENT_PAGE_SIZE = 30;
const EMPTY_PAGINATION: OperatorShipmentListPagination = { page: 1, limit: STAFF_PAGE_SIZE, total: 0, totalPages: 0 };

type Tab = "booked" | "drafts";
type WorkspaceRow = {
  id: string;
  consignee: string;
  destinationCountry: string;
  trackingNumber: string;
  status: string;
  createdAt: string;
  branch: string;
  account: string;
  businessAccountId: string;
  branchId: string;
  pieces: number;
  parcelNumbers: Array<string | null>;
  parcelWeightsKg: Array<number | null>;
  weightKg: number;
  bookingAmountMinor: number | null;
  currency: string;
  manifestEligible: boolean;
  combinedManifestEligible: boolean;
  link: string;
};

function humanize(value?: string | null) {
  return (value || "Pending").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function businessAccountDisplayName(account?: OperatorBusinessAccount) {
  if (!account) return "Business account name unavailable";
  const companyName = account.company?.companyName?.trim();
  const contactName = [account.contact?.firstName, account.contact?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return companyName || contactName || "Business account name unavailable";
}

function clientDraftRow(row: ClientShipmentListItem, slug: string, accountName: string, businessAccountId: string): WorkspaceRow {
  const canEdit = row.bookingState === "EDITABLE";
  return {
    id: row.id,
    consignee: row.destination.companyName || row.destination.contactName || "Consignee not entered",
    destinationCountry: row.destination.countryName || row.destination.countryCode || "-",
    trackingNumber: row.swiftlineTrackingNumber || "-",
    status: row.statusLabel || humanize(row.status),
    createdAt: row.createdAt || "",
    branch: row.branch.name || "-",
    account: accountName,
    businessAccountId,
    branchId: row.branchId,
    pieces: row.parcelCount ?? row.parcelWeightsKg?.length ?? 0,
    parcelNumbers: [],
    parcelWeightsKg: row.parcelWeightsKg ?? [],
    weightKg: 0,
    bookingAmountMinor: null,
    currency: row.shipmentInvoice?.currency || "INR",
    manifestEligible: false,
    combinedManifestEligible: false,
    link: canEdit
      ? `/portal/${encodeURIComponent(slug)}/shipments/drafts/${encodeURIComponent(row.id)}`
      : `/portal/${encodeURIComponent(slug)}/shipments/${encodeURIComponent(row.id)}`
  };
}

function clientBookedRow(row: ShipmentListItem, slug: string, accountName: string): WorkspaceRow {
  return {
    id: row.id,
    consignee: row.consignee || "Consignee not entered",
    destinationCountry: row.destinationCountry || "-",
    trackingNumber: row.swiftlineTrackingNumber || "-",
    status: row.statusLabel || humanize(row.status),
    createdAt: row.createdAt || "",
    branch: row.branch.name || "-",
    account: row.businessAccountName || accountName,
    businessAccountId: row.businessAccountId,
    branchId: row.branchId,
    pieces: row.pieces,
    parcelNumbers: row.awbNumbers ?? [],
    parcelWeightsKg: row.parcelWeightsKg ?? [],
    weightKg: row.weightKg,
    bookingAmountMinor: row.shipmentInvoice?.chargeableAmountMinor ?? null,
    currency: row.shipmentInvoice?.currency || "INR",
    manifestEligible: row.manifestEligible,
    combinedManifestEligible: false,
    link: `/portal/${encodeURIComponent(slug)}/shipments/${encodeURIComponent(row.id)}`
  };
}

const bookedStatusOptions = [
  { value: "SHIPMENT_CREATED", label: "Shipment created" },
  ...shipmentStatusOptions
];

const draftStatusOptions = [
  { value: "NEEDS_REVIEW", label: "Needs review" },
  { value: "ADDRESS_INCOMPLETE", label: "Address incomplete" },
  { value: "ADDRESS_VALIDATED", label: "Address validated" },
  { value: "VALIDATION_FAILED", label: "Validation failed" },
  { value: "READY_FOR_DPD", label: "Ready for booking" }
];

function formatDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date);
}

function formatMoney(amountMinor: number | null, currency: string) {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return "-";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function Pagination({ pagination, onChange }: { pagination: OperatorShipmentListPagination; onChange: (page: number) => void }) {
  if (pagination.totalPages <= 1) return null;
  const size = pagination.pageSize ?? pagination.limit ?? STAFF_PAGE_SIZE;
  const start = (pagination.page - 1) * size + 1;
  const end = Math.min(pagination.page * size, pagination.total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:px-5">
      <p className="text-sm text-slate-600">Showing {start}–{end} of {pagination.total}</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => onChange(pagination.page - 1)} disabled={pagination.page <= 1}
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">
          <FiArrowLeft aria-hidden="true" className="h-4 w-4" /><span>Previous</span>
        </button>
        <button type="button" onClick={() => onChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages}
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-45">
          <span>Next</span><FiArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("deliver")) return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (normalized.includes("cancel") || normalized.includes("reject")) return "bg-rose-50 text-rose-800 ring-rose-200";
  if (normalized.includes("draft") || normalized.includes("pending") || normalized.includes("review")) return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export default function OperatorShipmentWorkspace({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [accounts, setAccounts] = useState<OperatorBusinessAccount[]>([]);
  const [branches, setBranches] = useState<OperatorBranch[]>([]);
  const [accountId, setAccountId] = useState("");
  const [tab, setTab] = useState<Tab>("booked");
  const [status, setStatus] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [pagination, setPagination] = useState<OperatorShipmentListPagination>(EMPTY_PAGINATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(new Set());
  const [manifestMode, setManifestMode] = useState<"ACCOUNT" | "COMBINED" | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestError, setManifestError] = useState("");
  const client = session?.membership.role === "CLIENT";
  const canCreate = !supportReadOnly && Boolean(session && ["OPERATOR_ADMIN", "OPERATIONS", "CLIENT"].includes(session.membership.role));
  const canCreateCombinedManifest = !supportReadOnly && Boolean(session && ["OPERATOR_ADMIN", "OPERATIONS"].includes(session.membership.role));

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.all([
      getOperatorSession(operatorSlug, controller.signal),
      listOperatorBusinessAccounts(operatorSlug, { page: 1, pageSize: 100 }, controller.signal),
      listOperatorBranches(operatorSlug, { page: 1, pageSize: 100 }, controller.signal)
    ]).then(([operator, accountResult, branchResult]) => {
      if (!active) return;
      setSession(operator);
      setAccounts(accountResult.accounts);
      setBranches(branchResult.branches);
      setAccountId((current) => current || (operator.membership.role === "CLIENT" ? accountResult.accounts[0]?._id ?? "" : ""));
      if (operator.membership.role === "CLIENT" && accountResult.accounts.length === 0) setLoading(false);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/shipments`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load shipments for this operator.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, router]);

  useEffect(() => {
    if (!session || (client && !accountId)) return;
    let active = true;
    const controller = new AbortController();
    const input = {
      page,
      pageSize: client ? CLIENT_PAGE_SIZE : STAFF_PAGE_SIZE,
      businessAccountId: client ? accountId : accountId || undefined,
      search: query || undefined,
      status: status || undefined
    };
    const request = tab === "drafts"
      ? client
        ? listOperatorClientShipmentDrafts(operatorSlug, { ...input, businessAccountId: accountId }, controller.signal)
        : listOperatorStaffShipmentDrafts(operatorSlug, input, controller.signal)
      : client
        ? listOperatorClientBookedShipments(operatorSlug, input, controller.signal)
        : listOperatorStaffBookedShipments(operatorSlug, input, controller.signal);

    request.then((result) => {
      if (!active) return;
      const selectedAccountName = businessAccountDisplayName(accounts.find((account) => account._id === accountId));
      const nextRows = tab === "drafts"
        ? client
          ? (result as { shipments: ClientShipmentListItem[] }).shipments.map((row) => clientDraftRow(row, operatorSlug, selectedAccountName, accountId))
          : (result as { drafts: OperatorStaffShipmentDraft[] }).drafts.map((row) => ({
            id: row.id,
            consignee: row.destination.companyName || row.destination.contactName || "Consignee not entered",
            destinationCountry: row.destination.countryName || row.destination.countryCode || "-",
            trackingNumber: "-",
            status: humanize(row.status),
            createdAt: row.createdAt,
            branch: branches.find((branch) => branch._id === row.branchId)?.name || "-",
            account: row.businessAccountName || businessAccountDisplayName(accounts.find((account) => account._id === row.businessAccountId)),
            businessAccountId: row.businessAccountId,
            branchId: row.branchId,
            pieces: row.parcelCount,
            parcelNumbers: [],
            parcelWeightsKg: row.parcelWeightsKg,
            weightKg: 0,
            bookingAmountMinor: null,
            currency: "INR",
            manifestEligible: false,
            combinedManifestEligible: false,
            link: row.bookingState === "EDITABLE"
              ? `/portal/${encodeURIComponent(operatorSlug)}/shipments/drafts/${encodeURIComponent(row.id)}`
              : `/portal/${encodeURIComponent(operatorSlug)}/shipments/${encodeURIComponent(row.id)}`
          }))
        : client
          ? (result as { shipments: ShipmentListItem[] }).shipments.map((row) => clientBookedRow(row, operatorSlug, selectedAccountName))
          : (result as { shipments: OperatorStaffShipmentRow[] }).shipments.map((row) => ({
            id: row.draft._id,
            consignee: row.draft.consigneeEnteredAddress.companyName || row.draft.consigneeEnteredAddress.contactName || "Consignee not entered",
            destinationCountry: row.draft.consigneeEnteredAddress.countryName || row.draft.consigneeEnteredAddress.countryCode || "-",
            trackingNumber: row.shipment?.swiftlineTrackingNumber || "-",
            status: humanize(row.currentEvent?.status || (row.shipment?.status === "LABEL_RECEIVED" ? "SHIPMENT_BOOKED" : row.shipment?.status)),
            createdAt: row.shipment?.createdAt || row.draft.createdAt,
            branch: branches.find((branch) => branch._id === row.draft.branchId)?.name || "-",
            account: row.businessAccountName || businessAccountDisplayName(accounts.find((account) => account._id === row.draft.businessAccountId)),
            businessAccountId: row.draft.businessAccountId,
            branchId: row.draft.branchId,
            pieces: row.draft.parcelCount ?? row.draft.parcelList?.length ?? 0,
            parcelNumbers: row.shipment?.parcelNumbers ?? [],
            parcelWeightsKg: (row.draft.parcelList || []).map((parcel) => typeof parcel.weightKg === "number" ? parcel.weightKg : null),
            weightKg: Number((row.draft.parcelList || []).reduce((sum, parcel) => sum + (parcel.weightKg || 0), 0).toFixed(3)),
            bookingAmountMinor: row.taxInvoice?.totalAmountMinor ?? null,
            currency: row.taxInvoice?.currency || "INR",
            manifestEligible: row.manifestEligible,
            combinedManifestEligible: row.combinedManifestEligible,
            link: `/portal/${encodeURIComponent(operatorSlug)}/shipments/${encodeURIComponent(row.draft._id)}`
          }));
      setRows(nextRows);
      setPagination(result.pagination);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Unable to load shipments.");
      setRows([]);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, session, client, accountId, tab, status, page, query, accounts, branches]);

  useEffect(() => {
    const nextQuery = queryInput.trim();
    if (nextQuery === query) return;

    const timeoutId = window.setTimeout(() => {
      setSelectedShipmentIds(new Set());
      setLoading(true);
      setError("");
      setPage(1);
      setQuery(nextQuery);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [queryInput, query]);

  const accountOptions = useMemo(() => accounts.map((account) => ({ value: account._id, label: businessAccountDisplayName(account) })), [accounts]);
  const activeStatusOptions = tab === "booked" ? bookedStatusOptions : draftStatusOptions;
  const visibleRows = client && !accountId ? [] : rows;
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectableVisibleRows = canCreate && tab === "booked" ? visibleRows.filter(isManifestSelectable) : [];
  const selectedVisibleCount = selectableVisibleRows.filter((row) => selectedShipmentIds.has(row.id)).length;
  const allVisibleSelected = selectableVisibleRows.length > 0 && selectedVisibleCount === selectableVisibleRows.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectedRows = visibleRows.filter((row) => selectedShipmentIds.has(row.id));
  const sameBranch = selectedRows.length > 0 && selectedRows.every((row) => row.branchId === selectedRows[0].branchId);
  const sameAccount = selectedRows.length > 0 && selectedRows.every((row) => row.businessAccountId === selectedRows[0].businessAccountId);
  const canCreateAccountManifest = canCreate && sameBranch && sameAccount && selectedRows.every((row) => row.manifestEligible);
  const canCreateCombined = canCreateCombinedManifest && sameBranch && selectedRows.every((row) => row.combinedManifestEligible);
  const selectedPieces = selectedRows.reduce((sum, row) => sum + row.pieces, 0);
  const selectedWeight = selectedRows.reduce((sum, row) => sum + row.weightKg, 0);

  function isManifestSelectable(row: WorkspaceRow) {
    return client ? row.manifestEligible : row.manifestEligible || row.combinedManifestEligible;
  }

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  async function submitManifest(values: ManifestDialogValues) {
    if (!manifestMode || selectedRows.length === 0) return;
    const input: CreateBulkShipmentManifestInput = {
      shipmentDraftIds: selectedRows.map((row) => row.id),
      origin: values.origin,
      destination: values.destination,
      coloader: values.coloader,
      paymentType: values.paymentType
    };
    setManifestBusy(true);
    setManifestError("");
    try {
      const result = manifestMode === "COMBINED"
        ? await createCombinedShipmentManifest(input, operatorSlug)
        : await createBulkShipmentManifest(input, client ? "client" : "admin", operatorSlug);
      setManifestMode(null);
      router.push(`/portal/${encodeURIComponent(operatorSlug)}/manifests#manifest-${encodeURIComponent(result.manifest.id)}`);
    } catch (cause) {
      setManifestError(cause instanceof Error ? cause.message : "The manifest could not be created. Review the selected shipments and try again.");
    } finally {
      setManifestBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950">Shipments</h1>
            <p className="mt-2 max-w-2xl text-sm leading-5 text-slate-600">Book and follow shipments within this operator workspace.</p>
          </div>
          {canCreate ? (
            <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments/new`} className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:w-auto">
              <FiPlus aria-hidden="true" className="h-4 w-4" /> New shipment
            </Link>
          ) : null}
        </div>

        {error ? <div role="alert" className="mt-6 rounded-lg border border-rose-200 bg-white p-4 text-sm text-rose-800">{error}</div> : null}

        <section aria-label="Shipment list filters" className="mt-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(!client || accounts.length > 1) ? (
                <OperatorSelect
                  id="operator-shipment-account"
                  label="Business account"
                  value={accountId}
                  options={accountOptions}
                  placeholder={client ? "Choose an account" : "All business accounts"}
                  onChange={(value) => {
                    setSelectedShipmentIds(new Set());
                    setLoading(true);
                    setError("");
                    setAccountId(value);
                    setPage(1);
                    if (!value && client) { setRows([]); setPagination(EMPTY_PAGINATION); }
                  }}
                />
              ) : null}
              <OperatorSelect
                id="operator-shipment-status"
                label="Status"
                value={status}
                options={activeStatusOptions}
                placeholder="All statuses"
                onChange={(value) => {
                  setSelectedShipmentIds(new Set());
                  setLoading(true);
                  setError("");
                  setStatus(value);
                  setPage(1);
                }}
              />
              <div className="min-w-0 sm:col-span-2 xl:col-span-1">
                <label htmlFor="operator-shipment-search" className="mb-1.5 block text-sm font-medium text-slate-700">Search shipments</label>
                <div className="relative min-w-0">
                  <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input id="operator-shipment-search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} maxLength={100} placeholder="AWB, consignee, consignor, reference" className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-1" role="tablist" aria-label="Shipment status">
              {(["booked", "drafts"] as const).map((value) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => { setSelectedShipmentIds(new Set()); setLoading(true); setError(""); setTab(value); setStatus(""); setPage(1); }} className={`min-h-9 rounded px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] ${tab === value ? "bg-white text-[#0D1282] shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                  {value === "booked" ? "Booked" : "Drafts"}
                </button>
              ))}
            </div>
          </div>
        </section>

        {canCreate && tab === "booked" ? (
          <section aria-label="Shipment manifest actions" className="mt-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p aria-live="polite" className="text-sm text-slate-700">
              {selectedRows.length
                ? `${selectedRows.length} shipment${selectedRows.length === 1 ? "" : "s"} selected · ${selectedPieces} pcs · ${selectedWeight.toFixed(2)} kg`
                : "Select booked shipments from this page to create a manifest."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {selectedRows.length ? <button type="button" onClick={() => setSelectedShipmentIds(new Set())} className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Clear selection</button> : null}
              <button type="button" onClick={() => { setManifestMode("ACCOUNT"); setManifestError(""); }} disabled={!canCreateAccountManifest || manifestBusy} className="min-h-10 rounded-md bg-[#0D1282] px-3 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:bg-slate-400">Create account manifest</button>
              {canCreateCombinedManifest ? <button type="button" onClick={() => { setManifestMode("COMBINED"); setManifestError(""); }} disabled={!canCreateCombined || manifestBusy} className="min-h-10 rounded-md border border-[#0D1282] bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-600 disabled:hover:bg-white">Create combined manifest</button> : null}
            </div>
          </section>
        ) : null}

        <section aria-label={tab === "booked" ? "Booked shipments" : "Shipment drafts"} className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {loading ? (
            <div aria-label="Loading shipments" className="animate-pulse space-y-3 p-4 sm:p-5">
              <div className="h-11 rounded bg-slate-100" /><div className="h-14 rounded bg-slate-100" /><div className="h-14 rounded bg-slate-100" />
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-base font-semibold text-slate-900">{tab === "booked" ? "No booked shipments yet" : "No shipment drafts"}</p>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-5 text-slate-600">
                {tab === "booked" ? "When a shipment is booked, its operator tracking ID and current status will appear here." : "Unfinished bookings are saved here so your team can continue them later."}
              </p>
              {canCreate ? <Link href={`/portal/${encodeURIComponent(operatorSlug)}/shipments/new`} className="mt-5 inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiPlus aria-hidden="true" className="h-4 w-4" />Create shipment</Link> : null}
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    <tr>{canCreate && tab === "booked" ? <th scope="col" className="w-14 px-4 py-3"><input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} disabled={selectableVisibleRows.length === 0} onChange={(event) => { const selectPage = event.currentTarget.checked; setSelectedShipmentIds((current) => { const next = new Set(current); for (const row of selectableVisibleRows) { if (selectPage) next.add(row.id); else next.delete(row.id); } return next; }); }} aria-label="Select all eligible shipments on this page" className="h-4 w-4 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282] disabled:cursor-not-allowed disabled:opacity-40" /></th> : null}<th scope="col" className="px-5 py-3">AWB</th><th scope="col" className="px-5 py-3">Consignee</th><th scope="col" className="px-5 py-3">Parcels</th><th scope="col" className="px-5 py-3">Amount</th><th scope="col" className="px-5 py-3">Status</th><th scope="col" className="px-5 py-3">Created</th><th scope="col" className="px-5 py-3">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {visibleRows.map((row) => <tr key={row.id}>
                      {canCreate && tab === "booked" ? <td className="px-4 py-4"><input type="checkbox" checked={selectedShipmentIds.has(row.id)} disabled={!isManifestSelectable(row)} onChange={() => setSelectedShipmentIds((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} aria-label={`Select shipment ${row.trackingNumber}`} className="h-4 w-4 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282] disabled:cursor-not-allowed disabled:opacity-40" /></td> : null}
                      <td className="max-w-[17rem] px-5 py-4"><p className="truncate font-semibold tabular-nums text-slate-900" title={row.trackingNumber}>{row.trackingNumber}</p><p className="mt-1 truncate text-xs text-slate-600" title={row.account}>{row.account}</p></td>
                      <td className="max-w-[17rem] px-5 py-4"><p className="truncate font-medium text-slate-900" title={row.consignee}>{row.consignee}</p><p className="mt-1 truncate text-xs text-slate-600" title={row.destinationCountry}>{row.destinationCountry}</p></td>
                      <td className="px-5 py-4"><ShipmentHoverCard
                        label={`Parcel weights for ${row.pieces} ${row.pieces === 1 ? "parcel" : "parcels"}`}
                        fitContent
                        persistOnTouch
                        card={<div>
                          <p className="mb-2 font-semibold text-white">Parcel weights</p>
                          {Math.max(row.pieces, row.parcelWeightsKg.length) > 0 ? <ul className="space-y-1.5">{Array.from({ length: Math.max(row.pieces, row.parcelWeightsKg.length) }, (_, index) => {
                            const weight = row.parcelWeightsKg[index];
                            return <li key={index} className="flex items-center justify-between gap-4"><span className="min-w-0 break-all text-slate-300">{row.parcelNumbers[index] || "Parcel number unavailable"}</span><span className="shrink-0 font-semibold tabular-nums text-white">{typeof weight === "number" && Number.isFinite(weight) ? `${Number(weight.toFixed(3))} kg` : "Weight not recorded"}</span></li>;
                          })}</ul> : <p className="text-slate-300">Parcel weights are not available.</p>}
                        </div>}
                      ><span className="font-semibold text-[#0D1282] underline underline-offset-2 hover:text-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{row.pieces} {row.pieces === 1 ? "parcel" : "parcels"}</span></ShipmentHoverCard></td>
                      <td className="whitespace-nowrap px-5 py-4 font-semibold tabular-nums text-slate-900">{tab === "booked" ? formatMoney(row.bookingAmountMinor, row.currency) : "-"}</td>
                      <td className="px-5 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusTone(row.status)}`}>{row.status}</span></td>
                      <td className="whitespace-nowrap px-5 py-4 tabular-nums text-slate-600">{formatDate(row.createdAt)}</td>
                      <td className="px-5 py-4"><Link href={row.link} className="font-semibold text-[#0D1282] underline-offset-2 hover:underline">Details</Link></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-slate-200 md:hidden">
                {visibleRows.map((row) => <li key={row.id} className="space-y-3 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">{canCreate && tab === "booked" ? <input type="checkbox" checked={selectedShipmentIds.has(row.id)} disabled={!isManifestSelectable(row)} onChange={() => setSelectedShipmentIds((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} aria-label={`Select shipment ${row.trackingNumber}`} className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282] disabled:cursor-not-allowed disabled:opacity-40" /> : null}<div className="min-w-0 flex-1"><p className="break-all font-semibold tabular-nums text-slate-900">{row.trackingNumber}</p><p className="mt-1 truncate text-sm text-slate-600" title={row.account}>{row.account}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusTone(row.status)}`}>{row.status}</span></div>
                  <dl className="grid grid-cols-[minmax(6rem,0.75fr)_minmax(0,1.25fr)] gap-x-3 gap-y-2 text-sm"><dt className="text-slate-500">Consignee</dt><dd className="break-words text-slate-800">{row.consignee}</dd><dt className="text-slate-500">Destination</dt><dd className="break-words text-slate-800">{row.destinationCountry}</dd><dt className="text-slate-500">Parcels</dt><dd><ShipmentHoverCard label={`Parcel weights for ${row.pieces} ${row.pieces === 1 ? "parcel" : "parcels"}`} fitContent persistOnTouch card={<div><p className="mb-2 font-semibold text-white">Parcel weights</p>{Math.max(row.pieces, row.parcelWeightsKg.length) > 0 ? <ul className="space-y-1.5">{Array.from({ length: Math.max(row.pieces, row.parcelWeightsKg.length) }, (_, index) => { const weight = row.parcelWeightsKg[index]; return <li key={index} className="flex items-center justify-between gap-4"><span className="min-w-0 break-all text-slate-300">{row.parcelNumbers[index] || "Parcel number unavailable"}</span><span className="shrink-0 font-semibold tabular-nums text-white">{typeof weight === "number" && Number.isFinite(weight) ? `${Number(weight.toFixed(3))} kg` : "Weight not recorded"}</span></li>; })}</ul> : <p className="text-slate-300">Parcel weights are not available.</p>}</div>}><span className="font-semibold text-[#0D1282] underline underline-offset-2">{row.pieces} {row.pieces === 1 ? "parcel" : "parcels"}</span></ShipmentHoverCard></dd><dt className="text-slate-500">Amount</dt><dd className="font-semibold tabular-nums text-slate-800">{tab === "booked" ? formatMoney(row.bookingAmountMinor, row.currency) : "-"}</dd><dt className="text-slate-500">Created</dt><dd className="text-slate-700">{formatDate(row.createdAt)}</dd></dl>
                  <Link href={row.link} className="inline-flex min-h-10 items-center font-semibold text-[#0D1282] underline-offset-2 hover:underline">Details</Link>
                </li>)}
              </ul>
            </>
          )}
          {!loading && !error ? <Pagination pagination={pagination} onChange={(nextPage) => { setSelectedShipmentIds(new Set()); setLoading(true); setPage(nextPage); }} /> : null}
        </section>
      </main>
      {manifestMode ? <CreateManifestDialog
        title={manifestMode === "COMBINED" ? "Create combined manifest" : "Create account manifest"}
        shipmentCount={selectedRows.length}
        totalPieces={selectedPieces}
        totalWeightKg={selectedWeight}
        defaults={{ origin: selectedRows[0]?.branch || "", destination: "", coloader: "", paymentType: "" }}
        busy={manifestBusy}
        error={manifestError}
        onCancel={() => { if (!manifestBusy) setManifestMode(null); }}
        onConfirm={(values) => void submitManifest(values)}
      /> : null}
    </div>
  );
}
