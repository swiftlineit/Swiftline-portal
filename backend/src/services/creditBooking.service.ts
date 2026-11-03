import mongoose from "mongoose";
import { BalanceReservation, type BalanceReservationStatus } from "../models/balanceReservation.model.js";
import { BusinessCreditAccount, type IBusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditLedgerEntry, type CreditLedgerEntryType } from "../models/creditLedgerEntry.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { getCreditBalances } from "./creditAccount.service.js";
import { getCreditRestrictionState } from "./creditOverdue.service.js";

type ReserveBookingCapacityInput = {
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  amountMinor: number;
  idempotencyKey: string;
  expiresAt: Date;
  createdBy: mongoose.Types.ObjectId;
  parcelCount: number;
  pricingSnapshot: Record<string, unknown>;
};

type ReservationTransitionInput = {
  reservationId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  createdBy: mongoose.Types.ObjectId;
  dpdShipmentId?: mongoose.Types.ObjectId;
};

export function allocateBookingAmount(amountMinor: number, availableAdvanceMinor: number, availableCreditMinor: number) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("BOOKING_AMOUNT_INVALID");
  }

  const advanceAmountMinor = Math.min(amountMinor, Math.max(availableAdvanceMinor, 0));
  const creditAmountMinor = amountMinor - advanceAmountMinor;
  if (creditAmountMinor > Math.max(availableCreditMinor, 0)) {
    throw new Error("INSUFFICIENT_BOOKING_CAPACITY");
  }

  return { advanceAmountMinor, creditAmountMinor };
}

function isTransientTransactionError(error: unknown) {
  const labels = (error as { errorLabels?: unknown })?.errorLabels;
  return Array.isArray(labels) && labels.includes("TransientTransactionError");
}

async function runTransactionWithRetry<T>(operation: (session: mongoose.ClientSession) => Promise<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await operation(session);
      });
      return result as T;
    } catch (error) {
      lastError = error;
      if (!isTransientTransactionError(error) || attempt === attempts - 1) throw error;
    } finally {
      await session.endSession();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Booking balance transaction failed.");
}

/**
 * Whether this reservation has ever appeared on the customer's ledger.
 *
 * Reserving is silent, so most reservations never do. It is what decides whether
 * a later release has anything to close out.
 */
async function hasBookingLedgerEntry(
  reservationId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
) {
  const existing = await CreditLedgerEntry.findOne({ reference: `BOOKING-${reservationId.toString()}` })
    .select("_id")
    .session(session)
    .exec();
  return Boolean(existing);
}

async function appendBookingLedgerEntry(input: {
  account: IBusinessCreditAccount;
  type: CreditLedgerEntryType;
  reservationId: mongoose.Types.ObjectId;
  amountMinor: number;
  advanceAmountMinor: number;
  creditAmountMinor: number;
  idempotencyKey: string;
  description: string;
  createdBy: mongoose.Types.ObjectId | null;
  session: mongoose.ClientSession;
}) {
  const balances = getCreditBalances(input.account);
  await CreditLedgerEntry.create([{
    businessAccountId: input.account.businessAccountId,
    creditAccountId: input.account._id,
    type: input.type,
    reference: `BOOKING-${input.reservationId.toString()}`,
    description: input.description,
    amountMinor: input.amountMinor,
    currency: input.account.currency,
    availableCreditAfterMinor: balances.availableCreditMinor,
    availableAdvanceAfterMinor: balances.availableAdvanceMinor,
    idempotencyKey: input.idempotencyKey,
    createdBy: input.createdBy,
    metadata: {
      reservationId: input.reservationId,
      advanceAmountMinor: input.advanceAmountMinor,
      creditAmountMinor: input.creditAmountMinor
    }
  }], { session: input.session });
}

function availableAdvanceExpression() {
  return { $max: [{ $subtract: ["$customerAdvanceBalanceMinor", "$reservedAdvanceMinor"] }, 0] };
}

