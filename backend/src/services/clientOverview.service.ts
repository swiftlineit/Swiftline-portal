import mongoose from "mongoose";
import { Claim } from "../models/claim.model.js";
import { activeClaimStatusValues } from "../models/claimTypes.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { openSupportTicketStatusValues, SupportTicket } from "../models/supportTicket.model.js";
import {
  collectClientAttention,
  type ClientAction,
  type ShipmentException
} from "./clientAttention.service.js";

/**
 * Everything the client dashboard shows, in one round trip.
 *
 * The staff dashboard builds its figures by fetching whole lists into the
 * browser and counting them. That is the pattern this endpoint exists to avoid:
 * this is the first screen a customer sees, and it has to answer "where are my
 * shipments, what is broken, what do you need from me" without downloading the
 * account's history to do arithmetic on it.
 *
 * So every number here is counted in the database and returned finished. The
 * caller renders; it never counts.
 */

/** Statuses that mean the shipment is moving but has not reached delivery. */
const inTransitStatuses = [
  "PARCEL_COLLECTED",
  "WAREHOUSE_SCAN_IN",
  "ORIGIN_HUB_PROCESSED",
  "READY_FOR_EXPORT",
  "ORIGIN_HUB_DISPATCHED",
  "EXPORT_CUSTOMS_CLEARED",
  "FLIGHT_ASSIGNED",
  "FLIGHT_DEPARTED",
  "DESTINATION_ARRIVED",
  "IMPORT_CUSTOMS_CLEARANCE",
  "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED",
  "DELIVERY_HUB_ARRIVED",
  "IN_TRANSIT"
];

/**
 * Exception types that mean the shipment will not arrive when it should.
 *
 * Once a delivery estimate is stamped on each shipment this widens to include
 * anything past its date; for now a delay is something Operations has recorded,
 * which is the only delay the system actually knows about.
 */
const delayExceptionTypes = new Set(["SHIPMENT_DELAYED", "MISSED_CONNECTION"]);

/**
 * Midnight tonight and this morning, in IST.
 *
 * "Delivered today" has to mean the Indian working day. A UTC server would roll
 * the counter over at 05:30 IST and show a morning's deliveries as yesterday's.
 */
