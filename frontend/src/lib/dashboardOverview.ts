import { listBranches } from "@/lib/branches";
import { listBusinessAccounts, type BusinessAccount } from "@/lib/businessAccounts";
import { listAdminCreditAccounts } from "@/lib/creditAccounts";
import { countCreditAccountsAtRisk } from "@/lib/creditPaymentStatus";
import { listDpdShipments, listShipmentAmendments, type DpdShipmentHistoryItem } from "@/lib/dpdLabels";
import { getShipmentDashboardSummary, type ShipmentDashboardSummary } from "@/lib/shipmentsList";
import { listOperationsManifests, type ManifestStatus, type OperationsManifest } from "@/lib/operationsManifests";
import { listShipmentCancellations } from "@/lib/shipmentCancellations";
import { listShipmentQuotes } from "@/lib/shipmentQuotes";
import { listSupportTickets, type SupportTicket } from "@/lib/supportTickets";
import {
  FINANCE_AREA,
  OPERATIONS_AREA,
  RATE_CARD_AREA,
  SHIPMENT_VIEW_AREA,
  STAFF_DIRECTORY_AREA,
  withAdmin
} from "@/lib/roles";
import type { AuthenticatedUser } from "@/lib/useAdminUser";

// Recent shipment rows power the trend, pipeline, and activity feed. KPI totals
// come from the exact shipment-list summary so they match their drill-downs.
const SHIPMENT_WINDOW = 100;
const TREND_DAYS = 14;
const ACTIVITY_LIMIT = 12;

export type DashboardRole = AuthenticatedUser["role"];

// What each internal role is allowed to read. Every admin data route is gated to
// `admin`, manifests additionally admit `operations`, and notifications are open
// to every signed-in role- so asking for anything else would only collect 403s.
export type DashboardCapability = "shipments" | "accounts" | "finance" | "approvals" | "manifests";

// Operations receives shipment data for the four operational KPI cards and the
// full manifest lifecycle breakdown. The KPI component keeps its view limited
// to those four cards; HR has no reporting scope, so it sees the scope card.
const roleCapabilities: Record<string, DashboardCapability[]> = {
  admin: ["shipments", "accounts", "finance", "approvals", "manifests"],
  operations: ["shipments", "manifests"],
  finance: ["finance"],
  delivery: ["shipments"]
};

export function getDashboardCapabilities(role?: string): DashboardCapability[] {
  return roleCapabilities[role ?? ""] ?? [];
}

export { describeRole } from "@/lib/roles";

// ── shaped results ────────────────────────────────────────────────────────────

export type StageTone = "stage" | "warning" | "serious" | "critical";

export type StageCount = {
  key: string;
  label: string;
  count: number;
  tone: StageTone;
  /** Position in the lifecycle, used to pick the ordinal ramp step. */
  step: number;
};

export type TrendPoint = { key: string; label: string; caption: string; count: number };

export type ActivityKind =
  | "shipment"
  | "delivery"
  | "manifest"
  | "account"
  | "ticket"
  | "exception";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  actor: string;
  at: string;
  href?: string;
};

export type TaskItem = {
  id: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  tone: "info" | "warning" | "critical";
};

export type ShipmentOverview = {
  windowSize: number;
  windowSaturated: boolean;
  bookedToday: number;
  bookedYesterday: number;
  inTransit: number;
  delivered: number;
  onHold: number;
  exceptions: number;
  stages: StageCount[];
  trend: TrendPoint[];
  trendCoversDays: number;
  bookedValueMinor: number;
  currency: string;
};

export type ManifestOverview = {
  /** Operations gets the full lifecycle breakdown; admin gets totals and the queue. */
  detailed: boolean;
  total: number;
  stages: StageCount[];
  packing: number;
  readyToSeal: number;
  sealed: number;
  dispatched: number;
  recent: OperationsManifest[];
};

export type AccountOverview = {
  total: number;
  active: number;
  pendingReview: number;
  recent: BusinessAccount[];
  activeBranches: number;
};