function availableCreditExpression(now: Date, allowCredit = true) {
  if (!allowCredit) return 0;
  return {
    $cond: [
      {
        $and: [
          { $eq: ["$status", "ACTIVE"] },
          {
            $or: [
              { $eq: ["$validFrom", null] },
              { $lte: ["$validFrom", now] }
            ]
          },
          {
            $or: [
              { $eq: ["$validUntil", null] },
              { $gt: ["$validUntil", now] }
            ]
          }
        ]
      },
      {
        $max: [{
          $subtract: [
            "$approvedCreditLimitMinor",
            { $add: ["$reservedCreditMinor", "$unbilledCreditMinor", "$invoicedOutstandingMinor"] }
          ]
        }, 0]
      },
      0
    ]
  };
}

export async function reserveBookingCapacity(input: ReserveBookingCapacityInput) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("BOOKING_AMOUNT_INVALID");

  const existing = await BalanceReservation.findOne({ idempotencyKey: input.idempotencyKey }).exec();
  if (existing) {
    if (existing.amountMinor !== input.amountMinor) throw new Error("BOOKING_RESERVATION_AMOUNT_MISMATCH");
    const charge = await ShipmentCharge.findOne({ shipmentDraftId: input.shipmentDraftId }).exec();
    return { reserved: false as const, reservation: existing, charge };
  }

  const policyAccount = await BusinessCreditAccount.findOne({ businessAccountId: input.businessAccountId }).exec();
  if (!policyAccount) throw new Error("INSUFFICIENT_BOOKING_CAPACITY");
  const restriction = await getCreditRestrictionState({
    businessAccountId: input.businessAccountId,
    gracePeriodDays: policyAccount.gracePeriodDays,
    maxOverdueDays: policyAccount.maxOverdueDays
  });
  if (restriction.level === "ALL_BOOKINGS_BLOCKED") throw new Error("OVERDUE_BOOKING_BLOCKED");
  if (
    restriction.level === "CREDIT_BLOCKED"
    && getCreditBalances(policyAccount).availableAdvanceMinor < input.amountMinor
  ) {
    throw new Error("OVERDUE_CREDIT_USAGE_BLOCKED");
  }
  const allowCredit = restriction.level !== "CREDIT_BLOCKED";

  return runTransactionWithRetry(async (session) => {
    const concurrentReservation = await BalanceReservation.findOne({ idempotencyKey: input.idempotencyKey }).session(session).exec();
    if (concurrentReservation) {
      const concurrentCharge = await ShipmentCharge.findOne({ shipmentDraftId: input.shipmentDraftId }).session(session).exec();
      return { reserved: false as const, reservation: concurrentReservation, charge: concurrentCharge };
    }

    const advanceAvailable = availableAdvanceExpression();
    const creditAvailable = availableCreditExpression(new Date(), allowCredit);
    const accountBefore = await BusinessCreditAccount.findOneAndUpdate(
      {
        businessAccountId: input.businessAccountId,
        currency: "INR",
        status: { $nin: ["ON_HOLD", "SUSPENDED", "EXPIRED", "REJECTED", "CLOSED"] },
        $expr: { $gte: [{ $add: [advanceAvailable, creditAvailable] }, input.amountMinor] }
      },
      [{
        $set: {
          reservedAdvanceMinor: {
            $add: ["$reservedAdvanceMinor", { $min: [input.amountMinor, advanceAvailable] }]
          },
          reservedCreditMinor: {
            $add: ["$reservedCreditMinor", { $max: [{ $subtract: [input.amountMinor, advanceAvailable] }, 0] }]
          },
          version: { $add: ["$version", 1] }
        }
      }],
      // This Mongoose version requires updatePipeline to accept the pipeline-array update.
      { returnDocument: "before", session, updatePipeline: true }
    ).exec();

    if (!accountBefore) throw new Error("INSUFFICIENT_BOOKING_CAPACITY");
    const beforeBalances = getCreditBalances(accountBefore);
    const allocation = allocateBookingAmount(
      input.amountMinor,
      beforeBalances.availableAdvanceMinor,
      beforeBalances.availableCreditMinor
    );

    const [reservation] = await BalanceReservation.create([{
      businessAccountId: input.businessAccountId,
      branchId: input.branchId,
      shipmentDraftId: input.shipmentDraftId,
      amountMinor: input.amountMinor,
      ...allocation,
      currency: "INR",
      status: "ACTIVE",
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt
    }], { session });
    if (!reservation) throw new Error("BOOKING_RESERVATION_NOT_CREATED");

    const existingCharge = await ShipmentCharge.findOne({ shipmentDraftId: input.shipmentDraftId }).session(session).exec();
    const charge = existingCharge
      ? await ShipmentCharge.findOneAndUpdate(
        { _id: existingCharge._id, customerChargeStatus: "REVERSED" },
        {
          $set: {
            balanceReservationId: reservation._id,
            dpdShipmentId: null,
            parcelCount: input.parcelCount,
            paymentSource: "BUSINESS_ACCOUNT",
            customerChargeMinor: input.amountMinor,
            customerCurrency: "INR",
            customerChargeStatus: "RESERVED",
            pricingSnapshot: input.pricingSnapshot
          }
        },
        { returnDocument: "after", session, runValidators: true }
      ).exec()
      : (await ShipmentCharge.create([{
        businessAccountId: input.businessAccountId,
        branchId: input.branchId,
        shipmentDraftId: input.shipmentDraftId,
        balanceReservationId: reservation._id,
        parcelCount: input.parcelCount,
        paymentSource: "BUSINESS_ACCOUNT",
        customerChargeMinor: input.amountMinor,
        customerCurrency: "INR",
        customerChargeStatus: "RESERVED",
        pricingSnapshot: input.pricingSnapshot
      }], { session }))[0];
    if (!charge) throw new Error("SHIPMENT_CHARGE_NOT_CREATED");

    // Deliberately no ledger entry here. A reservation is a hold, not a movement
    // of money, and most failed bookings never become one: writing it at this
    // point filled the customer's ledger with reserved/released pairs for
    // shipments that were rejected by the carrier and never existed. The hold is
    // still real- it sits on the account's reserved totals and on the
    // BalanceReservation- so concurrent bookings cannot overdraw the limit.
    // The ledger records the booking when the reservation converts.
    return { reserved: true as const, reservation, charge };
  });
}

