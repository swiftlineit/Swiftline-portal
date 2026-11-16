import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { formatShipmentStatusLabel } from "./shipmentListing.service.js";
import {
  SupportTicket, openSupportTicketStatusValues, resolvedClientReplyLimit, shipmentIssueCategoryValues,
  supportTicketCategoryValues, supportTicketPriorityValues, supportTicketStatusValues, firstResponseDueFrom,
  type SupportTicketCategory, type SupportTicketPriority, type SupportTicketStatus
} from "../models/supportTicket.model.js";
import { SupportTicketCounter } from "../models/supportTicketCounter.model.js";
import { SupportTicketMessage } from "../models/supportTicketMessage.model.js";
import { User } from "../models/user.model.js";
import { notifyActiveAdmins, notifyPortalUsers } from "./portalNotification.service.js";

export class SupportTicketError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "SupportTicketError";
  }
}

export type CreateSupportTicketInput = {
  businessAccountId: string;
  category: SupportTicketCategory;
  subject: string;
  description: string;
  relatedShipmentDraftId?: string | null;
  /** Idempotency key used when submitting a persisted client draft. */
  sourceDraftId?: string | null;
};

export type SupportTicketFilters = {
  page: number;
  limit: number;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  search?: string;
  branchId?: string;
};

function financialYear(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

async function nextTicketNumber(now: Date, session: mongoose.ClientSession) {
  const year = financialYear(now);
  const counter = await SupportTicketCounter.findOneAndUpdate(
    { financialYear: year },
    { $inc: { sequence: 1 }, $setOnInsert: { financialYear: year } },
    { upsert: true, returnDocument: "after", runValidators: true, session }
  ).exec();
  if (!counter) throw new SupportTicketError("A ticket number could not be generated. Please try again.", 500);
  return `TKT/${year}/${String(counter.sequence).padStart(5, "0")}`;
}

async function activeMembership(userId: mongoose.Types.ObjectId, businessAccountId: mongoose.Types.ObjectId) {
  const [member, account] = await Promise.all([
    BusinessAccountMember.findOne({ user: userId, businessAccount: businessAccountId, status: "active" }).exec(),
    BusinessAccount.findById(businessAccountId).select("status suspension.mode").lean().exec()
  ]);
  return account && !(account.status === "suspended" && account.suspension?.mode === "SECURITY_LOCK") ? member : null;
}

function isShipmentIssueCategory(category: SupportTicketCategory) {
  return (shipmentIssueCategoryValues as readonly string[]).includes(category);
}

/**
 * How many replies the customer has already spent of their post-resolution
 * allowance. Counted from `resolvedAt`, so reopening and resolving again grants
 * a fresh allowance rather than leaving the thread permanently locked.
 */
function clientRepliesSinceResolution(
  messages: Array<{ authorType: "CLIENT" | "ADMIN"; createdAt: Date }>,
  resolvedAt: Date
) {
  return messages.filter((message) => message.authorType === "CLIENT" && message.createdAt >= resolvedAt).length;
}

async function assertClientCanView(ticket: InstanceType<typeof SupportTicket>, userId: mongoose.Types.ObjectId) {
  const membership = await activeMembership(userId, ticket.businessAccountId);
  if (!membership) throw new SupportTicketError("Ticket not found.", 404);
  const canViewCompanyTickets = ["account_owner", "account_admin"].includes(membership.role);
  if (!canViewCompanyTickets && String(ticket.createdBy) !== String(userId)) {
    throw new SupportTicketError("Ticket not found.", 404);
  }
  return membership;
}

async function contextFor(ticket: InstanceType<typeof SupportTicket>) {
  const [account, branch, creator, assignee, shipment] = await Promise.all([
    BusinessAccount.findById(ticket.businessAccountId).select("accountId company.companyName").lean().exec(),
    Branch.findById(ticket.branchId).select("name code").lean().exec(),
    User.findById(ticket.createdBy).select("name email").lean().exec(),
    ticket.assignedTo ? User.findById(ticket.assignedTo).select("name email").lean().exec() : null,
    ticket.relatedShipmentDraftId
      ? ShipmentDraft.findById(ticket.relatedShipmentDraftId)
        .select("_id consigneeEnteredAddress serviceType serviceCode createdAt")
        .lean()
        .exec()
      : null
  ]);

  /**
   * The shipment a ticket is about, summarised onto the ticket itself.
   *
   * Sent with the ticket rather than fetched by the page, because both the
   * customer writing it and the agent working it need the same facts, and
   * neither should have to open the shipment to answer "where is it".
   */
  let relatedShipment: {
    draftId: string;
    awb: string;
    origin: string;
    destination: string;
    consignee: string;
    bookedAt: Date | null;
    statusLabel: string;
    lastScan: { statusLabel: string; location: string; at: Date } | null;
    service: string;
  } | null = null;

  if (shipment) {
    const [booking, latestEvent] = await Promise.all([
      DpdShipment.findOne({ shipmentDraftId: shipment._id })
        .select("swiftlineTrackingNumber dpdShipmentId")
        .lean()
        .exec(),
      ShipmentEvent.findOne({ shipmentDraftId: shipment._id, customerVisible: true })
        .sort({ eventAt: -1, createdAt: -1 })
        .select("status eventAt location")
        .lean()
        .exec()
    ]);

    const consigneeAddress = shipment.consigneeEnteredAddress;
    relatedShipment = {
      draftId: String(shipment._id),
      awb: booking?.swiftlineTrackingNumber || booking?.dpdShipmentId || "",
      // The raising branch is where the shipment starts from.
      origin: branch?.name ? `${branch.name}${branch.code ? ` (${branch.code})` : ""}` : "",
      destination: [
        consigneeAddress?.townOrCity,
        consigneeAddress?.postcode,
        consigneeAddress?.countryName || consigneeAddress?.countryCode
      ].filter(Boolean).join(", "),
      consignee: consigneeAddress?.companyName || consigneeAddress?.contactName || "",
      bookedAt: shipment.createdAt ?? null,
      statusLabel: formatShipmentStatusLabel(latestEvent?.status),
      lastScan: latestEvent
        ? {
          statusLabel: formatShipmentStatusLabel(latestEvent.status),
          location: latestEvent.location ?? "",
          at: latestEvent.eventAt
        }
        : null,
      service: shipment.serviceType || shipment.serviceCode || ""
    };
  }

  return {
    account: account ? { id: String(account._id), accountId: account.accountId, companyName: account.company.companyName } : null,
    branch: branch ? { id: String(branch._id), name: branch.name, code: branch.code } : null,
    creator: creator ? { id: String(creator._id), name: creator.name || creator.email, email: creator.email } : null,
    assignee: assignee ? { id: String(assignee._id), name: assignee.name || assignee.email, email: assignee.email } : null,
    relatedShipment
  };
}

/**
 * The first-response clock, as the queue reads it.
 *
 * `breached` is derived here rather than stored: a written flag is wrong for
 * every minute between the deadline passing and a sweeper noticing it, and this
 * is read far more often than any job would run. Once Swiftline has replied the
 * clock stops, whether it was met or missed- the answer is a fact about that
 * reply, not about the current time.
 */
function serializeTicketSla(ticket: InstanceType<typeof SupportTicket>) {
  const respondedAt = ticket.firstRespondedAt ?? null;
  const dueAt = ticket.firstResponseDueAt;
  const settled = Boolean(respondedAt) || ticket.status === "RESOLVED" || ticket.status === "CLOSED";

  return {
    firstResponseDueAt: dueAt,
    firstRespondedAt: respondedAt,
    breached: respondedAt ? respondedAt > dueAt : !settled && new Date() > dueAt,
    /** Still running, so the UI knows whether to count down or report an outcome. */
    open: !settled,
    /**
     * When Swiftline was alerted, or null if the sweeper has not run yet.
     *
     * Stored rather than derived, unlike `breached`, because it records a
     * message that was actually sent- the UI can only claim "escalated" if
     * somebody was genuinely told.
     */
    escalatedAt: ticket.slaEscalatedAt ?? null
  };
}

export async function serializeSupportTicket(ticket: InstanceType<typeof SupportTicket>, audience: "CLIENT" | "ADMIN", includeMessages = false) {
  const context = await contextFor(ticket);
  const messages = includeMessages
    ? await SupportTicketMessage.find({ ticketId: ticket._id, ...(audience === "CLIENT" ? { internal: false } : {}) })
      .sort({ createdAt: 1 }).exec()
    : [];
  const authors = includeMessages
    ? new Map((await User.find({ _id: { $in: messages.map((message) => message.authorId) } }).select("name email").lean().exec())
      .map((user) => [String(user._id), user]))
    : new Map<string, { name?: string; email: string }>();
  // Only the detail view loads messages, and only it renders the composer, so the
  // allowance is computed from the messages already in hand rather than re-queried.
  const replyAllowance = includeMessages && ticket.status === "RESOLVED" && ticket.resolvedAt
    ? {
      used: Math.min(clientRepliesSinceResolution(messages, ticket.resolvedAt), resolvedClientReplyLimit),
      max: resolvedClientReplyLimit
    }
    : null;

  return {
    id: String(ticket._id), ticketNumber: ticket.ticketNumber,
    businessAccountId: String(ticket.businessAccountId), branchId: String(ticket.branchId),
    resolvedReplyAllowance: replyAllowance,
    category: ticket.category, priority: ticket.priority, status: ticket.status, subject: ticket.subject,
    relatedShipmentDraftId: ticket.relatedShipmentDraftId ? String(ticket.relatedShipmentDraftId) : null,
    assignedTo: ticket.assignedTo ? String(ticket.assignedTo) : null,
    lastMessageAt: ticket.lastMessageAt, resolvedAt: ticket.resolvedAt ?? null, closedAt: ticket.closedAt ?? null,
    sla: serializeTicketSla(ticket),
    createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, ...context,
    statusHistory: ticket.statusHistory.map((item) => ({
      fromStatus: item.fromStatus ?? null, toStatus: item.toStatus, changedBy: String(item.changedBy),
      note: item.note, changedAt: item.changedAt
    })),
    messages: messages.map((message) => {
      const author = authors.get(String(message.authorId));
      return {
        id: String(message._id), authorId: String(message.authorId), authorType: message.authorType,
        authorName: author?.name || author?.email || "Portal user", message: message.message,
        internal: audience === "ADMIN" ? message.internal : false, createdAt: message.createdAt
      };
    })
  };
}

function ticketQuery(filters: SupportTicketFilters) {
  const query: Record<string, unknown> = {};
  if (filters.status && supportTicketStatusValues.includes(filters.status)) query.status = filters.status;
  if (filters.priority && supportTicketPriorityValues.includes(filters.priority)) query.priority = filters.priority;
  if (filters.category && supportTicketCategoryValues.includes(filters.category)) query.category = filters.category;
  if (filters.search) {
    const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [{ ticketNumber: { $regex: escaped, $options: "i" } }, { subject: { $regex: escaped, $options: "i" } }];
  }
  if (filters.branchId) {
    query.branchId = new mongoose.Types.ObjectId(filters.branchId);
  }
  return query;
}

export async function listAdminSupportTickets(filters: SupportTicketFilters) {
  const query = ticketQuery(filters);
  const [tickets, total] = await Promise.all([
    SupportTicket.find(query).sort({ lastMessageAt: -1 }).skip((filters.page - 1) * filters.limit).limit(filters.limit).exec(),
    SupportTicket.countDocuments(query)
  ]);
  return { tickets: await Promise.all(tickets.map((ticket) => serializeSupportTicket(ticket, "ADMIN"))), total };
}

export async function listClientSupportTickets(userId: mongoose.Types.ObjectId, filters: SupportTicketFilters) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" }).select("businessAccount role").lean().exec();
  const accounts = await BusinessAccount.find({ _id: { $in: memberships.map((member) => member.businessAccount) } })
    .select("status suspension.mode").lean().exec();
  const available = new Set(accounts.filter((account) => !(account.status === "suspended" && account.suspension?.mode === "SECURITY_LOCK"))
    .map((account) => String(account._id)));
  const visibility = memberships.filter((membership) => available.has(String(membership.businessAccount))).map((membership) => ["account_owner", "account_admin"].includes(membership.role)
    ? { businessAccountId: membership.businessAccount }
    : { businessAccountId: membership.businessAccount, createdBy: userId });
  const query = { $and: [ticketQuery(filters), { $or: visibility.length ? visibility : [{ _id: null }] }] };
  const [tickets, total] = await Promise.all([
    SupportTicket.find(query).sort({ lastMessageAt: -1 }).skip((filters.page - 1) * filters.limit).limit(filters.limit).exec(),
    SupportTicket.countDocuments(query)
  ]);
  return { tickets: await Promise.all(tickets.map((ticket) => serializeSupportTicket(ticket, "CLIENT"))), total };
}

