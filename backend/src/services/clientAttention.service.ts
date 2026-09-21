import mongoose from "mongoose";
import { Claim } from "../models/claim.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DeliveryAssignment, DeliveryAttempt, PodDispute } from "../models/pod.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentChargeVerification } from "../models/shipmentChargeVerification.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";

/**
 * What needs the customer's attention, derived rather than stored.
 *
 * Every signal here already exists somewhere in the system- a hold and its
 * reason, a failed delivery attempt, a POD dispute, an overdue statement, a
 * claim waiting on documents. Nothing new is written and nothing has to be kept
 * in step: storing a copy would mean invalidating it on every event, dispute and
 * payment, and a stale exception list is worse than none.
 *
 * The split is by what the reader can do about it. An **exception** is something
 * wrong that Swiftline is working on; the client is being told, not asked. An
 * **action** is something only the client can clear, and it always carries the
 * control that clears it. Anything that is both is an action- the customer
 * needs the button more than they need the news.
 */

// ── vocabulary ────────────────────────────────────────────────────────────────

export const shipmentExceptionTypeValues = [
  "CUSTOMS_HOLD",
  "ADDRESS_PROBLEM",
  "DELIVERY_ATTEMPTED",
  "CONSIGNEE_UNAVAILABLE",
  "DAMAGED_SHIPMENT",
  "MISSED_CONNECTION",
  "SHIPMENT_DELAYED",
  "REMOTE_AREA_ISSUE",
  "CLEARANCE_DOCUMENTS_REQUIRED",
  "RETURN_TO_SENDER",
  "WEIGHT_DIFFERENCE",
  "CARRIER_EXCEPTION"
] as const;
export type ShipmentExceptionType = (typeof shipmentExceptionTypeValues)[number];

/**
 * There is deliberately no "customs KYC required" action here.
 *
 * `validateKycDocuments` in shipmentValidation.service.ts refuses to book a
 * shipment whose KYC pack is incomplete, so a booked shipment always has one. A
 * document customs asks for *after* booking arrives as a `missing_documents`
 * hold, which is UPLOAD_CLEARANCE_DOCUMENTS below. Account-level KYC is a
 * different thing again and belongs to the Customs & KYC centre.
 */
export const clientActionTypeValues = [
  "UPLOAD_CLEARANCE_DOCUMENTS",
  "CONFIRM_CONSIGNEE_ADDRESS",
  "SETTLE_OVERDUE_INVOICE",
  "RESPOND_TO_SUPPORT_TICKET",
  "PROVIDE_CLAIM_DOCUMENTS",
  "ACCEPT_SETTLEMENT_OFFER"
] as const;
export type ClientActionType = (typeof clientActionTypeValues)[number];

/** Who inside Swiftline owns the problem, so the client knows who is on it. */
export const attentionTeamValues = [
  "Customs",
  "Operations",
  "Delivery",
  "Finance",
  "Customer Support"
] as const;
export type AttentionTeam = (typeof attentionTeamValues)[number];

/**
 * How loudly an item reads.
 *
 * CRITICAL is reserved for things that stop the shipment or cost money if
 * ignored. Making everything critical is the same as making nothing critical.
 */
export type AttentionSeverity = "CRITICAL" | "WARNING" | "INFO";

export const shipmentExceptionLabels: Record<ShipmentExceptionType, string> = {
  CUSTOMS_HOLD: "Customs Hold",
  ADDRESS_PROBLEM: "Address Problem",
  DELIVERY_ATTEMPTED: "Delivery Attempted",
  CONSIGNEE_UNAVAILABLE: "Consignee Unavailable",
  DAMAGED_SHIPMENT: "Damaged Shipment",
  MISSED_CONNECTION: "Missed Connection",
  SHIPMENT_DELAYED: "Shipment Delayed",
  REMOTE_AREA_ISSUE: "Remote Area Issue",
  CLEARANCE_DOCUMENTS_REQUIRED: "Clearance Documents Required",
  RETURN_TO_SENDER: "Return to Sender",
  WEIGHT_DIFFERENCE: "Weight Difference",
  CARRIER_EXCEPTION: "Carrier Exception"
};