async function findTransitionReservation(
  input: ReservationTransitionInput,
  from: BalanceReservationStatus[],
  to: BalanceReservationStatus,
  timestampField: "convertedAt" | "releasedAt" | "reviewRequiredAt",
  session: mongoose.ClientSession
) {
  return BalanceReservation.findOneAndUpdate(
    { _id: input.reservationId, status: { $in: from } },
    { $set: { status: to, [timestampField]: new Date() } },
    { returnDocument: "after", runValidators: true, session }
  ).exec();
}

export async function markBookingReservationConsuming(reservationId: mongoose.Types.ObjectId) {
  return BalanceReservation.findOneAndUpdate(
    { _id: reservationId, status: "ACTIVE" },
    { $set: { status: "CONSUMING", consumingAt: new Date() } },
    { returnDocument: "after", runValidators: true }
  ).exec();
}

export async function convertBookingReservation(input: ReservationTransitionInput) {
  const existingLedger = await CreditLedgerEntry.findOne({ idempotencyKey: input.idempotencyKey }).exec();
  if (existingLedger) return { converted: false as const, ledgerEntry: existingLedger };

  return runTransactionWithRetry(async (session) => {
    const reservation = await findTransitionReservation(input, ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"], "CONVERTED", "convertedAt", session);
    if (!reservation) {
      // A concurrent call may have already converted it; treat that as idempotent
      // success rather than a transition error.
      const priorLedger = await CreditLedgerEntry.findOne({ idempotencyKey: input.idempotencyKey }).session(session).exec();
      if (priorLedger) return { converted: false as const, ledgerEntry: priorLedger };
      throw new Error("BOOKING_RESERVATION_TRANSITION_INVALID");
    }

    const account = await BusinessCreditAccount.findOneAndUpdate(
      {
        businessAccountId: reservation.businessAccountId,
        reservedAdvanceMinor: { $gte: reservation.advanceAmountMinor },
        reservedCreditMinor: { $gte: reservation.creditAmountMinor },
        customerAdvanceBalanceMinor: { $gte: reservation.advanceAmountMinor }
      },
      {
        $inc: {
          customerAdvanceBalanceMinor: -reservation.advanceAmountMinor,
          reservedAdvanceMinor: -reservation.advanceAmountMinor,
          reservedCreditMinor: -reservation.creditAmountMinor,
          unbilledCreditMinor: reservation.creditAmountMinor,
          version: 1
        }
      },
      { returnDocument: "after", runValidators: true, session }
    ).exec();
    if (!account) throw new Error("BOOKING_RESERVATION_CONVERSION_FAILED");

    await appendBookingLedgerEntry({
      account,
      type: "BOOKING_CONVERTED",
      reservationId: reservation._id as mongoose.Types.ObjectId,
      amountMinor: reservation.amountMinor,
      advanceAmountMinor: reservation.advanceAmountMinor,
      creditAmountMinor: reservation.creditAmountMinor,
      idempotencyKey: input.idempotencyKey,
      description: "Shipment booking amount converted to an unbilled charge.",
      createdBy: input.createdBy,
      session
    });
    await ShipmentCharge.updateOne(
      { balanceReservationId: reservation._id, customerChargeStatus: { $in: ["RESERVED", "REVIEW_REQUIRED"] } },
      { $set: { customerChargeStatus: "COMPLETED", dpdShipmentId: input.dpdShipmentId ?? null } },
      { runValidators: true, session }
    ).exec();
    return { converted: true as const, reservation };
  });
}

export async function releaseBookingReservation(input: ReservationTransitionInput) {
  return runTransactionWithRetry(async (session) => {
    const reservation = await findTransitionReservation(input, ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"], "RELEASED", "releasedAt", session);
    if (!reservation) {
      // A concurrent call may have already released it; treat that as idempotent
      // success rather than a transition error. The reservation's own status is
      // the guard, because a release no longer always writes a ledger entry.
      const settled = await BalanceReservation.findOne({
        _id: input.reservationId,
        status: { $in: ["RELEASED", "EXPIRED"] }
      }).session(session).exec();
      if (settled) return { released: false as const, reservation: settled };
      throw new Error("BOOKING_RESERVATION_TRANSITION_INVALID");
    }

    const account = await BusinessCreditAccount.findOneAndUpdate(
      {
        businessAccountId: reservation.businessAccountId,
        reservedAdvanceMinor: { $gte: reservation.advanceAmountMinor },
        reservedCreditMinor: { $gte: reservation.creditAmountMinor }
      },
      {
        $inc: {
          reservedAdvanceMinor: -reservation.advanceAmountMinor,
          reservedCreditMinor: -reservation.creditAmountMinor,
          version: 1
        }
      },
      { returnDocument: "after", runValidators: true, session }
    ).exec();
    if (!account) throw new Error("BOOKING_RESERVATION_RELEASE_FAILED");

    // Only closes out a hold the ledger was already told about- which means a
    // booking that went to operations review. A reservation released without
    // ever being announced leaves no trace, because nothing about it ever
    // reached the customer's statement.
    if (await hasBookingLedgerEntry(reservation._id as mongoose.Types.ObjectId, session)) {
      await appendBookingLedgerEntry({
        account,
        type: "BOOKING_RELEASED",
        reservationId: reservation._id as mongoose.Types.ObjectId,
        amountMinor: reservation.amountMinor,
        advanceAmountMinor: reservation.advanceAmountMinor,
        creditAmountMinor: reservation.creditAmountMinor,
        idempotencyKey: input.idempotencyKey,
        description: "Shipment booking amount released.",
        createdBy: input.createdBy,
        session
      });
    }
    await ShipmentCharge.updateOne(
      { balanceReservationId: reservation._id },
      { $set: { customerChargeStatus: "REVERSED", dpdShipmentId: input.dpdShipmentId ?? null } },
      { runValidators: true, session }
    ).exec();
    return { released: true as const, reservation };
  });
}

// Release a single reservation that has passed its TTL without progressing to a
// booking attempt. Only ACTIVE reservations are eligible- a CONSUMING one is a
// live booking in flight and must never be swept.
export async function expireStaleReservation(reservationId: mongoose.Types.ObjectId) {
  const idempotencyKey = `BOOKING:EXPIRE:${reservationId.toString()}`;
  const existingLedger = await CreditLedgerEntry.findOne({ idempotencyKey }).exec();
  if (existingLedger) return { expired: false as const };

  return runTransactionWithRetry(async (session) => {
    const reservation = await BalanceReservation.findOneAndUpdate(
      { _id: reservationId, status: "ACTIVE", expiresAt: { $lt: new Date() } },
      { $set: { status: "EXPIRED", releasedAt: new Date() } },
      { returnDocument: "after", runValidators: true, session }
    ).exec();
    if (!reservation) return { expired: false as const };

    const account = await BusinessCreditAccount.findOneAndUpdate(
      {
        businessAccountId: reservation.businessAccountId,
        reservedAdvanceMinor: { $gte: reservation.advanceAmountMinor },
        reservedCreditMinor: { $gte: reservation.creditAmountMinor }
      },
      {
        $inc: {
          reservedAdvanceMinor: -reservation.advanceAmountMinor,
          reservedCreditMinor: -reservation.creditAmountMinor,
          version: 1
        }
      },
      { returnDocument: "after", runValidators: true, session }
    ).exec();
    if (!account) throw new Error("BOOKING_RESERVATION_RELEASE_FAILED");

    // As with an explicit release: only a hold the ledger already knows about
    // needs closing out. The atomic ACTIVE -> EXPIRED flip above is what makes
    // this run once, so it does not depend on the ledger for idempotency.
    if (await hasBookingLedgerEntry(reservation._id as mongoose.Types.ObjectId, session)) {
      await appendBookingLedgerEntry({
        account,
        type: "BOOKING_RELEASED",
        reservationId: reservation._id as mongoose.Types.ObjectId,
        amountMinor: reservation.amountMinor,
        advanceAmountMinor: reservation.advanceAmountMinor,
        creditAmountMinor: reservation.creditAmountMinor,
        idempotencyKey,
        description: "Expired shipment booking reservation released.",
        createdBy: null,
        session
      });
    }
    await ShipmentCharge.updateOne(
      { balanceReservationId: reservation._id, customerChargeStatus: "RESERVED" },
      { $set: { customerChargeStatus: "REVERSED" } },
      { runValidators: true, session }
    ).exec();

    return { expired: true as const };
  });
}

// Sweep all reservations that have passed their TTL. Safe to run repeatedly.
export async function expireStaleReservations(input: { now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date();
  const stale = await BalanceReservation.find({ status: "ACTIVE", expiresAt: { $lt: now } })
    .limit(input.limit ?? 500)
    .select("_id")
    .lean()
    .exec();

  let released = 0;
  let failed = 0;
  for (const reservation of stale) {
    try {
      const result = await expireStaleReservation(reservation._id as mongoose.Types.ObjectId);
      if (result.expired) released += 1;
    } catch (error) {
      failed += 1;
      console.error("Failed to expire booking reservation", String(reservation._id), error);
    }
  }

  return { scanned: stale.length, released, failed };
}

export async function markBookingReservationReviewRequired(input: ReservationTransitionInput) {
  return runTransactionWithRetry(async (session) => {
    const existing = await BalanceReservation.findById(input.reservationId).session(session).exec();
    if (existing?.status === "REVIEW_REQUIRED") return existing;

    const reservation = await findTransitionReservation(input, ["CONSUMING"], "REVIEW_REQUIRED", "reviewRequiredAt", session);
    if (!reservation) throw new Error("BOOKING_RESERVATION_TRANSITION_INVALID");
    const account = await BusinessCreditAccount.findOne({ businessAccountId: reservation.businessAccountId }).session(session).exec();
    if (!account) throw new Error("CREDIT_ACCOUNT_NOT_FOUND");

    await appendBookingLedgerEntry({
      account,
      type: "BOOKING_REVIEW_REQUIRED",
      reservationId: reservation._id as mongoose.Types.ObjectId,
      amountMinor: reservation.amountMinor,
      advanceAmountMinor: reservation.advanceAmountMinor,
      creditAmountMinor: reservation.creditAmountMinor,
      idempotencyKey: input.idempotencyKey,
      description: "Shipment booking outcome requires operations review; funds remain reserved.",
      createdBy: input.createdBy,
      session
    });
    await ShipmentCharge.updateOne(
      { balanceReservationId: reservation._id },
      { $set: { customerChargeStatus: "REVIEW_REQUIRED", dpdShipmentId: input.dpdShipmentId ?? null } },
      { runValidators: true, session }
    ).exec();
    return reservation;
  });
}
