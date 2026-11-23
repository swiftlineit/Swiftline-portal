import mongoose from "mongoose";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditBillingAdjustment } from "../models/creditBillingAdjustment.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import { getCreditBalances, isCreditWindowOpen } from "./creditAccount.service.js";
import { getCreditRestrictionState } from "./creditOverdue.service.js";
import { getTenantContext } from "./tenantScope.service.js";
import { applyPrepaidAmendmentMovement } from "./prepaid/amendmentFunding.service.js";
import type { ShipmentPricingEstimate } from "./shipmentPricing.service.js";

export class AmendmentBillingError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export type AmendmentBillingAdjustment = {
  previousAmountMinor: number;
  amendedAmountMinor: number;
  deltaAmountMinor: number;
  advanceUsedMinor: number;
  creditUsedMinor: number;
  creditReducedMinor: number;
  advanceRefundedMinor: number;
  /**
   * Part of a reduction that came back as fresh Customer Advance because the
   * customer had already paid it. Only ever non-zero once a shipment can be
   * re-weighed after its invoice reached a statement and was settled- there is
   * nothing left on the statement to take it off, so it is returned as booking
   * capacity instead.
   */
  advanceCreditedMinor: number;
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  /** What stays settled against the invoice once this adjustment is applied. */
  settledAmountMinor: number;
};

export type AmendmentFundingPreview = {
  billingMode: "BUSINESS_ACCOUNT" | "PREPAID" | "DIRECT" | "TEST";
  previousAmountMinor: number;
  amendedAmountMinor: number;
  deltaAmountMinor: number;
  availableBookingCapacityMinor: number;
  canFund: boolean;
  message: string;
  adjustment: AmendmentBillingAdjustment | null;
};

function toMinor(amount: number) {
  return Math.round(amount * 100);
}

const prepaidPaymentSources = new Set(["BUSINESS_WALLET", "DIRECT_RAZORPAY", "CASH_RECEIPT", "PUBLIC_RAZORPAY"]);
const rootDirectPaymentSources = new Set(["ADMIN_DIRECT", "DIRECT_RAZORPAY", "PUBLIC_RAZORPAY"]);

function calculatePrepaidAdjustment(invoice: InstanceType<typeof ShipmentInvoice>, amendedAmountMinor: number) {
  const deltaAmountMinor = amendedAmountMinor - invoice.totalAmountMinor;
  return calculateAmendmentBillingAdjustment({
    previousAmountMinor: invoice.totalAmountMinor,
    amendedAmountMinor,
    previousAdvanceAppliedMinor: invoice.advanceAppliedMinor,
    previousCreditOutstandingMinor: invoice.creditOutstandingMinor,
    availableAdvanceMinor: Math.max(deltaAmountMinor, 0),
    availableCreditMinor: 0,
    insufficientMessage: "Pay the additional amendment amount before approval."
  });
}