const exceptionTeams: Record<ShipmentExceptionType, AttentionTeam> = {
  CUSTOMS_HOLD: "Customs",
  ADDRESS_PROBLEM: "Operations",
  DELIVERY_ATTEMPTED: "Delivery",
  CONSIGNEE_UNAVAILABLE: "Delivery",
  DAMAGED_SHIPMENT: "Customer Support",
  MISSED_CONNECTION: "Operations",
  SHIPMENT_DELAYED: "Operations",
  REMOTE_AREA_ISSUE: "Delivery",
  CLEARANCE_DOCUMENTS_REQUIRED: "Customs",
  RETURN_TO_SENDER: "Operations",
  WEIGHT_DIFFERENCE: "Finance",
  CARRIER_EXCEPTION: "Operations"
};

const exceptionSeverities: Record<ShipmentExceptionType, AttentionSeverity> = {
  CUSTOMS_HOLD: "CRITICAL",
  ADDRESS_PROBLEM: "CRITICAL",
  DELIVERY_ATTEMPTED: "WARNING",
  CONSIGNEE_UNAVAILABLE: "WARNING",
  DAMAGED_SHIPMENT: "CRITICAL",
  MISSED_CONNECTION: "WARNING",
  SHIPMENT_DELAYED: "WARNING",
  REMOTE_AREA_ISSUE: "INFO",
  CLEARANCE_DOCUMENTS_REQUIRED: "CRITICAL",
  RETURN_TO_SENDER: "CRITICAL",
  WEIGHT_DIFFERENCE: "INFO",
  CARRIER_EXCEPTION: "WARNING"
};

/** What Swiftline is doing about it, in the client's words. */
const exceptionNextSteps: Record<ShipmentExceptionType, string> = {
  CUSTOMS_HOLD: "Swiftline is working with customs to release the shipment.",
  ADDRESS_PROBLEM: "Confirm the delivery address so the shipment can move again.",
  DELIVERY_ATTEMPTED: "The carrier will attempt delivery again.",
  CONSIGNEE_UNAVAILABLE: "Confirm a time or an alternative recipient with the consignee.",
  DAMAGED_SHIPMENT: "Swiftline is investigating. Raise a claim if the contents are affected.",
  MISSED_CONNECTION: "Swiftline is rebooking the shipment onto the next available service.",
  SHIPMENT_DELAYED: "Swiftline Operations is chasing the shipment.",
  REMOTE_AREA_ISSUE: "Delivery to this area takes longer than the standard transit time.",
  CLEARANCE_DOCUMENTS_REQUIRED: "Upload the documents customs has asked for.",
  RETURN_TO_SENDER: "The shipment is on its way back. Swiftline will confirm the return.",
  WEIGHT_DIFFERENCE: "The carrier re-weighed this shipment and the charge has changed.",
  CARRIER_EXCEPTION: "Swiftline Operations is following this up with the carrier."
};

// ── pure classification ───────────────────────────────────────────────────────

/**
 * A hold reason as an exception type.
 *
 * Reasons with no dedicated type fall through to SHIPMENT_DELAYED rather than
 * a catch-all "carrier exception": a hold is not the carrier's doing, and a held
 * shipment is genuinely delayed, so that is the one thing always true of it.
 * The hold note carries the specifics.
 */
export function exceptionTypeForHoldReason(reason?: string | null): ShipmentExceptionType {
  switch (reason) {
    case "customs_query":
    case "restricted_item_check":
      return "CUSTOMS_HOLD";
    case "missing_documents":
      return "CLEARANCE_DOCUMENTS_REQUIRED";
    case "address_issue":
      return "ADDRESS_PROBLEM";
    case "missed_connection":
    case "offloaded":
      return "MISSED_CONNECTION";
    default:
      return "SHIPMENT_DELAYED";
  }
}