export type FinanceOverview = {
  currency: string;
  invoicedOutstandingMinor: number;
  unbilledMinor: number;
  approvedLimitMinor: number;
  activeFacilities: number;
  restrictedFacilities: number;
  /** Heading for a block but not there yet - a customer to chase, not one already stopped. */
  atRiskFacilities: number;
};

export type ApprovalOverview = {
  amendments: number;
  cancellations: number;
  quotes: number;
  accounts: number;
  openTickets: number;
};

export type DashboardOverview = {
  generatedAt: string;
  shipments: ShipmentOverview | null;
  manifests: ManifestOverview | null;
  accounts: AccountOverview | null;
  finance: FinanceOverview | null;
  approvals: ApprovalOverview | null;
  activity: ActivityItem[];
  tasks: TaskItem[];
  /** Sections whose request failed, so the UI can say what is missing. */
  unavailable: string[];
};

// ── helpers ───────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

export function formatMinorMoney(amountMinor: number, currency = "INR") {
  if (currency !== "INR") {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 })
      .format(amountMinor / 100);
  }
  return money.format(amountMinor / 100);
}

const grouped = new Intl.NumberFormat("en-IN");

export function formatCount(value: number) {
  if (Math.abs(value) < 100_000) return grouped.format(value);
  if (Math.abs(value) < 10_000_000) return `${(value / 100_000).toFixed(1)}L`;
  return `${(value / 10_000_000).toFixed(2)}Cr`;
}

// Stat tiles get a compact reading so a large figure stays on one line; the
// finance panel below them carries the exact amount.
export function formatCompactMoney(amountMinor: number, currency = "INR") {
  const amount = amountMinor / 100;
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  if (Math.abs(amount) < 10_000_000) return `${symbol}${grouped.format(Math.round(amount))}`;
  const crores = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(amount / 10_000_000);
  return `${symbol}${crores} Cr`;
}

export function titleCase(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function startOfDay(value: Date) {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

const DAY_MS = 86_400_000;

// A rejected section must not blank the whole dashboard, so each source resolves
// to either its value or the label of what could not be loaded.
type Loaded<T> = { value: T | null; failed: string | null };

async function load<T>(label: string, task: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { value: await task(), failed: null };
  } catch {
    return { value: null, failed: label };
  }
}

// ── shipment derivation ───────────────────────────────────────────────────────

// Between them these cover every shipment-event status and every carrier status
// the history endpoint can fall back to, so no shipment drops out of the chart.
const shipmentStages: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "BOOKED", label: "Booked", statuses: ["SHIPMENT_CREATED", "SHIPMENT_BOOKED", "DPD_CREATING", "DPD_CREATED", "LABEL_RECEIVED"] },
  { key: "COLLECTED", label: "Collected", statuses: ["PARCEL_COLLECTED", "WAREHOUSE_SCAN_IN"] },
  {
    key: "IN_TRANSIT",
    label: "In transit",
    statuses: [
      "RELEASED_FROM_HOLD",
      "ORIGIN_HUB_PROCESSED",
      "READY_FOR_EXPORT",
      "ORIGIN_HUB_DISPATCHED",
      "EXPORT_CUSTOMS_CLEARED",
      "FLIGHT_ASSIGNED",
      "FLIGHT_DEPARTED",
      "IN_TRANSIT",
      "DESTINATION_ARRIVED",
      "IMPORT_CUSTOMS_CLEARANCE",
      "IMPORT_CUSTOMS_CLEARED",
      "DELIVERY_PARTNER_TRANSFERRED",
      "DELIVERY_HUB_ARRIVED"
    ]
  },
  { key: "OUT_FOR_DELIVERY", label: "Out for delivery", statuses: ["OUT_FOR_DELIVERY"] },
  { key: "DELIVERED", label: "Delivered", statuses: ["DELIVERED"] }
];

