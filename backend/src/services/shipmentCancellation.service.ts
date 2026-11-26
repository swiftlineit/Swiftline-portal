import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { CashAllocationEvent } from "../models/cashAllocationEvent.model.js";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CancellationDocumentCounter } from "../models/cancellationDocumentCounter.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { CreditBillingAdjustment } from "../models/creditBillingAdjustment.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import {
  ShipmentCancellation,
  type CancellationFinancialTreatment,
  type IShipmentCancellation
} from "../models/shipmentCancellation.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentDirectPayment } from "../models/shipmentDirectPayment.model.js";
import { ShipmentFunding } from "../models/shipmentFunding.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { CounterPayment, type CounterPaymentMethod } from "../models/counterPayment.model.js";
import { OperatorCounterPayment } from "../models/operatorCounterPayment.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent, type ShipmentEventStatus } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { appendCreditLedgerEntry } from "./creditAccount.service.js";
import { getTenantContext } from "./tenantScope.service.js";
import {
  notifyActiveAdmins,
  notifyBusinessFinancialMembers,
  notifyOperatorShipmentCancellationReviewers
} from "./portalNotification.service.js";
import {
  getOperatorCancellationEligibility,
  terminalOperatorShipmentStatuses
} from "./operatorShipmentCancellationPolicy.service.js";
import { suspensionMessage } from "./businessAccountSuspension.service.js";
import { ensureCancellationGatewayRefund } from "./prepaid/cancellationRefunds.service.js";

// The default fee and threshold for requiring an additional-fee reason; lower
// fees are valid and are not subject to a minimum.
export const DEFAULT_CANCELLATION_FEE_BASE_MINOR = 70000;
export const CANCELLATION_GST_RATE_PERCENT = 18;

const afterBookingStatuses: ShipmentEventStatus[] = [
  "PARCEL_COLLECTED", "WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED", "READY_FOR_EXPORT",
  "ORIGIN_HUB_DISPATCHED", "EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED", "FLIGHT_DEPARTED",
  "DESTINATION_ARRIVED", "IMPORT_CUSTOMS_CLEARANCE", "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED", "DELIVERY_HUB_ARRIVED", "IN_TRANSIT", "OUT_FOR_DELIVERY",
  "DELIVERED", "RETURNED", "LOST", "DAMAGED"
];
const terminalStatuses: ShipmentEventStatus[] = ["DELIVERED", "RETURNED", "LOST", "DAMAGED"];

export class ShipmentCancellationError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function calculateCancellationAmounts(
  originalAmountMinor: number,
  requestedFeeBaseMinor = DEFAULT_CANCELLATION_FEE_BASE_MINOR,
  taxTreatment: "GST_APPLICABLE" | "NO_GST" = "GST_APPLICABLE"
) {
  if (!Number.isInteger(originalAmountMinor) || originalAmountMinor < 0) {
    throw new ShipmentCancellationError(400, "The shipment invoice amount is invalid.");
  }
  if (!Number.isInteger(requestedFeeBaseMinor) || requestedFeeBaseMinor < 0) {
    throw new ShipmentCancellationError(400, "The cancellation fee must be a non-negative amount.");
  }

  const requestedGstMinor = taxTreatment === "NO_GST" ? 0 : Math.round(requestedFeeBaseMinor * CANCELLATION_GST_RATE_PERCENT / 100);
  const requestedTotalMinor = requestedFeeBaseMinor + requestedGstMinor;
  if (requestedTotalMinor <= originalAmountMinor) {
    return {
      feeBaseMinor: requestedFeeBaseMinor,
      feeGstMinor: requestedGstMinor,
      feeTotalMinor: requestedTotalMinor,
      refundableAmountMinor: originalAmountMinor - requestedTotalMinor,
      feeWasCapped: false
    };
  }

  // Cancellation must never create a new payable balance for a low-value shipment.
  const feeBaseMinor = taxTreatment === "NO_GST"
    ? originalAmountMinor
    : Math.round(originalAmountMinor * 100 / (100 + CANCELLATION_GST_RATE_PERCENT));
  const feeGstMinor = originalAmountMinor - feeBaseMinor;
  return {
    feeBaseMinor,
    feeGstMinor,
    feeTotalMinor: originalAmountMinor,
    refundableAmountMinor: 0,
    feeWasCapped: true
  };
}

export type ShipmentCancellationPreview = ReturnType<typeof calculateCancellationAmounts> & {
  originalAmountMinor: number;
  taxTreatment: "GST_APPLICABLE" | "NO_GST";
  manualRefundRequired: boolean;
  manualRefundSource: boolean;
  legacyCreditOnly: boolean;
};

export function isLegacyCreditOnlyFunding(input: {
  tenantKind?: string;
  chargePaymentSource?: string | null;
  fundingSource?: string | null;
}) {
  return input.tenantKind === "SWIFTLINE"
    && input.chargePaymentSource === "BUSINESS_ACCOUNT"
    && !input.fundingSource;
}

async function cancellationFinancialTreatment(
  shipmentDraftId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<CancellationFinancialTreatment> {
  const tenantContext = getTenantContext();
  if (tenantContext?.kind !== "SWIFTLINE") return "STANDARD";
  const ownerFilter = { tenantId: tenantContext.tenantId };
  const [charge, funding] = await Promise.all([
    ShipmentCharge.findOne({ shipmentDraftId, ...ownerFilter })
      .select("paymentSource").session(session ?? null).lean().exec(),
    ShipmentFunding.findOne({ shipmentDraftId, ...ownerFilter })
      .select("source").session(session ?? null).lean().exec()
  ]);
  return isLegacyCreditOnlyFunding({
    tenantKind: tenantContext.kind,
    chargePaymentSource: charge?.paymentSource,
    fundingSource: funding?.source
  }) ? "LEGACY_CREDIT_NO_SETTLEMENT" : "STANDARD";
}

export function calculateCancellationSettlement(input: {
  originalAmountMinor: number;
  feeTotalMinor: number;
  refundableAmountMinor: number;
  currentCreditOutstandingMinor: number;
}) {
  const values = Object.values(input);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new ShipmentCancellationError(400, "The cancellation settlement values are invalid.");
  }
  if (input.feeTotalMinor + input.refundableAmountMinor !== input.originalAmountMinor) {
    throw new ShipmentCancellationError(409, "The cancellation fee and refund do not match the shipment total.");
  }
  if (input.currentCreditOutstandingMinor > input.originalAmountMinor) {
    throw new ShipmentCancellationError(409, "The shipment credit allocation exceeds the invoice total.");
  }

  const settledOriginalAmountMinor = input.originalAmountMinor - input.currentCreditOutstandingMinor;
  const cancellationFeeCreditMinor = Math.max(0, input.feeTotalMinor - settledOriginalAmountMinor);
  const netCreditReleasedMinor = input.currentCreditOutstandingMinor - cancellationFeeCreditMinor;
  const customerAdvanceCreditedMinor = input.refundableAmountMinor - netCreditReleasedMinor;

  return {
    originalCreditReversedMinor: input.currentCreditOutstandingMinor,
    cancellationFeeCreditMinor,
    cancellationFeeSettledMinor: input.feeTotalMinor - cancellationFeeCreditMinor,
    netCreditReleasedMinor,
    customerAdvanceCreditedMinor
  };
}

export function getCancellationEligibility(input: {
  requesterType: "CLIENT" | "ADMIN";
  hasBooked: boolean;
  hasParcelCollectedOrLater: boolean;
  hasTerminalStatus: boolean;
  alreadyCancelled: boolean;
}) {
  if (input.alreadyCancelled) return { allowed: false, message: "This shipment has already been cancelled." };
  if (!input.hasBooked) return { allowed: false, message: "Only booked shipments can be cancelled." };
  if (input.requesterType === "CLIENT" && input.hasParcelCollectedOrLater) {
    return { allowed: false, message: "Cancellation is no longer available because the parcel has been collected. Contact your assigned branch." };
  }
  if (input.requesterType === "ADMIN" && input.hasTerminalStatus) {
    return { allowed: false, message: "Delivered, returned, lost, or damaged shipments cannot be cancelled." };
  }
  return { allowed: true, message: "" };
}

