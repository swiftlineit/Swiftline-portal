import mongoose from "mongoose";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { DpdShipment, type DpdShipmentStatus } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, shipmentOperationalStatusValues } from "../models/shipmentEvent.model.js";
import { buildDeliveryEstimates } from "./shipmentTracking.service.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { isDpdLabelDestination } from "./als/alsPayload.service.js";
import { dateRangeCondition } from "../utils/dateRangeFilter.js";
import { normalizeCsbType } from "./csbType.service.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";
import {
  shipmentDestinationRegionCondition,
  type ShipmentDestinationRegionCode
} from "./shipmentDestinationRegions.js";
import {
  canonicalShipmentStatus,
  equivalentCurrentStatusValues
} from "./shipmentStatusSequence.service.js";

export type ShipmentListingFilter = {
  businessAccountIds?: mongoose.Types.ObjectId[];
  /** Staff-only source filter for self-serve public bookings. */
  creationSource?: "PUBLIC_ONLINE";
  branchIds?: mongoose.Types.ObjectId[];
  status?: string;
  /**
   * Free text over AWB, piece number, consignee, the consignee address
   * (company/contact, town/city, county/state, postcode, address lines,
   * country name/code) and the customer's own reference. Applied in the
   * database rather than to the fetched page: this list is paginated, so
   * filtering what was already returned would silently miss the shipment
   * sitting on page three.
   */
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Carrier booking calendar day used by the dashboard's Booked today KPI. */
  bookedDate?: string;
  /** Keeps only booked drafts created through the rebooking flow. */
  rebookedOnly?: boolean;
  /** When true, keep only shipments with a current exception or unresolved carrier booking. */
  attention?: boolean;
  /** Staff-only destination groups, matched against the effective consignee address. */
  destinationRegions?: ShipmentDestinationRegionCode[];
  page: number;
  limit: number;
  /** Manifest assignments are per actor role, so eligibility is role-scoped. */
  actorRole: "admin" | "client";
  /**
   * Which carrier booking states belong in this list.
   *
   * Staff see every booking, so a shipment stuck awaiting reconciliation is
   * visible here instead of only in the DPD labels panel- the two views
   * disagreeing about what exists is what hid such shipments before. Customers
   * see only shipments that completed.
   */
  bookingStatuses?: DpdShipmentStatus[];
  /** `field:direction`, validated against `shipmentSortFields`. */
  sort?: string;
};

/**
 * Columns this list can genuinely order by.
 *
 * The page is selected from `ShipmentDraft` before bookings, events, invoices
 * and branches are joined on, so only fields the draft itself holds can order
 * it. AWB, tracking status, weight and invoice are all assembled after the
 * page is chosen- sorting by them would order the twenty rows that happened to
 * be fetched and read as a broken sort on every other page.
 *
 * Consignee and destination are absent for a subtler reason: both are shown as
 * a fallback- company name or contact name, country name or country code-
 * and the database can only order by one stored field at a time. Sorting by
 * `companyName` while the cell shows a contact name puts every row without a
 * company at the top in no visible order, which looks like a broken sort
 * rather than a limitation. Ordering the coalesced value needs an aggregation
 * pipeline, and that is not worth it for two columns.
 *
 * The table therefore offers sort arrows on these columns only. An unsupported
 * value falls back to the default rather than erroring, so a stale bookmark
 * still loads.
 */
export const shipmentSortFields: Record<string, string> = {
  booked: "createdAt",
  updated: "updatedAt",
  service: "serviceType",
  pieces: "parcelCount"
};

function sortSpec(sort?: string): Record<string, 1 | -1> {
  const [field = "", direction = ""] = (sort ?? "").split(":");
  const path = shipmentSortFields[field];
  // Newest booking first by default, matching the "Created" column the table
  // shows. Sorting by updatedAt instead floated old shipments to the top
  // whenever a tracking event or amendment touched them, which reads as broken.
  if (!path) return { createdAt: -1, _id: -1 };
  // `_id` breaks ties so paging never repeats or skips a row when many
  // shipments share a value- every consignee named the same, for instance.
  return { [path]: direction === "asc" ? 1 : -1, _id: -1 };
}