export function calculateAmendmentBillingAdjustment(input: {
  previousAmountMinor: number;
  amendedAmountMinor: number;
  previousAdvanceAppliedMinor: number;
  previousCreditOutstandingMinor: number;
  availableAdvanceMinor: number;
  availableCreditMinor: number;
  insufficientMessage?: string;
}): AmendmentBillingAdjustment {
  const deltaAmountMinor = input.amendedAmountMinor - input.previousAmountMinor;
  let advanceUsedMinor = 0;
  let creditUsedMinor = 0;
  let creditReducedMinor = 0;
  let advanceRefundedMinor = 0;
  let advanceCreditedMinor = 0;

  // What the customer has already paid against this invoice. Settling a billing
  // statement clears the invoice's outstanding credit without moving anything
  // into the applied advance, so whatever the two allocations no longer account
  // for is money that has actually changed hands. Zero for every invoice that
  // has not been billed and paid, which is the state amendments always find.
  const previousSettledMinor = input.previousAmountMinor
    - input.previousAdvanceAppliedMinor
    - input.previousCreditOutstandingMinor;

  if (deltaAmountMinor > 0) {
    advanceUsedMinor = Math.min(deltaAmountMinor, Math.max(input.availableAdvanceMinor, 0));
    creditUsedMinor = deltaAmountMinor - advanceUsedMinor;
    if (creditUsedMinor > Math.max(input.availableCreditMinor, 0)) {
      throw new AmendmentBillingError(
        402,
        input.insufficientMessage
          ?? "Available Customer Advance and credit are not sufficient for this amendment. Contact your assigned branch."
      );
    }
  } else if (deltaAmountMinor < 0) {
    // A reduction unwinds in the order the money was committed: outstanding
    // credit first, then advance applied at booking, and only then value the
    // customer has already paid. That last part cannot be taken off a statement
    // that is already settled, so it is returned as Customer Advance.
    const reductionMinor = Math.abs(deltaAmountMinor);
    creditReducedMinor = Math.min(reductionMinor, input.previousCreditOutstandingMinor);
    advanceRefundedMinor = Math.min(reductionMinor - creditReducedMinor, input.previousAdvanceAppliedMinor);
    advanceCreditedMinor = reductionMinor - creditReducedMinor - advanceRefundedMinor;
    if (advanceCreditedMinor > previousSettledMinor) {
      throw new AmendmentBillingError(409, "The existing invoice payment allocation is inconsistent.");
    }
  }

  const advanceAppliedMinor = input.previousAdvanceAppliedMinor + advanceUsedMinor - advanceRefundedMinor;
  const creditOutstandingMinor = input.previousCreditOutstandingMinor + creditUsedMinor - creditReducedMinor;
  const settledAmountMinor = previousSettledMinor - advanceCreditedMinor;
  if (advanceAppliedMinor + creditOutstandingMinor + settledAmountMinor !== input.amendedAmountMinor) {
    throw new AmendmentBillingError(409, "The amended invoice payment allocation is inconsistent.");
  }

  return {
    previousAmountMinor: input.previousAmountMinor,
    amendedAmountMinor: input.amendedAmountMinor,
    deltaAmountMinor,
    advanceUsedMinor,
    creditUsedMinor,
    creditReducedMinor,
    advanceRefundedMinor,
    advanceCreditedMinor,
    advanceAppliedMinor,
    creditOutstandingMinor,
    settledAmountMinor
  };
}