async function cancellationGate(
  shipmentDraftId: mongoose.Types.ObjectId,
  requesterType: "CLIENT" | "ADMIN",
  session?: mongoose.ClientSession
) {
  const [events, receivedParcel] = await Promise.all([
    ShipmentEvent.find({ shipmentDraftId }).select("status eventAt createdAt").session(session ?? null).lean().exec(),
    ShipmentOperationsParcelScan.exists({ shipmentDraftId, action: "RECEIVE" }).session(session ?? null).exec()
  ]);
  const statuses = new Set(events.map((event) => event.status));
  if (getTenantContext()?.kind === "OPERATOR") {
    const latestEvent = [...events].sort((left, right) => (
      new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime()
      || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    ))[0];
    return getOperatorCancellationEligibility({
      hasBooked: statuses.has("SHIPMENT_BOOKED"),
      latestStatus: latestEvent?.status,
      hasTerminalStatus: events.some((event) => terminalOperatorShipmentStatuses.includes(event.status)),
      alreadyCancelled: statuses.has("SHIPMENT_CANCELLED")
    });
  }
  return getCancellationEligibility({
    requesterType,
    hasBooked: statuses.has("SHIPMENT_BOOKED"),
    hasParcelCollectedOrLater: Boolean(receivedParcel) || afterBookingStatuses.some((status) => statuses.has(status)),
    hasTerminalStatus: terminalStatuses.some((status) => statuses.has(status)),
    alreadyCancelled: statuses.has("SHIPMENT_CANCELLED")
  });
}

function getFinancialYear(date: Date) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

async function nextDocumentNumber(
  documentType: "CREDIT_NOTE" | "FEE_INVOICE",
  date: Date,
  session: mongoose.ClientSession
) {
  const financialYear = getFinancialYear(date);
  const counter = await CancellationDocumentCounter.findOneAndUpdate(
    { financialYear, documentType },
    { $inc: { sequence: 1 }, $setOnInsert: { financialYear, documentType } },
    { returnDocument: "after", upsert: true, runValidators: true, session }
  ).exec();
  const prefix = documentType === "CREDIT_NOTE" ? "CN" : "CFI";
  return { financialYear, number: `${prefix}/${financialYear}/${String(counter.sequence).padStart(5, "0")}` };
}

function feeTaxSplit(feeGstMinor: number, taxType: "CGST_SGST" | "IGST") {
  if (taxType === "IGST") {
    return { cgstAmountMinor: 0, sgstAmountMinor: 0, igstAmountMinor: feeGstMinor };
  }
  const cgstAmountMinor = Math.floor(feeGstMinor / 2);
  return { cgstAmountMinor, sgstAmountMinor: feeGstMinor - cgstAmountMinor, igstAmountMinor: 0 };
}

export function serializeShipmentCancellation(
  cancellation: IShipmentCancellation,
  financialTreatment: CancellationFinancialTreatment = cancellation.financialTreatment ?? "STANDARD"
) {
  return {
    id: String(cancellation._id),
    shipmentDraftId: String(cancellation.shipmentDraftId),
    dpdShipmentId: String(cancellation.dpdShipmentId),
    businessAccountId: String(cancellation.businessAccountId),
    branchId: String(cancellation.branchId),
    requesterType: cancellation.requesterType,
    requesterRole: cancellation.requesterRole,
    reason: cancellation.reason,
    shipmentStatusAtRequest: cancellation.shipmentStatusAtRequest,
    status: cancellation.status,
    financialTreatment,
    originalAmountMinor: cancellation.originalAmountMinor,
    taxTreatment: cancellation.taxTreatment ?? "GST_APPLICABLE",
    requestedFeeBaseMinor: cancellation.requestedFeeBaseMinor,
    approvedFeeBaseMinor: cancellation.approvedFeeBaseMinor ?? null,
    feeGstMinor: cancellation.feeGstMinor ?? null,
    feeTotalMinor: cancellation.feeTotalMinor ?? null,
    refundableAmountMinor: cancellation.refundableAmountMinor ?? null,
    feeReason: cancellation.feeReason,
    carrierConfirmed: cancellation.carrierConfirmed,
    carrierConfirmationRequired: cancellation.carrierConfirmationRequired !== false,
    settlementConfirmed: cancellation.settlementConfirmed,
    paymentRefundStatus: cancellation.paymentRefundStatus ?? "NOT_REQUIRED",
    paymentRefundAmountMinor: cancellation.paymentRefundAmountMinor ?? 0,
    paymentRefundReference: cancellation.paymentRefundReference ?? "",
    paymentRefundedAt: cancellation.paymentRefundedAt ?? null,
    gatewayRefundStarted: Boolean(cancellation.gatewayRefundPlan),
    carrierReference: cancellation.carrierReference,
    reviewNote: cancellation.reviewNote,
    settlement: cancellation.settlement ?? null,
    creditNoteId: cancellation.creditNoteId ? String(cancellation.creditNoteId) : null,
    cancellationFeeInvoiceId: cancellation.cancellationFeeInvoiceId ? String(cancellation.cancellationFeeInvoiceId) : null,
    requestedAt: cancellation.requestedAt,
    reviewedAt: cancellation.reviewedAt ?? null,
    completedAt: cancellation.completedAt ?? null
  };
}

export async function getShipmentCancellation(shipmentDraftId: mongoose.Types.ObjectId) {
  const cancellation = await ShipmentCancellation.findOne({ shipmentDraftId }).sort({ requestedAt: -1 }).exec();
  if (!cancellation) return null;
  const financialTreatment = await cancellationFinancialTreatment(shipmentDraftId);
  return serializeShipmentCancellation(cancellation, financialTreatment);
}

