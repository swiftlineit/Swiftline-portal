"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiAlertTriangle, FiArchive, FiArrowDown, FiExternalLink, FiFileText, FiPlus, FiSearch, FiTrash2, FiX } from "react-icons/fi";
import { BsArrowCounterclockwise } from "react-icons/bs";
import { toast } from "react-toastify";
import CreateManifestDialog, { type ManifestDialogValues } from "@/components/shipments/CreateManifestDialog";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import ParcelManifestCell from "@/components/shipments/ParcelManifestCell";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { SortableHeader, TableToolbar, defaultPageSizeOptions, type TableColumnOption } from "@/components/ui/TableToolbar";
import { ScheduleChip } from "@/components/shipments/ShipmentJourney";
import GatewayIataInput, { isValidGatewayIata } from "@/components/shipments/GatewayIataInput";
import { emptyDateRange, type DateRange } from "@/lib/dateRange";
import { currentDateTimeLocal, dateTimeLocalToIso, formatDashboardDate, formatDashboardDateTime } from "@/lib/dateFormat";
import { formatCsbType } from "@/lib/csbType";
import { createBulkShipmentManifest, manifestsHref } from "@/lib/shipmentManifests";
import { shipmentInvoicePageUrl } from "@/lib/shipmentInvoices";
import {
  bulkUpdateDpdShipmentOperationalStatus,
  rebookShipmentDraft,
  shipmentOperationalStatusOptions,
  type BulkShipmentStatusResult,
  type ShipmentOperationalStatus
} from "@/lib/dpdLabels";
import { listBusinessAccounts, type BusinessAccount } from "@/lib/businessAccounts";
import {
  parseShipmentDestinationRegions,
  shipmentDestinationRegionOptions,
  type ShipmentDestinationRegionCode
} from "@/lib/shipmentDestinationRegions";
import {
  deleteBookedShipment,
  listShipments,
  shipmentDetailsHref,
  shipmentListParams,
  shipmentListPath,
  shipmentStatusOptions,
  type DpdLabelStatus,
  type ShipmentAudience,
  type ShipmentListItem,
  type ShipmentListPagination
} from "@/lib/shipmentsList";

const emptyPagination: ShipmentListPagination = { page: 1, limit: 20, total: 0, totalPages: 1 };
const REBOOKED_FILTER_VALUE = "__REBOOKED__";
const PUBLIC_BOOKING_FILTER_VALUE = "PUBLIC_ONLINE";
// One-time namespace bump prevents an earlier saved test filter from hiding
// the normal list after this persistence behavior is introduced.
const shipmentViewStorageVersion = "v2";
const shipmentViewQueryKeys = [
  "search",
  "status",
  "attention",
  "bookedDate",
  "rebooked",
  "dateFrom",
  "dateTo",
  "businessAccountId",
  "creationSource",
  "destinationRegions",
  "view",
  "page",
  "limit",
  "sort"
] as const;

type ShipmentViewState = {
  search: string;
  status: string;
  attentionOnly: boolean;
  bookedDate: string;
  rebookedOnly: boolean;
  dateRange: DateRange;
  businessAccountId: string;
  creationSource: string;
  destinationRegions: ShipmentDestinationRegionCode[];
  page: number;
  limit: number;
  sort: string;
};

function parsePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePageSize(value: string | null) {
  const parsed = Number(value);
  return defaultPageSizeOptions.includes(parsed) ? parsed : defaultPageSizeOptions[0];
}

function parseShipmentSort(value: string | null) {
  return value === "booked:asc" || value === "booked:desc" ? value : "booked:desc";
}

function readShipmentViewState(value: string | null): ShipmentViewState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const savedDateRange = parsed.dateRange as Record<string, unknown> | undefined;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      status: typeof parsed.status === "string" ? parsed.status : "",
      attentionOnly: parsed.attentionOnly === true,
      bookedDate: typeof parsed.bookedDate === "string" ? parsed.bookedDate : "",
      rebookedOnly: parsed.rebookedOnly === true,
      dateRange: {
        from: typeof savedDateRange?.from === "string" ? savedDateRange.from : "",
        to: typeof savedDateRange?.to === "string" ? savedDateRange.to : ""
      },
      businessAccountId: typeof parsed.businessAccountId === "string" ? parsed.businessAccountId : "",
      creationSource: parsed.creationSource === PUBLIC_BOOKING_FILTER_VALUE ? PUBLIC_BOOKING_FILTER_VALUE : "",
      destinationRegions: Array.isArray(parsed.destinationRegions)
        ? parseShipmentDestinationRegions(
          parsed.destinationRegions.filter((value): value is string => typeof value === "string").join(",")
        )
        : [],
      page: typeof parsed.page === "number" && Number.isInteger(parsed.page) && parsed.page > 0 ? parsed.page : 1,
      limit: typeof parsed.limit === "number" && defaultPageSizeOptions.includes(parsed.limit)
        ? parsed.limit
        : defaultPageSizeOptions[0],
      sort: parsed.sort === "booked:asc" || parsed.sort === "booked:desc" ? parsed.sort : "booked:desc"
    };
  } catch {
    return null;
  }
}

function formatMoney(shipment: ShipmentListItem) {
  if (!shipment.shipmentInvoice) return "-";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: shipment.shipmentInvoice.currency,
    minimumFractionDigits: 2
  }).format(shipment.shipmentInvoice.chargeableAmountMinor / 100);
}

const dpdLabelPresentation: Record<DpdLabelStatus, { label: string; className: string }> = {
  AVAILABLE: { label: "DPD label available", className: "text-emerald-700" },
  NOT_AVAILABLE: { label: "DPD label not available", className: "text-red-600" },
  NOT_APPLICABLE: { label: "DPD label not applicable", className: "text-slate-500" }
};

function DpdLabelAvailability({ status }: { status: DpdLabelStatus }) {
  const presentation = dpdLabelPresentation[status];
  return (
    <p className={`mt-1 text-[10px] font-semibold leading-4 ${presentation.className}`}>
      {presentation.label}
    </p>
  );
}

function getAccountLabel(account: BusinessAccount) {
  return `${account.accountId} - ${account.company.companyName || account.contact.email}`;
}

function truncateBusinessAccountName(value: string, maxLength = 14) {
  const name = value.trim();
  if (!name) return "Not available";
  return name.length > maxLength ? `${name.slice(0, maxLength).trimEnd()}…` : name;
}

function visibleAccountName(shipment: ShipmentListItem) {
  return shipment.creationSource === "PUBLIC_ONLINE" ? "Public online" : shipment.businessAccountName;
}

/**
 * The stage a shipment is standing at, as the status filter spells it. Falls
 * back to the raw value so an unmapped status is still readable.
 */