const shipmentExceptions: Array<{ key: string; label: string; tone: StageTone; statuses: string[] }> = [
  { key: "ON_HOLD", label: "On hold", tone: "warning", statuses: ["ON_HOLD"] },
  { key: "RETURNED", label: "Returned or damaged", tone: "serious", statuses: ["RETURNED", "LOST", "DAMAGED"] },
  { key: "CANCELLED", label: "Cancelled", tone: "critical", statuses: ["SHIPMENT_CANCELLED"] },
  { key: "UNRESOLVED", label: "Booking unresolved", tone: "critical", statuses: ["DPD_REJECTED", "DPD_STATUS_UNKNOWN"] }
];

function shipmentStatus(item: DpdShipmentHistoryItem) {
  return item.currentEvent?.status || item.dpdShipment.status || "SHIPMENT_BOOKED";
}

function buildTrend(items: DpdShipmentHistoryItem[], saturated: boolean): { points: TrendPoint[]; days: number } {
  const today = startOfDay(new Date());
  const bookedAt = items
    .map((item) => (item.dpdShipment.createdAt ? new Date(item.dpdShipment.createdAt).getTime() : NaN))
    .filter((value) => Number.isFinite(value));

  let from = today - (TREND_DAYS - 1) * DAY_MS;

  // A saturated window hides everything older than its oldest row, so days before
  // it would read as zero bookings when they simply are not in the window. The
  // oldest day itself is only partially covered, so the series starts after it.
  if (saturated && bookedAt.length) {
    const firstWholeDay = startOfDay(new Date(Math.min(...bookedAt))) + DAY_MS;
    from = Math.min(Math.max(from, firstWholeDay), today);
  }

  const days = Math.max(1, Math.round((today - from) / DAY_MS) + 1);
  const counts = new Map<number, number>();
  for (let index = 0; index < days; index += 1) counts.set(from + index * DAY_MS, 0);

  for (const value of bookedAt) {
    const day = startOfDay(new Date(value));
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const points = [...counts.entries()].map(([day, count]) => {
    const date = new Date(day);
    return {
      key: String(day),
      label: String(date.getDate()).padStart(2, "0"),
      caption: date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
      count
    };
  });

  return { points, days };
}

function buildShipmentOverview(items: DpdShipmentHistoryItem[], summary: ShipmentDashboardSummary): ShipmentOverview {
  const tally = new Map<string, number>();

  for (const item of items) {
    const status = shipmentStatus(item);
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }

  const countOf = (statuses: string[]) => statuses.reduce((sum, status) => sum + (tally.get(status) ?? 0), 0);

  const stages: StageCount[] = shipmentStages.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    count: countOf(stage.statuses),
    tone: "stage",
    step: index
  }));

  const exceptions: StageCount[] = shipmentExceptions.map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: countOf(stage.statuses),
    tone: stage.tone,
    step: shipmentStages.length
  }));

  const saturated = items.length >= SHIPMENT_WINDOW;
  const trend = buildTrend(items, saturated);
  const invoiced = items.map((item) => item.shipmentInvoice).filter(Boolean);

  return {
    windowSize: items.length,
    windowSaturated: saturated,
    bookedToday: summary.bookedToday,
    bookedYesterday: summary.bookedYesterday,
    inTransit: summary.inTransit,
    delivered: summary.delivered,
    onHold: summary.onHold,
    exceptions: summary.exceptions,
    stages: [...stages, ...exceptions],
    trend: trend.points,
    trendCoversDays: trend.days,
    bookedValueMinor: invoiced.reduce((sum, invoice) => sum + (invoice?.totalAmountMinor ?? 0), 0),
    currency: invoiced[0]?.currency || "INR"
  };
}

// ── manifest derivation ───────────────────────────────────────────────────────