export async function createClientSupportTicket(userId: mongoose.Types.ObjectId, input: CreateSupportTicketInput) {
  if (!mongoose.Types.ObjectId.isValid(input.businessAccountId)) throw new SupportTicketError("Select a valid business account.");
  const accountId = new mongoose.Types.ObjectId(input.businessAccountId);
  const [membership, account] = await Promise.all([
    activeMembership(userId, accountId),
    BusinessAccount.findById(accountId).select("assignedBranch status").exec()
  ]);
  if (!membership || !account) throw new SupportTicketError("You do not have access to this business account.", 403);
  if (!account.assignedBranch) throw new SupportTicketError("Contact Swiftline because this account has no assigned branch.", 409);
  let sourceDraftId: mongoose.Types.ObjectId | null = null;
  if (input.sourceDraftId) {
    if (!mongoose.Types.ObjectId.isValid(input.sourceDraftId)) throw new SupportTicketError("The ticket draft is invalid.", 400);
    sourceDraftId = new mongoose.Types.ObjectId(input.sourceDraftId);
    const existingFromDraft = await SupportTicket.findOne({ sourceDraftId }).exec();
    if (existingFromDraft) {
      if (String(existingFromDraft.createdBy) !== String(userId) || String(existingFromDraft.businessAccountId) !== String(accountId)) {
        throw new SupportTicketError("The ticket draft could not be submitted.", 409);
      }
      return existingFromDraft;
    }
  }
  const branchId = account.assignedBranch;
  // A shipment problem is only actionable against a named shipment.
  if (isShipmentIssueCategory(input.category) && !input.relatedShipmentDraftId) {
    throw new SupportTicketError("Select the shipment this issue relates to.");
  }
  let shipmentId: mongoose.Types.ObjectId | null = null;
  if (input.relatedShipmentDraftId) {
    if (!mongoose.Types.ObjectId.isValid(input.relatedShipmentDraftId)) throw new SupportTicketError("Select a valid related shipment.");
    shipmentId = new mongoose.Types.ObjectId(input.relatedShipmentDraftId);
    const shipment = await ShipmentDraft.exists({ _id: shipmentId, businessAccountId: accountId });
    if (!shipment) throw new SupportTicketError("The selected shipment does not belong to this business account.", 400);
    // One live ticket per shipment, across the whole account: a second one would
    // split the conversation about the same problem.
    const openTicket = await SupportTicket.findOne({
      businessAccountId: accountId,
      relatedShipmentDraftId: shipmentId,
      status: { $in: openSupportTicketStatusValues }
    }).select("ticketNumber").lean().exec();
    if (openTicket) {
      throw new SupportTicketError(
        `Ticket ${openTicket.ticketNumber} is already open for this shipment. Reply on that ticket until it is resolved.`,
        409
      );
    }
  }
  const now = new Date();
  const session = await mongoose.startSession();
  let createdTicketId: mongoose.Types.ObjectId | null = null;
  try {
    await session.withTransaction(async () => {
      const created = await SupportTicket.create([{
        ticketNumber: await nextTicketNumber(now, session), businessAccountId: accountId,
        branchId, createdBy: userId, ...(sourceDraftId ? { sourceDraftId } : {}), relatedShipmentDraftId: shipmentId,
        category: input.category, priority: "NORMAL", status: "OPEN", subject: input.subject,
        statusHistory: [{ fromStatus: null, toStatus: "OPEN", changedBy: userId, note: "Ticket raised by customer.", changedAt: now }],
        lastMessageAt: now, firstResponseDueAt: firstResponseDueFrom("NORMAL", now)
      }], { session });
      const createdTicket = created[0];
      if (!createdTicket) throw new SupportTicketError("The ticket could not be created. Please try again.", 500);
      createdTicketId = createdTicket._id;
      await SupportTicketMessage.create([{
        ticketId: createdTicket._id, authorId: userId, authorType: "CLIENT", message: input.description, internal: false, createdAt: now
      }], { session });
      await AuditLog.create([{
        action: "SUPPORT_TICKET_CREATED", entityType: "SUPPORT_TICKET", entityId: createdTicket._id,
        performedBy: userId, performedAt: now, metadata: { ticketNumber: createdTicket.ticketNumber, businessAccountId: accountId }
      }], { session });
    });
  } catch (error) {
    // The unique sourceDraftId index closes the race where two submit requests
    // arrive together. Return the winner so retries never create a duplicate.
    const duplicateKey = typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
    if (!duplicateKey || !sourceDraftId) throw error;
    const existingFromDraft = await SupportTicket.findOne({ sourceDraftId }).exec();
    if (!existingFromDraft) throw error;
    createdTicketId = existingFromDraft._id;
  } finally { await session.endSession(); }
  if (!createdTicketId) throw new SupportTicketError("The ticket could not be created. Please try again.", 500);
  const ticket = await SupportTicket.findById(createdTicketId).exec();
  if (!ticket) throw new SupportTicketError("The ticket could not be loaded after creation. Please contact Swiftline support.", 500);
  await notifyActiveAdmins({
    type: "SUPPORT_TICKET_CREATED", title: "New support ticket",
    message: `${ticket.ticketNumber} has been raised and requires review.`,
    href: `/dashboard/tickets/${String(ticket._id)}#ticket-conversation`, idempotencyKey: `SUPPORT_TICKET_CREATED:${String(ticket._id)}`,
    businessAccountId: ticket.businessAccountId, metadata: { ticketId: ticket._id }
  });
  return ticket;
}

