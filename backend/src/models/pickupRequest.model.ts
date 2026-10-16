import mongoose from "mongoose";

/**
 * Where a pickup request sits.
 *
 * `DRIVER_ASSIGNED` and `MISSED` were added because a customer asking "is
 * anyone coming?" and "did they turn up?" could not be answered from this
 * field. Driver assignment was recorded only on the attempt, so the request
 * still read CONFIRMED once a driver was on it; and a failed collection had
 * nowhere to go at all- `CLOSED_UNSUCCESSFUL` existed in this list but was
 * never set by anything.
 *
 * `MISSED` is distinct from `CLOSED_UNSUCCESSFUL`: missed means nobody
 * collected on the day and the request is still alive to be rescheduled, while
 * closed-unsuccessful ends it. Collapsing the two would make a reschedulable
 * pickup look finished.
 */
export const pickupRequestStatusValues = [
  "REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED",
  "PARTIALLY_COLLECTED", "COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS", "MISSED", "CANCELLED", "CLOSED_UNSUCCESSFUL"
] as const;
export type PickupRequestStatus = (typeof pickupRequestStatusValues)[number];
export const pickupArrivalWindowValues = ["MORNING", "AFTERNOON", "EVENING", "EXACT"] as const;
export type PickupArrivalWindow = (typeof pickupArrivalWindowValues)[number];

/** What each status is called wherever a person reads it. */
export const pickupRequestStatusLabels: Record<PickupRequestStatus, string> = {
  REQUESTED: "Requested",
  CONFIRMED: "Scheduled",
  DRIVER_ASSIGNED: "Driver Assigned",
  IN_PROGRESS: "In Progress",
  ACTION_REQUIRED: "Action Required",
  PARTIALLY_COLLECTED: "Partially Collected",
  COLLECTED: "Collected",
  RECEIVED_AT_DELHI_HUB: "Received at Delhi hub",
  COMPLETED_WITH_MISSING_PARCELS: "Completed - parcels missing",
  MISSED: "Missed Pickup",
  CANCELLED: "Cancelled",
  CLOSED_UNSUCCESSFUL: "Closed Unsuccessful"
};

/** Statuses a pickup can still be rescheduled from. */
export const reschedulablePickupStatuses: PickupRequestStatus[] = [
  "REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED", "MISSED"
];

export interface IPickupRequest extends mongoose.Document {
  requestNumber: string;
  businessAccountId: mongoose.Types.ObjectId;
  businessAccountName: string;
  branchId: mongoose.Types.ObjectId;
  requestedBy: mongoose.Types.ObjectId;
  source: "CLIENT_PORTAL" | "ADMIN" | "API";
  status: PickupRequestStatus;
  addressFingerprint: string;
  pickupAddress: Record<string, unknown>;
  pickupContact: { name: string; email?: string; phone: string };
  requestedWindow: { startAt: Date; endAt: Date; timezone: string };
  dispatchAt?: Date | null;
  expectedDelhiArrival?: { date: Date; window: PickupArrivalWindow; exactAt?: Date | null; timezone: string } | null;
  confirmedWindow?: { startAt: Date; endAt: Date; timezone: string } | null;
  instructions?: string;
  transportCompany?: string;
  handlingRemarks?: string;
  pickupPartnerInfo?: string;
  documents: Array<{
    _id: mongoose.Types.ObjectId;
    originalName: string;
    storageKey: string;
    mimeType: string;
    size: number;
    uploadedAt: Date;
    uploadedBy: mongoose.Types.ObjectId;
  }>;
  dispatchReminderSentAt?: Date | null;
  pickupStartedAt?: Date | null;
  receivedAtDelhiHubAt?: Date | null;
  shipmentCount: number;
  totalBoxes: number;
  parcelCount: number;
  totalWeightKg: number;
  currentAttemptId?: mongoose.Types.ObjectId | null;
  version: number;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancelledAt?: Date | null;
  cancellationReason?: string;
  cancellationSource?: "CLIENT" | "ADMIN" | null;
  createdAt: Date;
  updatedAt: Date;
}

const windowSchema = new mongoose.Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, trim: true, maxlength: 80, required: true }
  },
  { _id: false }
);

const expectedArrivalSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    window: { type: String, enum: pickupArrivalWindowValues, required: true },
    exactAt: { type: Date, default: null },
    timezone: { type: String, trim: true, maxlength: 80, required: true }
  },
  { _id: false }
);

const pickupDocumentSchema = new mongoose.Schema(
  {
    originalName: { type: String, trim: true, maxlength: 200, required: true },
    storageKey: { type: String, trim: true, maxlength: 1024, required: true },
    mimeType: { type: String, trim: true, maxlength: 100, required: true },
    size: { type: Number, min: 1, max: 8 * 1024 * 1024, required: true },
    uploadedAt: { type: Date, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: false }
);

const pickupRequestSchema = new mongoose.Schema<IPickupRequest>(
  {
    requestNumber: { type: String, required: true, unique: true, trim: true, uppercase: true, index: true },
    businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    businessAccountName: { type: String, trim: true, maxlength: 200, default: "" },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    source: { type: String, enum: ["CLIENT_PORTAL", "ADMIN", "API"], required: true },
    status: { type: String, enum: pickupRequestStatusValues, default: "REQUESTED", required: true, index: true },
    addressFingerprint: { type: String, required: true, trim: true, maxlength: 500, index: true },
    pickupAddress: { type: mongoose.Schema.Types.Mixed, required: true },
    pickupContact: {
      name: { type: String, trim: true, maxlength: 120, required: true },
      email: { type: String, trim: true, lowercase: true, maxlength: 160, default: "" },
      phone: { type: String, trim: true, maxlength: 30, required: true }
    },
    requestedWindow: { type: windowSchema, required: true },
    dispatchAt: { type: Date, default: null, index: true },
    expectedDelhiArrival: { type: expectedArrivalSchema, default: null },
    confirmedWindow: { type: windowSchema, default: null },
    instructions: { type: String, trim: true, maxlength: 500, default: "" },
    transportCompany: { type: String, trim: true, maxlength: 120, default: "" },
    handlingRemarks: { type: String, trim: true, maxlength: 500, default: "" },
    pickupPartnerInfo: { type: String, trim: true, maxlength: 500, default: "" },
    documents: { type: [pickupDocumentSchema], default: [] },
    dispatchReminderSentAt: { type: Date, default: null },
    pickupStartedAt: { type: Date, default: null },
    receivedAtDelhiHubAt: { type: Date, default: null },
    shipmentCount: { type: Number, min: 0, default: 0 },
    totalBoxes: { type: Number, min: 0, default: 0, required: true },
    parcelCount: { type: Number, min: 0, required: true },
    totalWeightKg: { type: Number, min: 0, required: true },
    currentAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupAttempt", default: null },
    version: { type: Number, min: 1, default: 1, required: true },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: "" },
    cancellationSource: { type: String, enum: ["CLIENT", "ADMIN", null], default: null }
  },
  { timestamps: true }
);

pickupRequestSchema.index({ branchId: 1, status: 1, "requestedWindow.startAt": 1 });
pickupRequestSchema.index({ businessAccountId: 1, createdAt: -1 });
pickupRequestSchema.index(
  { status: 1, dispatchAt: 1, dispatchReminderSentAt: 1 },
  { name: "pickup_dispatch_reminder_due" }
);

export const PickupRequest = mongoose.model<IPickupRequest>("PickupRequest", pickupRequestSchema);
