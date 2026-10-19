import crypto from "node:crypto";
import mongoose from "mongoose";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import type { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { getCreditBalances } from "./creditAccount.service.js";
import { allocateBookingAmount } from "./creditBooking.service.js";
import { getCreditRestrictionState } from "./creditOverdue.service.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  type ShipmentPricingEstimate,
  type ShipmentPricingInput
} from "./shipmentPricing.service.js";

/**
 * How long a quoted price is honoured for.
 *
 * Matches the booking reservation TTL in `shipmentBookingBilling.service.ts`, so a
 * customer who books within the window they were shown a price in never meets a
 * reservation that has already expired.
 */
export const PRICE_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * How the shipment will be paid for.
 *
 * BUSINESS_ACCOUNT draws on the Customer Advance balance first and the approved
 * credit facility for the rest. COUNTER is a walk-in customer who pays before the
 * shipment is booked, so there is no balance to preview.
 */
export type ShipmentFundingMode = "BUSINESS_ACCOUNT" | "COUNTER";

export type ShipmentFundingPreview = {
  mode: ShipmentFundingMode;
  /** What the shipment costs in total- the figure the customer is committing to. */
  totalPayableMinor: number;
  /** Taken from the Customer Advance balance at booking. */
  advanceDeductionMinor: number;
  /** Charged to the approved credit facility, due on the next statement. */
  creditUsageMinor: number;
  availableAdvanceMinor: number;
  availableCreditMinor: number;
  /** False when the account cannot cover the total; `message` says why. */
  canFund: boolean;
  message: string;
};

export type ShipmentCostEstimate = {
  pricing: ShipmentPricingEstimate;
  funding: ShipmentFundingPreview;
  /**
   * Fingerprint of everything the price was calculated from. The booking call
   * sends it back, and a mismatch means rates or route charges moved while the
   * customer was filling the form- see `assertPriceLockUnchanged`.
   */
  pricingHash: string;
  /** When the quoted price stops being honoured and must be recalculated. */
  expiresAt: Date;
};

/**
 * Builds the fingerprint a price lock is checked against.
 *
 * Covers the priced amounts and the configuration they came from. Including the
 * configuration identifiers as well as the amounts means an edit that happens to
 * leave the total unchanged still invalidates the lock, so a booking is never
 * quietly priced against configuration the customer was not shown.
 */