export async function requestShipmentCancellation(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  requestedBy: mongoose.Types.ObjectId;
  requesterType: "CLIENT" | "ADMIN";
  requesterRole: string;
  reason: string;
  requestedFeeBaseMinor?: number;
  feeReason?: string;
  portalSlug?: string;
  notifyReviewers?: boolean;
}) {
  const tenantContext = getTenantContext();
  const ownerFilter = tenantContext ? { tenantId: tenantContext.tenantId } : {};
  const draft = await ShipmentDraft.findOne({ _id: input.shipmentDraftId, ...ownerFilter }).exec();
  if (!draft) throw new ShipmentCancellationError(404, "Shipment not found.");
  const account = await BusinessAccount.findById(draft.businessAccountId).select("status accountKind").lean().exec();
  if (!account) throw new ShipmentCancellationError(404, "Business account not found.");
  if (account.status === "suspended" && account.accountKind !== "INDIVIDUAL_SENTINEL") {
    throw new ShipmentCancellationError(423, suspensionMessage);
  }
  const dpdShipment = await DpdShipment.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).exec();
  if (!dpdShipment) throw new ShipmentCancellationError(409, "Only booked shipments can be cancelled.");
  const invoice = await ShipmentInvoice.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).exec();
  if (!invoice) throw new ShipmentCancellationError(409, "Shipment billing information is incomplete.");

  const gate = await cancellationGate(draft._id as mongoose.Types.ObjectId, input.requesterType);
  if (!gate.allowed) throw new ShipmentCancellationError(409, gate.message);
  if (await ShipmentAmendment.exists({
    shipmentDraftId: draft._id,
    status: { $in: ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"] }
  })) {
    throw new ShipmentCancellationError(409, "Approve or reject the pending amendment before requesting cancellation.");
  }
  const existing = await ShipmentCancellation.findOne({ shipmentDraftId: draft._id, status: "REQUESTED" }).exec();
  if (existing) return existing;
  const financialTreatment = await cancellationFinancialTreatment(draft._id as mongoose.Types.ObjectId);

  const latestEvent = await ShipmentEvent.findOne({ shipmentDraftId: draft._id })
    .sort({ eventAt: -1, createdAt: -1 })
    .lean()
    .exec();
  const cancellation = await ShipmentCancellation.create({
    shipmentDraftId: draft._id,
    dpdShipmentId: dpdShipment._id,
    shipmentInvoiceId: invoice._id,
    businessAccountId: draft.businessAccountId,
    branchId: draft.branchId,
    requestedBy: input.requestedBy,
    requesterType: input.requesterType,
    requesterRole: input.requesterRole,
    reason: input.reason,
    shipmentStatusAtRequest: latestEvent?.status ?? "SHIPMENT_BOOKED",
    status: "REQUESTED",
    financialTreatment,
    originalAmountMinor: invoice.totalAmountMinor,
    taxTreatment: invoice.taxTreatment ?? (invoice.gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE"),
    requestedFeeBaseMinor: financialTreatment === "LEGACY_CREDIT_NO_SETTLEMENT"
      ? 0
      : input.requestedFeeBaseMinor ?? (tenantContext?.kind === "OPERATOR" ? 0 : DEFAULT_CANCELLATION_FEE_BASE_MINOR),
    feeReason: input.feeReason?.trim() ?? "",
    carrierConfirmationRequired: tenantContext?.kind !== "OPERATOR",
    requestedAt: new Date()
  });

  await AuditLog.create({
    action: "SHIPMENT_CANCELLATION_REQUESTED",
    entityType: "SHIPMENT_CANCELLATION",
    entityId: cancellation._id,
    performedBy: input.requestedBy,
    performedAt: cancellation.requestedAt,
    metadata: { shipmentDraftId: draft._id, dpdShipmentId: dpdShipment._id, requesterType: input.requesterType }
  });
  if (input.notifyReviewers !== false) {
    const notification = {
      type: "SHIPMENT_CANCELLATION_REQUESTED" as const,
      title: "Shipment cancellation requested",
      message: `A cancellation request for shipment ${dpdShipment.dpdShipmentId || String(dpdShipment._id)} requires review.`,
      idempotencyKey: `SHIPMENT_CANCELLATION_REQUESTED:${String(cancellation._id)}`,
      businessAccountId: draft.businessAccountId,
      metadata: { cancellationId: String(cancellation._id), shipmentDraftId: String(draft._id) }
    };
    if (tenantContext?.kind === "OPERATOR") {
      await notifyOperatorShipmentCancellationReviewers(notification);
    } else {
      await notifyActiveAdmins({
        ...notification,
        href: `/dashboard/cancellations#cancellation-${String(cancellation._id)}`
      });
    }
  }
  return cancellation;
}

/**
 * Read-only preflight for the admin shipment-list cancellation dialog. All
 * eligibility and amount checks are repeated by the write path; this preview
 * exists so the admin can review the fee and refund before confirming them.
 */
export async function getShipmentCancellationPreview(
  shipmentDraftId: mongoose.Types.ObjectId,
  requestedFeeBaseMinor = DEFAULT_CANCELLATION_FEE_BASE_MINOR
): Promise<ShipmentCancellationPreview> {
  if (!Number.isSafeInteger(requestedFeeBaseMinor) || requestedFeeBaseMinor < 0) {
    throw new ShipmentCancellationError(400, "The cancellation fee must be a non-negative amount.");
  }
  const tenantContext = getTenantContext();
  const ownerFilter = tenantContext ? { tenantId: tenantContext.tenantId } : {};
  const draft = await ShipmentDraft.findOne({ _id: shipmentDraftId, ...ownerFilter }).exec();
  if (!draft) throw new ShipmentCancellationError(404, "Shipment not found.");

  const account = await BusinessAccount.findById(draft.businessAccountId).select("status accountKind").lean().exec();
  if (!account) throw new ShipmentCancellationError(404, "Business account not found.");
  if (account.status === "suspended" && account.accountKind !== "INDIVIDUAL_SENTINEL") {
    throw new ShipmentCancellationError(423, suspensionMessage);
  }

  const [dpdShipment, invoice] = await Promise.all([
    DpdShipment.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).exec(),
    ShipmentInvoice.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).exec()
  ]);
  if (!dpdShipment) throw new ShipmentCancellationError(409, "Only booked shipments can be cancelled.");
  if (!invoice || invoice.paymentStatus === "VOID") {
    throw new ShipmentCancellationError(409, "Active shipment billing information is unavailable.");
  }

  const gate = await cancellationGate(draft._id as mongoose.Types.ObjectId, "ADMIN");
  if (!gate.allowed) throw new ShipmentCancellationError(409, gate.message);
  if (await ShipmentAmendment.exists({
    shipmentDraftId: draft._id,
    status: { $in: ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"] }
  })) {
    throw new ShipmentCancellationError(409, "Resolve the pending amendment before cancelling this shipment.");
  }
  if (await ShipmentCancellation.exists({ shipmentDraftId: draft._id, status: "REQUESTED" })) {
    throw new ShipmentCancellationError(409, "A cancellation is already pending review for this shipment.");
  }

  const taxTreatment = invoice.taxTreatment ?? (invoice.gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE");
  const [funding, anyFunding, counterCharge, charge] = await Promise.all([
    ShipmentFunding.findOne({ shipmentDraftId: draft._id, status: "COMPLETED", ...ownerFilter }).select("source").lean().exec(),
    ShipmentFunding.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).select("source").lean().exec(),
    ShipmentCharge.exists({ shipmentDraftId: draft._id, paymentSource: "ADMIN_DIRECT", ...ownerFilter }),
    ShipmentCharge.findOne({ shipmentDraftId: draft._id, ...ownerFilter }).select("paymentSource").lean().exec()
  ]);
  const legacyCreditOnly = isLegacyCreditOnlyFunding({
    tenantKind: tenantContext?.kind,
    chargePaymentSource: charge?.paymentSource,
    fundingSource: anyFunding?.source
  });
  if (legacyCreditOnly) {
    return {
      feeBaseMinor: 0,
      feeGstMinor: 0,
      feeTotalMinor: 0,
      refundableAmountMinor: 0,
      feeWasCapped: false,
      originalAmountMinor: invoice.totalAmountMinor,
      taxTreatment,
      manualRefundSource: false,
      manualRefundRequired: false,
      legacyCreditOnly: true
    };
  }
  const amounts = calculateCancellationAmounts(invoice.totalAmountMinor, requestedFeeBaseMinor, taxTreatment);

  const manualRefundSource = funding?.source === "CASH_RECEIPT"
    || funding?.source === "BUSINESS_WALLET"
    || Boolean(counterCharge);
  return {
    ...amounts,
    originalAmountMinor: invoice.totalAmountMinor,
    taxTreatment,
    manualRefundSource,
    manualRefundRequired: amounts.refundableAmountMinor > 0 && manualRefundSource,
    legacyCreditOnly: false
  };
}

export async function rejectShipmentCancellation(input: {
  cancellationId: mongoose.Types.ObjectId;
  reviewedBy: mongoose.Types.ObjectId;
  reviewNote: string;
  portalSlug?: string;
}) {
  const cancellation = await ShipmentCancellation.findOneAndUpdate(
    { _id: input.cancellationId, status: "REQUESTED", gatewayRefundPlan: null },
    {
      $set: {
        status: "REJECTED",
        reviewedBy: input.reviewedBy,
        reviewNote: input.reviewNote,
        reviewedAt: new Date()
      }
    },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!cancellation) throw new ShipmentCancellationError(409, "Only pending cancellation requests without a started gateway refund can be rejected.");

  await AuditLog.create({
    action: "SHIPMENT_CANCELLATION_REJECTED",
    entityType: "SHIPMENT_CANCELLATION",
    entityId: cancellation._id,
    performedBy: input.reviewedBy,
    performedAt: cancellation.reviewedAt ?? new Date(),
    metadata: { shipmentDraftId: cancellation.shipmentDraftId, reviewNote: input.reviewNote }
  });
  const tenantContext = getTenantContext();
  const shipmentHref = tenantContext?.kind === "OPERATOR" && input.portalSlug
    ? `/portal/${encodeURIComponent(input.portalSlug)}/shipments/${String(cancellation.shipmentDraftId)}`
    : `/client/shipments/${String(cancellation.shipmentDraftId)}#shipment-cancellation`;
  await notifyBusinessFinancialMembers(cancellation.businessAccountId, {
    type: "SHIPMENT_CANCELLATION_REJECTED",
    title: "Cancellation request rejected",
    message: tenantContext?.kind === "OPERATOR"
      ? "The operator reviewed the shipment cancellation request and did not approve it."
      : "Swiftline reviewed the shipment cancellation request and did not approve it.",
    href: shipmentHref,
    idempotencyKey: `SHIPMENT_CANCELLATION_REJECTED:${String(cancellation._id)}`
  });
  return cancellation;
}

