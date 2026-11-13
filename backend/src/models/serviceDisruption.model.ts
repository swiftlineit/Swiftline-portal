import mongoose from "mongoose";

/**
 * Operational advisories shown as the header marquee and on the client
 * calendar. An admin or operations member publishes one of these to alert
 * clients (and staff) about anything that can affect shipments: weather,
 * airport closures, customs strikes, public holidays, cancelled flights,
 * security restrictions or peak season delays.
 */
export const serviceDisruptionTypeValues = [
  "WEATHER_DISRUPTION",
  "AIRPORT_CLOSURE",
  "CUSTOMS_STRIKE",
  "PUBLIC_HOLIDAY",
  "FLIGHT_CANCELLATION",
  "SECURITY_RESTRICTION",
  "PEAK_SEASON_DELAY",
  "INFORMATION"
] as const;

export const serviceDisruptionSeverityValues = ["INFO", "WARNING", "CRITICAL"] as const;

export type ServiceDisruptionType = (typeof serviceDisruptionTypeValues)[number];
export type ServiceDisruptionSeverity = (typeof serviceDisruptionSeverityValues)[number];

export interface IServiceDisruption extends mongoose.Document {
  type: ServiceDisruptionType;
  severity: ServiceDisruptionSeverity;
  title: string;
  message: string;
  /** When the disruption takes effect. `startAt` is always set. */
  startAt: Date;
  /** Optional end. `null` means the disruption runs until it is deactivated. */
  endAt?: Date | null;
  /**
   * Branches the disruption applies to. Empty means every branch- the common
   * case for network-wide alerts like a customs strike.
   */
  affectedBranches: mongoose.Types.ObjectId[];
  /** Only active disruptions are visible to clients and on the marquee. */
  active: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const serviceDisruptionSchema = new mongoose.Schema<IServiceDisruption>(
  {
    type: { type: String, enum: serviceDisruptionTypeValues, required: true, index: true },
    severity: { type: String, enum: serviceDisruptionSeverityValues, default: "INFO" },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, default: null },
    affectedBranches: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Branch" }],
      default: []
    },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

// The "live now" query used by the marquee and client calendar always filters
// on all three of these together.
serviceDisruptionSchema.index({ active: 1, startAt: 1, endAt: 1 });

export const ServiceDisruption = mongoose.model<IServiceDisruption>(
  "ServiceDisruption",
  serviceDisruptionSchema
);