export async function previewAmendmentFunding(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  pricing: ShipmentPricingEstimate;
  customerType?: "BUSINESS" | "INDIVIDUAL";
  session?: mongoose.ClientSession;
  purpose?: "AMENDMENT" | "FINAL_VERIFICATION";
}): Promise<AmendmentFundingPreview> {
  const invoiceQuery = ShipmentInvoice.findOne({ shipmentDraftId: input.shipmentDraftId });
  const chargeQuery = ShipmentCharge.findOne({ shipmentDraftId: input.shipmentDraftId });
  if (input.session) {
    invoiceQuery.session(input.session);
    chargeQuery.session(input.session);
  }
  const invoice = await invoiceQuery.exec();
  const charge = await chargeQuery.exec();
  if (!invoice) throw new AmendmentBillingError(409, "Shipment billing information is incomplete.");

  const draftQuery = ShipmentDraft.findById(input.shipmentDraftId).select("customerType");
  if (input.session) draftQuery.session(input.session);
  const customerType = input.customerType ?? (await draftQuery.lean().exec())?.customerType;

  if (!charge) {
    const dpdShipmentQuery = DpdShipment.findOne({ shipmentDraftId: input.shipmentDraftId });
    if (input.session) dpdShipmentQuery.session(input.session);
    const dpdShipment = await dpdShipmentQuery.exec();
    if (dpdShipment?.paymentSource !== "TEST") {
      throw new AmendmentBillingError(409, "Shipment billing information is incomplete.");
    }

    const amendedAmountMinor = toMinor(input.pricing.totalAmount);
    const adjustment = calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      previousAdvanceAppliedMinor: 0,
      previousCreditOutstandingMinor: invoice.totalAmountMinor,
      availableAdvanceMinor: 0,
      availableCreditMinor: Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0)
    });
    return {
      billingMode: "TEST",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: adjustment.deltaAmountMinor,
      availableBookingCapacityMinor: 0,
      canFund: true,
      message: "",
      adjustment
    };
  }

  const amendedAmountMinor = toMinor(input.pricing.totalAmount);
  if (
    getTenantContext()?.kind !== "OPERATOR"
    && input.customerType !== "BUSINESS"
    && rootDirectPaymentSources.has(charge.paymentSource)
  ) {
    const deltaAmountMinor = amendedAmountMinor - invoice.totalAmountMinor;
    const adjustment = calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      previousAdvanceAppliedMinor: invoice.advanceAppliedMinor,
      previousCreditOutstandingMinor: invoice.creditOutstandingMinor,
      availableAdvanceMinor: Math.max(deltaAmountMinor, 0),
      availableCreditMinor: 0,
      insufficientMessage: "Complete the additional Razorpay payment before approving this amendment."
    });
    return {
      billingMode: "DIRECT",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor,
      availableBookingCapacityMinor: 0,
      canFund: true,
      message: deltaAmountMinor > 0
        ? "Complete the additional Razorpay payment before approval."
        : deltaAmountMinor < 0
          ? "Record the refund before approval."
          : "No additional payment is required.",
      adjustment
    };
  }

  const rootDirectAmendmentPayment = getTenantContext()?.kind !== "OPERATOR"
    && input.purpose === "AMENDMENT"
    && charge.paymentSource === "ADMIN_DIRECT";
  if (
    getTenantContext()?.kind !== "OPERATOR"
    && (
      prepaidPaymentSources.has(charge.paymentSource)
      || rootDirectAmendmentPayment
      || (customerType === "BUSINESS" && input.purpose === "AMENDMENT")
    )
  ) {
    const adjustment = calculatePrepaidAdjustment(invoice, amendedAmountMinor);
    const accountQuery = PrepaidAccount.findOne({ businessAccountId: input.businessAccountId });
    if (input.session) accountQuery.session(input.session);
    const account = await accountQuery.lean().exec();
    const availableMinor = account?.status === "ACTIVE"
      ? Math.max(account.cashBalanceMinor - account.reservedBalanceMinor, 0)
      : 0;
    const canFund = adjustment.deltaAmountMinor <= 0 || availableMinor >= adjustment.deltaAmountMinor;
    return {
      billingMode: "PREPAID",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: adjustment.deltaAmountMinor,
      availableBookingCapacityMinor: availableMinor,
      canFund,
      message: adjustment.deltaAmountMinor > 0
        ? canFund
          ? "The additional amount will be reserved from the business wallet before staff approval."
          : "Add money to the business wallet to cover this increase, then submit the amendment."
        : adjustment.deltaAmountMinor < 0
          ? "The approved reduction will be credited to the business wallet."
          : "No additional payment is required.",
      adjustment
    };
  }
  if (charge.paymentSource !== "BUSINESS_ACCOUNT") {
    const adjustment = calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      // A counter sale was paid in full before booking, so nothing is outstanding
      // against a credit account and there is no capacity to check. Any delta the
      // amendment produces is collected from, or refunded to, the customer at the
      // counter and recorded as a CounterPayment.
      previousAdvanceAppliedMinor: charge.paymentSource === "ADMIN_DIRECT" ? invoice.totalAmountMinor : 0,
      previousCreditOutstandingMinor: charge.paymentSource === "ADMIN_DIRECT" ? 0 : invoice.totalAmountMinor,
      availableAdvanceMinor: charge.paymentSource === "ADMIN_DIRECT"
        ? Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0)
        : 0,
      availableCreditMinor: Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0)
    });
    return {
      billingMode: charge.paymentSource === "ADMIN_DIRECT" ? "DIRECT" : "TEST",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: adjustment.deltaAmountMinor,
      availableBookingCapacityMinor: 0,
      canFund: true,
      message: "",
      adjustment
    };
  }

  const accountQuery = BusinessCreditAccount.findOne({ businessAccountId: input.businessAccountId });
  if (input.session) accountQuery.session(input.session);
  const account = await accountQuery.exec();
  if (!account) throw new AmendmentBillingError(409, "Business credit account was not found.");

  const balances = getCreditBalances(account);
  const restriction = await getCreditRestrictionState({
    businessAccountId: input.businessAccountId,
    gracePeriodDays: account.gracePeriodDays,
    maxOverdueDays: account.maxOverdueDays,
    session: input.session
  });
  if (restriction.level === "ALL_BOOKINGS_BLOCKED") {
    return {
      billingMode: "BUSINESS_ACCOUNT",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: amendedAmountMinor - invoice.totalAmountMinor,
      availableBookingCapacityMinor: 0,
      canFund: false,
      message: restriction.message,
      adjustment: null
    };
  }
  const creditIsUsable = isCreditWindowOpen(account) && restriction.level !== "CREDIT_BLOCKED";
  const availableCreditMinor = creditIsUsable ? balances.availableCreditMinor : 0;
  const availableBookingCapacityMinor = balances.availableAdvanceMinor + availableCreditMinor;
  const blocked = ["ON_HOLD", "SUSPENDED", "EXPIRED", "REJECTED", "CLOSED"].includes(account.status);
  const isFinalVerification = input.purpose === "FINAL_VERIFICATION";

  try {
    const adjustment = calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      previousAdvanceAppliedMinor: invoice.advanceAppliedMinor,
      previousCreditOutstandingMinor: invoice.creditOutstandingMinor,
      availableAdvanceMinor: balances.availableAdvanceMinor,
      availableCreditMinor,
      insufficientMessage: isFinalVerification
        ? "Available Customer Advance and credit are not sufficient for the final verified charge. Contact the assigned branch."
        : undefined
    });
    if (blocked && adjustment.deltaAmountMinor > 0) {
      return {
        billingMode: "BUSINESS_ACCOUNT",
        previousAmountMinor: invoice.totalAmountMinor,
        amendedAmountMinor,
        deltaAmountMinor: adjustment.deltaAmountMinor,
        availableBookingCapacityMinor,
        canFund: false,
        message: isFinalVerification
          ? "This credit account cannot fund the final verified charge. Contact the assigned branch."
          : "This credit account cannot fund an amendment. Contact your assigned branch.",
        adjustment: null
      };
    }
    return {
      billingMode: "BUSINESS_ACCOUNT",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: adjustment.deltaAmountMinor,
      availableBookingCapacityMinor,
      canFund: true,
      message: "",
      adjustment
    };
  } catch (error) {
    if (!(error instanceof AmendmentBillingError) || error.statusCode !== 402) throw error;
    return {
      billingMode: "BUSINESS_ACCOUNT",
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      deltaAmountMinor: amendedAmountMinor - invoice.totalAmountMinor,
      availableBookingCapacityMinor,
      canFund: false,
      message: error.message,
      adjustment: null
    };
  }
}