/** A failed delivery attempt as an exception type. */
export function exceptionTypeForDeliveryFailure(reason?: string | null): ShipmentExceptionType {
  switch (reason) {
    case "RECIPIENT_UNAVAILABLE":
    case "BUSINESS_CLOSED":
      return "CONSIGNEE_UNAVAILABLE";
    case "RECIPIENT_REFUSED":
      return "DELIVERY_ATTEMPTED";
    case "INCORRECT_ADDRESS":
    case "ADDRESS_NOT_FOUND":
      return "ADDRESS_PROBLEM";
    case "CUSTOMS_HOLD":
    case "PAYMENT_OR_DUTY_PENDING":
      return "CUSTOMS_HOLD";
    case "DAMAGED_SHIPMENT":
      return "DAMAGED_SHIPMENT";
    case "UNSAFE_LOCATION":
      return "REMOTE_AREA_ISSUE";
    default:
      return "CARRIER_EXCEPTION";
  }
}

/** A POD dispute the client raised, as an exception type. */
export function exceptionTypeForPodDispute(category?: string | null): ShipmentExceptionType {
  switch (category) {
    case "DAMAGED_PARCEL":
      return "DAMAGED_SHIPMENT";
    case "WRONG_RECIPIENT":
    case "INCORRECT_LOCATION":
      return "ADDRESS_PROBLEM";
    default:
      return "CARRIER_EXCEPTION";
  }
}

// ── shapes ────────────────────────────────────────────────────────────────────

export type ShipmentException = {
  /** Stable across refreshes, so a list can key on it without reordering. */
  id: string;
  shipmentDraftId: string;
  awb: string;
  type: ShipmentExceptionType;
  label: string;
  /** What is wrong, in one line. */
  problem: string;
  requiredAction: string;
  assignedTeam: AttentionTeam;
  severity: AttentionSeverity;
  lastUpdateAt: Date;
  href: string;
};

export type ClientAction = {
  id: string;
  type: ClientActionType;
  label: string;
  detail: string;
  /** The words on the button that clears it. */
  actionLabel: string;
  href: string;
  shipmentDraftId: string | null;
  awb: string | null;
  severity: AttentionSeverity;
  raisedAt: Date;
};

export type ClientAttention = {
  exceptions: ShipmentException[];
  actions: ClientAction[];
  exceptionCountsByType: Record<string, number>;
};

export type AttentionScope = {
  businessAccountId: mongoose.Types.ObjectId;
  branchIds?: mongoose.Types.ObjectId[];
};

/** Shipments that have stopped moving, so an in-flight exception cannot apply. */
const settledEventStatuses = ["DELIVERED", "SHIPMENT_CANCELLED", "RETURNED"];

const severityRank: Record<AttentionSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** Most urgent first, then most recently touched. */
function byUrgency(
  left: { severity: AttentionSeverity; lastUpdateAt: Date },
  right: { severity: AttentionSeverity; lastUpdateAt: Date }
) {
  const bySeverity = severityRank[left.severity] - severityRank[right.severity];
  return bySeverity !== 0 ? bySeverity : right.lastUpdateAt.getTime() - left.lastUpdateAt.getTime();
}

/**
 * Everything demanding this account's attention right now.
 *
 * Exceptions are scoped to shipments still in flight, which is what keeps the
 * list bounded without a resolution flag on each signal: once a shipment is
 * delivered, cancelled or returned it stops producing them. POD disputes are the
 * exception to that, because they are raised *after* delivery and stay until
 * they are resolved.
 */