const manifestStages: Array<{ status: ManifestStatus; label: string; tone: StageTone }> = [
  { status: "DRAFT", label: "Draft", tone: "stage" },
  { status: "PACKING", label: "Packing", tone: "stage" },
  { status: "READY_TO_SEAL", label: "Ready to seal", tone: "stage" },
  { status: "SEALED", label: "Sealed", tone: "stage" },
  { status: "DISPATCHED", label: "Dispatched", tone: "stage" },
  { status: "CANCELLED", label: "Cancelled", tone: "critical" }
];

// The list endpoint reports a total per status filter, so one request per status
// gives exact tallies rather than counting a single page. Operations lives in
// this module all day and gets the full breakdown; the admin view only needs the
// grand total, the two queues it acts on, and the recent rows for the feed.
async function loadManifestOverview(detailed: boolean): Promise<Loaded<ManifestOverview>> {
  const wanted: ManifestStatus[] = detailed
    ? manifestStages.map((stage) => stage.status)
    : ["READY_TO_SEAL", "SEALED"];

  const [everything, ...byStatus] = await Promise.all([
    detailed ? null : load("Manifests", () => listOperationsManifests(1)),
    ...wanted.map((status) => load("Manifests", () => listOperationsManifests(1, status)))
  ]);

  // A single failed status would silently understate the totals, so the section
  // only reports figures when every request it made came back.
  if (byStatus.some((result) => result.value === null) || (everything && everything.value === null)) {
    return { value: null, failed: "Manifests" };
  }

  const totalFor = (status: ManifestStatus) => {
    const index = wanted.indexOf(status);
    return index === -1 ? 0 : byStatus[index].value?.pagination.total ?? 0;
  };

  const stages: StageCount[] = detailed
    ? manifestStages.map((stage, index) => ({
      key: stage.status,
      label: stage.label,
      count: totalFor(stage.status),
      tone: stage.tone,
      step: index
    }))
    : [];

  // The unfiltered page overlaps the per-status pages, so the same manifest can
  // arrive more than once; keep one row per id.
  const seen = new Map<string, OperationsManifest>();
  for (const manifest of [everything, ...byStatus].flatMap((result) => result?.value?.items ?? [])) {
    if (!seen.has(manifest.id)) seen.set(manifest.id, manifest);
  }

  const recent = [...seen.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 6);

  return {
    value: {
      detailed,
      total: detailed
        ? stages.reduce((sum, stage) => sum + stage.count, 0)
        : everything?.value?.pagination.total ?? 0,
      stages,
      packing: totalFor("PACKING"),
      readyToSeal: totalFor("READY_TO_SEAL"),
      sealed: totalFor("SEALED"),
      dispatched: totalFor("DISPATCHED"),
      recent
    },
    failed: null
  };
}

// ── activity ──────────────────────────────────────────────────────────────────

function shipmentActivity(items: DpdShipmentHistoryItem[]): ActivityItem[] {
  return items.slice(0, 8).map((item) => {
    const status = shipmentStatus(item);
    const consignee = item.shipmentDraft?.consigneeName || "Consignee not recorded";
    const reference = item.dpdShipment.swiftlineTrackingNumber || "AWB Pending";
    const exception = shipmentExceptions.find((stage) => stage.statuses.includes(status));

    return {
      id: `shipment-${item.dpdShipment.id}`,
      kind: status === "DELIVERED" ? "delivery" : exception ? "exception" : "shipment",
      title: `${reference} · ${item.currentEvent?.statusLabel || titleCase(status)}`,
      detail: `${consignee}- ${item.branch?.name || "Branch not assigned"}`,
      actor: item.branch?.code || "Swiftline",
      at: item.currentEvent?.eventAt || item.dpdShipment.updatedAt || item.dpdShipment.createdAt || "",
      href: `/dashboard/shipments/${item.dpdShipment.shipmentDraftId}`
    };
  });
}