async function applyShipmentBillingAdjustment(input: {
  referenceId: mongoose.Types.ObjectId;
  purpose: "AMENDMENT" | "FINAL_VERIFICATION";
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  pricing: ShipmentPricingEstimate;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  // Transaction sessions must not execute parallel database operations.
  const invoice = await ShipmentInvoice.findOne({ shipmentDraftId: input.shipmentDraftId })
    .session(input.session)
    .exec();
  const charge = await ShipmentCharge.findOne({ shipmentDraftId: input.shipmentDraftId })
    .session(input.session)
    .exec();
  const draft = await ShipmentDraft.findById(input.shipmentDraftId)
    .select("customerType")
    .session(input.session)
    .lean()
    .exec();
  if (!invoice) throw new AmendmentBillingError(409, "Shipment billing information is incomplete.");

  if (!charge) {
    const dpdShipment = await DpdShipment.findOne({ shipmentDraftId: input.shipmentDraftId })
      .session(input.session)
      .exec();
    if (dpdShipment?.paymentSource !== "TEST") {
      throw new AmendmentBillingError(409, "Shipment billing information is incomplete.");
    }

    const amendedAmountMinor = toMinor(input.pricing.totalAmount);
    return calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      previousAdvanceAppliedMinor: 0,
      previousCreditOutstandingMinor: invoice.totalAmountMinor,
      availableAdvanceMinor: 0,
      availableCreditMinor: Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0)
    });
  }

  const amendedAmountMinor = toMinor(input.pricing.totalAmount);
  const rootBusinessAmendment = getTenantContext()?.kind !== "OPERATOR"
    && draft?.customerType === "BUSINESS"
    && input.purpose === "AMENDMENT";
  if (
    getTenantContext()?.kind !== "OPERATOR"
    && (prepaidPaymentSources.has(charge.paymentSource) || rootBusinessAmendment)
  ) {
    const adjustment = calculatePrepaidAdjustment(invoice, amendedAmountMinor);
    if (input.purpose === "AMENDMENT") {
      await applyPrepaidAmendmentMovement({
        amendmentId: input.referenceId,
        adjustment,
        createdBy: input.createdBy,
        session: input.session
      });
    } else if (adjustment.deltaAmountMinor > 0) {
      throw new AmendmentBillingError(
        402,
        "The additional final verified charge must be paid before dispatch."
      );
    }
    charge.customerChargeMinor = amendedAmountMinor;
    charge.pricingSnapshot = input.pricing as unknown as Record<string, unknown>;
    await charge.save({ session: input.session });
    return adjustment;
  }
  if (charge.paymentSource !== "BUSINESS_ACCOUNT") {
    const isCounterSale = charge.paymentSource === "ADMIN_DIRECT";
    const adjustment = calculateAmendmentBillingAdjustment({
      previousAmountMinor: invoice.totalAmountMinor,
      amendedAmountMinor,
      // A counter sale is already settled in full, so the amended invoice must stay
      // settled in full: any increase is treated as collected at the counter and
      // any decrease as refunded there, leaving nothing outstanding on credit.
      // The matching cash movement is recorded as a CounterPayment.
      previousAdvanceAppliedMinor: isCounterSale ? invoice.totalAmountMinor : 0,
      previousCreditOutstandingMinor: isCounterSale ? 0 : invoice.totalAmountMinor,
      availableAdvanceMinor: isCounterSale ? Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0) : 0,
      availableCreditMinor: Math.max(amendedAmountMinor - invoice.totalAmountMinor, 0)
    });
    charge.customerChargeMinor = amendedAmountMinor;
    charge.pricingSnapshot = input.pricing as unknown as Record<string, unknown>;
    await charge.save({ session: input.session });
    return adjustment;
  }

  const account = await BusinessCreditAccount.findOne({ businessAccountId: input.businessAccountId })
    .session(input.session)
    .exec();
  if (!account) throw new AmendmentBillingError(409, "Business credit account was not found.");

  const balances = getCreditBalances(account);
  const restriction = await getCreditRestrictionState({
    businessAccountId: input.businessAccountId,
    gracePeriodDays: account.gracePeriodDays,
    maxOverdueDays: account.maxOverdueDays,
    session: input.session
  });
  if (restriction.level === "ALL_BOOKINGS_BLOCKED") {
    throw new AmendmentBillingError(409, restriction.message);
  }
  const creditIsUsable = isCreditWindowOpen(account) && restriction.level !== "CREDIT_BLOCKED";
  const adjustment = calculateAmendmentBillingAdjustment({
    previousAmountMinor: invoice.totalAmountMinor,
    amendedAmountMinor,
    previousAdvanceAppliedMinor: invoice.advanceAppliedMinor,
    previousCreditOutstandingMinor: invoice.creditOutstandingMinor,
    availableAdvanceMinor: balances.availableAdvanceMinor,
    availableCreditMinor: creditIsUsable ? balances.availableCreditMinor : 0,
    insufficientMessage: input.purpose === "FINAL_VERIFICATION"
      ? "Available Customer Advance and credit are not sufficient for the final verified charge. Contact the assigned branch."
      : undefined
  });

  const blockedStatuses = ["ON_HOLD", "SUSPENDED", "EXPIRED", "REJECTED", "CLOSED"];
  if (adjustment.deltaAmountMinor > 0 && blockedStatuses.includes(account.status)) {
    throw new AmendmentBillingError(
      409,
      input.purpose === "FINAL_VERIFICATION"
        ? "This credit account cannot fund the final verified charge. Contact the assigned branch."
        : "This credit account cannot fund an amendment. Contact your assigned branch."
    );
  }
  const originalStatementId = invoice.billingStatementId as mongoose.Types.ObjectId | null | undefined;
  const isPreviouslyBilled = Boolean(originalStatementId);
  if (!isPreviouslyBilled && adjustment.creditReducedMinor > account.unbilledCreditMinor) {
    throw new AmendmentBillingError(409, "The existing unbilled credit allocation is inconsistent.");
  }
  if (isPreviouslyBilled && adjustment.creditReducedMinor > account.invoicedOutstandingMinor) {
    throw new AmendmentBillingError(409, "The existing invoiced credit allocation is inconsistent.");
  }
  if (adjustment.deltaAmountMinor === 0) {
    charge.pricingSnapshot = input.pricing as unknown as Record<string, unknown>;
    await charge.save({ session: input.session });
    return adjustment;
  }

  const updatedAccount = await BusinessCreditAccount.findOneAndUpdate(
    {
      _id: account._id,
      version: account.version,
      customerAdvanceBalanceMinor: { $gte: adjustment.advanceUsedMinor },
      ...(isPreviouslyBilled
        ? { invoicedOutstandingMinor: { $gte: adjustment.creditReducedMinor } }
        : { unbilledCreditMinor: { $gte: adjustment.creditReducedMinor } })
    },
    {
      $inc: {
        // advanceCreditedMinor is value the customer had already paid, so it
        // comes back as fresh Customer Advance rather than being unwound from
        // the statement it was settled against.
        customerAdvanceBalanceMinor: adjustment.advanceRefundedMinor
          + adjustment.advanceCreditedMinor
          - adjustment.advanceUsedMinor,
        unbilledCreditMinor: adjustment.creditUsedMinor - (isPreviouslyBilled ? 0 : adjustment.creditReducedMinor),
        invoicedOutstandingMinor: isPreviouslyBilled ? -adjustment.creditReducedMinor : 0,
        version: 1
      }
    },
    { returnDocument: "after", runValidators: true, session: input.session }
  ).exec();
  if (!updatedAccount) throw new AmendmentBillingError(409, "Account balances changed while applying the shipment charge. Try again.");

  charge.customerChargeMinor = amendedAmountMinor;
  charge.pricingSnapshot = input.pricing as unknown as Record<string, unknown>;
  await charge.save({ session: input.session });

  if (isPreviouslyBilled && adjustment.creditReducedMinor > 0) {
    const originalStatement = await CreditBillingStatement.findOne({
      _id: originalStatementId,
      businessAccountId: input.businessAccountId,
      outstandingAmountMinor: { $gte: adjustment.creditReducedMinor }
    }).session(input.session).exec();
    if (!originalStatement) {
      throw new AmendmentBillingError(409, "The original billing statement cannot accept this amendment adjustment.");
    }
    originalStatement.creditAdjustmentMinor += adjustment.creditReducedMinor;
    originalStatement.outstandingAmountMinor -= adjustment.creditReducedMinor;
    originalStatement.status = originalStatement.outstandingAmountMinor === 0 ? "PAID" : "PARTIALLY_PAID";
    await originalStatement.save({ session: input.session });
  }

  const statementAdjustmentMinor = adjustment.creditUsedMinor - adjustment.creditReducedMinor;
  if (isPreviouslyBilled && statementAdjustmentMinor !== 0) {
    await CreditBillingAdjustment.create([{
      businessAccountId: input.businessAccountId,
      creditAccountId: updatedAccount._id,
      shipmentInvoiceId: invoice._id,
      originalStatementId: originalStatementId as mongoose.Types.ObjectId,
      sourceType: input.purpose,
      sourceId: input.referenceId,
      amountMinor: statementAdjustmentMinor,
      affectsAmountDue: statementAdjustmentMinor > 0,
      description: statementAdjustmentMinor > 0
        ? "Additional credit charge from an approved shipment update."
        : "Credit reduction from an approved shipment update; already applied to the original outstanding balance.",
      status: "PENDING",
      createdBy: input.createdBy
    }], { session: input.session });
  }

  if (adjustment.deltaAmountMinor !== 0) {
    const updatedBalances = getCreditBalances(updatedAccount);
    const isFinalVerification = input.purpose === "FINAL_VERIFICATION";
    await CreditLedgerEntry.create([{
      businessAccountId: input.businessAccountId,
      creditAccountId: updatedAccount._id,
      type: isFinalVerification
        ? adjustment.deltaAmountMinor > 0 ? "FINAL_CHARGE_INCREASE_APPLIED" : "FINAL_CHARGE_REDUCTION_APPLIED"
        : adjustment.deltaAmountMinor > 0 ? "AMENDMENT_INCREASE_APPLIED" : "AMENDMENT_REDUCTION_APPLIED",
      reference: `${isFinalVerification ? "FINAL-CHARGE" : "AMENDMENT"}-${input.referenceId.toString()}`,
      description: isFinalVerification
        ? adjustment.deltaAmountMinor > 0
          ? "Final verified shipment charge applied."
          : "Final verified shipment charge reduced."
        : adjustment.deltaAmountMinor > 0
          ? "Approved shipment amendment charge applied."
          : "Approved shipment amendment charge reduced.",
      amountMinor: Math.abs(adjustment.deltaAmountMinor),
      currency: updatedAccount.currency,
      availableCreditAfterMinor: updatedBalances.availableCreditMinor,
      availableAdvanceAfterMinor: updatedBalances.availableAdvanceMinor,
      idempotencyKey: `${isFinalVerification ? "FINAL_CHARGE" : "AMENDMENT_BILLING"}:${input.referenceId.toString()}`,
      createdBy: input.createdBy,
      metadata: adjustment
    }], { session: input.session });
  }

  return adjustment;
}

export function applyApprovedAmendmentBilling(input: {
  amendmentId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  pricing: ShipmentPricingEstimate;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  return applyShipmentBillingAdjustment({
    ...input,
    referenceId: input.amendmentId,
    purpose: "AMENDMENT"
  });
}

export function applyFinalChargeVerificationBilling(input: {
  verificationId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  pricing: ShipmentPricingEstimate;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  return applyShipmentBillingAdjustment({
    ...input,
    referenceId: input.verificationId,
    purpose: "FINAL_VERIFICATION"
  });
}
