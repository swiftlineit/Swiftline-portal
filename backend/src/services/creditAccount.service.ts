import mongoose from "mongoose";
import { BusinessCreditAccount, type IBusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditLedgerEntry, type CreditLedgerEntryType } from "../models/creditLedgerEntry.model.js";
import { maxCreditLimitLabel, maxCreditLimitMinor } from "../models/financialTypes.js";
import type { BusinessAccountMemberRole, CreditPermission } from "../models/businessAccountMember.model.js";
import { PaymentTermsDocument } from "../models/paymentTerms.model.js";
import { notifyBusinessFinancialMembers } from "./portalNotification.service.js";

const roleCreditPermissions: Record<BusinessAccountMemberRole, CreditPermission[]> = {
  account_owner: ["requestCredit", "useCreditPayment", "viewCreditBalance", "viewCreditDetails", "makeCreditPayment"],
  account_admin: ["requestCredit", "useCreditPayment", "viewCreditBalance", "viewCreditDetails", "makeCreditPayment"],
  finance: ["requestCredit", "useCreditPayment", "viewCreditBalance", "viewCreditDetails", "makeCreditPayment"],
  operations: ["useCreditPayment"],
  /**
   * Booking spends credit, so a booking user must be able to draw on it and
   * see whether any is left- the balance is what tells them a booking will go
   * through. They cannot request a limit or make payments.
   */
  booking_user: ["useCreditPayment", "viewCreditBalance"],
  /** A claim concerns goods, not the credit account. */
  claims_user: [],
  tracking_only: []
};

export const fallbackPaymentTerms = {
  version: "2026-11-prepaid-v1",
  title: "Swiftline Prepaid Payment Terms",
  effectiveFrom: new Date("2026-11-21T00:00:00.000Z"),
  sections: [
    { heading: "Wallet top-ups", content: "Wallet funds are available after Razorpay confirms the payment. A checkout that is cancelled, failed, or still pending does not add spendable funds." },
    { heading: "Shipment booking", content: "Every new shipment must be paid in full before it is booked. A business shipment can use available wallet funds, Razorpay payment at booking, or a staff-recorded cash receipt. A shipment is not created until the payment is verified or the receipt is finalized." },
    { heading: "Wallet reservations", content: "When wallet funds are used for booking, the amount is held while the booking is being completed. A failed booking releases the hold. The wallet activity shows confirmed top-ups, charges, refunds, and holds." },
    { heading: "Amendments", content: "A business account pays an increased shipment charge from its wallet. Add enough wallet funds before paying if the available balance is short. Individual and public shipment amendments are paid directly through Razorpay." },
    { heading: "Cash receipts", content: "Only Swiftline staff can record offline cash received for a business shipment. The receipt is tied to that shipment and does not add money to the business wallet. Standalone cash receipts also do not change wallet funds." },
    { heading: "Invoices and assistance", content: "Each booked shipment keeps its shipment invoice. Contact your assigned Swiftline branch if a payment, wallet entry, receipt, or invoice appears incorrect." }
  ]
};

export function getMemberCreditPermissions(role: BusinessAccountMemberRole, explicitPermissions?: CreditPermission[]) {
  return explicitPermissions?.length ? [...new Set(explicitPermissions)] : [...roleCreditPermissions[role]];
}

export function canAccessCreditFinancials(role: BusinessAccountMemberRole) {
  return role === "account_owner" || role === "account_admin" || role === "finance";
}

export function canCloseClientBillingCycle(role: BusinessAccountMemberRole) {
  return role === "finance";
}

export function getCreditActivationBlockers(input: {
  businessStatus: string;
  kycStatus?: string;
  agreementStatus?: string;
  depositStatus?: string;
  securityDepositRequiredMinor: number;
  approvedCreditLimitMinor: number;
  validUntil?: Date | null;
  now?: Date;
}, options: { requireAgreement?: boolean } = {}) {
  const now = input.now ?? new Date();
  const agreementBlocker = options.requireAgreement === false || input.agreementStatus === "signed"
    ? ""
    : "Credit agreement must be signed.";
  return [
    !["approved", "active"].includes(input.businessStatus) ? "Business account must be approved or active." : "",
    input.kycStatus !== "verified" ? "KYC must be verified." : "",
    agreementBlocker,
    input.securityDepositRequiredMinor > 0 && input.depositStatus !== "received" ? "Required security deposit must be received." : "",
    input.approvedCreditLimitMinor <= 0 ? "Approved credit limit must be greater than zero." : "",
    input.approvedCreditLimitMinor > maxCreditLimitMinor ? `Approved credit limit cannot exceed ${maxCreditLimitLabel}.` : "",
    input.validUntil && input.validUntil <= now ? "Credit validity has already expired." : ""
  ].filter((blocker): blocker is string => Boolean(blocker));
}

