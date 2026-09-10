import mongoose from "mongoose";
import {
  ShipmentEvent,
  type ShipmentEventSource,
} from "../models/shipmentEvent.model.js";

const SHIPMENT_BOOKED_STATUS = "SHIPMENT_BOOKED" as const;

export type EnsureShipmentBookedEventInput = {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  eventAt?: Date | null;
  source?: ShipmentEventSource;
  sourceReference?: string;
};

export function buildShipmentBookedEventUpdate(
  input: EnsureShipmentBookedEventInput,
) {
  return {
    $set: {
      dpdShipmentId: input.dpdShipmentId,
      customerVisible: true,
    },
    $setOnInsert: {
      shipmentDraftId: input.shipmentDraftId,
      status: SHIPMENT_BOOKED_STATUS,
      milestoneKey: SHIPMENT_BOOKED_STATUS,
      note: "Shipment booked with carrier.",
      source: input.source ?? "SYSTEM",
      sourceReference: input.sourceReference ?? "",
      customerVisible: true,
      createdBy: input.userId,
      eventAt: input.eventAt ?? new Date(),
    },
  };
}

/**
 * Persist the booking milestone once, regardless of how many times the
 * booking confirmation is retried. The event is the source of truth for all
 * staff, client and public timelines; the booking/payment records alone are
 * not enough to render a journey.
 */
export async function ensureShipmentBookedEvent(
  input: EnsureShipmentBookedEventInput,
) {
  try {
    return await ShipmentEvent.findOneAndUpdate(
      {
        shipmentDraftId: input.shipmentDraftId,
        status: SHIPMENT_BOOKED_STATUS,
      },
      buildShipmentBookedEventUpdate(input),
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      },
    ).exec();
  } catch (error) {
    // Two confirmation retries can race before either sees the inserted row.
    // The unique milestone index is the final guard; if it wins that race,
    // return the already-created event instead of turning a successful booking
    // into a false fulfilment failure.
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === 11000
    ) {
      const existing = await ShipmentEvent.findOne({
        shipmentDraftId: input.shipmentDraftId,
        status: SHIPMENT_BOOKED_STATUS,
      }).exec();
      if (existing) return existing;
    }
    throw error;
  }
}
