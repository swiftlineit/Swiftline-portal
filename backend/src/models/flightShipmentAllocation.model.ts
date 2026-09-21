import mongoose from "mongoose";

export const allocationStatusValues = ["ALLOCATED", "CARRIED", "REMOVED", "OFFLOADED"] as const;
export type AllocationStatus = (typeof allocationStatusValues)[number];

export interface IFlightShipmentAllocation extends mongoose.Document {
  flightLinehaulId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  awb: string;
  /** Actual and volumetric weights are retained so the capacity decision is auditable. */
  actualWeightKg?: number;
  volumetricWeightKg?: number;
  chargeableWeightKg?: number;
  /** Legacy capacity field; new allocations store the chargeable weight here too. */
  destinationCountryCode: string;
  destinationCountryName: string;
  weightKg: number;
  pieces: number;
  /** Parcels still physically assigned to this flight. Empty when fully offloaded. */
  activeParcelNumbers?: string[];
  /** Parcels removed from this flight without changing the shipment identity. */
  offloadedParcelNumbers?: string[];
  snapshot: Record<string, unknown>;
  status: AllocationStatus;
  allocatedBy: mongoose.Types.ObjectId;
  allocatedAt: Date;
  removedBy?: mongoose.Types.ObjectId | null;
  removedAt?: Date | null;
  removalReason: string;
  offloadId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new mongoose.Schema<IFlightShipmentAllocation>(
  {
    flightLinehaulId: { type: mongoose.Schema.Types.ObjectId, ref: "FlightLinehaul", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
    dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
    awb: { type: String, trim: true, uppercase: true, maxlength: 80, default: "" },
    actualWeightKg: { type: Number, min: 0 },
    volumetricWeightKg: { type: Number, min: 0 },
    chargeableWeightKg: { type: Number, min: 0 },
    destinationCountryCode: { type: String, trim: true, uppercase: true, maxlength: 2, default: "" },
    destinationCountryName: { type: String, trim: true, maxlength: 100, default: "" },
    weightKg: { type: Number, required: true, min: 0 },
    pieces: { type: Number, required: true, min: 0 },
    activeParcelNumbers: [{ type: String, trim: true, uppercase: true, maxlength: 80 }],
    offloadedParcelNumbers: [{ type: String, trim: true, uppercase: true, maxlength: 80 }],
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: allocationStatusValues, required: true, default: "ALLOCATED", index: true },
    allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    allocatedAt: { type: Date, default: Date.now },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    removedAt: { type: Date, default: null },
    removalReason: { type: String, trim: true, maxlength: 500, default: "" },
    offloadId: { type: mongoose.Schema.Types.ObjectId, ref: "FlightOffload", default: null }
  },
  { timestamps: true }
);

// Enforce one pre-departure allocation per shipment. CARRIED rows are immutable
// flight history, so a held/deferred parcel can be allocated to a later flight.
schema.index(
  { shipmentDraftId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ALLOCATED" },
    name: "uniq_active_allocation_per_shipment"
  }
);
schema.index({ flightLinehaulId: 1, status: 1 });
schema.index(
  { flightLinehaulId: 1, shipmentDraftId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ALLOCATED" },
    name: "uniq_active_flight_shipment"
  }
);
schema.index({ branchId: 1, status: 1, allocatedAt: -1 });

export const FlightShipmentAllocation = mongoose.model<IFlightShipmentAllocation>(
  "FlightShipmentAllocation",
  schema
);