// Approved credit is only spendable while the facility is ACTIVE and inside its
// validity window. Keeping this in one place ensures every API response, admin
// view, and the booking guard agree on what is actually available.
export function isCreditWindowOpen(
  account: Pick<IBusinessCreditAccount, "status" | "validFrom" | "validUntil">,
  now: Date = new Date()
) {
  if (account.status !== "ACTIVE") return false;
  if (account.validFrom && account.validFrom > now) return false;
  if (account.validUntil && account.validUntil <= now) return false;
  return true;
}

export function getCreditBalances(
  account: Pick<IBusinessCreditAccount,
    "approvedCreditLimitMinor" | "reservedCreditMinor" | "unbilledCreditMinor" |
    "invoicedOutstandingMinor" | "customerAdvanceBalanceMinor" | "reservedAdvanceMinor" |
    "status" | "validFrom" | "validUntil"
  >,
  now: Date = new Date()
) {
  const usedCreditMinor = account.reservedCreditMinor + account.unbilledCreditMinor + account.invoicedOutstandingMinor;
  const availableCreditMinor = isCreditWindowOpen(account, now)
    ? Math.max(account.approvedCreditLimitMinor - usedCreditMinor, 0)
    : 0;
  const availableAdvanceMinor = Math.max(account.customerAdvanceBalanceMinor - account.reservedAdvanceMinor, 0);

  return {
    usedCreditMinor,
    availableCreditMinor,
    availableAdvanceMinor,
    availableBookingCapacityMinor: availableAdvanceMinor + availableCreditMinor,
    // Everything the customer owes, whether or not it has reached a statement
    // yet. `invoicedOutstandingMinor` alone reads as zero until a cycle closes,
    // which hid a real balance behind an encouraging number. Reservations are
    // excluded: a hold on an unconfirmed booking is not yet a debt.
    totalOwedMinor: account.unbilledCreditMinor + account.invoicedOutstandingMinor
  };
}

// Share of the approved limit that is committed (reserved + unbilled + invoiced),
// and whether that share has crossed the configured warning threshold.
export function getCreditUtilization(account: Pick<IBusinessCreditAccount,
  "approvedCreditLimitMinor" | "reservedCreditMinor" | "unbilledCreditMinor" |
  "invoicedOutstandingMinor" | "customerAdvanceBalanceMinor" | "reservedAdvanceMinor" |
  "status" | "validFrom" | "validUntil" | "creditWarningThresholdPercent"
>, now: Date = new Date()) {
  const { usedCreditMinor } = getCreditBalances(account, now);
  const utilizationPercent = account.approvedCreditLimitMinor > 0
    ? Math.round((usedCreditMinor / account.approvedCreditLimitMinor) * 100)
    : 0;
  const warningActive = isCreditWindowOpen(account, now)
    && account.approvedCreditLimitMinor > 0
    && utilizationPercent >= account.creditWarningThresholdPercent;

  return { utilizationPercent, warningActive };
}

