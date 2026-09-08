import mongoose from "mongoose";

export const shipmentEventStatusValues = [
  "SHIPMENT_CREATED",
  "SHIPMENT_BOOKED",
  "SHIPMENT_CANCELLED",
  "ON_HOLD",
  "RELEASED_FROM_HOLD",
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
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "LOST",
  "DAMAGED"
] as const;

export const shipmentOperationalStatusValues = [
  "PARCEL_COLLECTED",
  "WAREHOUSE_SCAN_IN",
  "ORIGIN_HUB_PROCESSED",
  "READY_FOR_EXPORT",
  "ORIGIN_HUB_DISPATCHED",
  "DESTINATION_ARRIVED",
  "IMPORT_CUSTOMS_CLEARANCE",
  "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED",
  "DELIVERY_HUB_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DELIVERED"
] as const;

export const shipmentEventSourceValues = [
  "MANUAL",
  "PICKUP",
  "MANIFEST",
  "DELIVERY",
  "CARRIER",
  "SYSTEM"
] as const;

export const shipmentHoldReasonValues = [
  "missing_documents",
  "customs_query",
  "payment_issue",
  "customer_request",
  "address_issue",
  "restricted_item_check",
  "operational_delay",
  // A shipment that missed its flight or road connection. Recorded as a hold so
  // the client is told why it stopped moving, rather than left to infer it from
  // a gap between "flight assigned" and the next scan.
  "missed_connection",
  "other"
] as const;

export type ShipmentEventStatus = (typeof shipmentEventStatusValues)[number];
export type ShipmentHoldReason = (typeof shipmentHoldReasonValues)[number];
export type ShipmentEventSource = (typeof shipmentEventSourceValues)[number];

/**
 * The customer journey milestone represented by an event status.
 *
 * Holds and other exceptions deliberately return an empty key because they may
 * happen more than once. Historical export/flight names map onto the current
 * milestone so an old and a new name cannot create two customer-facing steps.
 */
export function shipmentMilestoneKey(status?: string | null): string {
  if (!status) return "";
  if (status === "EXPORT_CUSTOMS_CLEARED" || status === "FLIGHT_ASSIGNED") return "READY_FOR_EXPORT";
  if (status === "FLIGHT_DEPARTED") return "ORIGIN_HUB_DISPATCHED";
  if (status === "SHIPMENT_BOOKED") return status;
  return (shipmentOperationalStatusValues as readonly string[]).includes(status) ? status : "";
}

export interface IShipmentEvent extends mongoose.Document {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId?: mongoose.Types.ObjectId | null;
  status: ShipmentEventStatus;
  /** Canonical single-occurrence milestone; blank for repeatable events. */
  milestoneKey: string;
  holdReason?: ShipmentHoldReason | null;
  note: string;
  /**
   * Where the scan happened, as Operations typed it- "Delhi Hub",
   * "Heathrow, London", "Dubai Customs".
   *
   * Optional on purpose. It is free text keyed in alongside the event, so most
   * historical events have none and some new ones will not either. Tracking
   * uses it when it is meaningful for the latest status and otherwise derives
   * a coarse position from the route and status without inventing a scan.
   */
  location: string;
  source: ShipmentEventSource;
  /** Stable upstream reference, such as a manifest or delivery-assignment id. */
  sourceReference: string;
  /** Actual IATA gateway used by this shipment, when the event establishes it. */
  gatewayCode: string;
  /** Customer-safe gateway city/name, stored with the event so history cannot drift. */
  gatewayName: string;
  /** Last-mile partner as it was known when this event was recorded. */
  partnerName: string;
  partnerCode: string;
  customerVisible: boolean;
  createdBy: mongoose.Types.ObjectId;
  eventAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentEventSchema = new mongoose.Schema<IShipmentEvent>(
  {
    shipmentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShipmentDraft",
      required: true,
      index: true
    },
    dpdShipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DpdShipment",
      default: null,
      index: true
    },
    status: {
      type: String,
      enum: shipmentEventStatusValues,
      required: true,
      index: true
    },
    holdReason: {
      type: String,
      enum: [...shipmentHoldReasonValues, null],
      default: null
    },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    location: { type: String, trim: true, maxlength: 120, default: "" },
    source: {
      type: String,
      enum: shipmentEventSourceValues,
      required: true,
      default: "MANUAL",
      index: true
    },
    milestoneKey: {
      type: String,
      trim: true,
      maxlength: 40,
      default: function milestoneDefault(this: { status?: string }) {
        return shipmentMilestoneKey(this.status);
      }
    },
    sourceReference: { type: String, trim: true, maxlength: 120, default: "" },
    gatewayCode: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    gatewayName: { type: String, trim: true, maxlength: 120, default: "" },
    partnerName: { type: String, trim: true, maxlength: 120, default: "" },
    partnerCode: { type: String, trim: true, uppercase: true, maxlength: 24, default: "" },
    customerVisible: { type: Boolean, default: true, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    eventAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

shipmentEventSchema.index({ shipmentDraftId: 1, eventAt: -1 });
shipmentEventSchema.index(
  { shipmentDraftId: 1, eventAt: -1, createdAt: -1 },
  { name: "shipmentEvent_draft_event_created_desc" }
);
shipmentEventSchema.index({ dpdShipmentId: 1, eventAt: -1 });
shipmentEventSchema.index(
  { shipmentDraftId: 1, status: 1, source: 1, sourceReference: 1 },
  {
    unique: true,
    name: "uniq_shipment_event_source_reference",
    partialFilterExpression: { sourceReference: { $type: "string", $gt: "" } }
  }
);
shipmentEventSchema.index(
  { shipmentDraftId: 1, milestoneKey: 1 },
  {
    unique: true,
    name: "uniq_shipment_customer_milestone",
    partialFilterExpression: { milestoneKey: { $type: "string", $gt: "" } }
  }
);

export const ShipmentEvent = mongoose.model<IShipmentEvent>(
  "ShipmentEvent",
  shipmentEventSchema
);