export async function collectClientAttention(scope: AttentionScope): Promise<ClientAttention> {
  const draftFilter: Record<string, unknown> = {
    businessAccountId: scope.businessAccountId,
    deletedAt: null
  };
  if (scope.branchIds?.length) draftFilter.branchId = { $in: scope.branchIds };

  // The account's own drafts first, then their bookings- not every booked
  // shipment in the system narrowed down afterwards. Both steps ride an index
  // (businessAccountId on the draft, shipmentDraftId on the booking), so the
  // work stays proportional to one account rather than to the whole database.
  const accountDrafts = await ShipmentDraft.find(draftFilter).select("_id").lean().exec();
  if (!accountDrafts.length) {
    return { exceptions: [], actions: [], exceptionCountsByType: {} };
  }

  // Only booked shipments can carry an operational exception, and only booked
  // shipments have an AWB to show against one.
  const booked = await DpdShipment.find({
    shipmentDraftId: { $in: accountDrafts.map((draft) => draft._id) },
    status: "LABEL_RECEIVED"
  })
    .select("shipmentDraftId swiftlineTrackingNumber dpdShipmentId")
    .lean()
    .exec();

  const bookedByDraftId = new Map(booked.map((item) => [String(item.shipmentDraftId), item]));
  const draftIds = booked.map((item) => item.shipmentDraftId as mongoose.Types.ObjectId);

  const awbFor = (draftId: string) => {
    const shipment = bookedByDraftId.get(draftId);
    return shipment?.swiftlineTrackingNumber || shipment?.dpdShipmentId || "";
  };

  if (!draftIds.length) {
    return { exceptions: [], actions: [], exceptionCountsByType: {} };
  }

  const [events, assignments, disputes, verifications, statements, tickets, claims] = await Promise.all([
    ShipmentEvent.find({ shipmentDraftId: { $in: draftIds }, customerVisible: true })
      .sort({ eventAt: -1, createdAt: -1 })
      .select("shipmentDraftId status holdReason note location eventAt")
      .lean()
      .exec(),
    DeliveryAssignment.find({ shipmentDraftId: { $in: draftIds } })
      .select("_id shipmentDraftId status updatedAt")
      .lean()
      .exec(),
    PodDispute.find({
      businessAccountId: scope.businessAccountId,
      status: { $in: ["OPEN", "UNDER_REVIEW"] }
    })
      .select("shipmentDraftId category details status createdAt")
      .lean()
      .exec(),
    ShipmentChargeVerification.find({ shipmentDraftId: { $in: draftIds } })
      .select("shipmentDraftId previousAmountMinor verifiedAmountMinor verifiedAt")
      .lean()
      .exec(),
    CreditBillingStatement.find({ businessAccountId: scope.businessAccountId, status: "OVERDUE" })
      .select("_id statementNumber dueAt")
      .lean()
      .exec(),
    SupportTicket.find({
      businessAccountId: scope.businessAccountId,
      status: { $in: ["WAITING_FOR_CUSTOMER", "ACTION_REQUIRED"] }
    })
      .select("_id ticketNumber subject status lastMessageAt")
      .lean()
      .exec(),
    Claim.find({
      businessAccountId: scope.businessAccountId,
      $or: [
        { status: { $in: ["DOCUMENTS_PENDING", "NEEDS_INFORMATION"] } },
        { status: "DECIDED", acceptanceState: "PENDING" }
      ]
    })
      .select("_id claimNumber status acceptanceState updatedAt")
      .lean()
      .exec()
  ]);

  // The newest customer-visible event per shipment decides whether it is still
  // in flight, and carries any hold.
  const latestEventByDraft = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    if (!latestEventByDraft.has(key)) latestEventByDraft.set(key, event);
  }

  const inFlightDraftIds = new Set(
    draftIds
      .map((id) => String(id))
      .filter((id) => {
        const latest = latestEventByDraft.get(id);
        return !latest || !settledEventStatuses.includes(latest.status);
      })
  );

  const exceptions: ShipmentException[] = [];
  const actions: ClientAction[] = [];

  // ── holds ───────────────────────────────────────────────────────────────────
  for (const draftId of inFlightDraftIds) {
    const latest = latestEventByDraft.get(draftId);
    if (latest?.status !== "ON_HOLD") continue;

    const type = exceptionTypeForHoldReason(latest.holdReason);
    exceptions.push({
      id: `hold:${draftId}`,
      shipmentDraftId: draftId,
      awb: awbFor(draftId),
      type,
      label: shipmentExceptionLabels[type],
      problem: latest.note || shipmentExceptionLabels[type],
      requiredAction: exceptionNextSteps[type],
      assignedTeam: exceptionTeams[type],
      severity: exceptionSeverities[type],
      lastUpdateAt: latest.eventAt,
      href: `/client/shipments/${draftId}`
    });

    // A hold the client can clear themselves becomes an action as well, because
    // the control that clears it is what they actually need.
    if (latest.holdReason === "missing_documents") {
      actions.push({
        id: `action-documents:${draftId}`,
        type: "UPLOAD_CLEARANCE_DOCUMENTS",
        label: "Clearance documents required",
        detail: latest.note || "Customs has asked for documents before this shipment can move.",
        actionLabel: "Upload Document",
        href: `/client/shipments/${draftId}`,
        shipmentDraftId: draftId,
        awb: awbFor(draftId),
        severity: "CRITICAL",
        raisedAt: latest.eventAt
      });
    } else if (latest.holdReason === "address_issue") {
      actions.push({
        id: `action-address:${draftId}`,
        type: "CONFIRM_CONSIGNEE_ADDRESS",
        label: "Consignee address confirmation required",
        detail: latest.note || "The delivery address could not be confirmed.",
        actionLabel: "Update Address",
        href: `/client/shipments/${draftId}`,
        shipmentDraftId: draftId,
        awb: awbFor(draftId),
        severity: "CRITICAL",
        raisedAt: latest.eventAt
      });
    }
  }

  // ── delivery failures and returns ───────────────────────────────────────────
  const failedAssignments = assignments.filter((assignment) =>
    ["DELIVERY_FAILED", "RETURN_IN_PROGRESS", "RETURNED"].includes(assignment.status)
  );
  const attempts = failedAssignments.length
    ? await DeliveryAttempt.find({ assignmentId: { $in: failedAssignments.map((item) => item._id) } })
      .sort({ attemptedAt: -1 })
      .select("assignmentId reason notes attemptedAt")
      .lean()
      .exec()
    : [];
  const latestAttemptByAssignment = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    const key = String(attempt.assignmentId);
    if (!latestAttemptByAssignment.has(key)) latestAttemptByAssignment.set(key, attempt);
  }

  for (const assignment of failedAssignments) {
    const draftId = String(assignment.shipmentDraftId);
    const attempt = latestAttemptByAssignment.get(String(assignment._id));
    const returning = assignment.status !== "DELIVERY_FAILED";
    const type = returning
      ? "RETURN_TO_SENDER"
      : exceptionTypeForDeliveryFailure(attempt?.reason);

    exceptions.push({
      id: `delivery:${assignment._id}`,
      shipmentDraftId: draftId,
      awb: awbFor(draftId),
      type,
      label: shipmentExceptionLabels[type],
      problem: attempt?.notes || shipmentExceptionLabels[type],
      requiredAction: exceptionNextSteps[type],
      assignedTeam: exceptionTeams[type],
      severity: exceptionSeverities[type],
      lastUpdateAt: attempt?.attemptedAt ?? assignment.updatedAt ?? new Date(),
      href: `/client/shipments/${draftId}`
    });
  }

  // ── POD disputes ────────────────────────────────────────────────────────────
  for (const dispute of disputes) {
    const draftId = String(dispute.shipmentDraftId);
    const type = exceptionTypeForPodDispute(dispute.category);
    exceptions.push({
      id: `dispute:${dispute._id}`,
      shipmentDraftId: draftId,
      awb: awbFor(draftId),
      type,
      label: shipmentExceptionLabels[type],
      problem: dispute.details,
      requiredAction: exceptionNextSteps[type],
      assignedTeam: exceptionTeams[type],
      severity: exceptionSeverities[type],
      lastUpdateAt: dispute.createdAt,
      href: `/client/shipments/${draftId}`
    });
  }

  // ── re-weighs that changed the charge ───────────────────────────────────────
  for (const verification of verifications) {
    if (verification.verifiedAmountMinor <= verification.previousAmountMinor) continue;
    const draftId = String(verification.shipmentDraftId);
    if (!inFlightDraftIds.has(draftId)) continue;

    exceptions.push({
      id: `weight:${verification._id}`,
      shipmentDraftId: draftId,
      awb: awbFor(draftId),
      type: "WEIGHT_DIFFERENCE",
      label: shipmentExceptionLabels.WEIGHT_DIFFERENCE,
      problem: "The carrier re-weighed this shipment and the charge increased.",
      requiredAction: exceptionNextSteps.WEIGHT_DIFFERENCE,
      assignedTeam: exceptionTeams.WEIGHT_DIFFERENCE,
      severity: exceptionSeverities.WEIGHT_DIFFERENCE,
      lastUpdateAt: verification.verifiedAt,
      href: `/client/shipments/${draftId}`
    });
  }

  // ── account-level actions ───────────────────────────────────────────────────
  for (const statement of statements) {
    actions.push({
      id: `statement:${statement._id}`,
      type: "SETTLE_OVERDUE_INVOICE",
      label: `Statement ${statement.statementNumber} is overdue`,
      detail: "Settle the outstanding balance to keep booking capacity available.",
      actionLabel: "Pay Now",
      href: `/client/credit/statements/${statement._id}`,
      shipmentDraftId: null,
      awb: null,
      severity: "CRITICAL",
      raisedAt: statement.dueAt
    });
  }

  for (const ticket of tickets) {
    actions.push({
      id: `ticket:${ticket._id}`,
      type: "RESPOND_TO_SUPPORT_TICKET",
      label: `${ticket.ticketNumber} is waiting on you`,
      detail: ticket.subject,
      actionLabel: "Open Ticket",
      href: `/client/tickets/${ticket._id}`,
      shipmentDraftId: null,
      awb: null,
      severity: "WARNING",
      raisedAt: ticket.lastMessageAt
    });
  }

  for (const claim of claims) {
    const awaitingAcceptance = claim.status === "DECIDED";
    actions.push({
      id: `claim:${claim._id}`,
      type: awaitingAcceptance ? "ACCEPT_SETTLEMENT_OFFER" : "PROVIDE_CLAIM_DOCUMENTS",
      label: awaitingAcceptance
        ? `Claim ${claim.claimNumber ?? ""} has a decision to review`.trim()
        : `Claim ${claim.claimNumber ?? ""} is waiting on you`.trim(),
      detail: awaitingAcceptance
        ? "Accept the settlement or dispute the decision."
        : "Swiftline has asked for more information before this claim can move.",
      actionLabel: awaitingAcceptance ? "Review Decision" : "Open Claim",
      href: `/client/claims/${claim._id}`,
      shipmentDraftId: null,
      awb: null,
      severity: awaitingAcceptance ? "WARNING" : "CRITICAL",
      raisedAt: claim.updatedAt
    });
  }

  const exceptionCountsByType: Record<string, number> = {};
  for (const exception of exceptions) {
    exceptionCountsByType[exception.type] = (exceptionCountsByType[exception.type] ?? 0) + 1;
  }

  exceptions.sort(byUrgency);
  actions.sort((left, right) =>
    byUrgency(
      { severity: left.severity, lastUpdateAt: left.raisedAt },
      { severity: right.severity, lastUpdateAt: right.raisedAt }
    )
  );

  return { exceptions, actions, exceptionCountsByType };
}