function istDayStart(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00+05:30`);
}

export type ClientOverviewSummary = {
  totalShipments: number;
  inTransit: number;
  outForDelivery: number;
  deliveredToday: number;
  delayed: number;
  customsHold: number;
  exceptions: number;
  actionRequired: number;
  openClaims: number;
  openTickets: number;
  /**
   * Null rather than zero when the member may not see money. Zero is a figure,
   * and showing one to someone without financial access states something false.
   */
};

/** One line in "Needs Your Attention", from either side of the engine. */
export type AttentionItem = {
  id: string;
  kind: "ACTION" | "EXCEPTION";
  label: string;
  detail: string;
  actionLabel: string;
  href: string;
  awb: string | null;
  severity: "CRITICAL" | "WARNING" | "INFO";
  at: Date;
};

export type ClientOverview = {
  summary: ClientOverviewSummary;
  needsAttention: AttentionItem[];
  exceptions: ShipmentException[];
  actions: ClientAction[];
};

/** How many rows the dashboard strip shows before "view all". */
const NEEDS_ATTENTION_LIMIT = 6;

function toAttentionItem(action: ClientAction): AttentionItem;
function toAttentionItem(exception: ShipmentException): AttentionItem;
function toAttentionItem(entry: ClientAction | ShipmentException): AttentionItem {
  if ("actionLabel" in entry) {
    return {
      id: entry.id,
      kind: "ACTION",
      label: entry.label,
      detail: entry.detail,
      actionLabel: entry.actionLabel,
      href: entry.href,
      awb: entry.awb,
      severity: entry.severity,
      at: entry.raisedAt
    };
  }

  return {
    id: entry.id,
    kind: "EXCEPTION",
    label: `${entry.awb || "Shipment"}- ${entry.label}`,
    detail: entry.problem,
    actionLabel: "View Details",
    href: entry.href,
    awb: entry.awb,
    severity: entry.severity,
    at: entry.lastUpdateAt
  };
}

export async function buildClientOverview(input: {
  businessAccountId: mongoose.Types.ObjectId;
  branchIds?: mongoose.Types.ObjectId[];
  now?: Date;
}): Promise<ClientOverview> {
  const now = input.now ?? new Date();

  const draftFilter: Record<string, unknown> = {
    businessAccountId: input.businessAccountId,
    deletedAt: null
  };
  if (input.branchIds?.length) draftFilter.branchId = { $in: input.branchIds };

  // Only booked shipments count on a control tower: an unbooked draft has no
  // AWB, no movement, and nothing anyone can track.
  //
  // The account's drafts are found first and their bookings looked up from
  // those, rather than scanning every booked shipment in the system and
  // narrowing afterwards. Both steps use an index, so a busy month for another
  // customer never slows this customer's dashboard.
  const accountDrafts = await ShipmentDraft.find(draftFilter).select("_id").lean().exec();
  const booked = accountDrafts.length
    ? await DpdShipment.find({
      shipmentDraftId: { $in: accountDrafts.map((draft) => draft._id) },
      status: "LABEL_RECEIVED"
    })
      .select("shipmentDraftId")
      .lean()
      .exec()
    : [];
  const draftIds = booked.map((item) => item.shipmentDraftId as mongoose.Types.ObjectId);

  const dayStart = istDayStart(now);

  const [latestEvents, deliveredToday, openClaims, openTickets, attention] = await Promise.all([
    // One pass over the events, reduced to the newest per shipment in the
    // database rather than in memory.
    draftIds.length
      ? ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
        { $match: { shipmentDraftId: { $in: draftIds }, customerVisible: true } },
        { $sort: { eventAt: -1, createdAt: -1 } },
        { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
      ]).exec()
      : [],
    draftIds.length
      ? ShipmentEvent.countDocuments({
        shipmentDraftId: { $in: draftIds },
        status: "DELIVERED",
        customerVisible: true,
        eventAt: { $gte: dayStart }
      }).exec()
      : 0,
    Claim.countDocuments({
      businessAccountId: input.businessAccountId,
      status: { $in: activeClaimStatusValues }
    }).exec(),
    SupportTicket.countDocuments({
      businessAccountId: input.businessAccountId,
      status: { $in: openSupportTicketStatusValues }
    }).exec(),
    collectClientAttention({
      businessAccountId: input.businessAccountId,
      branchIds: input.branchIds
    })
  ]);

  const statusCounts = new Map<string, number>();
  for (const entry of latestEvents) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
  }
  const countOf = (statuses: string[]) =>
    statuses.reduce((total, status) => total + (statusCounts.get(status) ?? 0), 0);

  // A shipment with two delay exceptions is one delayed shipment, so the count
  // is of shipments rather than of exceptions.
  const delayedShipmentIds = new Set(
    attention.exceptions
      .filter((exception) => delayExceptionTypes.has(exception.type))
      .map((exception) => exception.shipmentDraftId)
  );

  const summary: ClientOverviewSummary = {
    totalShipments: draftIds.length,
    inTransit: countOf(inTransitStatuses),
    outForDelivery: countOf(["OUT_FOR_DELIVERY"]),
    deliveredToday,
    delayed: delayedShipmentIds.size,
    customsHold: attention.exceptionCountsByType.CUSTOMS_HOLD ?? 0,
    exceptions: attention.exceptions.length,
    actionRequired: attention.actions.length,
    openClaims,
    openTickets
  };

  // Actions lead: the customer can clear those, and a control tower should put
  // what they can do above what they can only watch.
  //
  // A shipment whose problem the customer can fix produces both an action and
  // an exception. Only the action is listed- the exception says the same thing
  // without the button, so showing both filled this strip with each shipment
  // twice and pushed other shipments off it entirely.
  const shipmentsWithActions = new Set(
    attention.actions.map((action) => action.shipmentDraftId).filter(Boolean)
  );
  const needsAttention = [
    ...attention.actions.map((action) => toAttentionItem(action)),
    ...attention.exceptions
      .filter((exception) => !shipmentsWithActions.has(exception.shipmentDraftId))
      .map((exception) => toAttentionItem(exception))
  ].slice(0, NEEDS_ATTENTION_LIMIT);

  return {
    summary,
    needsAttention,
    exceptions: attention.exceptions,
    actions: attention.actions
  };
}
