import mongoose from "mongoose";

export const flightLinehaulStatusValues = [
  // These legacy values remain readable for flights created before the
  // simplified lifecycle. New flights use only BOOKING_CONFIRMED (shown as
  // "Booked"), CARGO_ALLOCATED, DEPARTED, ARRIVED_DESTINATION, CLOSED and
  // CANCELLED.
  "PLANNED",
  "BOOKING_CONFIRMED",
  "CARGO_ALLOCATED",
  "MANIFEST_READY",
  "HANDED_TO_AIRLINE",
  "DEPARTED",
  "IN_TRANSIT",
  "CONNECTION",
  "ARRIVED_DESTINATION",
  "CUSTOMS",
  "HANDED_TO_FINAL_MILE",
  "CLOSED",
  "CANCELLED"
] as const;

export type FlightLinehaulStatus = (typeof flightLinehaulStatusValues)[number];

export const flightCustomsStatusValues = ["PENDING", "SUBMITTED", "CLEARED", "HELD"] as const;
export type FlightCustomsStatus = (typeof flightCustomsStatusValues)[number];

export const connectionRiskValues = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "MISSED"] as const;
export type ConnectionRisk = (typeof connectionRiskValues)[number];

export interface IFlightLinehaul extends mongoose.Document {
  flightLinehaulNumber: string;
  branchId: mongoose.Types.ObjectId;
  flightNumber: string;
  airlineName: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  transitIataCode: string;
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  actualDepartureAt?: Date | null;
  actualArrivalAt?: Date | null;
  capacityKg: number;
  allocatedWeightKg: number;
  utilisationPercent: number;
  totalShipments: number;
  totalBags: number;
  totalPieces: number;
  status: FlightLinehaulStatus;
  // single transit connection
  connection?: {
    transitAirportCode: string;
    scheduledArrivalAt?: Date | null;
    scheduledDepartureAt?: Date | null;
    actualArrivalAt?: Date | null;
    actualDepartureAt?: Date | null;
    layoverMinutes?: number | null;
    riskLevel: ConnectionRisk;
  } | null;
  customsStatus: FlightCustomsStatus;
  customsClearedAt?: Date | null;
  customsSubmittedAt?: Date | null;
  // destination handover
  destinationAgent: string;
  finalMileCarrier: string;
  arrivalAt?: Date | null;
  handoverAt?: Date | null;
  handoverReference: string;
  // cancellation
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason: string;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  closedAt?: Date | null;
  closedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const connectionSchema = new mongoose.Schema(
  {
    transitAirportCode: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    scheduledArrivalAt: { type: Date, default: null },
    scheduledDepartureAt: { type: Date, default: null },
    actualArrivalAt: { type: Date, default: null },
    actualDepartureAt: { type: Date, default: null },
    layoverMinutes: { type: Number, default: null },
    riskLevel: { type: String, enum: connectionRiskValues, default: "LOW" }
  },
  { _id: false }
);

const schema = new mongoose.Schema<IFlightLinehaul>(
  {
    flightLinehaulNumber: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true, maxlength: 40 },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    flightNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 20, index: true },
    airlineName: { type: String, trim: true, maxlength: 120, default: "" },
    mawbNumber: { type: String, trim: true, uppercase: true, maxlength: 40, default: "", index: true },
    originIataCode: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    destinationIataCode: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    transitIataCode: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    scheduledDepartureAt: { type: Date, required: true, index: true },
    scheduledArrivalAt: { type: Date, required: true, index: true },
    actualDepartureAt: { type: Date, default: null },
    actualArrivalAt: { type: Date, default: null },
    capacityKg: { type: Number, required: true, min: 0, default: 1000 },
    allocatedWeightKg: { type: Number, required: true, min: 0, default: 0 },
    utilisationPercent: { type: Number, required: true, min: 0, max: 200, default: 0 },
    totalShipments: { type: Number, required: true, min: 0, default: 0 },
    totalBags: { type: Number, required: true, min: 0, default: 0 },
    totalPieces: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: flightLinehaulStatusValues, required: true, default: "BOOKING_CONFIRMED", index: true },
    connection: { type: connectionSchema, default: null },
    customsStatus: { type: String, enum: flightCustomsStatusValues, default: "PENDING", index: true },
    customsClearedAt: { type: Date, default: null },
    customsSubmittedAt: { type: Date, default: null },
    destinationAgent: { type: String, trim: true, maxlength: 1000, default: "" },
    finalMileCarrier: { type: String, trim: true, maxlength: 200, default: "" },
    arrivalAt: { type: Date, default: null },
    handoverAt: { type: Date, default: null },
    handoverReference: { type: String, trim: true, maxlength: 120, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

schema.index({ branchId: 1, status: 1, scheduledDepartureAt: -1 });
schema.index({ branchId: 1, flightNumber: 1, scheduledDepartureAt: 1 }, { unique: false });
schema.index({ "connection.transitAirportCode": 1 });

export const FlightLinehaul = mongoose.model<IFlightLinehaul>("FlightLinehaul", schema);