function manifestActivity(items: OperationsManifest[]): ActivityItem[] {
  return items.slice(0, 6).map((manifest) => ({
    id: `manifest-${manifest.id}`,
    kind: "manifest" as const,
    title: `${manifest.manifestNumber} · ${titleCase(manifest.status)}`,
    detail: `${manifest.totalConsignments} consignments to ${manifest.header.destinationCountryName || "destination pending"}`,
    actor: manifest.branch?.code || "Operations",
    at: manifest.updatedAt || manifest.createdAt,
    href: `/dashboard/operations-manifests/${manifest.id}`
  }));
}

function accountActivity(accounts: BusinessAccount[]): ActivityItem[] {
  return accounts.slice(0, 5).map((account) => ({
    id: `account-${account._id}`,
    kind: "account" as const,
    title: `${account.company.companyName || account.accountId} · ${titleCase(account.status)}`,
    detail: `Business account ${account.accountId}`,
    actor: account.contact.email || "Portal",
    at: account.submittedAt || account.createdAt,
    href: `/dashboard/business-accounts/${account.accountId}`
  }));
}

function ticketActivity(tickets: SupportTicket[]): ActivityItem[] {
  return tickets.slice(0, 5).map((ticket) => ({
    id: `ticket-${ticket.id}`,
    kind: "ticket" as const,
    title: `${ticket.ticketNumber} · ${titleCase(ticket.status)}`,
    detail: ticket.subject,
    actor: ticket.account?.companyName || ticket.creator?.name || "Client",
    at: ticket.lastMessageAt || ticket.createdAt,
    href: `/dashboard/tickets`
  }));
}

// ── quick access ──────────────────────────────────────────────────────────────

export type QuickLink = { label: string; description: string; href: string; roles: string[] };

// Curated shortcuts to the work these roles start most often. The sidebar still
// owns navigation; this is a shorter, described list, so the two are deliberately
// separate.
export const quickLinks: QuickLink[] = [
  { label: "Shipments", description: "Upload invoices, book labels, and manage drafts", href: "/dashboard/dpd-labels", roles: withAdmin(OPERATIONS_AREA) },
  { label: "Tracking", description: "Look up any Swiftline, carrier, or parcel number", href: "/dashboard/tracking", roles: withAdmin(SHIPMENT_VIEW_AREA) },
  { label: "Manifests", description: "Pack bags, scan parcels, seal, and dispatch", href: "/dashboard/operations-manifests", roles: withAdmin(OPERATIONS_AREA) },
  { label: "Business Accounts", description: "Onboard clients and review KYC", href: "/dashboard/business-accounts", roles: ["admin"] },
  { label: "Credit Accounts", description: "Limits, statements, and payments", href: "/dashboard/credit-accounts", roles: withAdmin(FINANCE_AREA) },
  { label: "Country Rate Card", description: "Lane pricing and weight slabs", href: "/dashboard/country-rate-card", roles: withAdmin(RATE_CARD_AREA) },
  { label: "Branches", description: "Locations, codes, and assignments", href: "/dashboard/branches", roles: ["admin"] },
  { label: "Staff", description: "Add internal staff and review the directory", href: "/dashboard/users", roles: withAdmin(STAFF_DIRECTORY_AREA) },
  { label: "Support Tickets", description: "Answer client queries", href: "/dashboard/tickets", roles: withAdmin(OPERATIONS_AREA) }
];

export function quickLinksForRole(role?: string) {
  return quickLinks.filter((link) => link.roles.includes(role ?? ""));
}

// ── the loader ────────────────────────────────────────────────────────────────