/** Completed bookings: labels issued, and the only ones a customer may see. */
export const bookedShipmentStatuses: DpdShipmentStatus[] = ["LABEL_RECEIVED"];

/** Everything that reached the carrier, including outcomes needing review. */
export const allShipmentStatuses: DpdShipmentStatus[] = [
  "LABEL_RECEIVED",
  "DPD_CREATED",
  "DPD_STATUS_UNKNOWN",
  "DPD_CREATING",
  "DPD_REJECTED"
];

// The dashboard's In transit KPI includes every operational milestone from
// collection through out-for-delivery. Legacy flight/customs names are kept in
// this set because old event rows are still the source of the current stage.
export const inTransitEventStatuses = [
  "RELEASED_FROM_HOLD",
  ...shipmentOperationalStatusValues.filter((status) => status !== "DELIVERED"),
  "IN_TRANSIT",
  "EXPORT_CUSTOMS_CLEARED",
  "FLIGHT_ASSIGNED",
  "FLIGHT_DEPARTED"
];

function indiaBookingDayCondition(value?: string) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;
  const indiaOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const dayStartUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return {
    $gte: new Date(dayStartUtc - indiaOffsetMs),
    $lte: new Date(dayStartUtc + 86_400_000 - indiaOffsetMs - 1)
  };
}

export function formatBookingStatusLabel(status: DpdShipmentStatus) {
  if (status === "LABEL_RECEIVED") return "Booked";
  if (status === "DPD_CREATED") return "Awaiting Documents";
  if (status === "DPD_STATUS_UNKNOWN") return "Outcome Unconfirmed";
  if (status === "DPD_CREATING") return "Booking";
  return "Rejected";
}