export async function getSupportTicket(ticketId: string, audience: "CLIENT" | "ADMIN", userId?: mongoose.Types.ObjectId) {
  if (!mongoose.Types.ObjectId.isValid(ticketId)) throw new SupportTicketError("Ticket not found.", 404);
  const ticket = await SupportTicket.findById(ticketId).exec();
  if (!ticket) throw new SupportTicketError("Ticket not found.", 404);
  if (audience === "CLIENT") {
    if (!userId) throw new SupportTicketError("Please sign in again.", 401);
    await assertClientCanView(ticket, userId);
  }
  return ticket;
}

export async function addSupportTicketReply(input: {
  ticket: InstanceType<typeof SupportTicket>; userId: mongoose.Types.ObjectId; audience: "CLIENT" | "ADMIN";
  message: string; internal?: boolean;
}) {
  if (input.audience === "CLIENT") {
    await assertClientCanView(input.ticket, input.userId);
    if (input.ticket.status === "CLOSED") throw new SupportTicketError("This ticket is closed. Please raise a new ticket if you still need help.", 409);
    // A resolved ticket stays open for a short follow-up only. Swiftline is not
    // capped, so a customer's last question can always be answered.
    if (input.ticket.status === "RESOLVED" && input.ticket.resolvedAt) {
      const messages = await SupportTicketMessage.find({
        ticketId: input.ticket._id,
        authorType: "CLIENT",
        createdAt: { $gte: input.ticket.resolvedAt }
      }).select("authorType createdAt").lean().exec();
      if (messages.length >= resolvedClientReplyLimit) {
        throw new SupportTicketError(
          `This ticket is resolved and you have used both follow-up replies. Please raise a new ticket if you still need help.`,
          409
        );
      }
    }
  }
  const internal = input.audience === "ADMIN" && Boolean(input.internal);
  const now = new Date();
  await SupportTicketMessage.create({
    ticketId: input.ticket._id, authorId: input.userId, authorType: input.audience, message: input.message, internal, createdAt: now
  });
  input.ticket.lastMessageAt = now;
  // The first non-internal Swiftline reply stops the first-response clock. An
  // internal note is staff talking to staff, and does not answer the customer.
  if (input.audience === "ADMIN" && !internal && !input.ticket.firstRespondedAt) {
    input.ticket.firstRespondedAt = now;
  }
  await input.ticket.save();
  await AuditLog.create({
    action: "SUPPORT_TICKET_REPLIED", entityType: "SUPPORT_TICKET", entityId: input.ticket._id,
    performedBy: input.userId, performedAt: now, metadata: { internal, audience: input.audience }
  });
  if (input.audience === "ADMIN" && !internal) {
    await notifyPortalUsers([input.ticket.createdBy], {
      type: "SUPPORT_TICKET_REPLY", title: "Swiftline replied to your ticket",
      message: `${input.ticket.ticketNumber} has a new response.`,
      href: `/client/tickets/${String(input.ticket._id)}#ticket-conversation`,
      idempotencyKey: `SUPPORT_TICKET_REPLY:${String(input.ticket._id)}:${now.getTime()}`,
      businessAccountId: input.ticket.businessAccountId, metadata: { ticketId: input.ticket._id }
    });
  } else if (input.audience === "CLIENT") {
    const notification = {
      type: "SUPPORT_TICKET_REPLY" as const, title: "Customer replied to support ticket",
      message: `${input.ticket.ticketNumber} has a new customer response.`,
      href: `/dashboard/tickets/${String(input.ticket._id)}#ticket-conversation`,
      idempotencyKey: `SUPPORT_TICKET_CLIENT_REPLY:${String(input.ticket._id)}:${now.getTime()}`,
      businessAccountId: input.ticket.businessAccountId, metadata: { ticketId: input.ticket._id }
    };
    if (input.ticket.assignedTo) await notifyPortalUsers([input.ticket.assignedTo], notification);
    else await notifyActiveAdmins(notification);
  }
}