function formatStageLabel(status: string) {
  const visibleLabel = shipmentStatusOptions.find((option) => option.value === status)?.label;
  if (visibleLabel) return visibleLabel;
  // Defensive fallback during a staggered frontend/backend deployment. The
  // current API returns canonical values, but an old cached response must still
  // use the one visible stage name rather than exposing legacy filters again.
  if (status === "EXPORT_CUSTOMS_CLEARED" || status === "FLIGHT_ASSIGNED") return "Ready for Export";
  if (status === "FLIGHT_DEPARTED") return "Dispatched from Delhi Hub";
  return status;
}

/**
 * A shipment the operations user may push forward from the list. It must be a
 * completed booking, and it must not be on hold or cancelled- both are current
 * states, which is exactly what the list's `status` field holds (the newest
 * customer-visible event). Manifests and holds never block this, so the same-
 * day, same-flight shipments the bulk update exists for stay selectable.
 */
function isStatusUpdateEligible(shipment: ShipmentListItem) {
  return shipment.bookingStatus === "LABEL_RECEIVED"
    && shipment.status !== "ON_HOLD"
    && shipment.status !== "SHIPMENT_CANCELLED";
}

/**
 * The Shipments listing shared by the staff and client portals. It shows the same
 * columns as the Recent Shipments table on the Create Shipment page, plus a
 * selection column that feeds the bulk actions.
 *
 * Staff see two bulk actions. "Create Manifest" groups bookings into one
 * handover document. "Update Status" records the same operational status across
 * every selected shipment at once- the case where a day's bookings fly together
 * and move through the same stages together.
 *
 * `role` is the signed-in portal role and is only read to decide whether the
 * per-row Delete action is offered. It is absent on the client portal, which
 * never shows it. The server enforces the same rule regardless of what is
 * rendered here.
 */