export function formatShipmentStatusLabel(value?: string | null, event?: {
  gatewayCode?: string;
  gatewayName?: string;
  location?: string;
  statusLabel?: string;
} | null) {
  if (!value) return "Shipment Booked";
  if (canonicalShipmentStatus(value) === "DESTINATION_ARRIVED") {
    const storedLabel = event?.statusLabel?.trim();
    if (storedLabel && !/^destination arrived$/i.test(storedLabel)) return storedLabel;
    const gatewayCode = event?.gatewayCode?.trim().toUpperCase() || event?.location?.trim().toUpperCase();
    if (gatewayCode) {
      const name = event?.gatewayName?.trim() || (gatewayCode === "LHR" ? "London" : "Destination");
      return `Arrived at ${name} Gateway (${gatewayCode})`;
    }
  }
  return value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export type ShipmentDashboardSummary = {
  bookedToday: number;
  bookedYesterday: number;
  inTransit: number;
  delivered: number;
  onHold: number;
  exceptions: number;
};

function indiaDayString(value: Date, offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const shifted = new Date(Date.UTC(year, month - 1, day) + offsetDays * 86_400_000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

/**
 * Resolves the intersection between live drafts and carrier bookings without
 * first materialising every booking document in the database.
 *
 * Account, branch, date and destination filters can reduce the draft set
 * substantially. Applying that set to the booking query is especially
 * important for client and branch-scoped pages: their response time should be
 * based on their own shipments, not the total size of the portal.
 */
async function findBookedDraftIds(
  draftFilter: Record<string, unknown>,
  bookingFilter: Record<string, unknown>
): Promise<mongoose.Types.ObjectId[]> {
  const hasNarrowDraftScope = Object.keys(draftFilter).some((key) => key !== "deletedAt");
  let scopedDraftIds: mongoose.Types.ObjectId[] | null = null;

  if (hasNarrowDraftScope) {
    scopedDraftIds = await ShipmentDraft.distinct("_id", draftFilter).exec() as mongoose.Types.ObjectId[];
    if (!scopedDraftIds.length) return [];
  }

  return DpdShipment.distinct("shipmentDraftId", {
    ...bookingFilter,
    ...(scopedDraftIds ? { shipmentDraftId: { $in: scopedDraftIds } } : {})
  }).exec() as Promise<mongoose.Types.ObjectId[]>;
}

/**
 * Exact dashboard shipment totals. The drill-down table uses the same booked
 * scope and latest-event rules; keeping these totals here prevents a capped
 * recent-history feed from disagreeing with the table's pagination total.
 */
export async function summarizeBookedShipments(filter: Pick<ShipmentListingFilter, "actorRole" | "businessAccountIds" | "branchIds" | "bookingStatuses">): Promise<ShipmentDashboardSummary> {
  const bookingStatuses = filter.bookingStatuses ?? bookedShipmentStatuses;
  const draftScope: Record<string, unknown> = { deletedAt: null };
  if (filter.businessAccountIds) draftScope.businessAccountId = { $in: filter.businessAccountIds };
  if (filter.branchIds) draftScope.branchId = { $in: filter.branchIds };

  const bookedDraftIds = await findBookedDraftIds(draftScope, { status: { $in: bookingStatuses } });
  if (!bookedDraftIds.length) {
    return { bookedToday: 0, bookedYesterday: 0, inTransit: 0, delivered: 0, onHold: 0, exceptions: 0 };
  }

  const draftFilter: Record<string, unknown> = {
    ...draftScope,
    _id: { $in: bookedDraftIds }
  };

  const candidates = await ShipmentDraft.find(draftFilter).select("_id").lean().exec();
  const candidateIds = candidates.map((draft) => draft._id);
  if (!candidateIds.length) {
    return { bookedToday: 0, bookedYesterday: 0, inTransit: 0, delivered: 0, onHold: 0, exceptions: 0 };
  }

  const eventVisibilityFilter = filter.actorRole === "client" ? { customerVisible: true } : {};
  const now = new Date();
  const [bookedToday, bookedYesterday, latest, unresolvedBookings] = await Promise.all([
    DpdShipment.countDocuments({
      shipmentDraftId: { $in: candidateIds },
      status: { $in: bookingStatuses },
      createdAt: indiaBookingDayCondition(indiaDayString(now))
    }).exec(),
    DpdShipment.countDocuments({
      shipmentDraftId: { $in: candidateIds },
      status: { $in: bookingStatuses },
      createdAt: indiaBookingDayCondition(indiaDayString(now, -1))
    }).exec(),
    ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
      { $match: { shipmentDraftId: { $in: candidateIds }, ...eventVisibilityFilter } },
      // The draft id comes first so the compound event index can stream each
      // draft's newest row directly into the group stage.
      { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
      { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
    ]).exec(),
    DpdShipment.find({
      shipmentDraftId: { $in: candidateIds },
      status: { $in: ["DPD_REJECTED", "DPD_STATUS_UNKNOWN"] }
    }).select("shipmentDraftId").lean().exec()
  ]);

  const latestByDraft = new Map(latest.map((item) => [String(item._id), item.status]));
  const inTransitStatuses = new Set<string>(inTransitEventStatuses);
  const inTransit = [...latestByDraft.values()].filter((status) => inTransitStatuses.has(status)).length;
  const deliveredStatuses = new Set(equivalentCurrentStatusValues("DELIVERED"));
  const delivered = [...latestByDraft.values()].filter((status) => deliveredStatuses.has(status)).length;
  const onHold = [...latestByDraft.values()].filter((status) => status === "ON_HOLD").length;
  const exceptionIds = new Set(
    [...latestByDraft.entries()]
      .filter(([, status]) => ["ON_HOLD", "RETURNED", "LOST", "DAMAGED", "SHIPMENT_CANCELLED"].includes(status))
      .map(([draftId]) => draftId)
  );
  for (const booking of unresolvedBookings) exceptionIds.add(String(booking.shipmentDraftId));

  return { bookedToday, bookedYesterday, inTransit, delivered, onHold, exceptions: exceptionIds.size };
}

function joinPlace(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))].join(", ");
}

/**
 * The booked shipments a Shipments page shows. "Booked" means the carrier
 * returned labels, which is also the point a shipment becomes manifestable.
 */