export async function loadDashboardOverview(role?: string): Promise<DashboardOverview> {
  const capabilities = getDashboardCapabilities(role);
  const can = (capability: DashboardCapability) => capabilities.includes(capability);

  const [
    shipmentHistory,
    shipmentSummary,
    accountsPage,
    activeAccounts,
    pendingAccounts,
    activeBranches,
    manifests,
    amendments,
    cancellations,
    quotes,
    tickets,
    creditAccounts
  ] = await Promise.all([
    can("shipments") ? load("Shipments", () => listDpdShipments(SHIPMENT_WINDOW, "", false, false, true)) : null,
    can("shipments") ? load("Shipment totals", getShipmentDashboardSummary) : null,
    can("accounts") ? load("Business accounts", () => listBusinessAccounts("", "", 1, 5)) : null,
    can("accounts") ? load("Business accounts", () => listBusinessAccounts("", "", 1, 1, "active")) : null,
    can("accounts") ? load("Business accounts", () => listBusinessAccounts("", "", 1, 1, "pending_review")) : null,
    can("accounts") ? load("Branches", () => listBranches("", "ACTIVE", 1, 1)) : null,
    can("manifests") ? loadManifestOverview(!can("shipments")) : null,
    can("approvals") ? load("Amendments", () => listShipmentAmendments({ status: "REQUESTED" })) : null,
    can("approvals") ? load("Cancellations", () => listShipmentCancellations({ status: "REQUESTED" })) : null,
    can("approvals") ? load("Quote requests", () => listShipmentQuotes("admin", { status: "REQUESTED" })) : null,
    can("approvals") ? load("Support tickets", () => listSupportTickets("admin", { status: "OPEN", limit: 5 })) : null,
    can("finance") ? load("Credit accounts", () => listAdminCreditAccounts()) : null
  ]);

  const unavailable = [
    shipmentHistory, shipmentSummary, accountsPage, activeAccounts, pendingAccounts, activeBranches,
    manifests, amendments, cancellations, quotes, tickets, creditAccounts
  ]
    .map((result) => result?.failed)
    .filter((label): label is string => Boolean(label));

  const shipments = shipmentHistory?.value && shipmentSummary?.value
    ? buildShipmentOverview(shipmentHistory.value.shipments, shipmentSummary.value)
    : null;

  const accounts: AccountOverview | null = accountsPage?.value
    ? {
      total: accountsPage.value.total ?? accountsPage.value.accounts.length,
      active: activeAccounts?.value?.total ?? 0,
      pendingReview: pendingAccounts?.value?.total ?? 0,
      recent: accountsPage.value.accounts,
      activeBranches: activeBranches?.value?.total ?? activeBranches?.value?.branches.length ?? 0
    }
    : null;

  const credit = creditAccounts?.value?.creditAccounts ?? [];
  const finance: FinanceOverview | null = creditAccounts?.value
    ? {
      currency: "INR",
      invoicedOutstandingMinor: credit.reduce((sum, account) => sum + (account.invoicedOutstandingMinor ?? 0), 0),
      unbilledMinor: credit.reduce((sum, account) => sum + (account.unbilledCreditMinor ?? 0), 0),
      approvedLimitMinor: credit.reduce((sum, account) => sum + (account.approvedCreditLimitMinor ?? 0), 0),
      activeFacilities: credit.filter((account) => account.status === "ACTIVE").length,
      restrictedFacilities: credit.filter((account) => account.restriction && account.restriction.level !== "NONE").length,
      atRiskFacilities: countCreditAccountsAtRisk(credit)
    }
    : null;

  const approvals: ApprovalOverview | null = amendments || cancellations || quotes || tickets
    ? {
      amendments: amendments?.value?.amendments.length ?? 0,
      cancellations: cancellations?.value?.cancellations.length ?? 0,
      quotes: quotes?.value?.quotes.length ?? 0,
      accounts: pendingAccounts?.value?.total ?? 0,
      openTickets: tickets?.value?.pagination.total ?? 0
    }
    : null;

  // Four sources merge here and each keys its own rows, so the feed is de-duped
  // by id before it reaches React.
  const activityById = new Map<string, ActivityItem>();
  for (const item of [
    ...(shipmentHistory?.value ? shipmentActivity(shipmentHistory.value.shipments) : []),
    ...(manifests?.value ? manifestActivity(manifests.value.recent) : []),
    ...(accountsPage?.value ? accountActivity(accountsPage.value.accounts) : []),
    ...(tickets?.value ? ticketActivity(tickets.value.tickets) : [])
  ]) {
    if (item.at && !activityById.has(item.id)) activityById.set(item.id, item);
  }

  const activity = [...activityById.values()]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, ACTIVITY_LIMIT);

  return {
    generatedAt: new Date().toISOString(),
    shipments,
    manifests: manifests?.value ?? null,
    accounts,
    finance,
    approvals,
    activity,
    tasks: buildTasks({ shipments, manifests: manifests?.value ?? null, approvals, finance }),
    unavailable: [...new Set(unavailable)]
  };
}