/**
 * Where a ticket may go from where it is.
 *
 * The three waiting states move freely between each other: a ticket held for a
 * carrier often turns out to need the customer instead, and forcing it back
 * through IN_PROGRESS to get there would put a step in the history that nobody
 * actually took. Everything live can be resolved or closed outright, because a
 * ticket answered in one reply should not need a detour to be finished.
 */
const allowedTransitions: Record<SupportTicketStatus, SupportTicketStatus[]> = {
  OPEN: ["ASSIGNED", "IN_PROGRESS", "AWAITING_CARRIER", "WAITING_FOR_CUSTOMER", "ACTION_REQUIRED", "RESOLVED", "CLOSED"],
  ASSIGNED: ["IN_PROGRESS", "AWAITING_CARRIER", "WAITING_FOR_CUSTOMER", "ACTION_REQUIRED", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["AWAITING_CARRIER", "WAITING_FOR_CUSTOMER", "ACTION_REQUIRED", "RESOLVED", "CLOSED"],
  AWAITING_CARRIER: ["IN_PROGRESS", "WAITING_FOR_CUSTOMER", "ACTION_REQUIRED", "RESOLVED", "CLOSED"],
  WAITING_FOR_CUSTOMER: ["IN_PROGRESS", "AWAITING_CARRIER", "ACTION_REQUIRED", "RESOLVED", "CLOSED"],
  ACTION_REQUIRED: ["IN_PROGRESS", "AWAITING_CARRIER", "WAITING_FOR_CUSTOMER", "RESOLVED", "CLOSED"],
  // A resolved ticket reopens into investigation rather than back to Open, so
  // the queue never shows a second-time ticket as though nobody had seen it.
  RESOLVED: ["IN_PROGRESS", "CLOSED"],
  CLOSED: ["IN_PROGRESS"]
};

export async function updateSupportTicketByAdmin(input: {
  ticket: InstanceType<typeof SupportTicket>; userId: mongoose.Types.ObjectId;
  status?: SupportTicketStatus; priority?: SupportTicketPriority; assignedTo?: string | null; note?: string;
}) {
  const previousStatus = input.ticket.status;
  if (input.status && input.status !== previousStatus) {
    if (!allowedTransitions[previousStatus].includes(input.status)) {
      throw new SupportTicketError(`A ${previousStatus.replaceAll("_", " ").toLowerCase()} ticket cannot move directly to ${input.status.replaceAll("_", " ").toLowerCase()}.`, 409);
    }
    input.ticket.status = input.status;
    input.ticket.statusHistory.push({
      fromStatus: previousStatus, toStatus: input.status, changedBy: input.userId,
      note: input.note || (previousStatus === "CLOSED" ? "Ticket reopened by Swiftline support." : "Status updated by Swiftline support."),
      changedAt: new Date()
    });
    input.ticket.resolvedAt = input.status === "RESOLVED" ? new Date() : input.ticket.resolvedAt;
    input.ticket.closedAt = input.status === "CLOSED" ? new Date() : null;
  }
  if (input.priority && input.priority !== input.ticket.priority) {
    input.ticket.priority = input.priority;
    // Raising priority pulls the deadline in; it is measured from when the
    // ticket was raised, not from now, so escalating an already-old ticket
    // reports it overdue rather than granting it a fresh window.
    if (!input.ticket.firstRespondedAt) {
      input.ticket.firstResponseDueAt = firstResponseDueFrom(input.priority, input.ticket.createdAt);
    }
  }
  if (input.assignedTo !== undefined) {
    if (input.assignedTo) {
      if (!mongoose.Types.ObjectId.isValid(input.assignedTo)) throw new SupportTicketError("Select a valid support assignee.");
      const admin = await User.exists({ _id: input.assignedTo, role: "admin", userStatus: "active" });
      if (!admin) throw new SupportTicketError("The selected support assignee is unavailable.");
      input.ticket.assignedTo = new mongoose.Types.ObjectId(input.assignedTo);
    } else input.ticket.assignedTo = null;
  }
  await input.ticket.save();
  await AuditLog.create({
    action: "SUPPORT_TICKET_UPDATED", entityType: "SUPPORT_TICKET", entityId: input.ticket._id,
    performedBy: input.userId, performedAt: new Date(), metadata: { previousStatus, status: input.ticket.status, priority: input.ticket.priority }
  });
  if (input.status && input.status !== previousStatus) {
    await notifyPortalUsers([input.ticket.createdBy], {
      type: "SUPPORT_TICKET_STATUS_UPDATED", title: "Support ticket updated",
      message: `${input.ticket.ticketNumber} is now ${input.ticket.status.replaceAll("_", " ").toLowerCase()}.`,
      href: `/client/tickets/${String(input.ticket._id)}#ticket-conversation`,
      idempotencyKey: `SUPPORT_TICKET_STATUS:${String(input.ticket._id)}:${input.ticket.status}:${input.ticket.statusHistory.length}`,
      businessAccountId: input.ticket.businessAccountId, metadata: { ticketId: input.ticket._id, status: input.ticket.status }
    });
  }
}

export async function listActiveSupportAdmins() {
  return User.find({ role: "admin", userStatus: "active" }).select("name email").sort({ name: 1, email: 1 }).lean().exec();
}