export async function listBookedShipments(filter: ShipmentListingFilter) {
  // A deleted shipment leaves its DpdShipment behind, so the carrier lookup
  // below still finds it. The draft is what decides whether it is still live,
  // and both audiences and the exports read this same filter.
  const draftFilter: Record<string, unknown> = { deletedAt: null };
  if (filter.businessAccountIds) draftFilter.businessAccountId = { $in: filter.businessAccountIds };
  if (filter.creationSource) draftFilter.creationSource = filter.creationSource;
  if (filter.branchIds) draftFilter.branchId = { $in: filter.branchIds };
  if (filter.rebookedOnly) {
    draftFilter.rebookedFromDraftId = { $exists: true, $ne: null };
  }
  const destinationCondition = shipmentDestinationRegionCondition(filter.destinationRegions ?? []);
  if (destinationCondition) Object.assign(draftFilter, destinationCondition);
  const createdAt = dateRangeCondition(filter.dateFrom, filter.dateTo);
  if (createdAt) draftFilter.createdAt = createdAt;

  const bookingCreatedAt = indiaBookingDayCondition(filter.bookedDate);
  let allowedDraftIds = await findBookedDraftIds(draftFilter, {
    status: { $in: filter.bookingStatuses ?? bookedShipmentStatuses },
    ...(bookingCreatedAt ? { createdAt: bookingCreatedAt } : {})
  });

  if (filter.search?.trim()) {
    // Escaped because these are identifiers people paste: a stray bracket from
    // a copied email would otherwise be read as regex syntax.
    const pattern = new RegExp(filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const [byBooking, byDraft] = await Promise.all([
      DpdShipment.find({
        shipmentDraftId: { $in: allowedDraftIds },
        $or: [
          { swiftlineTrackingNumber: pattern },
          { dpdShipmentId: pattern },
          { parcelNumbers: pattern }
        ]
      }).select("shipmentDraftId").lean().exec(),
      ShipmentDraft.find({
        ...draftFilter,
        _id: { $in: allowedDraftIds },
        $or: [
          { "consigneeEnteredAddress.companyName": pattern },
          { "consigneeEnteredAddress.contactName": pattern },
          { "consigneeEnteredAddress.townOrCity": pattern },
          { "consigneeEnteredAddress.county": pattern },
          { "consigneeEnteredAddress.countryName": pattern },
          { "consigneeEnteredAddress.countryCode": pattern },
          { "consigneeEnteredAddress.postcode": pattern },
          { "consigneeEnteredAddress.addressLine1": pattern },
          { "consigneeEnteredAddress.addressLine2": pattern },
          { "consigneeValidatedAddress.companyName": pattern },
          { "consigneeValidatedAddress.contactName": pattern },
          { "consigneeValidatedAddress.townOrCity": pattern },
          { "consigneeValidatedAddress.county": pattern },
          { "consigneeValidatedAddress.countryName": pattern },
          { "consigneeValidatedAddress.countryCode": pattern },
          { "consigneeValidatedAddress.postcode": pattern },
          { "consigneeValidatedAddress.addressLine1": pattern },
          { "consigneeValidatedAddress.addressLine2": pattern },
          { "consigneeSelectedAddress.companyName": pattern },
          { "consigneeSelectedAddress.contactName": pattern },
          { "consigneeSelectedAddress.townOrCity": pattern },
          { "consigneeSelectedAddress.county": pattern },
          { "consigneeSelectedAddress.countryName": pattern },
          { "consigneeSelectedAddress.countryCode": pattern },
          { "consigneeSelectedAddress.postcode": pattern },
          { "consigneeSelectedAddress.addressLine1": pattern },
          { "consigneeSelectedAddress.addressLine2": pattern },
          { "parcelList.shipmentReference1": pattern },
          { "parcelList.shipmentReference2": pattern }
        ]
      }).select("_id").lean().exec()
    ]);

    const matched = new Set([
      ...byBooking.map((item) => String(item.shipmentDraftId)),
      ...byDraft.map((draft) => String(draft._id))
    ]);
    allowedDraftIds = allowedDraftIds.filter((id) => matched.has(String(id)));
  }

  const candidateFilter = { ...draftFilter, _id: { $in: allowedDraftIds } };

  // Staff bulk updates are validated against every operational event, so their
  // table must use that same history. Client lists remain customer-visible only.
  const eventVisibilityFilter = filter.actorRole === "client"
    ? { customerVisible: true }
    : {};

  // Staff choose one canonical filter. Historical aliases are matched behind
  // that single option so old records remain findable without exposing old
  // flight/customs names as separate stages.
  let matchingIds: mongoose.Types.ObjectId[] | null = null;
  if (filter.status || filter.attention) {
    const candidateIds = await ShipmentDraft.distinct("_id", candidateFilter).exec() as mongoose.Types.ObjectId[];
    const [latest, unresolvedBookings] = await Promise.all([
      ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
      { $match: { shipmentDraftId: { $in: candidateIds }, ...eventVisibilityFilter } },
      { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
      { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
      ]).exec(),
      filter.attention ? DpdShipment.distinct("shipmentDraftId", {
        shipmentDraftId: { $in: candidateIds },
        status: { $in: ["DPD_REJECTED", "DPD_STATUS_UNKNOWN"] }
      }).exec() as Promise<mongoose.Types.ObjectId[]> : Promise.resolve([])
    ]);

    if (filter.status) {
      const acceptedStatuses = new Set(filter.status === "IN_TRANSIT"
        ? inTransitEventStatuses
        : equivalentCurrentStatusValues(filter.status));
      matchingIds = latest
        .filter((item) => acceptedStatuses.has(item.status))
        .map((item) => item._id);
    }

    if (filter.attention) {
      const attentionStatuses = new Set(["ON_HOLD", "RETURNED", "LOST", "DAMAGED", "SHIPMENT_CANCELLED"]);
      const attentionIds = new Set([
        ...latest.filter((item) => attentionStatuses.has(item.status)).map((item) => String(item._id)),
        ...unresolvedBookings.map((draftId) => String(draftId))
      ]);
      matchingIds = (matchingIds ?? candidateIds).filter((id) => attentionIds.has(String(id)));
    }
  }

  const query = matchingIds ? { ...candidateFilter, _id: { $in: matchingIds } } : candidateFilter;
  const requestedPage = Math.max(1, filter.page);
  const draftProjection = [
    "businessAccountId",
    "branchId",
    "creationSource",
    "customerType",
    "consignorAddress.contactName",
    "consigneeEnteredAddress",
    "consigneeValidatedAddress",
    "parcelList.weightKg",
    "parcelList.shipmentContentType",
    "parcelList.shipmentReference1",
    "serviceType",
    "csbType",
    "createdAt",
    "updatedAt"
  ].join(" ");
  const loadPage = (pageNumber: number) => ShipmentDraft.find(query)
    .select(draftProjection)
    .sort(sortSpec(filter.sort))
    .skip((pageNumber - 1) * filter.limit)
    .limit(filter.limit)
    .lean()
    .exec();
  const [total, requestedDrafts] = await Promise.all([
    ShipmentDraft.countDocuments(query).exec(),
    loadPage(requestedPage)
  ]);
  const totalPages = Math.max(1, Math.ceil(total / filter.limit));
  const page = Math.min(requestedPage, totalPages);
  const drafts = page === requestedPage ? requestedDrafts : await loadPage(page);

  const draftIds = drafts.map((draft) => draft._id);
  const [bookings, events, branches, accounts, manifests, invoices] = await Promise.all([
    DpdShipment.find({ shipmentDraftId: { $in: draftIds } })
      .select("shipmentDraftId swiftlineTrackingNumber status currentShipmentSnapshot bookingSnapshot")
      .lean()
      .exec(),
    ShipmentEvent.find({ shipmentDraftId: { $in: draftIds }, ...eventVisibilityFilter })
      .sort({ shipmentDraftId: 1, eventAt: -1, createdAt: -1 })
      .select("shipmentDraftId status statusLabel eventAt location gatewayCode gatewayName")
      .lean()
      .exec(),
    Branch.find({ _id: { $in: drafts.map((draft) => draft.branchId) } }).select("name code address.city").lean().exec(),
    BusinessAccount.find({ _id: { $in: drafts.map((draft) => draft.businessAccountId) } })
      .select("accountId company.companyName")
      .lean()
      .exec(),
    ShipmentManifest.find({ shipmentDraftIds: { $in: draftIds }, actorRole: filter.actorRole })
      .select("manifestNumber shipmentDraftIds")
      .lean()
      .exec(),
    ShipmentInvoice.find({ shipmentDraftId: { $in: draftIds } })
      .select("shipmentDraftId invoiceNumber currency totalAmountMinor status revision")
      .lean()
      .exec()
  ]);

  const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
  const branchById = new Map(branches.map((branch) => [String(branch._id), branch]));
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const invoiceByDraft = new Map(invoices.map((invoice) => [String(invoice.shipmentDraftId), invoice]));
  const currentEventByDraft = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    if (!currentEventByDraft.has(key)) currentEventByDraft.set(key, event);
  }
  const manifestByDraft = new Map<string, (typeof manifests)[number]>();
  for (const manifest of manifests) {
    for (const draftId of manifest.shipmentDraftIds) manifestByDraft.set(String(draftId), manifest);
  }

  // Every event for a draft, oldest last, so the estimate can find collection
  // and delivery without a second query per row.
  const eventsByDraft = new Map<string, typeof events>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    const draftEvents = eventsByDraft.get(key);
    if (draftEvents) draftEvents.push(event);
    else eventsByDraft.set(key, [event]);
  }
  /**
   * One estimate per row, in a handful of queries rather than two per row.
   * Measured on a twenty-row page: 5 queries and 91ms batched, against 50 and
   * 1.5s computing them one at a time, for identical answers.
   */
  const estimateByDraft = await buildDeliveryEstimates(drafts.map((draft) => ({
    key: String(draft._id),
    draft,
    events: eventsByDraft.get(String(draft._id)) ?? []
  })));
  // A cancelled shipment keeps its label, so cancellation is what makes it
  // unmanifestable rather than the carrier status.
  const cancelledDraftIds = new Set(events
    .filter((event) => event.status === "SHIPMENT_CANCELLED")
    .map((event) => String(event.shipmentDraftId)));

  // Carrier-label readiness is internal operational data. Only load it for the
  // staff list, and only for routes where a DPD label is actually applicable.
  // A carrier booking id alone is not proof that the document was stored.
  const dpdLabelDraftIds = new Set(filter.actorRole === "admin"
    ? drafts
      .filter((draft) => isDpdLabelDestination(
        (draft.consigneeValidatedAddress ?? draft.consigneeEnteredAddress)?.countryCode
      ))
      .map((draft) => String(draft._id))
    : []);
  const bookingIdsForLabelCheck = bookings
    .filter((booking) => dpdLabelDraftIds.has(String(booking.shipmentDraftId)))
    .map((booking) => booking._id);
  const dpdShipmentIdsWithLabel = bookingIdsForLabelCheck.length
    ? await LabelDocument.distinct("dpdShipmentId", {
      dpdShipmentId: { $in: bookingIdsForLabelCheck },
      labelType: "DPD",
      voidedAt: null
    }).exec() as mongoose.Types.ObjectId[]
    : [];
  const dpdLabelShipmentIdSet = new Set(dpdShipmentIdsWithLabel.map((id) => String(id)));

  const shipments = drafts.map((draft) => {
    const draftId = String(draft._id);
    const booking = bookingByDraft.get(draftId);
    const snapshot = booking
      ? readShipmentBookingSnapshot(booking.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
      : null;
    const branch = branchById.get(String(draft.branchId));
    const account = accountById.get(String(draft.businessAccountId));
    const currentEvent = currentEventByDraft.get(draftId);
    const currentStatus = canonicalShipmentStatus(currentEvent?.status) || "SHIPMENT_BOOKED";
    const manifest = manifestByDraft.get(draftId);
    const consignee = draft.consigneeValidatedAddress ?? draft.consigneeEnteredAddress;
    const parcels = snapshot?.parcels ?? [];

    return {
      id: draftId,
      creationSource: draft.creationSource,
      businessAccountId: String(draft.businessAccountId),
      // A walk-in is booked against the system sentinel, whose name is bookkeeping.
      // The list shows the person who actually sent the shipment instead.
      businessAccountName: draft.customerType === "INDIVIDUAL"
        ? draft.consignorAddress?.contactName || "Individual customer"
        : account?.company?.companyName ?? "",
      businessAccountCode: draft.customerType === "INDIVIDUAL"
        ? "INDIVIDUAL"
        : account?.accountId ?? "",
      branchId: String(draft.branchId),
      branch: {
        name: branch?.name ?? "",
        code: branch?.code ?? "",
        city: branch?.address?.city ?? ""
      },
      shipmentReference: draft.parcelList.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 ?? "",
      invoiceNumber: "",
      swiftlineTrackingNumber: booking?.swiftlineTrackingNumber ?? "",
      awbNumbers: parcels.map((parcel) => parcel.swiftlineParcelNumber).filter(Boolean),
      forwardingNumbers: parcels.map((parcel) => parcel.carrierParcelNumber).filter(Boolean),
      consignor: snapshot?.consignor?.companyName || snapshot?.consignor?.contactName || account?.company?.companyName || "",
      consignee: consignee?.companyName || consignee?.contactName || "",
      destination: joinPlace([consignee?.townOrCity, consignee?.countryName || consignee?.countryCode]),
      destinationCountry: consignee?.countryName || consignee?.countryCode || "",
      product: [...new Set(draft.parcelList.map((parcel) => parcel.shipmentContentType).filter(Boolean))].join(", "),
      // The Swiftline service the customer bought, as the manifest shows it.
      serviceInfo: draft.serviceType,
      // Customs route, shown under the shipment reference in the list.
      csbType: normalizeCsbType(draft.csbType),
      route: `${branch?.address?.city || branch?.name || "Origin Not Set"} to `
        + `${consignee?.townOrCity || consignee?.postcode || "Destination Not Set"}`,
      shipmentInvoice: (() => {
        const invoice = invoiceByDraft.get(draftId);
        return invoice ? {
          invoiceNumber: invoice.invoiceNumber,
          currency: invoice.currency,
          chargeableAmountMinor: invoice.totalAmountMinor,
          status: invoice.status,
          revision: invoice.revision
        } : null;
      })(),
      pieces: parcels.length || draft.parcelList.length,
      weightKg: Number((parcels.length
        ? parcels.reduce((sum, parcel) => sum + parcel.actualWeightKg, 0)
        : draft.parcelList.reduce((sum, parcel) => sum + (parcel.weightKg || 0), 0)).toFixed(3)),
      status: currentStatus,
      statusLabel: formatShipmentStatusLabel(currentStatus, currentEvent),
      // The newest scan, so a support agent can see where the shipment last was
      // without opening it. Null until Operations records one.
      // When it should arrive and whether it is going to, so the list answers
      // that without the customer opening each shipment to find out.
      deliveryEstimate: estimateByDraft.get(draftId) ?? null,
      lastScan: currentEvent
        ? {
          statusLabel: formatShipmentStatusLabel(currentStatus, currentEvent),
          location: currentEvent.location ?? "",
          at: currentEvent.eventAt
        }
        : null,
      // The carrier-side state, distinct from the tracking status above. Lets the
      // table mark a shipment that reached the carrier but has not completed.
      bookingStatus: booking?.status ?? "DPD_CREATING",
      bookingStatusLabel: formatBookingStatusLabel(booking?.status ?? "DPD_CREATING"),
      manifest: manifest ? { id: String(manifest._id), manifestNumber: manifest.manifestNumber } : null,
      // Only a completed booking can be manifested: an unreconciled one has no
      // final label set to hand over.
      manifestEligible: !manifest
        && booking?.status === "LABEL_RECEIVED"
        && Boolean(snapshot)
        && cancelledDraftIds.has(draftId) === false,
      ...(filter.actorRole === "admin"
        ? {
          dpdLabelStatus: isDpdLabelDestination(consignee?.countryCode)
            ? booking && dpdLabelShipmentIdSet.has(String(booking._id))
              ? "AVAILABLE" as const
              : "NOT_AVAILABLE" as const
            : "NOT_APPLICABLE" as const
        }
        : {}),
      createdAt: draft.createdAt ?? null,
      updatedAt: draft.updatedAt ?? null
    };
  });

  return { shipments, pagination: { page, limit: filter.limit, total, totalPages } };
}