export async function assertNoPendingShipmentCancellation(
  shipmentDraftId: mongoose.Types.ObjectId,
  action: string,
  session?: mongoose.ClientSession
) {
  const pending = await ShipmentCancellation.exists({ shipmentDraftId, status: "REQUESTED" })
    .session(session ?? null);
  if (pending) {
    throw new ShipmentCancellationError(
      409,
      `This shipment has a pending cancellation request. Resolve it before ${action}.`
    );
  }
}

async function completeLegacyCreditCancellation(input: {
  cancellationId: mongoose.Types.ObjectId;
  reviewedBy: mongoose.Types.ObjectId;
  carrierConfirmed: boolean;
  carrierReference: string;
  reviewNote: string;
}) {
  const tenantContext = getTenantContext();
  const ownerFilter = tenantContext ? { tenantId: tenantContext.tenantId } : {};
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const cancellation = await ShipmentCancellation.findById(input.cancellationId).session(session).exec();
      if (!cancellation) throw new ShipmentCancellationError(404, "Cancellation request not found.");
      if (cancellation.status === "COMPLETED") return cancellation;
      if (cancellation.status !== "REQUESTED") {
        throw new ShipmentCancellationError(409, "Only pending cancellation requests can be approved.");
      }
      if (
        cancellation.gatewayRefundPlan
        || cancellation.paymentRefundStatus !== "NOT_REQUIRED"
        || cancellation.paymentRefundAmountMinor > 0
        || cancellation.creditNoteId
        || cancellation.cancellationFeeInvoiceId
      ) {
        throw new ShipmentCancellationError(
          409,
          "A refund or financial document is already recorded for this cancellation. Reconcile it before completing the legacy cancellation."
        );
      }
      if (
        cancellation.carrierConfirmationRequired !== false
        && !input.carrierConfirmed
      ) {
        throw new ShipmentCancellationError(400, "Confirm carrier cancellation before completing the cancellation.");
      }
      if (cancellation.carrierConfirmationRequired === false && tenantContext?.kind !== "OPERATOR") {
        throw new ShipmentCancellationError(404, "Cancellation request not found.");
      }
      if (await cancellationFinancialTreatment(cancellation.shipmentDraftId, session) !== "LEGACY_CREDIT_NO_SETTLEMENT") {
        throw new ShipmentCancellationError(409, "The shipment funding changed. Review the cancellation settlement again.");
      }

      const gate = await cancellationGate(cancellation.shipmentDraftId, "ADMIN", session);
      if (!gate.allowed) throw new ShipmentCancellationError(409, gate.message);
      const pendingAmendment = await ShipmentAmendment.exists({
        shipmentDraftId: cancellation.shipmentDraftId,
        status: { $in: ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"] }
      }).session(session);
      if (pendingAmendment) {
        throw new ShipmentCancellationError(409, "Approve or reject the pending amendment before completing cancellation.");
      }
      const invoice = await ShipmentInvoice.findOne({
        _id: cancellation.shipmentInvoiceId,
        shipmentDraftId: cancellation.shipmentDraftId,
        paymentStatus: { $ne: "VOID" },
        ...ownerFilter
      }).session(session).exec();
      if (!invoice) throw new ShipmentCancellationError(409, "The active shipment invoice could not be found.");
      if (invoice.totalAmountMinor !== cancellation.originalAmountMinor) {
        throw new ShipmentCancellationError(409, "The shipment invoice changed after cancellation was requested. Reject this request and create a new one.");
      }

      const completedAt = new Date();
      const financialNote = "Legacy credit shipment cancelled without refund, wallet credit, fee, or financial documents; historical invoice and statement unchanged.";
      await ShipmentEvent.create([{
        shipmentDraftId: cancellation.shipmentDraftId,
        dpdShipmentId: cancellation.dpdShipmentId,
        status: "SHIPMENT_CANCELLED",
        note: financialNote,
        customerVisible: true,
        createdBy: input.reviewedBy,
        eventAt: completedAt
      }], { session });

      cancellation.status = "COMPLETED";
      cancellation.financialTreatment = "LEGACY_CREDIT_NO_SETTLEMENT";
      cancellation.requestedFeeBaseMinor = 0;
      cancellation.approvedFeeBaseMinor = 0;
      cancellation.feeGstMinor = 0;
      cancellation.feeTotalMinor = 0;
      cancellation.refundableAmountMinor = 0;
      cancellation.feeReason = "";
      cancellation.carrierConfirmed = input.carrierConfirmed;
      cancellation.settlementConfirmed = true;
      cancellation.paymentRefundStatus = "NOT_REQUIRED";
      cancellation.paymentRefundAmountMinor = 0;
      cancellation.paymentRefundReference = "";
      cancellation.paymentRefundedAt = null;
      cancellation.carrierReference = input.carrierReference;
      cancellation.reviewNote = [financialNote, input.reviewNote.trim()].filter(Boolean).join(" ").slice(0, 500);
      cancellation.reviewedBy = input.reviewedBy;
      cancellation.reviewedAt = completedAt;
      cancellation.completedAt = completedAt;
      cancellation.settlement = {
        originalCreditReversedMinor: 0,
        cancellationFeeCreditMinor: 0,
        netCreditReleasedMinor: 0,
        statementCreditAppliedMinor: 0,
        customerAdvanceCreditedMinor: 0
      };
      cancellation.creditNoteId = null;
      cancellation.cancellationFeeInvoiceId = null;
      await cancellation.save({ session });

      await AuditLog.create([{
        action: "SHIPMENT_CANCELLATION_COMPLETED",
        entityType: "SHIPMENT_CANCELLATION",
        entityId: cancellation._id,
        performedBy: input.reviewedBy,
        performedAt: completedAt,
        metadata: {
          shipmentDraftId: cancellation.shipmentDraftId,
          financialTreatment: "LEGACY_CREDIT_NO_SETTLEMENT",
          refundAmountMinor: 0,
          feeTotalMinor: 0,
          historicalInvoiceAndStatementChanged: false
        }
      }], { session });
      await notifyBusinessFinancialMembers(cancellation.businessAccountId, {
        type: "SHIPMENT_CANCELLATION_COMPLETED",
        title: "Shipment cancellation completed",
        message: "This legacy credit-ledger shipment was cancelled without a refund, wallet credit, cancellation fee, or changes to its historical invoice and statement.",
        href: `/client/shipments/${String(cancellation.shipmentDraftId)}#shipment-cancellation`,
        idempotencyKey: `SHIPMENT_CANCELLATION_COMPLETED:${String(cancellation._id)}`
      }, session);
      return cancellation;
    });
  } finally {
    await session.endSession();
  }
}