function buildTasks(input: {
  shipments: ShipmentOverview | null;
  manifests: ManifestOverview | null;
  approvals: ApprovalOverview | null;
  finance: FinanceOverview | null;
}): TaskItem[] {
  const tasks: TaskItem[] = [];
  const { shipments, manifests, approvals, finance } = input;

  if (approvals?.accounts) {
    tasks.push({
      id: "accounts",
      label: "Business accounts awaiting review",
      detail: "KYC and company details need a decision",
      count: approvals.accounts,
      href: "/dashboard/business-accounts",
      tone: "warning"
    });
  }

  if (approvals?.amendments) {
    tasks.push({
      id: "amendments",
      label: "Amendment requests to approve",
      detail: "Pricing impact is calculated and waiting",
      count: approvals.amendments,
      href: "/dashboard/amendments",
      tone: "warning"
    });
  }

  if (approvals?.cancellations) {
    tasks.push({
      id: "cancellations",
      label: "Cancellation requests to settle",
      detail: "Confirm the fee and release the refund",
      count: approvals.cancellations,
      href: "/dashboard/cancellations",
      tone: "critical"
    });
  }

  if (approvals?.quotes) {
    tasks.push({
      id: "quotes",
      label: "Quote requests to price",
      detail: "Clients are waiting on a final rate",
      count: approvals.quotes,
      href: "/dashboard/quote-requests",
      tone: "info"
    });
  }

  if (shipments?.onHold) {
    tasks.push({
      id: "hold",
      label: "Shipments on hold",
      detail: "Release or resolve the hold reason",
      count: shipments.onHold,
      href: "/dashboard/dpd-labels",
      tone: "critical"
    });
  }

  if (manifests?.readyToSeal) {
    tasks.push({
      id: "seal",
      label: "Manifests ready to seal",
      detail: "All bags are closed and scans reconcile",
      count: manifests.readyToSeal,
      href: "/dashboard/operations-manifests",
      tone: "info"
    });
  }

  if (manifests?.sealed) {
    tasks.push({
      id: "dispatch",
      label: "Sealed manifests awaiting dispatch",
      detail: "Confirm the flight and dispatch the bags",
      count: manifests.sealed,
      href: "/dashboard/operations-manifests",
      tone: "warning"
    });
  }

  if (approvals?.openTickets) {
    tasks.push({
      id: "tickets",
      label: "Open support tickets",
      detail: "Clients are waiting on a first reply",
      count: approvals.openTickets,
      href: "/dashboard/tickets",
      tone: "info"
    });
  }

  if (finance?.restrictedFacilities || finance?.atRiskFacilities) {
    const restricted = finance.restrictedFacilities;
    const atRisk = finance.atRiskFacilities;
    tasks.push({
      id: "credit",
      label: restricted
        ? "Credit facilities restricted"
        : "Credit facilities at risk",
      // Both halves are named when both exist, so the count and the sentence
      // never disagree about what the number refers to.
      detail: restricted && atRisk
        ? `${restricted} blocked by overdue balances, ${atRisk} due soon`
        : restricted
          ? "Overdue balances are blocking new bookings"
          : "Payment due soon - chase before bookings stop",
      count: restricted + atRisk,
      href: "/dashboard/credit-accounts",
      tone: restricted ? "critical" : "warning"
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return tasks.sort((left, right) => order[left.tone] - order[right.tone]);
}