export default function ShipmentsListPage({ audience, role }: { audience: ShipmentAudience; role?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const attentionOnlyFromQuery = searchParams.get("attention") === "1" || searchParams.get("attention") === "true";
  const bookedDateFromQuery = searchParams.get("bookedDate") ?? "";
  const statusFromQuery = searchParams.get("status") ?? "";
  const rebookedFromQuery = searchParams.get("rebooked") === "1" || searchParams.get("rebooked") === "true";
  const dateFromQuery = searchParams.get("dateFrom") ?? "";
  const dateToQuery = searchParams.get("dateTo") ?? "";
  const searchFromQuery = searchParams.get("search")?.trim() ?? "";
  const businessAccountFromQuery = searchParams.get("businessAccountId") ?? "";
  const creationSourceFromQuery = searchParams.get("creationSource") === PUBLIC_BOOKING_FILTER_VALUE
    ? PUBLIC_BOOKING_FILTER_VALUE
    : "";
  const destinationRegionsFromQuery = parseShipmentDestinationRegions(searchParams.get("destinationRegions"));
  const allShipmentsViewFromQuery = searchParams.get("view") === "all";
  const pageFromQuery = parsePositiveInteger(searchParams.get("page"), 1);
  const limitFromQuery = parsePageSize(searchParams.get("limit"));
  const sortFromQuery = parseShipmentSort(searchParams.get("sort"));
  const hasShipmentViewQuery = shipmentViewQueryKeys.some((key) => searchParams.has(key));
  const [shipments, setShipments] = useState<ShipmentListItem[]>([]);
  const [pagination, setPagination] = useState<ShipmentListPagination>(emptyPagination);
  // Keyed by shipment id so a selection survives moving to another page - only
  // the rows on the page that was just (re)loaded are ever touched below.
  const [selected, setSelected] = useState<Map<string, ShipmentListItem>>(new Map());
  // Which bulk action the selection bar is serving, if any. Holds the two flows
  // apart: the manifest checks account/branch, the status update does not.
  const [activeFlow, setActiveFlow] = useState<"manifest" | "status" | null>(null);
  const [status, setStatus] = useState(rebookedFromQuery ? "" : statusFromQuery);
  const [rebookedOnly, setRebookedOnly] = useState(rebookedFromQuery);
  const [bookedDate, setBookedDate] = useState(bookedDateFromQuery);
  const [attentionOnly, setAttentionOnly] = useState(attentionOnlyFromQuery);
  // Business-account filter, staff only. Clients are already scoped to the
  // accounts they belong to, so the dropdown would only ever offer one row.
  const [businessAccountId, setBusinessAccountId] = useState(
    creationSourceFromQuery ? "" : businessAccountFromQuery
  );
  const [creationSource, setCreationSource] = useState(creationSourceFromQuery);
  const [destinationRegions, setDestinationRegions] = useState<ShipmentDestinationRegionCode[]>(destinationRegionsFromQuery);
  const [accounts, setAccounts] = useState<BusinessAccount[]>([]);
  const [bulkStatus, setBulkStatus] = useState<ShipmentOperationalStatus>("PARCEL_COLLECTED");
  const [bulkStatusNote, setBulkStatusNote] = useState("");
  const [bulkStatusLocation, setBulkStatusLocation] = useState("");
  const [bulkStatusGatewayCode, setBulkStatusGatewayCode] = useState("");
  /**
   * When these scans actually happened, as a datetime-local value.
   *
   * Optional. Left empty, each event is stamped with the moment it is recorded,
   * exactly as before. Filled in, that is the time the customer's timeline
   * shows- which is how a batch keyed in a day late still reads correctly.
   */
  const [bulkStatusAt, setBulkStatusAt] = useState("");
  const [bulkStatusBusy, setBulkStatusBusy] = useState(false);
  const [bulkStatusResult, setBulkStatusResult] = useState<BulkShipmentStatusResult | null>(null);
  /**
   * What is typed, and what has actually been searched for.
   *
   * Held apart so the list refetches once the typing settles rather than on
   * every keystroke- this is a server-side search across every page, not a
   * filter over the rows already on screen.
   */
  const [searchInput, setSearchInput] = useState(searchFromQuery);
  const [search, setSearch] = useState(searchFromQuery);
  const [dateRange, setDateRange] = useState(() => ({
    from: dateFromQuery || bookedDateFromQuery,
    to: dateToQuery || bookedDateFromQuery
  }));
  const [page, setPage] = useState(pageFromQuery);
  // Rows per page. 20 is what this table has always opened at; the toolbar
  // offers the larger sizes for working a whole day's shipments in one screen.
  const [limit, setLimit] = useState(limitFromQuery);
  // Newest booking first, the order this table has always opened in.
  const [sort, setSort] = useState(sortFromQuery);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(
    // Staff open on the Parcels scan state; the lane stays available as an
    // opt-in column rather than taking table width by default.
    () => new Set(audience === "admin" ? ["route"] : [])
  );
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [lastManifestNumber, setLastManifestNumber] = useState("");
  // The row awaiting delete confirmation. Held rather than a bare id so the
  // prompt can name the shipment the operator is about to remove.
  const [pendingDelete, setPendingDelete] = useState<ShipmentListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Single rebook in flight - tracks which booked shipment is being cloned.
  const [rebookingId, setRebookingId] = useState<string | null>(null);
  const [restoringView, setRestoringView] = useState(true);
  const restoredView = useRef(false);

  // A selection may span pages, but it must never survive a change to the
  // query that defines those pages. Otherwise hidden rows from an earlier
  // filter can travel into a later bulk update.
  const selectionScope = JSON.stringify({
    audience,
    attentionOnly,
    bookedDate,
    businessAccountId,
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    creationSource,
    destinationRegions: [...destinationRegions].sort(),
    rebookedOnly,
    search,
    sort,
    status
  });
  const previousSelectionScope = useRef(selectionScope);

  const createShipmentHref = audience === "client" ? "/client/dpd-labels" : "/dashboard/dpd-labels";
  const shipmentPagePath = audience === "client" ? "/client/shipments" : "/dashboard/shipments";
  // Staff table only, and only for an administrator. Operations and delivery
  // work this list daily but do not remove rows from it.
  const canDelete = audience === "admin" && role === "admin";
  // Rebook is staff-only: admin and operations may rebook any booked shipment
  // into a new EDITABLE draft preserving its businessAccountId + branchId
  // (individual shipments keep their original branch). Delivery/finance see no button.
  const canRebook = audience === "admin" && (role === "admin" || role === "operations");

  /**
   * Columns a customer may hide. AWB and Actions are locked: one identifies the
   * row and the other is how anything gets done with it, so a table without
   * them is not a shorter table, it is a broken one.
   */
  const columnOptions: TableColumnOption[] = [
    { key: "awb", label: "AWB / Shipment No.", locked: true },
    { key: "consignee", label: "Consignee" },
    // Staff-only scan state. Separate key from "route" so each column is
    // toggled independently; clients never see this entry.
    ...(audience === "admin" ? [{ key: "parcels", label: "Parcels" }] : []),
    { key: "route", label: "Route" },
    { key: "amount", label: "Chargeable Amount" },
    { key: "status", label: "Status" },
    { key: "eta", label: "Estimated Delivery" },
    { key: "created", label: "Created" },
    { key: "actions", label: "Actions", locked: true }
  ];
  const shows = (key: string) => !hiddenColumns.has(key);
  const [sortKey = "booked", sortDirection = "desc"] = sort.split(":");

  function applySort(key: string, direction: "asc" | "desc") {
    setSort(`${key}:${direction}`);
    // A reordered list has a different first page, so staying on page four
    // would show rows from the middle of the new order.
    setPage(1);
  }

  const load = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await listShipments(audience, {
        page,
        limit,
        status,
        search,
        dateRange: bookedDate ? emptyDateRange : dateRange,
        bookedDate,
        rebooked: rebookedOnly,
        businessAccountId: creationSource ? "" : businessAccountId,
        creationSource: creationSource === PUBLIC_BOOKING_FILTER_VALUE ? "PUBLIC_ONLINE" : undefined,
        destinationRegions: audience === "admin" ? destinationRegions : [],
        sort,
        attention: attentionOnly
      });
      setShipments(data.shipments);
      setPagination(data.pagination);
      // The API clamps a page that no longer exists after data changes. Keep
      // local state and the persisted URL aligned with that server decision.
      setPage((current) => current === data.pagination.page ? current : data.pagination.page);
      // Refresh or drop only the selections that belong to this page - a shipment
      // manifested elsewhere in the meantime is no longer eligible and falls out,
      // but selections on other pages are left untouched so they survive paging.
      setSelected((current) => {
        if (!current.size) return current;
        const next = new Map(current);
        for (const shipment of data.shipments) {
          if (!next.has(shipment.id)) continue;
          const stillSelectable = shipment.manifestEligible || (audience === "admin" && isStatusUpdateEligible(shipment));
          if (stillSelectable) next.set(shipment.id, shipment);
          else next.delete(shipment.id);
        }
        return next;
      });
    } catch (caught) {
      // A background reconciliation must not replace a successful optimistic
      // update with a full-page error. The next normal load will try again.
      if (!options.background) {
        setError(caught instanceof Error ? caught.message : "Unable to load shipments.");
      }
    } finally {
      if (!options.background) setLoading(false);
    }
  }, [attentionOnly, audience, bookedDate, businessAccountId, creationSource, dateRange, destinationRegions, limit, page, rebookedOnly, search, sort, status]);

  // The URL wins when it contains a dashboard drill-down or an explicit
  // filter. Otherwise restore only this audience's last view from the tab
  // session, then fetch the current rows from the server.
  useEffect(() => {
    if (restoredView.current) return;

    const saved = !hasShipmentViewQuery
      ? readShipmentViewState(
        window.sessionStorage.getItem(`swiftline:shipments:${shipmentViewStorageVersion}:${audience}`)
      )
      : null;
    const timer = window.setTimeout(() => {
      // Mark this complete only when the deferred callback actually runs. In
      // React Strict Mode the first effect pass is cleaned up immediately;
      // marking it before the callback would cancel the timer and leave the
      // shipment fetch gated forever.
      restoredView.current = true;
      if (saved) {
        setSearchInput(saved.search);
        setSearch(saved.search);
        setStatus(saved.rebookedOnly ? "" : saved.status);
        setRebookedOnly(saved.rebookedOnly);
        setAttentionOnly(saved.attentionOnly);
        setBookedDate(saved.bookedDate);
        setDateRange(saved.dateRange);
        setBusinessAccountId(audience === "admin" && !saved.creationSource ? saved.businessAccountId : "");
        setCreationSource(audience === "admin" ? saved.creationSource : "");
        setDestinationRegions(audience === "admin" ? saved.destinationRegions : []);
        setPage(saved.page);
        setLimit(saved.limit);
        setSort(saved.sort);
      }
      setRestoringView(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [audience, hasShipmentViewQuery]);

  // The sidebar's All Shipments link is an explicit reset command. It must win
  // over both the current in-memory filters and the tab's saved view, otherwise
  // a previous attention-only KPI drill-down can make the canonical list look
  // empty when there are simply no attention shipments.
  useEffect(() => {
    if (!allShipmentsViewFromQuery) return;

    const timer = window.setTimeout(() => {
      // Mark this reset complete only when the deferred callback runs, matching
      // the Strict Mode-safe restoration path above.
      restoredView.current = true;
      setSearchInput("");
      setSearch("");
      setStatus("");
      setRebookedOnly(false);
      setAttentionOnly(false);
      setBookedDate("");
      setDateRange(emptyDateRange);
      setBusinessAccountId("");
      setCreationSource("");
      setDestinationRegions([]);
      setPage(1);
      setLimit(defaultPageSizeOptions[0]);
      setSort("booked:desc");
      setRestoringView(false);
      router.replace(shipmentPagePath, { scroll: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [allShipmentsViewFromQuery, router, shipmentPagePath]);

  // Deferred so the fetch's setState lands after the first paint rather than
  // cascading a render, matching the other listing screens.
  useEffect(() => {
    if (restoringView || allShipmentsViewFromQuery) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [allShipmentsViewFromQuery, load, restoringView]);

  // Keep the view addressable for refreshes/browser history and keep a
  // tab-scoped fallback for navigation links that return to the bare list
  // route. Only controls are saved; shipment rows are always reloaded.
  useEffect(() => {
    if (restoringView || allShipmentsViewFromQuery) return;

    const savedState: ShipmentViewState = {
      search,
      status: rebookedOnly ? "" : status,
      attentionOnly,
      bookedDate,
      rebookedOnly,
      dateRange: { from: dateRange.from, to: dateRange.to },
      businessAccountId: audience === "admin" && !creationSource ? businessAccountId : "",
      creationSource: audience === "admin" ? creationSource : "",
      destinationRegions: audience === "admin" ? destinationRegions : [],
      page,
      limit,
      sort
    };
    try {
      window.sessionStorage.setItem(
        `swiftline:shipments:${shipmentViewStorageVersion}:${audience}`,
        JSON.stringify(savedState)
      );
    } catch {
      // Private browsing or a full storage quota should not block the table.
    }

    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status && !rebookedOnly) params.set("status", status);
    if (attentionOnly) params.set("attention", "1");
    if (bookedDate) {
      params.set("bookedDate", bookedDate);
    } else {
      if (dateRange.from) params.set("dateFrom", dateRange.from);
      if (dateRange.to) params.set("dateTo", dateRange.to);
    }
    if (rebookedOnly) params.set("rebooked", "1");
    if (audience === "admin" && creationSource === PUBLIC_BOOKING_FILTER_VALUE) {
      params.set("creationSource", "PUBLIC_ONLINE");
    } else if (audience === "admin" && businessAccountId) {
      params.set("businessAccountId", businessAccountId);
    }
    if (audience === "admin" && destinationRegions.length) params.set("destinationRegions", destinationRegions.join(","));
    if (page > 1) params.set("page", String(page));
    if (limit !== defaultPageSizeOptions[0]) params.set("limit", String(limit));
    if (sort !== "booked:desc") params.set("sort", sort);

    const nextSearch = params.toString();
    if (window.location.search.slice(1) !== nextSearch) {
      router.replace(
        `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
        { scroll: false }
      );
    }
  }, [allShipmentsViewFromQuery, attentionOnly, audience, bookedDate, businessAccountId, creationSource, dateRange.from, dateRange.to, destinationRegions, limit, page, rebookedOnly, restoringView, router, search, sort, status]);

  useEffect(() => {
    if (previousSelectionScope.current === selectionScope) return;
    previousSelectionScope.current = selectionScope;
    setSelected(new Map());
    setActiveFlow(null);
    setBulkStatusResult(null);
  }, [selectionScope]);

  // The account list powers the staff filter. All accounts are shown, not just
  // active ones, so a suspended account's historical shipments stay findable.
  useEffect(() => {
    if (audience !== "admin") return;
    let mounted = true;
    listBusinessAccounts()
      .then((data) => { if (mounted) setAccounts(data.accounts); })
      .catch(() => { /* the filter stays empty; the table still loads */ });
    return () => { mounted = false; };
  }, [audience]);

  // Applies the typed term once typing settles, and returns to page one- the
  // page you were on rarely exists in a narrower result set.
  useEffect(() => {
    if (restoringView) return;
    const timer = window.setTimeout(() => {
      setSearch((current) => {
        if (current === searchInput.trim()) return current;
        setPage(1);
        return searchInput.trim();
      });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [restoringView, searchInput]);

  // Staff may select anything they could act on; a client's rows are still
  // gated on manifest eligibility because the manifest is their only action.
  const selectable = useMemo(() => shipments.filter((shipment) => (
    audience === "admin" ? shipment.manifestEligible || isStatusUpdateEligible(shipment) : shipment.manifestEligible
  )), [audience, shipments]);
  const selectedList = useMemo(() => [...selected.values()], [selected]);
  // Each flow works from the subset of the selection it can actually act on, so
  // a mixed selection never sends an ineligible row to the other flow's API.
  const manifestSelection = useMemo(() => selectedList.filter((shipment) => shipment.manifestEligible), [selectedList]);
  const statusSelection = useMemo(() => selectedList.filter(isStatusUpdateEligible), [selectedList]);
  const manifestTotals = useMemo(() => ({
    pieces: manifestSelection.reduce((sum, shipment) => sum + shipment.pieces, 0),
    weightKg: manifestSelection.reduce((sum, shipment) => sum + shipment.weightKg, 0)
  }), [manifestSelection]);

  // A manifest covers one business account and branch, so a mixed selection
  // cannot become one document.
  const mixedSelection = manifestSelection.length > 1 && manifestSelection.some((shipment) =>
    shipment.businessAccountId !== manifestSelection[0]?.businessAccountId
    || shipment.branchId !== manifestSelection[0]?.branchId);

  /**
   * The distinct stages the status selection spans.
   *
   * A bulk update records one status across many shipments, which only means
   * something if they are all standing at the same point. Mixing stages would
   * advance some while writing the rest a second, identical timeline row for a
   * scan that never happened twice, so the server refuses the batch whole. The
   * same rule is applied here so the operator is told while they are still
   * choosing, rather than by a toast after the click.
   */
  const selectedStages = useMemo(
    () => [...new Set(statusSelection.map((shipment) => shipment.status))],
    [statusSelection]
  );
  const selectedDestinationCountries = useMemo(
    () => [...new Set(statusSelection.map((shipment) => shipment.destinationCountry.trim()).filter(Boolean))],
    [statusSelection]
  );
  const mixedStatusSelection = selectedStages.length > 1;
  const alreadyAtBulkStatus = selectedStages.length === 1 && selectedStages[0] === bulkStatus;
  const isBulkGatewayStatus = bulkStatus === "DESTINATION_ARRIVED";
  const mixedGatewayDestinations = isBulkGatewayStatus && selectedDestinationCountries.length > 1;
  const bulkIsUkRoute = selectedDestinationCountries.length === 1
    && ["GB", "UK", "UNITED KINGDOM"].includes(selectedDestinationCountries[0]?.toUpperCase() ?? "");
  const bulkGatewayInvalid = isBulkGatewayStatus
    && !isValidGatewayIata(bulkIsUkRoute ? "LHR" : bulkStatusGatewayCode);
  const bulkStatusBlocked = mixedStatusSelection
    || alreadyAtBulkStatus
    || mixedGatewayDestinations
    || bulkGatewayInvalid;

  const allSelected = selectable.length > 0 && selectable.every((shipment) => selected.has(shipment.id));

  // Selects/deselects only the current page's eligible rows, leaving any
  // selections already made on other pages untouched.
  function toggleAll() {
    setSelected((current) => {
      const next = new Map(current);
      if (allSelected) {
        for (const shipment of selectable) next.delete(shipment.id);
      } else {
        for (const shipment of selectable) next.set(shipment.id, shipment);
      }
      return next;
    });
  }

  function toggleOne(shipment: ShipmentListItem) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(shipment.id)) next.delete(shipment.id);
      else next.set(shipment.id, shipment);
      return next;
    });
  }

  async function handleCreate(values: ManifestDialogValues) {
    const shipmentDraftIds = manifestSelection.map((shipment) => shipment.id);
    if (!shipmentDraftIds.length) {
      toast.error("Select at least one shipment that is eligible for a manifest.");
      return;
    }
    setCreating(true);
    try {
      const result = await createBulkShipmentManifest({ shipmentDraftIds, ...values }, audience);
      toast.success(`Manifest ${result.manifest.manifestNumber} generated with ${shipmentDraftIds.length} `
        + `${shipmentDraftIds.length === 1 ? "shipment" : "shipments"}.`);
      setLastManifestNumber(result.manifest.manifestNumber);
      setDialogOpen(false);
      setSelected(new Map());
      setActiveFlow(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Manifest could not be generated.");
    } finally {
      setCreating(false);
    }
  }

  async function handleBulkStatusUpdate() {
    const shipmentDraftIds = statusSelection.map((shipment) => shipment.id);
    if (!shipmentDraftIds.length || bulkStatusBlocked) return;

    setBulkStatusBusy(true);
    setError("");
    try {
      const result = await bulkUpdateDpdShipmentOperationalStatus({
        shipmentDraftIds,
        expectedStatuses: statusSelection.map((shipment) => ({
          shipmentDraftId: shipment.id,
          status: shipment.status
        })),
        status: bulkStatus,
        note: bulkStatusNote,
        location: bulkStatusLocation,
        gatewayCode: isBulkGatewayStatus
          ? (bulkIsUkRoute ? "LHR" : bulkStatusGatewayCode)
          : undefined,
        eventAt: dateTimeLocalToIso(bulkStatusAt)
      });
      setBulkStatusResult(result);
      if (result.updated?.length) {
        const updatedByDraft = new Map(result.updated.map((item) => [item.shipmentDraftId, item]));
        setShipments((current) => current.map((shipment) => {
          const updated = updatedByDraft.get(shipment.id);
          return updated
            ? {
              ...shipment,
              status: updated.status,
              statusLabel: updated.statusLabel,
              lastScan: updated.lastScan
            }
            : shipment;
        }));
      }
      toast.success(result.message);
      setActiveFlow(null);
      setBulkStatusNote("");
      setBulkStatusLocation("");
      setBulkStatusGatewayCode("");
      setBulkStatusAt("");
      setSelected(new Map());
      // The API already returned the exact changed rows, so the operator can
      // continue immediately. Reconcile filters, pagination and estimates in
      // the background without putting the whole table back into loading.
      void load({ background: true });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The bulk status update could not be completed.");
    } finally {
      setBulkStatusBusy(false);
    }
  }

  async function handleRebook(shipmentId: string) {
    if (rebookingId) return;
    setRebookingId(shipmentId);
    try {
      const result = await rebookShipmentDraft(shipmentId);
      toast.success("Shipment cloned for rebooking. Complete the booking.");
      router.push(`/dashboard/dpd-labels/${result.shipmentDraft._id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Rebooking failed. Please try again.");
    } finally {
      setRebookingId(null);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await deleteBookedShipment(pendingDelete.id);
      toast.success(result.message || "Shipment deleted.");
      // Dropped from the selection too: a deleted row must not travel into a
      // manifest or a bulk status update on the next click.
      setSelected((current) => {
        if (!current.has(pendingDelete.id)) return current;
        const next = new Map(current);
        next.delete(pendingDelete.id);
        return next;
      });
      setPendingDelete(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The shipment could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-8xl ">
      <section className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-[#0D1282]">Shipments

              {attentionOnly ? (
              <span className="ml-4 inline-flex items-center gap-2 rounded-full bg-amber-50 px-2.5 py-1 text-sm font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
                Attention needed only
                <Link href={`${audience === "client" ? "/client/shipments" : "/dashboard/shipments"}?attention=0`} aria-label="Clear attention filter" className="rounded-full p-0.5 hover:bg-amber-100">
                  <FiX aria-hidden="true" className="h-3 w-3" />
                </Link>
              </span>
            ) : null}
            </h1>

            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
              {attentionOnly
                ? "Showing shipments with an active exception or unresolved booking outcome."
                : audience === "client"
                ? "Your booked shipments. Select one or more to generate a manifest."
                : "All booked shipments across business accounts. Select one or more to update their status at once."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={manifestsHref(audience)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:border-[#0D1282]/40 hover:bg-[#0D1282]/5"
            >
              <FiArchive aria-hidden="true" className="h-4 w-4" />
              View Manifests
            </Link>
            <Link
              href={createShipmentHref}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90"
            >
              <FiPlus aria-hidden="true" className="h-4 w-4" />
              Create New Shipment
            </Link>
          </div>
        </div>

        <div className="px-5 py-5 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">
            <div
              className={`grid gap-4 ${
                audience === "admin"
                  ? "md:grid-cols-2 xl:grid-cols-12"
                  : "md:grid-cols-2 xl:grid-cols-8"
              }`}
            >
              {/* Search */}
              <label
                className={`block min-w-0 ${
                  audience === "admin"
                    ? "xl:col-span-4"
                    : "xl:col-span-3"
                }`}
              >
                <span className="mb-1.5 block text-xs font-semibold text-slate-600">
                  Search
                </span>

                <div className="relative">
                  <FiSearch
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    maxLength={80}
                    placeholder="Search AWB, consignee, destination, or reference"
                    className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-10 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                  />

                  {searchInput ? (
                    <button
                      type="button"
                      onClick={() => setSearchInput("")}
                      aria-label="Clear search"
                      className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    >
                      <FiX aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </label>

              {/* Date range */}
              <div
                className={`min-w-0 ${
                  audience === "admin"
                    ? "xl:col-span-4"
                    : "xl:col-span-3"
                }`}
              >
                <span className="mb-1.5 block text-xs font-semibold text-slate-600">
                  Date range
                </span>

                <div className="[&_*]:rounded-lg">
                  <DateRangeFilter
                    value={dateRange}
                    onChange={(value) => {
                      setBookedDate("");
                      setDateRange(value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>

              {/* Business account */}
              {audience === "admin" ? (
                <label className="block min-w-0 xl:col-span-2">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-600">
                    Business account
                  </span>

                  <div className="relative">
                    <select
                      value={creationSource || businessAccountId}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === PUBLIC_BOOKING_FILTER_VALUE) {
                          setBusinessAccountId("");
                          setCreationSource(PUBLIC_BOOKING_FILTER_VALUE);
                        } else {
                          setCreationSource("");
                          setBusinessAccountId(value);
                        }
                        setPage(1);
                      }}
                      className="h-11 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-900 outline-none transition hover:border-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                    >
                      <option value="">All Business Accounts</option>
                      <option value={PUBLIC_BOOKING_FILTER_VALUE}>Public online</option>
                      {accounts.map((account) => (
                        <option key={account._id} value={account._id}>
                          {getAccountLabel(account)}
                        </option>
                      ))}
                    </select>

                    <FiArrowDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400/70"
                    />
                  </div>
                </label>
              ) : null}

              {/* Status */}
              <label className="block min-w-0 xl:col-span-2">
                <span className="mb-1.5 block text-xs font-semibold text-slate-600">
                  Status
                </span>

                <div className="relative">
                  <select
                    value={rebookedOnly ? REBOOKED_FILTER_VALUE : status}
                    onChange={(event) => {
                      const value = event.target.value;
                      const isRebooked = value === REBOOKED_FILTER_VALUE;
                      setRebookedOnly(isRebooked);
                      setStatus(isRebooked ? "" : value);
                      setPage(1);
                    }}
                    className="h-11 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-900 outline-none transition hover:border-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                  >
                    <option value="">All Status</option>
                    {shipmentStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                    {audience === "admin" ? (
                      <option value={REBOOKED_FILTER_VALUE}>Rebooked</option>
                    ) : null}
                  </select>

                  <FiArrowDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400/70"
                  />
                </div>
              </label>

            </div>
          </div>

          {/* Bulk actions */}
          <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-h-6">
              {selectedList.length ? (
                <span className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {selectedList.length} selected
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setActiveFlow((current) =>
                    current === "manifest" ? null : "manifest",
                  )
                }
                className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3.5 text-sm font-semibold transition ${
                  activeFlow === "manifest"
                    ? "border-[#0D1282] bg-[#0D1282] text-white"
                    : "border-slate-300 bg-white text-[#0D1282] hover:border-[#0D1282]/30 hover:bg-[#0D1282]/5"
                }`}
              >
                <FiArchive aria-hidden="true" className="h-3.5 w-3.5" />
                Create Manifest
              </button>

              {audience === "admin" ? (
                <button
                  type="button"
                  onClick={() =>
                    setActiveFlow((current) =>
                      current === "status" ? null : "status",
                    )
                  }
                  className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3.5 text-sm font-semibold transition ${
                    activeFlow === "status"
                      ? "border-[#0D1282] bg-[#0D1282] text-white"
                      : "border-slate-300 bg-white text-[#0D1282] hover:border-[#0D1282]/30 hover:bg-[#0D1282]/5"
                  }`}
                >
                  <FiArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  Update Status
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {lastManifestNumber ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-sm font-semibold text-emerald-800">
            Manifest {lastManifestNumber} was generated successfully.
          </p>
          <Link
            href={manifestsHref(audience)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            <FiArchive aria-hidden="true" className="h-4 w-4" />
            View All Manifests
          </Link>
        </div>
      ) : null}

      {bulkStatusResult ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-emerald-800">{bulkStatusResult.message}</p>
            <button
              type="button"
              onClick={() => setBulkStatusResult(null)}
              className="h-8 rounded-lg border border-emerald-300 bg-white px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              Dismiss
            </button>
          </div>
          {bulkStatusResult.skipped.length ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                Skipped - resolve these before updating again
              </p>
              <ul className="mt-1 max-h-44 space-y-1 overflow-y-auto text-sm text-slate-700">
                {bulkStatusResult.skipped.map((skip) => (
                  <li key={skip.shipmentDraftId} className="flex flex-wrap gap-x-2">
                    <span className="font-semibold text-slate-900">
                      {skip.swiftlineTrackingNumber || skip.shipmentDraftId}
                    </span>
                    <span className="text-slate-600">{skip.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeFlow === "manifest" ? (
        <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-[#0D1282]/20 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          {manifestSelection.length ? (
            <>
              <div>
                <p className="text-sm font-semibold text-[#0D1282]">
                  {manifestSelection.length} {manifestSelection.length === 1 ? "shipment" : "shipments"} selected
                  {" · "}{manifestTotals.pieces} pcs · {manifestTotals.weightKg.toFixed(2)} kg
                </p>
                {selectedList.length > manifestSelection.length ? (
                  <p className="mt-1 text-xs font-semibold text-slate-600">
                    {selectedList.length - manifestSelection.length} selected {selectedList.length - manifestSelection.length === 1 ? "shipment is" : "shipments are"} not
                    manifest-eligible and will be left out.
                  </p>
                ) : null}
                {mixedSelection ? (
                  <p className="mt-1 text-xs font-semibold text-amber-700">
                    A manifest covers one business account and branch. Narrow the selection to continue.
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Map())}
                  className="h-9 rounded-4xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-slate-500"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  disabled={mixedSelection || !manifestSelection.length}
                  className="h-9 rounded-4xl bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  Create Manifest
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm font-semibold text-[#0D1282]">
              Select shipments below using the checkboxes, then create a manifest.
            </p>
          )}
        </div>
      ) : null}

      {activeFlow === "status" ? (
  <div className="mb-5 overflow-hidden rounded-2xl border border-[#0D1282]/20 bg-white shadow-sm">
    {statusSelection.length ? (
      <>
        <div className="flex flex-col gap-2 border-b border-slate-200 bg-[#0D1282]/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#0D1282]">
              Update {statusSelection.length}{" "}
              {statusSelection.length === 1 ? "shipment" : "shipments"} to a new status.
            </p>

            {selectedList.length > statusSelection.length ? (
              <p className="mt-1 text-xs font-medium leading-5 text-slate-600">
                {selectedList.length - statusSelection.length} selected{" "}
                {selectedList.length - statusSelection.length === 1
                  ? "shipment is"
                  : "shipments are"}{" "}
                not eligible (not booked, on hold or cancelled) and will be skipped.
              </p>
            ) : null}
            {mixedStatusSelection ? (
              <p className="mt-1 text-xs font-semibold leading-5 text-amber-700">
                A bulk update covers shipments that are all at the same stage. This
                selection mixes {selectedStages.map(formatStageLabel).sort().join(", ")}.
                Narrow it to shipments that share one current status and update each
                group separately.
              </p>
            ) : null}

            {alreadyAtBulkStatus ? (
              <p className="mt-1 text-xs font-semibold leading-5 text-amber-700">
                Every selected shipment is already at {formatStageLabel(bulkStatus)}.
                Choose the stage they should move to next.
              </p>
            ) : null}

            {mixedGatewayDestinations ? (
              <p className="mt-1 text-xs font-semibold leading-5 text-amber-700">
                Destination arrival can assign one gateway only to shipments for one destination country.
                Split {[...selectedDestinationCountries].sort().join(", ")} into separate updates.
              </p>
            ) : null}

            {isBulkGatewayStatus && !mixedGatewayDestinations ? (
              <p className="mt-1 text-xs font-medium leading-5 text-slate-600">
                One IATA will apply to every selected shipment. Include only shipments that arrived through the same gateway.
              </p>
            ) : null}

          </div>

          <span className="w-fit shrink-0 rounded-full border border-[#0D1282]/15 bg-white px-3 py-1.5 text-xs font-semibold text-[#0D1282]">
            {statusSelection.length} selected
          </span>
        </div>

        <div className={`grid gap-4 px-5 py-5 lg:grid-cols-2 xl:items-start ${
          isBulkGatewayStatus
            ? "xl:grid-cols-[minmax(180px,1fr)_minmax(210px,1.1fr)_minmax(170px,0.9fr)_150px_minmax(190px,1fr)_auto]"
            : "xl:grid-cols-[minmax(190px,1fr)_minmax(220px,1.1fr)_minmax(190px,1fr)_minmax(210px,1fr)_auto]"
        }`}>
          <label className="block min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              New Status
            </span>

            <div className="relative mt-2">
              <select
                value={bulkStatus}
                onChange={(event) => {
                  setBulkStatus(event.target.value as ShipmentOperationalStatus);
                  setBulkStatusGatewayCode("");
                }}
                className="h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
              >
                {shipmentOperationalStatusOptions.map((option) => (
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

          {isBulkGatewayStatus ? (
            <GatewayIataInput
              value={bulkStatusGatewayCode}
              onChange={setBulkStatusGatewayCode}
              ukRoute={bulkIsUkRoute}
            />
          ) : null}

          <label className="block min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Note{" "}
              <span className="font-normal normal-case text-slate-400">
                (optional)
              </span>
            </span>

            <input
              value={bulkStatusNote}
              onChange={(event) => setBulkStatusNote(event.target.value)}
              placeholder="Shared note for these shipments"
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="block min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Location{" "}
              <span className="font-normal normal-case text-slate-400">
                (optional)
              </span>
            </span>

            <input
              value={bulkStatusLocation}
              onChange={(event) => setBulkStatusLocation(event.target.value)}
              maxLength={120}
              placeholder="Delhi Hub"
              title="Where this scan happened. Shown to the customer as the shipment's current location."
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </label>

          <label className="block min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Status Date{" "}
              <span className="font-normal normal-case text-slate-400">
                (optional)
              </span>
            </span>

            <input
              type="datetime-local"
              value={bulkStatusAt}
              onChange={(event) => setBulkStatusAt(event.target.value)}
              max={currentDateTimeLocal()}
              title="When these scans actually happened. Leave empty to record them as happening now."
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
            <span className="mt-1 block text-xs font-medium leading-4 text-slate-500">
              Shown on the timeline instead of the moment you press Update.
            </span>
          </label>

          <div className="flex gap-2 lg:col-span-2 xl:col-span-1 xl:mt-6">
            <button
              type="button"
              onClick={handleBulkStatusUpdate}
              disabled={bulkStatusBusy || bulkStatusBlocked}
              className="h-11 flex-1 whitespace-nowrap rounded-xl bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400 xl:flex-none"
            >
              {bulkStatusBusy ? "Updating..." : "Update Status"}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveFlow(null);
                setBulkStatusNote("");
                setBulkStatusLocation("");
                setBulkStatusGatewayCode("");
                setBulkStatusAt("");
              }}
              className="h-11 flex-1 rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 xl:flex-none"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    ) : (
      <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[#0D1282]">
            Select shipments to update
          </p>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Select shipments below using the checkboxes, then update their
            status at once.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setActiveFlow(null);
            setBulkStatusNote("");
            setBulkStatusLocation("");
            setBulkStatusGatewayCode("");
            setBulkStatusAt("");
          }}
          className="h-10 shrink-0 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    )}
  </div>
) : null}

      {/* Export carries the same filters as the table, built from one helper so
          a downloaded file can never disagree with what is on screen. */}
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {audience === "admin" ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
         

            {shipmentDestinationRegionOptions.map((option) => {
              const checked = destinationRegions.includes(option.code);

              return (
                <label
                  key={option.code}
                  className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition ${
                    checked
                      ? "border-[#0D1282]/25 bg-[#0D1282]/6 text-[#0D1282]"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setDestinationRegions((current) =>
                        event.target.checked
                          ? [...current, option.code]
                          : current.filter((value) => value !== option.code),
                      );
                      setPage(1);
                    }}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
                  />
                  {option.label}
                </label>
              );
            })}

            {destinationRegions.length ? (
              <button
                type="button"
                onClick={() => {
                  setDestinationRegions([]);
                  setPage(1);
                }}
                className="h-9 px-1 text-xs font-semibold text-[#0D1282] transition hover:text-[#090d62]"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : (
          <div />
        )}

        <div className="flex justify-end">
          <TableToolbar
          exportPath={shipmentListPath(audience)}
          exportParams={shipmentListParams({
            status,
            search,
            dateRange: bookedDate ? emptyDateRange : dateRange,
            bookedDate,
            rebooked: rebookedOnly,
            businessAccountId: creationSource ? "" : businessAccountId,
            creationSource: creationSource === PUBLIC_BOOKING_FILTER_VALUE ? "PUBLIC_ONLINE" : undefined,
            destinationRegions: audience === "admin" ? destinationRegions : [],
            sort,
            attention: attentionOnly
          })}
          exportName="shipments"
          rowCount={pagination.total}
          columns={columnOptions}
          hiddenColumns={hiddenColumns}
          onHiddenColumnsChange={setHiddenColumns}
          pageSize={limit}
          onPageSizeChange={(next) => {
            setLimit(next);
            // A bigger page starts at the top: page four of the old size is
            // somewhere in the middle of the new one.
            setPage(1);
          }}
        />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={!selectable.length}
                    aria-label="Select all shipments on this page"
                    className="h-4 w-4 accent-[#0D1282]"
                  />
                </th>
                <th className="px-4 py-3">AWB / Shipment No.</th>
                {shows("consignee") ? <th className="px-4 py-3">Consignee</th> : null}
                {audience === "admin" && shows("parcels") ? <th className="px-4 py-3">Parcels</th> : null}
                {shows("route") ? <th className="px-4 py-3">Route</th> : null}
                {shows("amount") ? <th className="px-4 py-3">Chargeable Amount</th> : null}
                {shows("status") ? <th className="px-4 py-3">Status</th> : null}
                {/* The only sortable column on show. Consignee, Parcels, Route,
                    Amount and Status cannot be ordered by the server- see
                    shipmentSortableColumns for why- so they stay plain
                    headings rather than arrows that reorder one page. */}
                {shows("eta") ? <th className="px-4 py-3">Estimated Delivery</th> : null}
                {shows("created") ? (
                  <SortableHeader
                    label="Created"
                    sortKey="booked"
                    active={sortKey === "booked"}
                    direction={sortDirection === "asc" ? "asc" : "desc"}
                    onSort={applySort}
                  />
                ) : null}
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((shipment) => (
                <tr key={shipment.id} className="border-b border-slate-100 transition hover:bg-slate-50/70 last:border-b-0">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(shipment.id)}
                      onChange={() => toggleOne(shipment)}
                      disabled={!shipment.manifestEligible && !(audience === "admin" && isStatusUpdateEligible(shipment))}
                      aria-label={`Select shipment ${shipment.swiftlineTrackingNumber || shipment.id}`}
                      className="h-4 w-4 accent-[#0D1282] disabled:opacity-40"
                    />
                  </td>
                  <td className="w-56 max-w-56 px-4 py-3 align-middle">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-950">
                        {shipment.swiftlineTrackingNumber || "AWB Pending"}
                      </p>
                      <div
                        className="mt-1 flex min-w-0 items-center gap-1.5 text-xs"
                        aria-label={`Account ${visibleAccountName(shipment) || "not available"}`}
                      >
                        <span className="shrink-0 text-slate-400">Account</span>
                        <span
                          className="max-w-[14ch] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-slate-700"
                          title={visibleAccountName(shipment) || "Account not available"}
                        >
                          {truncateBusinessAccountName(visibleAccountName(shipment))}
                        </span>
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>
                          {shipment.shipmentInvoice?.invoiceNumber
                            ? `Tax Invoice: ${shipment.shipmentInvoice.invoiceNumber}`
                            : "Tax Invoice Pending"}
                        </span>
                        {/* Customs route, so CSB-V shipments are identifiable at a glance. */}
                        <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 font-semibold text-slate-600">
                          {formatCsbType(shipment.csbType)}
                        </span>
                      </p>
                    </div>
                  </td>
                  {shows("consignee") ? (
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{shipment.consignee || "Not set"}</p>
                      <p className="mt-1 text-xs text-slate-500">{shipment.destination || "Not set"}</p>
                    </td>
                  ) : null}
                  {audience === "admin" && shows("parcels") ? (
                    <td className="px-4 py-3">
                      <ParcelManifestCell shipment={shipment} />
                    </td>
                  ) : null}
                  {shows("route") ? (
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{shipment.route}</p>
                      <p className="mt-1 text-xs text-slate-500">{shipment.branch.name || shipment.branch.code}</p>
                    </td>
                  ) : null}
                  {shows("amount") ? (
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">{formatMoney(shipment)}</td>
                  ) : null}
                  {shows("status") ? (
                  <td className="px-4 py-3">
                    <span className="inline-flex py-1 text-xs font-semibold text-slate-700">
                      {shipment.statusLabel}
                    </span>
                    {audience === "admin" && shipment.dpdLabelStatus ? (
                      <DpdLabelAvailability status={shipment.dpdLabelStatus} />
                    ) : null}
                    {/* A booking that reached the carrier but has not completed is
                        shown here rather than being hidden from this table. */}
                    {shipment.bookingStatus !== "LABEL_RECEIVED" ? (
                      <p className="mt-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        {shipment.bookingStatusLabel}
                      </p>
                    ) : null}
                  </td>
                  ) : null}
                  {shows("eta") ? (
                    <td className="whitespace-nowrap px-4 py-3">
                      {shipment.deliveryEstimate ? (
                        <>
                          <p className="text-slate-800">
                            {formatDashboardDate(
                              shipment.deliveryEstimate.deliveredAt
                              ?? shipment.deliveryEstimate.estimatedDeliveryAt
                            )}
                          </p>
                          <div className="mt-1">
                            <ScheduleChip estimate={shipment.deliveryEstimate} />
                          </div>
                        </>
                      ) : (
                        // No route configured for this lane, so no date is
                        // claimed rather than one being invented.
                        <span className="text-slate-400">Not available</span>
                      )}
                    </td>
                  ) : null}
                  {shows("created") ? (
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {formatDashboardDateTime(shipment.createdAt)}
                    </td>
                  ) : null}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={shipmentDetailsHref(audience, shipment.id)}
                        className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                      >
                        <FiExternalLink aria-hidden="true" className="h-4 w-4" />View Details
                      </Link>
                      <Link
                        href={shipmentInvoicePageUrl(shipment.id, audience)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                      >
                        <FiFileText aria-hidden="true" className="h-4 w-4" />Invoice
                      </Link>
                      {canRebook ? (
                        <button
                          type="button"
                          onClick={() => void handleRebook(shipment.id)}
                          disabled={rebookingId === shipment.id}
                          aria-label={`Rebook shipment ${shipment.swiftlineTrackingNumber || shipment.id}`}
                          className="inline-flex items-center gap-1 font-semibold text-[#0D1282] hover:text-[#0D1282]/80 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <BsArrowCounterclockwise aria-hidden="true" className="h-4 w-4" />
                          {rebookingId === shipment.id ? "Rebooking..." : "Rebook"}
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(shipment)}
                          aria-label={`Delete shipment ${shipment.swiftlineTrackingNumber || shipment.id}`}
                          className="inline-flex items-center gap-1 font-semibold text-[#D71313] hover:text-[#b30f0f]"
                        >
                          <FiTrash2 aria-hidden="true" className="h-4 w-4" />Delete
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !shipments.length ? (
                <tr>
                  {/* Counted rather than fixed at 8: hiding a column would
                      otherwise leave the empty message spanning past the table. */}
                  <td colSpan={3 + columnOptions.filter((column) => !column.locked && shows(column.key)).length} className="px-4 py-14 text-center text-slate-500">
                    No booked shipments found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-slate-600">
          Page {pagination.page} of {pagination.totalPages} · {pagination.total} total
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="h-9 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:border-[#0D1282]/40 hover:bg-[#0D1282]/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPage((value) => value + 1)}
            className="h-9 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:border-[#0D1282]/40 hover:bg-[#0D1282]/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      {dialogOpen ? (
        <CreateManifestDialog
          shipmentCount={manifestSelection.length}
          totalPieces={manifestTotals.pieces}
          totalWeightKg={manifestTotals.weightKg}
          busy={creating}
          defaults={{
            origin: (manifestSelection[0]?.branch.city || manifestSelection[0]?.branch.name || "").toUpperCase(),
            destination: (manifestSelection[0]?.destinationCountry || "").toUpperCase(),
            coloader: "",
            paymentType: ""
          }}
          onCancel={() => setDialogOpen(false)}
          onConfirm={handleCreate}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this shipment?"
          description={
            <>
              <p>
                <span className="font-semibold text-slate-900">
                  {pendingDelete.swiftlineTrackingNumber || "AWB Pending"}
                </span>
                {pendingDelete.consignee ? ` to ${pendingDelete.consignee}` : ""} will be removed from
                the shipment lists for both staff and the customer.
              </p>
              {/* Says plainly what this does not do. The money side is a
                  cancellation, and an operator reaching for Delete to stop a
                  shipment needs to know it is not the same thing. */}
              <p className="mt-3">
                The carrier booking, the tax invoice and its number, and any manifest are kept, and
                the deletion is recorded. This does not cancel the shipment or refund anything.
              </p>
            </>
          }
          confirmLabel="Delete Shipment"
          busy={deleting}
          busyLabel="Deleting..."
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