export function buildPricingHash(pricing: ShipmentPricingEstimate): string {
  const fingerprint = {
    lines: pricing.lines.map((line) => [line.code, line.amountMinor]),
    totalMinor: Math.round(pricing.totalAmount * 100),
    baseMinor: Math.round(pricing.baseAmount * 100),
    gstRate: pricing.gstRate,
    taxTreatment: pricing.taxTreatment ?? (pricing.gstRate === 0 ? "NO_GST" : "GST_APPLICABLE"),
    noGstEligible: Boolean(pricing.noGstEligible),
    gstForced: Boolean(pricing.gstForced),
    gstBillingVersion: pricing.gstBillingVersion ?? 1,
    csbType: pricing.csbType,
    insuranceApplied: pricing.insuranceApplied,
    remoteAreaApplied: pricing.remoteAreaApplied,
    rateCardBand: pricing.pricingBasis.rateCardBand ?? "BAND_A",
    // Preserve the legacy/public fingerprint exactly; only private cards add
    // ownership and revision, so existing paid public quotes remain valid.
    ...(pricing.pricingBasis.businessAccountId ? {
      businessAccountId: pricing.pricingBasis.businessAccountId,
      privateRateCardVersion: pricing.pricingBasis.privateRateCardVersion
    } : {}),
    rateCardIds: [...pricing.pricingBasis.rateCardIds].sort(),
    routeChargesUpdatedAt: pricing.pricingBasis.routeChargesUpdatedAt?.toISOString() ?? null,
    gstBillingEffectiveFrom: pricing.pricingBasis.gstBillingEffectiveFrom?.toISOString() ?? null
  };

  return crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

function toMinor(amount: number) {
  return Math.round(amount * 100);
}

/**
 * Splits the total across the Customer Advance balance and the credit facility,
 * exactly as `reserveBookingCapacity` will at booking, but without reserving
 * anything.
 *
 * A preview must never take capacity: a customer looking at a price has not
 * committed to it, and holding funds for every page view would starve real
 * bookings. The trade-off is that a preview can go stale, which the price lock
 * and the reservation itself both catch.
 */
async function previewBusinessAccountFunding(input: {
  businessAccountId: mongoose.Types.ObjectId;
  totalMinor: number;
  session?: mongoose.ClientSession;
}): Promise<ShipmentFundingPreview> {
  const empty = {
    mode: "BUSINESS_ACCOUNT" as const,
    totalPayableMinor: input.totalMinor,
    advanceDeductionMinor: 0,
    creditUsageMinor: 0,
    availableAdvanceMinor: 0,
    availableCreditMinor: 0
  };

  const query = BusinessCreditAccount.findOne({ businessAccountId: input.businessAccountId });
  if (input.session) query.session(input.session);
  const account = await query.exec();

  if (!account) {
    return {
      ...empty,
      canFund: false,
      message: "This business account has no credit account yet. Add a Customer Advance or request a credit limit to book."
    };
  }

  const balances = getCreditBalances(account);
  const restriction = await getCreditRestrictionState({
    businessAccountId: input.businessAccountId,
    gracePeriodDays: account.gracePeriodDays,
    maxOverdueDays: account.maxOverdueDays,
    session: input.session
  });

  // Overdue statements can block credit, or bookings altogether. Mirrored from
  // reserveBookingCapacity so the estimate refuses for the same reasons booking
  // would, rather than quoting a price that cannot be paid.
  if (restriction.level === "ALL_BOOKINGS_BLOCKED") {
    return {
      ...empty,
      availableAdvanceMinor: balances.availableAdvanceMinor,
      canFund: false,
      message: "Bookings are on hold because of an overdue statement. Clear the outstanding balance to continue."
    };
  }

  const creditBlocked = restriction.level === "CREDIT_BLOCKED";
  const availableCreditMinor = creditBlocked ? 0 : balances.availableCreditMinor;
  const availableAdvanceMinor = balances.availableAdvanceMinor;

  try {
    const allocation = allocateBookingAmount(input.totalMinor, availableAdvanceMinor, availableCreditMinor);
    return {
      mode: "BUSINESS_ACCOUNT",
      totalPayableMinor: input.totalMinor,
      advanceDeductionMinor: allocation.advanceAmountMinor,
      creditUsageMinor: allocation.creditAmountMinor,
      availableAdvanceMinor,
      availableCreditMinor,
      canFund: true,
      message: allocation.creditAmountMinor > 0
        ? "Customer Advance is used first; the balance is charged to your credit facility and appears on your next statement."
        : "This booking is covered by your Customer Advance balance."
    };
  } catch {
    // allocateBookingAmount throws when the amount cannot be covered, or when the
    // total is not a positive integer number of paise.
    return {
      ...empty,
      availableAdvanceMinor,
      availableCreditMinor,
      canFund: false,
      message: creditBlocked
        ? "Credit is on hold because of an overdue statement, and the Customer Advance balance does not cover this shipment."
        : "Available Customer Advance and credit do not cover this shipment. Add an advance or contact your assigned branch."
    };
  }
}

/**
 * Prices a draft and previews how it would be paid for, with a lock the booking
 * call validates.
 *
 * This is the single source of the figures shown before booking. The booking path
 * prices the same draft through the same engine, so the estimate a customer
 * accepts and the amount they are charged can only differ if the underlying
 * configuration changed- which is precisely what `pricingHash` detects.
 */
export async function buildShipmentCostEstimate(input: {
  draft: InstanceType<typeof ShipmentDraft>;
  /**
   * In-progress form values to price instead of what is stored.
   *
   * The booking form prices as the customer types, before they save, so the panel
   * is never showing a total for a shipment they have already changed. Nothing is
   * persisted here- the draft still has to be saved before it can be booked, and
   * the price lock is what ties the accepted figure to the saved state.
   */
  overrides?: Partial<ShipmentPricingInput>;
  session?: mongoose.ClientSession;
}): Promise<ShipmentCostEstimate> {
  const pricing = await calculateShipmentPricingEstimate({
    ...buildPricingInputFromDraft(input.draft),
    ...input.overrides,
    session: input.session
  });
  const totalMinor = toMinor(pricing.totalAmount);

  // A walk-in customer settles at the counter, so there is no stored balance to
  // draw the shipment against and nothing to preview.
  const funding: ShipmentFundingPreview = input.draft.customerType === "INDIVIDUAL"
    ? {
      mode: "COUNTER",
      totalPayableMinor: totalMinor,
      advanceDeductionMinor: 0,
      creditUsageMinor: 0,
      availableAdvanceMinor: 0,
      availableCreditMinor: 0,
      canFund: true,
      message: "Collect this amount from the customer before booking."
    }
    : await previewBusinessAccountFunding({
      businessAccountId: input.draft.businessAccountId,
      totalMinor,
      session: input.session
    });

  return {
    pricing,
    funding,
    pricingHash: buildPricingHash(pricing),
    expiresAt: new Date(Date.now() + PRICE_LOCK_TTL_MS)
  };
}

export class ShipmentPriceChangedError extends Error {
  public readonly statusCode = 409;
  public readonly code = "PRICE_CHANGED";

  constructor(
    public readonly acceptedHash: string,
    public readonly currentPricing: ShipmentPricingEstimate
  ) {
    super("The price for this shipment changed while you were booking it. Review the updated charges before continuing.");
    this.name = "ShipmentPriceChangedError";
  }
}

/**
 * Rejects a booking whose accepted price no longer matches what the shipment
 * prices at now.
 *
 * Counter-sales and test/seed paths can omit a hash because they do not use the
 * customer-facing estimator. Business-account bookings must provide one so a
 * rate-card reassignment cannot be silently accepted while a booking is open.
 */
export function assertPriceLockUnchanged(input: {
  acceptedPricingHash?: string | null;
  currentPricing: ShipmentPricingEstimate;
  requireAcceptedPricing?: boolean;
}) {
  const accepted = input.acceptedPricingHash?.trim();
  if (!accepted) {
    if (input.requireAcceptedPricing) {
      throw new ShipmentPriceChangedError("", input.currentPricing);
    }
    return;
  }

  if (accepted !== buildPricingHash(input.currentPricing)) {
    throw new ShipmentPriceChangedError(accepted, input.currentPricing);
  }
}