export function serializeCreditAccount(account: IBusinessCreditAccount) {
  return {
    id: String(account._id),
    businessAccountId: String(account.businessAccountId),
    status: account.status,
    ...getCreditUtilization(account),
    currency: account.currency,
    requestedCreditLimitMinor: account.requestedCreditLimitMinor,
    requestReason: account.requestReason,
    requestedAt: account.requestedAt ?? null,
    approvedCreditLimitMinor: account.approvedCreditLimitMinor,
    reservedCreditMinor: account.reservedCreditMinor,
    unbilledCreditMinor: account.unbilledCreditMinor,
    invoicedOutstandingMinor: account.invoicedOutstandingMinor,
    customerAdvanceBalanceMinor: account.customerAdvanceBalanceMinor,
    reservedAdvanceMinor: account.reservedAdvanceMinor,
    ...getCreditBalances(account),
    paymentTermsDays: account.paymentTermsDays,
    billingCycle: account.billingCycle,
    validFrom: account.validFrom ?? null,
    validUntil: account.validUntil ?? null,
    gracePeriodDays: account.gracePeriodDays,
    maxOverdueDays: account.maxOverdueDays,
    creditWarningThresholdPercent: account.creditWarningThresholdPercent,
    securityDepositRequiredMinor: account.securityDepositRequiredMinor,
    riskCategory: account.riskCategory,
    internalRemarks: account.internalRemarks,
    holdReason: account.holdReason,
    reviewedAt: account.reviewedAt ?? null,
    activatedAt: account.activatedAt ?? null,
    version: account.version,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export async function ensureCreditAccount(businessAccountId: mongoose.Types.ObjectId, session?: mongoose.ClientSession) {
  return BusinessCreditAccount.findOneAndUpdate(
    { businessAccountId },
    { $setOnInsert: { businessAccountId } },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
  ).exec();
}

export async function appendCreditLedgerEntry(input: {
  account: IBusinessCreditAccount;
  type: CreditLedgerEntryType;
  reference: string;
  description: string;
  amountMinor?: number;
  idempotencyKey: string;
  createdBy: mongoose.Types.ObjectId | null;
  metadata?: Record<string, unknown>;
  session?: mongoose.ClientSession;
}) {
  const balances = getCreditBalances(input.account);
  const documents = await CreditLedgerEntry.create([{
    businessAccountId: input.account.businessAccountId,
    creditAccountId: input.account._id,
    type: input.type,
    reference: input.reference,
    description: input.description,
    amountMinor: input.amountMinor ?? 0,
    currency: input.account.currency,
    availableCreditAfterMinor: balances.availableCreditMinor,
    availableAdvanceAfterMinor: balances.availableAdvanceMinor,
    idempotencyKey: input.idempotencyKey,
    createdBy: input.createdBy,
    metadata: input.metadata ?? {}
  }], { session: input.session });
  return documents[0];
}

// Mark every active facility whose validity window has closed as EXPIRED. The
// available-credit math already treats a lapsed window as zero (isCreditWindowOpen);
// this makes the status explicit and blocks new bookings via the status guard.
export async function expireLapsedCreditAccounts(now = new Date()) {
  const result = await BusinessCreditAccount.updateMany(
    { status: "ACTIVE", validUntil: { $ne: null, $lt: now } },
    { $set: { status: "EXPIRED" }, $inc: { version: 1 } }
  ).exec();

  return { expired: result.modifiedCount };
}

// Notify finance members whose credit utilization has crossed the warning
// threshold. Keyed per day so an over-threshold account is nudged once daily
// rather than on every job run.
export async function notifyCreditUtilizationWarnings(now = new Date()) {
  const accounts = await BusinessCreditAccount.find({ status: "ACTIVE", approvedCreditLimitMinor: { $gt: 0 } }).exec();
  const dayKey = now.toISOString().slice(0, 10);
  let notified = 0;

  for (const account of accounts) {
    const { utilizationPercent, warningActive } = getCreditUtilization(account, now);
    if (!warningActive) continue;

    try {
      await notifyBusinessFinancialMembers(account.businessAccountId, {
        type: "CREDIT_UTILIZATION_WARNING",
        title: "Credit utilization is high",
        message: `Your credit facility is ${utilizationPercent}% used, at or above the ${account.creditWarningThresholdPercent}% warning level.`,
        href: "/client/credit#credit-summary",
        idempotencyKey: `CREDIT_WARNING:${String(account._id)}:${dayKey}`,
        metadata: { utilizationPercent, thresholdPercent: account.creditWarningThresholdPercent }
      });
      notified += 1;
    } catch (error) {
      console.error("Failed to send credit utilization warning", String(account._id), error);
    }
  }

  return { notified };
}

export async function getCurrentPaymentTerms() {
  const document = await PaymentTermsDocument.findOne({
    status: "PUBLISHED",
    effectiveFrom: { $lte: new Date() }
  }).sort({ effectiveFrom: -1 }).lean().exec();

  const publishedText = document
    ? `${document.title} ${document.sections.map((section) => `${section.heading} ${section.content}`).join(" ")}`
    : "";
  const containsRetiredCreditTerms = /credit account|credit facility|available credit|customer advance|credit billing statement/i.test(publishedText);
  return document && !containsRetiredCreditTerms ? {
    version: document.version,
    title: document.title,
    effectiveFrom: document.effectiveFrom,
    sections: document.sections
  } : fallbackPaymentTerms;
}

/** Shapes an increase request for both the client view and the admin queue. */
export function serializeLimitIncrease(request: {
  _id: unknown;
  businessAccountId: unknown;
  currentLimitMinor: number;
  requestedLimitMinor: number;
  reason: string;
  status: string;
  requestedAt: Date;
  reviewedAt?: Date | null;
  decidedLimitMinor?: number | null;
  decisionNote?: string;
}) {
  return {
    id: String(request._id),
    businessAccountId: String(request.businessAccountId),
    currentLimitMinor: request.currentLimitMinor,
    requestedLimitMinor: request.requestedLimitMinor,
    reason: request.reason,
    status: request.status,
    requestedAt: request.requestedAt,
    reviewedAt: request.reviewedAt ?? null,
    decidedLimitMinor: request.decidedLimitMinor ?? null,
    decisionNote: request.decisionNote ?? ""
  };
}