export async function approveShipmentCancellation(input: {
  cancellationId: mongoose.Types.ObjectId;
  reviewedBy: mongoose.Types.ObjectId;
  feeBaseMinor: number;
  feeReason: string;
  carrierConfirmed: boolean;
  settlementConfirmed: boolean;
  carrierReference: string;
  reviewNote: string;
  portalSlug?: string;
  /**
   * How an offline refund was paid back. Required for counter sales, cash
   * receipts, and legacy wallet-funded shipments with something to refund.
   * Account-backed cancellations settle through the credit ledger instead.
   */
  refundPayout?: {
    method: CounterPaymentMethod;
    reference?: string;
    note?: string;
  };
}) {
  if (!input.settlementConfirmed) {
    throw new ShipmentCancellationError(400, "Confirm the cancellation settlement before completing the refund.");
  }
  const tenantContext = getTenantContext();
  const preflightCancellation = await ShipmentCancellation.findById(input.cancellationId).exec();
  if (!preflightCancellation) throw new ShipmentCancellationError(404, "Cancellation request not found.");
  if (preflightCancellation.status === "COMPLETED") return preflightCancellation;
  if (preflightCancellation.status !== "REQUESTED") {
    throw new ShipmentCancellationError(409, "Only pending cancellation requests can be approved.");
  }
  if (preflightCancellation.carrierConfirmationRequired !== false && !input.carrierConfirmed) {
    throw new ShipmentCancellationError(400, "Confirm carrier cancellation before completing the refund.");
  }
  if (preflightCancellation.carrierConfirmationRequired === false && tenantContext?.kind !== "OPERATOR") {
    throw new ShipmentCancellationError(404, "Cancellation request not found.");
  }
  if (
    preflightCancellation.financialTreatment === "LEGACY_CREDIT_NO_SETTLEMENT"
    || await cancellationFinancialTreatment(preflightCancellation.shipmentDraftId) === "LEGACY_CREDIT_NO_SETTLEMENT"
  ) {
    return completeLegacyCreditCancellation({
      cancellationId: preflightCancellation._id as mongoose.Types.ObjectId,
      reviewedBy: input.reviewedBy,
      carrierConfirmed: input.carrierConfirmed,
      carrierReference: input.carrierReference,
      reviewNote: input.reviewNote
    });
  }
  if (tenantContext?.kind === "OPERATOR") {
    if (input.feeBaseMinor > 0 && input.feeReason.trim().length < 5) {
      throw new ShipmentCancellationError(400, "Explain the operator cancellation fee.");
    }
  } else if (input.feeBaseMinor > DEFAULT_CANCELLATION_FEE_BASE_MINOR && input.feeReason.trim().length < 5) {
    throw new ShipmentCancellationError(400, "Explain the additional carrier or handling fee.");
  }
  const preflightGate = await cancellationGate(preflightCancellation.shipmentDraftId, "ADMIN");
  if (!preflightGate.allowed) throw new ShipmentCancellationError(409, preflightGate.message);
  if (await ShipmentAmendment.exists({
    shipmentDraftId: preflightCancellation.shipmentDraftId,
    status: { $in: ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"] }
  })) {
    throw new ShipmentCancellationError(409, "Approve or reject the pending amendment before completing cancellation.");
  }
  const preflightInvoice = await ShipmentInvoice.findOne({
    _id: preflightCancellation.shipmentInvoiceId,
    shipmentDraftId: preflightCancellation.shipmentDraftId,
    paymentStatus: { $ne: "VOID" }
  }).exec();
  if (!preflightInvoice) throw new ShipmentCancellationError(409, "The active shipment invoice could not be found.");
  if (preflightInvoice.totalAmountMinor !== preflightCancellation.originalAmountMinor) {
    throw new ShipmentCancellationError(409, "The shipment invoice changed after cancellation was requested. Reject this request and create a new one.");
  }
  const preflightTaxTreatment = preflightInvoice.taxTreatment ?? (preflightInvoice.gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE");
  const preflightAmounts = calculateCancellationAmounts(preflightInvoice.totalAmountMinor, input.feeBaseMinor, preflightTaxTreatment);
  if (
    preflightCancellation.gatewayRefundPlan
    && preflightCancellation.gatewayRefundPlan.amountMinor !== preflightAmounts.refundableAmountMinor
  ) {
    throw new ShipmentCancellationError(
      409,
      "A Razorpay refund was already started for this cancellation. Retry with the original reviewed fee."
    );
  }
  try {
    const refundResult = await ensureCancellationGatewayRefund({
      shipmentDraftId: preflightCancellation.shipmentDraftId,
      cancellationId: preflightCancellation._id as mongoose.Types.ObjectId,
      amountMinor: preflightAmounts.refundableAmountMinor
    });
    if (refundResult === "PENDING") {
      throw new ShipmentCancellationError(202, "The Razorpay refund is still processing. Retry approval after the payment status updates.");
    }
  } catch (error) {
    if (error instanceof ShipmentCancellationError) throw error;
    throw new ShipmentCancellationError(502, error instanceof Error ? error.message : "The Razorpay refund could not be confirmed.");
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const cancellation = await ShipmentCancellation.findById(input.cancellationId).session(session).exec();
      if (!cancellation) throw new ShipmentCancellationError(404, "Cancellation request not found.");
      if (cancellation.status === "COMPLETED") return cancellation;
      if (cancellation.status !== "REQUESTED") {
        throw new ShipmentCancellationError(409, "Only pending cancellation requests can be approved.");
      }
      if (cancellation.carrierConfirmationRequired !== false && !input.carrierConfirmed) {
        throw new ShipmentCancellationError(400, "Confirm carrier cancellation before completing the refund.");
      }
      if (cancellation.carrierConfirmationRequired === false && tenantContext?.kind !== "OPERATOR") {
        throw new ShipmentCancellationError(404, "Cancellation request not found.");
      }

      const gate = await cancellationGate(cancellation.shipmentDraftId, "ADMIN", session);
      if (!gate.allowed) throw new ShipmentCancellationError(409, gate.message);
      const pendingAmendment = await ShipmentAmendment.exists({
        shipmentDraftId: cancellation.shipmentDraftId,
        status: { $in: ["REQUESTED", "AWAITING_PAYMENT", "PAYMENT_SECURED"] }
      }).session(session);
      if (pendingAmendment) {
        throw new ShipmentCancellationError(409, "Approve or reject the pending amendment before completing cancellation.");
      }

      const invoice = await ShipmentInvoice.findOne({
        _id: cancellation.shipmentInvoiceId,
        shipmentDraftId: cancellation.shipmentDraftId,
        paymentStatus: { $ne: "VOID" }
      }).session(session).exec();
      if (!invoice) throw new ShipmentCancellationError(409, "The active shipment invoice could not be found.");
      if (invoice.totalAmountMinor !== cancellation.originalAmountMinor) {
        throw new ShipmentCancellationError(
          409,
          "The shipment invoice changed after cancellation was requested. Reject this request and create a new one."
        );
      }

      const taxTreatment = invoice.taxTreatment ?? (invoice.gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE");
      const amounts = calculateCancellationAmounts(invoice.totalAmountMinor, input.feeBaseMinor, taxTreatment);
      const prepaidFunding = await ShipmentFunding.findOne({
        shipmentDraftId: cancellation.shipmentDraftId,
        status: "COMPLETED"
      }).session(session).exec();
      const legacyWalletFunding = prepaidFunding?.source === "BUSINESS_WALLET";
      const businessCharge = await ShipmentCharge.exists({
        shipmentDraftId: cancellation.shipmentDraftId,
        paymentSource: "BUSINESS_ACCOUNT"
      }).session(session);

      // A walk-in paid into a company account before the shipment was booked, so
      // the refund has to leave the same way. The credit note below is only the
      // document; requiring the payout to be recorded in the same transaction is
      // what stops the paperwork and the money that actually moved from drifting
      // apart, and is what makes the counter-sales report reconcile.
      const counterCharge = await ShipmentCharge.findOne({
        shipmentDraftId: cancellation.shipmentDraftId,
        paymentSource: "ADMIN_DIRECT"
      }).session(session).exec();
      let cashReceipt: InstanceType<typeof CashReceipt> | null = null;
      if (prepaidFunding?.source === "CASH_RECEIPT" && prepaidFunding.sourceReferenceId) {
        cashReceipt = await CashReceipt.findOne({
          _id: prepaidFunding.sourceReferenceId,
          shipmentDraftId: cancellation.shipmentDraftId,
          businessAccountId: cancellation.businessAccountId,
          status: "FINALIZED"
        }).session(session).exec();
        if (!cashReceipt) throw new ShipmentCancellationError(409, "The original cash receipt could not be found for refund reconciliation.");
      }

      if ((counterCharge || cashReceipt || legacyWalletFunding) && amounts.refundableAmountMinor > 0) {
        if (!input.refundPayout) {
          throw new ShipmentCancellationError(
            400,
            "Record how the refund was paid back to the customer before completing this cancellation."
          );
        }
        if (input.refundPayout.method !== "CASH" && !input.refundPayout.reference?.trim()) {
          throw new ShipmentCancellationError(400, "Enter the bank, UPI, card, or cheque reference for this refund.");
        }

        if (counterCharge) {
          const refundPayment = {
            shipmentDraftId: cancellation.shipmentDraftId,
            branchId: counterCharge.branchId,
            direction: "REFUNDED",
            amountMinor: amounts.refundableAmountMinor,
            method: input.refundPayout.method,
            reference: input.refundPayout.reference ?? "",
            note: input.refundPayout.note ?? "",
            recordedBy: input.reviewedBy,
            recordedAt: new Date()
          } as const;
          if (tenantContext?.kind === "OPERATOR") {
            await OperatorCounterPayment.create([{
              ...refundPayment,
              tenantId: tenantContext.tenantId,
              sourceType: "CANCELLATION",
              sourceId: cancellation._id
            }], { session });
          } else {
            await CounterPayment.create([refundPayment], { session });
          }
        } else if (cashReceipt) {
          await CashAllocationEvent.create([{
            cashReceiptId: cashReceipt!._id as mongoose.Types.ObjectId,
            businessAccountId: cancellation.businessAccountId,
            branchId: cancellation.branchId,
            eventType: "REFUNDED",
            amountMinor: amounts.refundableAmountMinor,
            shipmentDraftId: cancellation.shipmentDraftId,
            idempotencyKey: `CASH_CANCEL_REFUND:${String(cancellation._id)}`,
            reason: `Cancellation cash refund paid by ${input.refundPayout.method}. ${input.refundPayout.reference ? `Reference: ${input.refundPayout.reference}. ` : ""}${input.refundPayout.note ?? ""}`.trim().slice(0, 500),
            createdBy: input.reviewedBy
          }], { session });
        }
      }

      let paymentRefundStatus: IShipmentCancellation["paymentRefundStatus"] = "NOT_REQUIRED";
      let paymentRefundReference = "";
      if (amounts.refundableAmountMinor > 0 && prepaidFunding?.source === "DIRECT_RAZORPAY") {
        const plan = cancellation.gatewayRefundPlan as {
          amountMinor?: number;
          allocations?: Array<{ source?: string; paymentId?: string; amountMinor?: number }>;
        } | null;
        if (plan?.amountMinor !== amounts.refundableAmountMinor || !plan.allocations?.length) {
          throw new ShipmentCancellationError(409, "The reviewed Razorpay refund plan is missing or does not match this cancellation.");
        }
        const refunds: string[] = [];
        let plannedAmount = 0;
        for (const allocation of plan.allocations) {
          const allocationAmount = allocation.amountMinor;
          if (
            allocation.source !== "DIRECT_RAZORPAY"
            || !allocation.paymentId
            || typeof allocationAmount !== "number"
            || !Number.isInteger(allocationAmount)
            || allocationAmount <= 0
          ) {
            throw new ShipmentCancellationError(409, "The reviewed Razorpay refund plan contains an invalid payment allocation.");
          }
          const payment = await ShipmentDirectPayment.findOne({
            _id: allocation.paymentId,
            shipmentDraftId: cancellation.shipmentDraftId,
            status: "REFUNDED",
            razorpayRefundAmountMinor: allocationAmount
          }).session(session).exec();
          if (!payment?.razorpayRefundId) throw new ShipmentCancellationError(409, "A Razorpay shipment refund has not completed yet.");
          plannedAmount += allocationAmount;
          refunds.push(payment.razorpayRefundId);
        }
        if (plannedAmount !== amounts.refundableAmountMinor) {
          throw new ShipmentCancellationError(409, "The reviewed Razorpay refund allocations do not balance with this cancellation.");
        }
        paymentRefundStatus = "RAZORPAY_REFUNDED";
        paymentRefundReference = refunds.join(", ").slice(0, 120);
      } else if (amounts.refundableAmountMinor > 0 && prepaidFunding?.source === "PUBLIC_RAZORPAY") {
        const plan = cancellation.gatewayRefundPlan as {
          amountMinor?: number;
          allocations?: Array<{ source?: string; paymentId?: string; amountMinor?: number }>;
        } | null;
        if (plan?.amountMinor !== amounts.refundableAmountMinor || !plan.allocations?.length) {
          throw new ShipmentCancellationError(409, "The reviewed Razorpay refund plan is missing or does not match this cancellation.");
        }
        const allocation = plan.allocations[0];
        if (
          plan.allocations.length !== 1
          || allocation?.source !== "PUBLIC_RAZORPAY"
          || !allocation.paymentId
          || allocation.amountMinor !== amounts.refundableAmountMinor
        ) throw new ShipmentCancellationError(409, "The public Razorpay refund plan contains an invalid payment allocation.");
        const payment = await PublicShipmentPayment.findOne({
          _id: allocation.paymentId,
          shipmentDraftId: cancellation.shipmentDraftId,
          status: "REFUNDED",
          razorpayRefundAmountMinor: allocation.amountMinor
        }).session(session).exec();
        if (!payment?.razorpayRefundId) throw new ShipmentCancellationError(409, "The public Razorpay refund has not completed yet.");
        paymentRefundStatus = "RAZORPAY_REFUNDED";
        paymentRefundReference = payment.razorpayRefundId;
      } else if (amounts.refundableAmountMinor > 0 && legacyWalletFunding) {
        paymentRefundStatus = "MANUAL_REFUNDED";
        paymentRefundReference = input.refundPayout?.reference?.trim()
          || `${input.refundPayout?.method ?? "MANUAL"}_LEGACY_WALLET_REFUND`;
      } else if (amounts.refundableAmountMinor > 0 && cashReceipt) {
        paymentRefundStatus = "CASH_REFUNDED";
        paymentRefundReference = input.refundPayout?.reference?.trim() || cashReceipt.receiptNumber;
      } else if (amounts.refundableAmountMinor > 0 && counterCharge) {
        paymentRefundStatus = "CASH_REFUNDED";
        paymentRefundReference = input.refundPayout?.reference?.trim() || "STAFF_RECORDED_REFUND";
      }

      const settlement = businessCharge
        ? calculateCancellationSettlement({
            originalAmountMinor: invoice.totalAmountMinor,
            feeTotalMinor: amounts.feeTotalMinor,
            refundableAmountMinor: amounts.refundableAmountMinor,
            currentCreditOutstandingMinor: invoice.creditOutstandingMinor
          })
        : {
            originalCreditReversedMinor: 0,
            cancellationFeeCreditMinor: 0,
            cancellationFeeSettledMinor: amounts.feeTotalMinor,
            netCreditReleasedMinor: 0,
            customerAdvanceCreditedMinor: 0
          };
      let statementCreditAppliedMinor = 0;
      if (businessCharge) {
        const account = await BusinessCreditAccount.findOne({ businessAccountId: cancellation.businessAccountId })
          .session(session)
          .exec();
        if (!account) throw new ShipmentCancellationError(409, "Business credit account was not found.");

        const isBilled = Boolean(invoice.billingStatementId);
        statementCreditAppliedMinor = isBilled ? settlement.originalCreditReversedMinor : 0;
        const unbilledCreditChangeMinor = isBilled
          ? settlement.cancellationFeeCreditMinor
          : settlement.cancellationFeeCreditMinor - settlement.originalCreditReversedMinor;
        const updatedAccount = await BusinessCreditAccount.findOneAndUpdate(
          {
            _id: account._id,
            version: account.version,
            ...(isBilled
              ? { invoicedOutstandingMinor: { $gte: statementCreditAppliedMinor } }
              : { unbilledCreditMinor: { $gte: settlement.originalCreditReversedMinor } })
          },
          {
            $inc: {
              invoicedOutstandingMinor: -statementCreditAppliedMinor,
              unbilledCreditMinor: unbilledCreditChangeMinor,
              customerAdvanceBalanceMinor: settlement.customerAdvanceCreditedMinor,
              version: 1
            }
          },
          { returnDocument: "after", runValidators: true, session }
        ).exec();
        if (!updatedAccount) {
          throw new ShipmentCancellationError(409, "Credit balances changed during cancellation. Try again.");
        }

        if (invoice.billingStatementId && statementCreditAppliedMinor > 0) {
          const statement = await CreditBillingStatement.findOne({
            _id: invoice.billingStatementId,
            outstandingAmountMinor: { $gte: statementCreditAppliedMinor }
          }).session(session).exec();
          if (!statement) {
            throw new ShipmentCancellationError(409, "The original billing statement cannot accept this cancellation credit.");
          }
          statement.creditAdjustmentMinor += statementCreditAppliedMinor;
          statement.outstandingAmountMinor -= statementCreditAppliedMinor;
          statement.status = statement.outstandingAmountMinor === 0 ? "PAID" : "PARTIALLY_PAID";
          await statement.save({ session });
          await CreditBillingAdjustment.create([{
            businessAccountId: cancellation.businessAccountId,
            creditAccountId: updatedAccount._id,
            shipmentInvoiceId: invoice._id,
            originalStatementId: statement._id,
            sourceType: "CANCELLATION",
            sourceId: cancellation._id,
            amountMinor: -statementCreditAppliedMinor,
            affectsAmountDue: false,
            description: "Shipment cancellation credit already applied to the original statement.",
            status: "PENDING",
            createdBy: input.reviewedBy
          }], { session });
        }

        await appendCreditLedgerEntry({
          account: updatedAccount,
          type: "SHIPMENT_CANCELLATION_APPLIED",
          reference: `CANCELLATION-${String(cancellation._id)}`,
          description: "Shipment cancellation refund and credit release applied.",
          amountMinor: amounts.refundableAmountMinor,
          idempotencyKey: `SHIPMENT_CANCELLATION:${String(cancellation._id)}`,
          createdBy: input.reviewedBy,
          metadata: {
            shipmentDraftId: cancellation.shipmentDraftId,
            feeTotalMinor: amounts.feeTotalMinor,
            originalCreditReversedMinor: settlement.originalCreditReversedMinor,
            cancellationFeeCreditMinor: settlement.cancellationFeeCreditMinor,
            netCreditReleasedMinor: settlement.netCreditReleasedMinor,
            statementCreditAppliedMinor,
            customerAdvanceCreditedMinor: settlement.customerAdvanceCreditedMinor
          },
          session
        });
      }

      const issuedAt = new Date();
      const creditNoteNumber = await nextDocumentNumber("CREDIT_NOTE", issuedAt, session);
      const feeTaxes = feeTaxSplit(amounts.feeGstMinor, invoice.taxType);
      const [creditNote] = await ShipmentCreditNote.create([{
        creditNoteNumber: creditNoteNumber.number,
        financialYear: creditNoteNumber.financialYear,
        cancellationId: cancellation._id,
        shipmentInvoiceId: invoice._id,
        shipmentDraftId: cancellation.shipmentDraftId,
        businessAccountId: cancellation.businessAccountId,
        branchId: cancellation.branchId,
        originalInvoiceNumber: invoice.invoiceNumber,
        originalInvoiceRevision: invoice.revision,
        supplier: invoice.supplier,
        customer: invoice.customer,
        shipment: invoice.shipment,
        taxableValueMinor: invoice.taxableValueMinor,
        gstRatePercent: invoice.gstRatePercent,
        taxTreatment,
        taxType: invoice.taxType,
        cgstAmountMinor: invoice.cgstAmountMinor,
        sgstAmountMinor: invoice.sgstAmountMinor,
        igstAmountMinor: invoice.igstAmountMinor,
        totalTaxAmountMinor: invoice.totalTaxAmountMinor,
        totalAmountMinor: invoice.totalAmountMinor,
        reason: cancellation.reason,
        issuedAt,
        createdBy: input.reviewedBy
      }], { session });
      const operatorCancellation = cancellation.carrierConfirmationRequired === false;
      const feeInvoiceNumber = !operatorCancellation || amounts.feeTotalMinor > 0
        ? await nextDocumentNumber("FEE_INVOICE", issuedAt, session)
        : null;
      let feeInvoice: InstanceType<typeof CancellationFeeInvoice> | null = null;
      if (feeInvoiceNumber) {
        const [createdFeeInvoice] = await CancellationFeeInvoice.create([{
          invoiceNumber: feeInvoiceNumber.number,
          financialYear: feeInvoiceNumber.financialYear,
          cancellationId: cancellation._id,
          shipmentDraftId: cancellation.shipmentDraftId,
          businessAccountId: cancellation.businessAccountId,
          branchId: cancellation.branchId,
          supplier: invoice.supplier,
          customer: invoice.customer,
          taxableValueMinor: amounts.feeBaseMinor,
          gstRatePercent: taxTreatment === "NO_GST" ? 0 : CANCELLATION_GST_RATE_PERCENT,
          taxTreatment,
          taxType: invoice.taxType,
          ...feeTaxes,
          totalTaxAmountMinor: amounts.feeGstMinor,
          totalAmountMinor: amounts.feeTotalMinor,
          advanceAppliedMinor: settlement.cancellationFeeSettledMinor,
          creditOutstandingMinor: settlement.cancellationFeeCreditMinor,
          paymentStatus: settlement.cancellationFeeCreditMinor === 0
            ? "PAID"
            : settlement.cancellationFeeSettledMinor > 0 ? "PARTIALLY_PAID" : "UNPAID",
          billingStatementId: null,
          billedAt: null,
          feeReason: input.feeReason.trim() || "Standard shipment cancellation fee.",
          issuedAt,
          createdBy: input.reviewedBy
        }], { session });
        feeInvoice = createdFeeInvoice ?? null;
      }
      if (!creditNote || (feeInvoiceNumber && !feeInvoice)) {
        throw new ShipmentCancellationError(500, "Cancellation financial documents could not be generated.");
      }

      invoice.paymentStatus = "VOID";
      invoice.creditOutstandingMinor = 0;
      invoice.updatedBy = input.reviewedBy;
      await invoice.save({ session });
      await ShipmentCharge.updateOne(
        { shipmentDraftId: cancellation.shipmentDraftId },
        { $set: { customerChargeStatus: "REVERSED" } },
        { runValidators: true, session }
      ).exec();
      await ShipmentEvent.create([{
        shipmentDraftId: cancellation.shipmentDraftId,
        dpdShipmentId: cancellation.dpdShipmentId,
        status: "SHIPMENT_CANCELLED",
        note: operatorCancellation
          ? "Shipment cancelled after operator review."
          : "Shipment cancelled after Swiftline review and carrier confirmation.",
        customerVisible: true,
        createdBy: input.reviewedBy,
        eventAt: issuedAt
      }], { session });

      cancellation.status = "COMPLETED";
      cancellation.approvedFeeBaseMinor = amounts.feeBaseMinor;
      cancellation.feeGstMinor = amounts.feeGstMinor;
      cancellation.feeTotalMinor = amounts.feeTotalMinor;
      cancellation.refundableAmountMinor = amounts.refundableAmountMinor;
      cancellation.feeReason = amounts.feeTotalMinor > 0
        ? input.feeReason.trim() || (operatorCancellation ? "Operator cancellation fee." : "Standard shipment cancellation fee.")
        : "";
      cancellation.carrierConfirmed = operatorCancellation ? false : true;
      cancellation.settlementConfirmed = true;
      cancellation.paymentRefundStatus = paymentRefundStatus;
      cancellation.paymentRefundAmountMinor = amounts.refundableAmountMinor;
      cancellation.paymentRefundReference = paymentRefundReference;
      cancellation.paymentRefundedAt = amounts.refundableAmountMinor > 0 ? issuedAt : null;
      cancellation.carrierReference = input.carrierReference;
      cancellation.reviewNote = input.reviewNote;
      cancellation.reviewedBy = input.reviewedBy;
      cancellation.reviewedAt = issuedAt;
      cancellation.completedAt = issuedAt;
      cancellation.settlement = {
        originalCreditReversedMinor: settlement.originalCreditReversedMinor,
        cancellationFeeCreditMinor: settlement.cancellationFeeCreditMinor,
        netCreditReleasedMinor: settlement.netCreditReleasedMinor,
        statementCreditAppliedMinor,
        customerAdvanceCreditedMinor: settlement.customerAdvanceCreditedMinor
      };
      cancellation.creditNoteId = creditNote._id;
      cancellation.cancellationFeeInvoiceId = feeInvoice?._id ?? null;
      await cancellation.save({ session });

      await AuditLog.create([{
        action: "SHIPMENT_CANCELLATION_COMPLETED",
        entityType: "SHIPMENT_CANCELLATION",
        entityId: cancellation._id,
        performedBy: input.reviewedBy,
        performedAt: issuedAt,
        metadata: {
          shipmentDraftId: cancellation.shipmentDraftId,
          creditNoteNumber: creditNote.creditNoteNumber,
          cancellationFeeInvoiceNumber: feeInvoice?.invoiceNumber ?? null,
          feeTotalMinor: amounts.feeTotalMinor,
          refundableAmountMinor: amounts.refundableAmountMinor,
          paymentRefundStatus,
          paymentRefundReference,
          manualRefundMethod: legacyWalletFunding ? input.refundPayout?.method ?? null : null,
          manualRefundNote: legacyWalletFunding ? input.refundPayout?.note?.trim() || null : null
        }
      }], { session });
      const clientHref = operatorCancellation && input.portalSlug
        ? `/portal/${encodeURIComponent(input.portalSlug)}/shipments/${String(cancellation.shipmentDraftId)}`
        : `/client/shipments/${String(cancellation.shipmentDraftId)}#shipment-cancellation`;
      const feeInvoiceMessage = feeInvoice
        ? ` ${feeInvoice.invoiceNumber} is available.`
        : " No cancellation fee was applied.";
      await notifyBusinessFinancialMembers(cancellation.businessAccountId, {
        type: "SHIPMENT_CANCELLATION_COMPLETED",
        title: "Shipment cancellation completed",
        message: operatorCancellation
          ? `The operator completed the cancellation. ${creditNote.creditNoteNumber} is available.${feeInvoiceMessage}`
          : `Cancellation completed. ${creditNote.creditNoteNumber} and ${feeInvoice!.invoiceNumber} are available.`,
        href: clientHref,
        idempotencyKey: `SHIPMENT_CANCELLATION_COMPLETED:${String(cancellation._id)}`
      }, session);
      const { syncShipmentProfitability } = await import("./shipmentProfitability.service.js");
      await syncShipmentProfitability(cancellation.shipmentDraftId, { session });
      return cancellation;
    });
  } finally {
    await session.endSession();
  }
}

export async function cancelShipmentDirectly(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  requestedBy: mongoose.Types.ObjectId;
  requesterRole: "admin" | "operations";
  reason: string;
  feeBaseMinor: number;
  feeReason: string;
  carrierReference: string;
  refundPayout?: {
    method: CounterPaymentMethod;
    reference?: string;
    note?: string;
  };
}): Promise<{ cancellation: IShipmentCancellation; completed: boolean; message: string }> {
  const completedCancellation = await ShipmentCancellation.findOne({
    shipmentDraftId: input.shipmentDraftId,
    status: "COMPLETED"
  }).sort({ completedAt: -1 }).exec();
  if (completedCancellation) {
    return {
      cancellation: completedCancellation,
      completed: true,
      message: "This shipment has already been cancelled."
    };
  }

  if (!Number.isSafeInteger(input.feeBaseMinor) || input.feeBaseMinor < 0) {
    throw new ShipmentCancellationError(400, "The cancellation fee must be a non-negative amount.");
  }
  const preview = await getShipmentCancellationPreview(input.shipmentDraftId, input.feeBaseMinor);
  if (
    !preview.legacyCreditOnly
    && input.feeBaseMinor > DEFAULT_CANCELLATION_FEE_BASE_MINOR
    && input.feeReason.trim().length < 5
  ) {
    throw new ShipmentCancellationError(400, "Explain the additional carrier or handling fee.");
  }
  const feeBaseMinor = preview.legacyCreditOnly ? 0 : input.feeBaseMinor;
  const feeReason = preview.legacyCreditOnly ? "" : input.feeReason.trim();
  if (preview.manualRefundRequired && !input.refundPayout) {
    throw new ShipmentCancellationError(400, "Record the offline refund payout before completing this cancellation.");
  }
  if (preview.manualRefundRequired && input.refundPayout?.method !== "CASH" && !input.refundPayout?.reference?.trim()) {
    throw new ShipmentCancellationError(400, "Enter the bank, UPI, card, or cheque reference for the offline refund.");
  }

  const cancellation = await requestShipmentCancellation({
    shipmentDraftId: input.shipmentDraftId,
    requestedBy: input.requestedBy,
    requesterType: "ADMIN",
    requesterRole: input.requesterRole,
    reason: input.reason,
    requestedFeeBaseMinor: feeBaseMinor,
    feeReason,
    notifyReviewers: false
  });
  if (
    cancellation.requesterType !== "ADMIN"
    || String(cancellation.requestedBy) !== String(input.requestedBy)
    || cancellation.reason !== input.reason
    || cancellation.requestedFeeBaseMinor !== feeBaseMinor
    || cancellation.feeReason !== feeReason
  ) {
    throw new ShipmentCancellationError(409, "A different cancellation request or fee is already active for this shipment.");
  }

  try {
    const approvedCancellation = await approveShipmentCancellation({
      cancellationId: cancellation._id as mongoose.Types.ObjectId,
      reviewedBy: input.requestedBy,
      feeBaseMinor,
      feeReason,
      carrierConfirmed: true,
      settlementConfirmed: true,
      carrierReference: input.carrierReference,
      reviewNote: `Completed directly by ${input.requesterRole === "admin" ? "an administrator" : "an operations user"} from the shipment list.`,
      ...(preview.manualRefundRequired ? { refundPayout: input.refundPayout } : {})
    });
    return {
      cancellation: approvedCancellation,
      completed: approvedCancellation.status === "COMPLETED",
      message: approvedCancellation.status === "COMPLETED"
        ? preview.legacyCreditOnly
          ? "Legacy credit shipment cancelled without refund, credit, fee, or financial-document changes."
          : "Shipment cancellation completed."
        : "Cancellation is still pending review."
    };
  } catch (error) {
    const pendingCancellation = await ShipmentCancellation.findById(cancellation._id).exec() ?? cancellation;
    await notifyActiveAdmins({
      type: "SHIPMENT_CANCELLATION_REQUESTED",
      title: "Direct cancellation needs review",
      message: "A direct cancellation could not finish automatically. Review its refund and settlement status.",
      href: `/dashboard/cancellations#cancellation-${String(pendingCancellation._id)}`,
      idempotencyKey: `SHIPMENT_CANCELLATION_DIRECT_REVIEW:${String(pendingCancellation._id)}`,
      businessAccountId: pendingCancellation.businessAccountId,
      metadata: {
        cancellationId: String(pendingCancellation._id),
        shipmentDraftId: String(pendingCancellation.shipmentDraftId)
      }
    });
    if (error instanceof ShipmentCancellationError && error.statusCode === 202) {
      return {
        cancellation: pendingCancellation,
        completed: false,
        message: error.message
      };
    }
    throw error;
  }
}
