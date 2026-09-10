import mongoose from "mongoose";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import type { ShipmentDraft } from "../models/shipmentDraft.model.js";
import {
  convertBookingReservation,
  markBookingReservationConsuming,
  markBookingReservationReviewRequired,
  releaseBookingReservation,
  reserveBookingCapacity
} from "./creditBooking.service.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  type ShipmentPricingEstimate
} from "./shipmentPricing.service.js";

const RESERVATION_TTL_MS = 15 * 60 * 1000;
type ShipmentDraftDocument = InstanceType<typeof ShipmentDraft>;

function bookingReservationKey(shipmentDraftId: mongoose.Types.ObjectId, bookingAttemptId: string) {
  return `SHIPMENT_BOOKING:${shipmentDraftId.toString()}:${bookingAttemptId}`;
}

function transitionKey(action: "CONVERT" | "RELEASE" | "REVIEW", reservationId: mongoose.Types.ObjectId) {
  return `SHIPMENT_BOOKING:${action}:${reservationId.toString()}`;
}

function toMinor(amount: number) {
  return Math.round(amount * 100);
}

export async function reserveShipmentBookingCharge(input: {
  draft: ShipmentDraftDocument;
  createdBy: mongoose.Types.ObjectId;
  bookingAttemptId: string;
  pricing?: ShipmentPricingEstimate;
}) {
  const existingCharge = await ShipmentCharge.findOne({ shipmentDraftId: input.draft._id }).exec();
  if (existingCharge?.customerChargeStatus === "COMPLETED") {
    return { charge: existingCharge, reservation: null, reserved: false as const };
  }

  const pricing = input.pricing
    ?? await calculateShipmentPricingEstimate(buildPricingInputFromDraft(input.draft));
  if (pricing.missingRate) throw new Error("BOOKING_RATE_NOT_FOUND");

  const amountMinor = toMinor(pricing.totalAmount);
  if (amountMinor <= 0) throw new Error("BOOKING_AMOUNT_INVALID");

  return reserveBookingCapacity({
    businessAccountId: input.draft.businessAccountId,
    branchId: input.draft.branchId,
    shipmentDraftId: input.draft._id as mongoose.Types.ObjectId,
    amountMinor,
    idempotencyKey: bookingReservationKey(input.draft._id as mongoose.Types.ObjectId, input.bookingAttemptId),
    expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
    createdBy: input.createdBy,
    parcelCount: Math.max(input.draft.parcelList.length || input.draft.parcelCount || 1, 1),
    pricingSnapshot: pricing
  });
}

/**
 * Records the charge for a walk-in shipment, which was paid into a company
 * account before the booking was made.
 *
 * There is no reservation to hold and nothing to convert later, so the charge is
 * written straight to COMPLETED with no `balanceReservationId`. It exists because
 * the rest of the shipment lifecycle reads it: the amendment flow rejects a
 * shipment that has no charge, and the cancellation flow inspects `paymentSource`
 * to decide whether credit needs unwinding. `ADMIN_DIRECT` tells both of them
 * that no credit is involved.
 *
 * Idempotent on `shipmentDraftId`, which is unique on the model, so a retried
 * booking updates the existing row rather than colliding.
 */
export async function recordCounterShipmentCharge(input: {
  draft: ShipmentDraftDocument;
  pricing: ShipmentPricingEstimate;
  session?: mongoose.ClientSession;
}) {
  const amountMinor = toMinor(input.pricing.totalAmount);
  if (amountMinor <= 0) throw new Error("BOOKING_AMOUNT_INVALID");

  return ShipmentCharge.findOneAndUpdate(
    { shipmentDraftId: input.draft._id },
    {
      businessAccountId: input.draft.businessAccountId,
      branchId: input.draft.branchId,
      shipmentDraftId: input.draft._id,
      balanceReservationId: null,
      parcelCount: Math.max(input.draft.parcelList.length || input.draft.parcelCount || 1, 1),
      paymentSource: "ADMIN_DIRECT",
      customerChargeMinor: amountMinor,
      customerCurrency: "INR",
      customerChargeStatus: "COMPLETED",
      pricingSnapshot: input.pricing
    },
    {
      returnDocument: "after",
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      session: input.session ?? null
    }
  ).exec();
}

/**
 * Records a Razorpay charge that was captured before shipment fulfilment.
 * Public money never enters the business credit ledger; this row only gives the
 * invoice, amendment and staff reconciliation flows the settled charge they
 * already expect for every booked shipment.
 */
export async function recordPublicShipmentCharge(input: {
  draft: ShipmentDraftDocument;
  pricing: ShipmentPricingEstimate;
  session?: mongoose.ClientSession;
}) {
  const amountMinor = toMinor(input.pricing.totalAmount);
  if (amountMinor <= 0) throw new Error("BOOKING_AMOUNT_INVALID");

  return ShipmentCharge.findOneAndUpdate(
    { shipmentDraftId: input.draft._id },
    {
      businessAccountId: input.draft.businessAccountId,
      branchId: input.draft.branchId,
      shipmentDraftId: input.draft._id,
      balanceReservationId: null,
      parcelCount: Math.max(input.draft.parcelList.length || input.draft.parcelCount || 1, 1),
      paymentSource: "PUBLIC_RAZORPAY",
      customerChargeMinor: amountMinor,
      customerCurrency: "INR",
      customerChargeStatus: "COMPLETED",
      pricingSnapshot: input.pricing,
    },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true, session: input.session ?? null },
  ).exec();
}

async function getReservedCharge(shipmentDraftId: mongoose.Types.ObjectId) {
  return ShipmentCharge.findOne({ shipmentDraftId }).exec();
}

export async function markShipmentBookingChargeConsuming(shipmentDraftId: mongoose.Types.ObjectId) {
  const charge = await getReservedCharge(shipmentDraftId);
  if (!charge?.balanceReservationId || charge.customerChargeStatus !== "RESERVED") return charge;
  await markBookingReservationConsuming(charge.balanceReservationId);
  return charge;
}

export async function completeShipmentBookingCharge(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
}) {
  const charge = await getReservedCharge(input.shipmentDraftId);
  if (!charge?.balanceReservationId) return null;
  if (charge.customerChargeStatus === "COMPLETED") return charge;

  await convertBookingReservation({
    reservationId: charge.balanceReservationId,
    idempotencyKey: transitionKey("CONVERT", charge.balanceReservationId),
    createdBy: input.createdBy,
    dpdShipmentId: input.dpdShipmentId
  });
  return getReservedCharge(input.shipmentDraftId);
}

export async function releaseShipmentBookingCharge(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
}) {
  const charge = await getReservedCharge(input.shipmentDraftId);
  if (!charge?.balanceReservationId) return null;
  if (charge.customerChargeStatus === "REVERSED") return charge;

  await releaseBookingReservation({
    reservationId: charge.balanceReservationId,
    idempotencyKey: transitionKey("RELEASE", charge.balanceReservationId),
    createdBy: input.createdBy,
    dpdShipmentId: input.dpdShipmentId
  });
  return getReservedCharge(input.shipmentDraftId);
}

export async function markShipmentBookingChargeReviewRequired(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
}) {
  const charge = await getReservedCharge(input.shipmentDraftId);
  if (!charge?.balanceReservationId) return null;

  await markBookingReservationReviewRequired({
    reservationId: charge.balanceReservationId,
    idempotencyKey: transitionKey("REVIEW", charge.balanceReservationId),
    createdBy: input.createdBy,
    dpdShipmentId: input.dpdShipmentId
  });
  return getReservedCharge(input.shipmentDraftId);
}
